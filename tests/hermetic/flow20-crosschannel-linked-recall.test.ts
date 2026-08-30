/**
 * ハーメティック L1 — 動線20: 連携済みの人が「覚えてる？」と聞いたときに否認しない（B-1 / B-3）。
 *
 * ─ 何が壊れていたか（B-1）─
 *
 *   LIFF / LINE 純正 Account Link で連携した人は subject_links にしか「同じ人」の判断が無く、
 *   user_identity_map には行が無い。routes/line.ts の履歴ゲートは
 *   `identity.isLinked || canonical.linked` なので **履歴はプロンプトに入っていた**のに、
 *   runAgent へ渡すフラグだけが `identity.isLinked`（＝false）のままだった。
 *   その結果「連携済みです。以前の会話内容を自然に参照してください」という指示が出ず、
 *   AI は目の前の履歴を無視して「覚えていない」と否認していた。
 *   ＝ Setaka の最優先要求（チャットで連携の恩恵を感じたい）が実現しない状態。
 *
 * ─ 何を固定するか ─
 *
 *   subject_links だけで連携している人の LINE 発話を **実 webhook 経路で** 流し、
 *   Anthropic に実際に渡ったリクエストを捕捉して次の 3 点を固定する:
 *     (a) 別チャネル（サイトのチャット）の過去発言がプロンプトに入っている
 *     (b) 「連携済み・以前の会話内容を自然に参照してください」の指示ブロックが出ている
 *     (c) お客様に届いた返答が、その指示に沿った内容のまま素通りする（記憶否認フレーズを含まない）
 *   さらに B-3 として、履歴が複数チャネルにまたがるときだけチャネル印が付き、
 *   その読み方の説明がシステム側に入ることを固定する。
 *
 *   (b) の assert が「常に真」でないことを担保するため、**連携していない人**の同一発話で
 *   指示ブロックが出ないこと・チャネル印が付かないことも対で確認する（ネガティブ対照）。
 *
 * ─ 安全 ─
 *
 *   実ネットワーク非接触・実送信ゼロ。Anthropic と canonical 解決 RPC は本ファイル内だけで
 *   横取りする（共有のハーメティックルータには足さない。足すと「Anthropic が未モックで
 *   ブロックされる」ことに依存している既存テスト（flow17）の前提が変わるため）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getHermetic, type Hermetic } from "../lib/hermetic";
import { dispatchLineWebhook, settle } from "../lib/webhook";
import { messageEvent, synthLineUserId } from "../lib/synthetic";

/** 連携済みの人が「覚えてる？」と確かめにくる発話（どのインターセプタにも掛からない自由文）。 */
const RECALL_QUESTION = "前にそっちで話した私のお茶の好み、覚えてる？それに合うのを教えて。";

/** サイトのチャットで既に伝えてある好み（LINE 側には一度も書いていない）。 */
const WEB_TURNS: Array<{ role: "user" | "assistant"; content: string }> = [
  {
    role: "user",
    content: "渋いお茶が苦手です。甘くてまろやかなほうじ茶が好みです。",
  },
  {
    role: "assistant",
    content: "渋みが少なく、甘みとまろやかさのあるほうじ茶をお探しなのですね。",
  },
];

/** LINE 側に残っている発話。 */
const LINE_TURNS: Array<{ role: "user" | "assistant"; content: string }> = [
  { role: "user", content: "水出しで淹れるのが好きです。" },
  { role: "assistant", content: "水出しがお好みなのですね。承知しました。" },
];

/** モック LLM が返す「ちゃんと覚えている」返答（実 API 非接触）。 */
const CANNED_REPLY =
  "はい、覚えております。サイトのチャットで伺った、渋みが苦手でまろやかなほうじ茶がお好みというお話ですね。";

/** 「覚えていない」系の否認フレーズ（1 つでも出たら退行）。 */
const DENIAL_PHRASES = [
  "覚えていません",
  "覚えておりません",
  "記憶しておりません",
  "確認できません",
  "履歴を持っていません",
];

/** 捕捉した Anthropic リクエスト（1 ターンにつき 1 件）。 */
interface CapturedLlmCall {
  system: string;
  messages: Array<{ role: string; content: unknown }>;
}

