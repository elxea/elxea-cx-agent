/**
 * CLM Route — POST /v1/chat/completions（OpenAI 互換・SSE）
 *
 * Hume EVI を「声」、既存の elxea-cx-agent を「頭脳」として繋ぐための受け口。
 * Hume の Custom Language Model (CLM) は OpenAI 互換の `/chat/completions` を
 * SSE で叩く方式が公式推奨なので、その形だけを満たす**薄い変換層**を置く。
 *
 * ## ここでやらないこと（重要）
 *
 * 会話のロジックはこのファイルに 1 行も無い。ナレッジ検索・顧客文脈・ペルソナ・
 * 道具・ブランド是正はすべて `runAgentStreaming`（src/agent/core.ts）の中にあり、
 * それが唯一の正本である。ここは
 *
 *   OpenAI 形式 → 既存エージェントの引数 → OpenAI 形式の SSE
 *
 * という往復の変換と、認証と、観測ログだけを持つ。声の口が増えても会話は 1 つ。
 *
 * ## 会話履歴を保存しない
 *
 * この経路では `saveMessage` を呼ばない。履歴は Hume が `messages` として毎回
 * 送ってくるので、こちらでも保存すると同じ会話を 2 か所で持つことになる
 * （spike で洗い出した「二重管理 7 箇所」の #4 がまさにこれ）。どちらを正本に
 * するかが決まるまで、増やす側には回らない。
 */
import type { Context } from "hono";
import type { Env } from "../index";
import { runAgentStreaming, type StreamCallbacks, type Message } from "../agent/core";
import { createEmbedding } from "../lib/embedding";
import { isValidSyncApiKey } from "../lib/sync-auth";
import {
  normalizeMessages,
  sseFrame,
  SSE_DONE_FRAME,
  buildChunk,
  buildCompletion,
  newCompletionId,
  resolveLogLevel,
  buildRequestLog,
  deriveSessionKey,
  resolveSystemPolicy,
  resolveToolPolicy,
  type ClmRequestBody,
} from "../lib/clm-protocol";

/** 声の 1 往復で受け取ってよい発話の長さ（文字）。異常に長いものは弾く。 */
const MAX_UTTERANCE_LENGTH = 2000;
/** AI に渡す履歴の上限（声の会話は往復が速く、放っておくと際限なく伸びる）。 */
const MAX_HISTORY_TURNS = 30;

/**
 * この受け口の認証。
 *
 * ## なぜ SYNC_API_SECRET を使い回さないのか
 *
 * `SYNC_API_SECRET` は「この呼び出しは自社の web-app からだ」を意味する鍵で、
 * これを持つ呼び出し元は `/api/chat` で **shopify_customer_id を自己申告できる**
 * （isTrustedServerCaller → 認証済み identity として扱われる）。CLM の鍵は
 * 社外（Hume）に預けるものなので、同じ鍵にすると「声の設定画面に貼った鍵で
 * 他人の顧客 ID を名乗れる」状態になる。用途が違う鍵は分ける、というのは
 * このリポジトリが既に ERASE_API_SECRET / LINKAGE_EVENT_SECRET で採っている流儀。
 *
 * ## ヘッダーの形
 *
 * 既存の 2 つの流儀の**両方**を受ける（新しい流儀は足さない）:
 *   - `X-API-Key: <secret>`            … web.ts / sync-auth.ts と同じ
 *   - `Authorization: Bearer <secret>` … index.ts の /api/alerts/status と同じ
 * 相手（Hume の設定画面）がどちらの形しか出せなくても繋がるようにするため。
 * 突き合わせはどちらも `isValidSyncApiKey`（定数時間比較・前後空白の正規化つき）。
 *
 * fail-closed: `CLM_API_SECRET` が未設定なら、何を送られても 401。
 */