let h: Hermetic;
let llmCalls: CapturedLlmCall[];
/** 本ファイルが被せた fetch（afterEach で自分のものだけを剥がすための目印）。 */
let localFetch: typeof fetch | undefined;
/** 被せる前の fetch（＝共有ハーメティックルータ）。剥がすときに戻す先。 */
let innerFetch: typeof fetch | undefined;
/** canonical 解決 RPC が返す中身（テストごとに差し替える）。 */
let canonicalRpcBody: Record<string, unknown>;

/** system ブロック（配列 or 文字列）を 1 本のテキストに畳む。 */
function flattenSystem(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((b) => (b && typeof b === "object" ? String((b as { text?: unknown }).text ?? "") : ""))
    .join("");
}

/** メッセージ列を 1 本のテキストに畳む（content は文字列 or マルチモーダル配列）。 */
function flattenMessages(messages: CapturedLlmCall["messages"]): string {
  return messages
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (!Array.isArray(m.content)) return "";
      return m.content
        .map((p) => (p && typeof p === "object" ? String((p as { text?: unknown }).text ?? "") : ""))
        .join("");
    })
    .join("\n");
}

/** Anthropic Messages API の最小応答（tool_use なし＝そのまま最終応答になる）。 */
function anthropicResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "msg_e2e_flow20",
      type: "message",
      role: "assistant",
      model: "claude-mock",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  // 共有のハーメティックガードは setupFiles（tests/lib/hermetic-setup.ts）が既に敷いている。
  // その上に本ファイル専用の横取りを 1 枚だけ重ねる（共有ルータには手を入れない）。
  h = getHermetic();
  llmCalls = [];
  canonicalRpcBody = { found: false, reason: "not_found" };

  const inner = globalThis.fetch;
  innerFetch = inner;
  const wrapper = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;

    // (1) canonical 解決 RPC（subject_links の連結成分）。モック Supabase は RPC を解さないため
    //     ここで返す。返す形は src/lib/cdp/canonical.ts の readResolution が読む契約そのもの。
    if (url.includes("/rest/v1/rpc/cdp_canonical_identifiers")) {
      return new Response(JSON.stringify(canonicalRpcBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // (2) Anthropic。実 API は叩かず、渡されたリクエストを捕捉して定型の返答を返す。
    if (url.includes("api.anthropic.com")) {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      llmCalls.push({
        system: flattenSystem(body.system),
        messages: Array.isArray(body.messages)
          ? (body.messages as CapturedLlmCall["messages"])
          : [],
      });
      return anthropicResponse(CANNED_REPLY);
    }

    return inner(input, init);
  }) as typeof fetch;

  localFetch = wrapper;
  globalThis.fetch = wrapper;
});

afterEach(() => {
  // 自分が被せた 1 枚だけを剥がす（共有ガードの restore 順序に依存しない）。
  if (localFetch !== undefined && innerFetch !== undefined && globalThis.fetch === localFetch) {
    globalThis.fetch = innerFetch;
  }
  localFetch = undefined;
  innerFetch = undefined;
});

/** 会話ログを 1 件分の行にする（created_at は明示＝並び順を決定的にする）。 */
function conversationRow(
  userId: string,
  channel: "line" | "web",
  role: "user" | "assistant",
  content: string,
  minute: number,
): Record<string, unknown> {
  return {
    user_id: userId,
    channel,
    role,
    content,
    created_at: `2026-08-01T00:${String(minute).padStart(2, "0")}:00Z`,
  };
}

/** LINE の 1 発話を webhook 経路で流し、waitUntil と fire-and-forget を落ち着かせる。 */
async function say(userId: string, text: string): Promise<void> {
  const res = await dispatchLineWebhook({
    env,
    channelSecret: String(env.LINE_CHANNEL_SECRET),
    events: [messageEvent(userId, text)],
  });
  expect(res.status, "webhook が 200 で受理されていない").toBe(200);
  await settle();
}