function authorize(c: Context<{ Bindings: Env }>): Response | null {
  const secret = (c.env as { CLM_API_SECRET?: string }).CLM_API_SECRET;
  const headerKey = c.req.header("X-API-Key");
  const authHeader = c.req.header("Authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;

  const ok = isValidSyncApiKey(headerKey, secret) || isValidSyncApiKey(bearer, secret);
  if (ok) return null;

  const reason = !secret
    ? "secret-unset"
    : !headerKey && !bearer
      ? "key-absent"
      : "key-mismatch";
  // 鍵の値・長さ・先頭は出さない。出るのは「なぜ弾いたか」の分類だけ。
  console.warn(`[clm] rejected request: reason=${reason}`);
  return c.json({ error: { message: "Unauthorized", type: "invalid_request_error" } }, 401);
}

/** テストから会話本体を差し替えられるようにする（本番は既定値＝実物）。 */
export type ClmDeps = {
  runAgentStreaming: typeof runAgentStreaming;
  createEmbedding: (text: string, env: Env) => Promise<number[]>;
};

export function createClmChatCompletionsHandler(deps: ClmDeps) {
  return async function clmHandler(c: Context<{ Bindings: Env }>): Promise<Response> {
    const unauthorized = authorize(c);
    if (unauthorized) return unauthorized;

    const env = c.env as Env & {
      CLM_LOG_MESSAGES?: string;
      CLM_SYSTEM_POLICY?: string;
      CLM_TOOL_POLICY?: string;
      CLM_SESSION_SALT?: string;
      DELIVERY_TARGET_ENV?: string;
    };

    let body: ClmRequestBody;
    try {
      body = (await c.req.json()) as ClmRequestBody;
    } catch {
      return c.json(
        { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
        400,
      );
    }

    // --- F-2: 相手が何を送ってきたかを残す（中身は既定で出さない） ---
    const { level, downgradedFrom } = resolveLogLevel(env.CLM_LOG_MESSAGES, env.DELIVERY_TARGET_ENV);
    if (downgradedFrom) {
      console.warn(
        `[clm] CLM_LOG_MESSAGES="${downgradedFrom}" is refused on prod; using "shape" (no message content is logged)`,
      );
    }
    const requestLog = buildRequestLog(body, level);
    if (requestLog) console.log(`[clm] request ${JSON.stringify(requestLog)}`);

    const normalized = normalizeMessages(body.messages);
    if (normalized.droppedRoles.length > 0) {
      console.log(`[clm] dropped roles: ${JSON.stringify(normalized.droppedRoles)}`);
    }

    if (!normalized.latestUserText) {
      return c.json(
        { error: { message: "messages must contain at least one user message", type: "invalid_request_error" } },
        400,
      );
    }
    if (normalized.latestUserText.length > MAX_UTTERANCE_LENGTH) {
      return c.json(
        { error: { message: `message too long (max ${MAX_UTTERANCE_LENGTH})`, type: "invalid_request_error" } },
        400,
      );
    }

    // --- F-3: 相手から来た system をどう扱うか ---
    //
    // 既定は `own` = **破棄する**。自社の systemPrompt(env) を唯一の正本にする。
    // 理由: (1) こちらの system にはブランド事実・エスカレーション条件・ペルソナが
    // 入っており、出口のブランド是正（brand-guard）もそれ前提で効いている。
    // (2) Hume 側の指示文は自社のリポジトリで版管理されておらず、設定画面で誰かが
    // 触れば会話の性格が黙って変わる。声の口が増えたことで振る舞いの正本が 2 つに
    // なるのは避ける。
    // `append` に倒せば併用できる（Hume 側の文面を実測してから決めるための切替）。
    const systemPolicy = resolveSystemPolicy(env.CLM_SYSTEM_POLICY);
    const extraSystem =
      systemPolicy === "append" && normalized.systemTexts.length > 0
        ? normalized.systemTexts.join("\n\n")
        : undefined;
    console.log(
      `[clm] system_policy=${systemPolicy} incoming_system_count=${normalized.systemTexts.length} applied=${extraSystem ? "yes" : "no"}`,
    );

    // --- F-5: 音声経路の道具の範囲 ---
    const toolPolicy = resolveToolPolicy(env.CLM_TOOL_POLICY);

    // --- 決定 #7: 相手の custom_session_id を鍵として信じない ---
    const rawSessionId =
      typeof body.custom_session_id === "string" ? body.custom_session_id : undefined;
    const sessionKey = await deriveSessionKey(rawSessionId, env.CLM_SESSION_SALT);

    const history: Message[] = normalized.history
      .slice(-MAX_HISTORY_TURNS)
      .map((t) => ({ role: t.role, content: t.content }));

    // 埋め込みはストリームを開く前に取る。ここで失敗したら
    // 「SSE の途中でエラー」ではなく素直に 500 を返せる。
    let embedding: number[];
    const tStart = Date.now();
    try {
      embedding = await deps.createEmbedding(normalized.latestUserText, env);
    } catch (err) {
      console.error("[clm] embedding failed:", err instanceof Error ? err.message : err);
      return c.json(
        { error: { message: "Internal server error", type: "server_error" } },
        500,
      );
    }

    const model = typeof body.model === "string" && body.model ? body.model : "elxea-cx-agent";
    const completionId = newCompletionId();
    const created = Math.floor(Date.now() / 1000);
    const wantsStream = body.stream === true;

    /** 会話本体を 1 回だけ呼ぶ。ストリーム版・非ストリーム版で共有する。 */
    const runAgent = (callbacks: StreamCallbacks) =>
      deps.runAgentStreaming(
        normalized.latestUserText,
        history,
        embedding,
        sessionKey,
        // Channel は "line" | "web" の 2 値しかない。声は web アプリ側の口から来る
        // 想定なので "web" を使う。ここで 3 値目を足すと会話本体・保存・集計まで
        // 波及するため、音声であることは Channel ではなく toolPolicy で表す。
        "web",
        env,
        callbacks,
        { toolPolicy, ...(extraSystem ? { extraSystem } : {}) },
      );

    // ------------------------------------------------------------------
    // 非ストリーミング（stream:false）— 偽クライアントでの確認・デバッグ用
    // ------------------------------------------------------------------
    if (!wantsStream) {
      let text = "";
      let failed: string | null = null;
      const callbacks: StreamCallbacks = {
        onTextDelta: (t) => { text += t; },
        onProductCards: () => {},
        onCartLink: () => {},
        onQuickReplies: () => {},
        onDone: (full) => { text = full; },
        onError: (message) => { failed = message; },
      };
      try {
        await runAgent(callbacks);
      } catch (err) {
        console.error("[clm] non-stream error:", err instanceof Error ? err.message : err);
        failed = "Internal server error";
      }
      if (failed && !text) {
        return c.json({ error: { message: failed, type: "server_error" } }, 500);
      }
      console.log(`[clm] non-stream done elapsed=${Date.now() - tStart}ms chars=${text.length}`);
      return c.json(buildCompletion({ id: completionId, created, model, content: text }));
    }

    // ------------------------------------------------------------------
    // ストリーミング（Hume はこちらを使う）
    // ------------------------------------------------------------------
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const write = (frame: string) => {
      // 相手が切った後の書き込みは握りつぶす（Workers 側を落とさない）
      writer.write(encoder.encode(frame)).catch(() => {});
    };
    const writeDelta = (delta: { role?: "assistant"; content?: string }, finishReason?: "stop") =>
      write(sseFrame(buildChunk({ id: completionId, created, model, delta, finishReason })));

    let firstDeltaAt: number | null = null;

    const pump = (async () => {
      try {
        // 最初のフレームで role を宣言するのが OpenAI の並び。
        writeDelta({ role: "assistant" });

        const callbacks: StreamCallbacks = {
          onTextDelta: (t) => {
            if (firstDeltaAt === null) {
              firstDeltaAt = Date.now();
              console.log(`[clm] ttft=${firstDeltaAt - tStart}ms`);
            }
            writeDelta({ content: t });
          },
          // 声には出せないので落とす。落としたことは残す（無言で消さない）。
          onProductCards: (p) => console.log(`[clm] dropped product_cards count=${p.length} (voice has no surface)`),
          onCartLink: () => console.log("[clm] dropped cart_link (voice has no surface)"),
          onQuickReplies: (items) => console.log(`[clm] dropped quick_replies count=${items.length} (voice has no surface)`),
          onDone: () => {
            writeDelta({}, "stop");
            write(SSE_DONE_FRAME);
            console.log(
              `[clm] done elapsed=${Date.now() - tStart}ms ttft=${firstDeltaAt ? firstDeltaAt - tStart : -1}ms`,
            );
          },
          onError: (message) => {
            console.error(`[clm] agent error: ${message}`);
            write(sseFrame({ error: { message, type: "server_error" } }));
          },
        };

        await runAgent(callbacks);
      } catch (err) {
        console.error("[clm] streaming error:", err instanceof Error ? err.message : err);
        try {
          write(sseFrame({ error: { message: "Internal server error", type: "server_error" } }));
          writeDelta({}, "stop");
          write(SSE_DONE_FRAME);
        } catch { /* writer may already be closed */ }
      } finally {
        try { await writer.close(); } catch { /* ignore */ }
      }
    })();

    // Workers はレスポンスを返した後も waitUntil の中だけは走り続ける。
    try {
      c.executionCtx.waitUntil(pump);
    } catch {
      // executionCtx を持たない環境（テスト等）では何もしない。pump は既に走っている。
    }

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  };
}

/** 本番で使う実物。 */
export const clmChatCompletionsHandler = createClmChatCompletionsHandler({
  runAgentStreaming,
  createEmbedding,
});