describe("hermetic L1 — 動線20: 連携済みの人の記憶否認（B-1 / B-3）", () => {
  it("subject_links だけで連携している人: 履歴が入り・連携済み指示が出て・否認しない返答が届く", async () => {
    const lineUserId = synthLineUserId("f20a");
    const webSessionId = "sess-e2e-f20a";

    // 旧台帳（user_identity_map）には **わざと行を入れない**。
    //   → resolveUnifiedUserId は isLinked=false を返す（★11 で直した人の実状態）。
    for (const [i, t] of WEB_TURNS.entries()) {
      h.supabase.seed("conversations", [
        conversationRow(webSessionId, "web", t.role, t.content, 10 + i),
      ]);
    }
    for (const [i, t] of LINE_TURNS.entries()) {
      h.supabase.seed("conversations", [
        conversationRow(lineUserId, "line", t.role, t.content, 20 + i),
      ]);
    }

    // canonical 解決だけが「同じ人」と言っている状態（link 1 本）。
    canonicalRpcBody = {
      found: true,
      canonical_id: "01E2ECANONICALF20A0000000A",
      member_count: 2,
      link_count: 1,
      identifier_values: [lineUserId, webSessionId],
      truncated: false,
    };

    await say(lineUserId, RECALL_QUESTION);

    expect(llmCalls.length, "Anthropic が一度も呼ばれていない（AI 会話に到達していない）").toBeGreaterThan(0);
    const call = llmCalls[0];
    const prompt = flattenMessages(call.messages);

    // (a) 別チャネル（サイトのチャット）の過去発言がプロンプトに入っている。
    expect(prompt, "web 側の過去発言が履歴に入っていない").toContain("まろやかなほうじ茶が好みです");
    expect(prompt, "LINE 側の過去発言が履歴に入っていない").toContain("水出しで淹れるのが好きです");

    // (b) 連携済み指示ブロックが出ている（B-1 の本丸）。
    expect(call.system, "連携済みの指示ブロックが出ていない（B-1 退行）").toContain(
      "以前の会話内容を自然に参照してください",
    );
    expect(call.system, "連携済みフラグがプロンプトに現れていない").toContain("アカウント連携済み");

    // (c) お客様に届いた返答が指示に沿った内容のまま素通りする（否認フレーズを含まない）。
    const texts = h.line.texts();
    expect(texts.length, "返答が 1 件も送られていない").toBeGreaterThan(0);
    const delivered = texts.join("\n");
    expect(delivered, "モック LLM の返答が届いていない").toContain("覚えております");
    for (const phrase of DENIAL_PHRASES) {
      expect(delivered, `記憶否認フレーズ「${phrase}」が返答に含まれている`).not.toContain(phrase);
    }

    // (B-3) 履歴が複数チャネルにまたがるので、チャネル印と読み方の説明が入る。
    expect(prompt, "チャネル印（サイトのチャット）が付いていない").toContain("[サイトのチャット]");
    expect(prompt, "チャネル印（LINE）が付いていない").toContain("[LINE]");
    expect(call.system, "チャネル印の読み方の説明が入っていない").toContain("会話履歴のチャネル表示");
  });

  it("ネガティブ対照 — 連携していない人: 連携済み指示もチャネル印も出ない", async () => {
    const lineUserId = synthLineUserId("f20b");

    h.supabase.seed("conversations", [
      conversationRow(lineUserId, "line", "user", "水出しで淹れるのが好きです。", 10),
      conversationRow(lineUserId, "line", "assistant", "承知しました。", 11),
    ]);

    // canonical も旧台帳も「同じ人」と言っていない（既定の found:false のまま）。
    await say(lineUserId, RECALL_QUESTION);

    expect(llmCalls.length, "Anthropic が一度も呼ばれていない").toBeGreaterThan(0);
    const call = llmCalls[0];

    expect(call.system, "未連携の人に連携済み指示が出ている（過剰適用）").not.toContain(
      "以前の会話内容を自然に参照してください",
    );
    expect(call.system, "未連携の人に連携済みフラグが出ている").not.toContain("アカウント連携済み");
    // 単一チャネルなので B-3 の印は 1 文字も足さない（既存の会話体験を動かさない）。
    expect(flattenMessages(call.messages), "単一チャネルなのにチャネル印が付いている").not.toContain(
      "[LINE]",
    );
    expect(call.system, "単一チャネルなのに印の説明が入っている").not.toContain(
      "会話履歴のチャネル表示",
    );
  });
});
