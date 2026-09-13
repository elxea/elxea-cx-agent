/**
 * CLM Protocol — OpenAI 互換 `/chat/completions` の「形」だけを扱う純粋モジュール
 *
 * ここには**会話の中身を作るロジックを一切置かない**。会話本体は
 * `src/agent/core.ts` の `runAgentStreaming` ただ 1 つが正本で、このファイルは
 *
 *   (1) 受け取った OpenAI 形式のリクエストを、既存エージェントが読める形に直す
 *   (2) 返すものを OpenAI 形式の SSE フレームに包む
 *   (3) 相手（Hume EVI）が何を送ってきたのかを、**中身を漏らさずに**観測する
 *
 * の 3 つだけを担う。ネットワークにも env にも触らないので、そのままテストできる。
 *
 * ## なぜ (3) が要るのか
 *
 * Hume を Custom Language Model (CLM) として繋ぐとき、最大の未知は
 * **「Hume が `messages` に何を入れて寄越すのか」**である。公式ドキュメントには
 * system role を入れるとも入れないとも書かれておらず、prosody（声色のスコア）が
 * `messages` の中に混ざるのか別フィールドで来るのかも確定していない。
 * ここが分からないと「Hume 側の指示文」と「自社の system prompt」のどちらを
 * 正本にするかを決められない（＝二重管理が残る）。
 *
 * したがって受け口は最初から**観測装置**として作る。ただし `messages` には
 * お客様の発話がそのまま入る。だから既定は「中身を 1 文字も出さず、形だけ出す」
 * （= level "shape"）にし、中身を出す level は**本番では効かない**ようにする。
 */

/** OpenAI Chat Completions のメッセージ（未知フィールドは捨てずに残す） */
export type OpenAIMessage = {
  role?: unknown;
  content?: unknown;
  name?: unknown;
  [key: string]: unknown;
};

/** OpenAI Chat Completions のリクエストボディ（未知フィールドは捨てずに残す） */
export type ClmRequestBody = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  /** Hume が付けてくる可能性のあるセッション識別子（生の顧客 ID は入れない約束） */
  custom_session_id?: unknown;
  [key: string]: unknown;
};

/** 既存エージェントに渡す会話履歴の 1 発言 */
export type NormalizedTurn = { role: "user" | "assistant"; content: string };

/** 正規化の結果 */
export type NormalizedRequest = {
  /** system / developer role のテキスト（＝相手側の指示文。採否は呼び出し側の方針で決める） */
  systemTexts: string[];
  /** 末尾の user 発言を**除いた**会話履歴 */
  history: NormalizedTurn[];
  /** 今回答えるべき発言（＝末尾の user 発言）。無ければ空文字 */
  latestUserText: string;
  /** 落とした role の一覧（tool / function 等。観測用） */
  droppedRoles: string[];
};

/* ------------------------------------------------------------------------- *
 * 入力の正規化
 * ------------------------------------------------------------------------- */

/**
 * OpenAI の `content` は「文字列」か「パートの配列」の 2 形態がある。
 * どちらで来ても壊れないよう、テキスト部分だけを 1 本の文字列に畳む。
 * 画像等のテキストでないパートは黙って捨てず、`[image]` のような目印も残さない
 * （音声経路では使わないため。必要になったらここを増やす）。
 */
export function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === "string") {
        parts.push(p);
      } else if (p && typeof p === "object") {
        const obj = p as Record<string, unknown>;
        if (typeof obj.text === "string") parts.push(obj.text);
      }
    }
    return parts.join("");
  }
  return "";
}

/**
 * OpenAI 形式の `messages` を、既存エージェントの引数の形に直す。
 *
 * - system / developer は `systemTexts` に分離する（**履歴には混ぜない**）。
 *   混ぜると「相手の指示文」が会話の発言として AI に読まれ、誰の指示か分からなくなる。
 * - tool / function role は落とす（この受け口は道具の往復を相手に見せない）。
 * - 末尾の user 発言だけを「今の問い」として取り出す。末尾が user でない場合は
 *   最後の user 発言を探して使い、それ以降の発言は履歴に残す（順序は変えない）。
 */
export function normalizeMessages(messagesRaw: unknown): NormalizedRequest {
  const systemTexts: string[] = [];
  const droppedRoles: string[] = [];
  const turns: NormalizedTurn[] = [];

  const messages = Array.isArray(messagesRaw) ? (messagesRaw as OpenAIMessage[]) : [];

  for (const m of messages) {
    const role = typeof m?.role === "string" ? m.role : "";
    const text = flattenContent(m?.content);
    if (role === "system" || role === "developer") {
      if (text) systemTexts.push(text);
      continue;
    }
    if (role === "user" || role === "assistant") {
      // 空の発言は履歴に入れない（Anthropic 側が空 content を嫌うため）
      if (text) turns.push({ role, content: text });
      continue;
    }
    if (role) droppedRoles.push(role);
  }

  // 末尾から最後の user 発言を探す
  let lastUserIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  if (lastUserIdx < 0) {
    return { systemTexts, history: turns, latestUserText: "", droppedRoles };
  }

  const latestUserText = turns[lastUserIdx].content;
  const history = [...turns.slice(0, lastUserIdx), ...turns.slice(lastUserIdx + 1)];
  return { systemTexts, history, latestUserText, droppedRoles };
}

/* ------------------------------------------------------------------------- *
 * 出力（OpenAI 互換 SSE）
 * ------------------------------------------------------------------------- */

/** SSE の 1 フレーム（`data: {...}\n\n`） */
export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** ストリーム終端。OpenAI クライアントはこれを見て読み取りを止める。 */
export const SSE_DONE_FRAME = "data: [DONE]\n\n";

export type ChunkDelta = { role?: "assistant"; content?: string };

/** `chat.completion.chunk` 1 個を組み立てる */
export function buildChunk(params: {
  id: string;
  created: number;
  model: string;
  delta: ChunkDelta;
  finishReason?: "stop" | "length" | null;
}): Record<string, unknown> {
  return {
    id: params.id,
    object: "chat.completion.chunk",
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        delta: params.delta,
        logprobs: null,
        finish_reason: params.finishReason ?? null,
      },
    ],
  };
}

/** 非ストリーミング（`stream:false`）で返す完了オブジェクト */
export function buildCompletion(params: {
  id: string;
  created: number;
  model: string;
  content: string;
  finishReason?: "stop" | "length";
}): Record<string, unknown> {
  return {
    id: params.id,
    object: "chat.completion",
    created: params.created,
    model: params.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: params.content },
        logprobs: null,
        finish_reason: params.finishReason ?? "stop",
      },
    ],
    // 正しいトークン数を出すには Anthropic 側の usage を引き回す必要があり、
    // それは会話本体の戻り値を変えること＝正本を汚すことになる。0 を返して
    // 「数えていない」ことを明示する（嘘の数字を置かない）。
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** 補完 ID（OpenAI の見た目に合わせる。中身は単なるランダム） */
export function newCompletionId(): string {
  const rand = crypto?.randomUUID
    ? crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(16).slice(2).padEnd(24, "0");
  return `chatcmpl-${rand.slice(0, 24)}`;
}

/* ------------------------------------------------------------------------- *
 * 観測（F-2）— 中身を漏らさずに「何が来たか」を残す
 * ------------------------------------------------------------------------- */

/**
 * ログの濃さ。
 *
 * - `off`      … 何も出さない
 * - `shape`    … **中身を 1 文字も出さない**。role の並び・文字数・キー名だけ（既定）
 * - `redacted` … shape に加えて、system の本文（＝自社/Hume の設定であって顧客の発話ではない）
 *                と、user/assistant の**伏字化した先頭だけ**を出す
 * - `full`     … 生のボディをそのまま出す。spike 用。**本番では無効**
 */
export type ClmLogLevel = "off" | "shape" | "redacted" | "full";

/**
 * env の申告から実際の level を決める。
 *
 * 本番（DELIVERY_TARGET_ENV="prod"）では `redacted` / `full` を**受け付けない**。
 * 顧客の発話が入り得るものを、設定ミス 1 つで本番のログに出しっぱなしにしないため。
 * 申告が本番で拒否されたことは呼び出し側が 1 行警告する（黙って格下げしない）。
 */
export function resolveLogLevel(
  declared: string | undefined,
  targetEnv: string | undefined,
): { level: ClmLogLevel; downgradedFrom?: ClmLogLevel } {
  const raw = (declared ?? "").trim().toLowerCase();
  const asked: ClmLogLevel =
    raw === "off" || raw === "shape" || raw === "redacted" || raw === "full"
      ? (raw as ClmLogLevel)
      : "shape";

  const isProd = (targetEnv ?? "").trim().toLowerCase() === "prod";
  if (isProd && (asked === "redacted" || asked === "full")) {
    return { level: "shape", downgradedFrom: asked };
  }
  return { level: asked };
}

/** OpenAI が定める既知のトップレベルキー（これ以外が来たら Hume 固有＝観測対象） */
const KNOWN_BODY_KEYS = new Set([
  "model", "messages", "stream", "stream_options", "temperature", "top_p", "n",
  "max_tokens", "max_completion_tokens", "stop", "presence_penalty",
  "frequency_penalty", "logit_bias", "user", "tools", "tool_choice",
  "response_format", "seed", "logprobs", "top_logprobs", "parallel_tool_calls",
]);

/** OpenAI が定める既知のメッセージキー */
const KNOWN_MESSAGE_KEYS = new Set([
  "role", "content", "name", "tool_calls", "tool_call_id", "function_call", "refusal",
]);

/**
 * 数字列・メールアドレス・URL を伏せ、先頭だけ残す。
 *
 * 「伏字にしたから安全」ではない（自由文の発話そのものは残る）ので、これを使う
 * level は本番で無効化してある。ここは spike 中に**人が読むため**の最小化に過ぎない。
 */
export function redactText(text: string, maxChars = 80): string {
  const masked = text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\d{3,}/g, "[num]");
  return masked.length > maxChars ? `${masked.slice(0, maxChars)}…` : masked;
}

/**
 * 「何が来たか」を中身抜きで記述する。
 *
 * ここが F-2 の本体。prosody が `messages[].models.prosody` のような未知キーで
 * 来ても、`extra_message_keys` にキー名が現れるので**中身を出さずに発見できる**。
 */
export function describeRequestShape(body: ClmRequestBody): Record<string, unknown> {
  const messages = Array.isArray(body?.messages) ? (body.messages as OpenAIMessage[]) : [];
  const extraBodyKeys = Object.keys(body ?? {}).filter((k) => !KNOWN_BODY_KEYS.has(k));
  const extraMessageKeys = new Set<string>();
  const nestedKeyPaths = new Set<string>();

  const roles: string[] = [];
  const lengths: number[] = [];
  let systemCount = 0;

  for (const m of messages) {
    const role = typeof m?.role === "string" ? m.role : "(missing)";
    roles.push(role);
    lengths.push(flattenContent(m?.content).length);
    if (role === "system" || role === "developer") systemCount++;

    for (const [k, v] of Object.entries(m ?? {})) {
      if (KNOWN_MESSAGE_KEYS.has(k)) continue;
      extraMessageKeys.add(k);
      // 1 段だけ潜ってキー名を出す（prosody の入れ子を見つけるため。値は出さない）
      if (v && typeof v === "object" && !Array.isArray(v)) {
        for (const sub of Object.keys(v as Record<string, unknown>)) {
          nestedKeyPaths.add(`${k}.${sub}`);
        }
      }
    }
  }

  const customSessionId = body?.custom_session_id;

  return {
    message_count: messages.length,
    roles,
    content_lengths: lengths,
    system_message_count: systemCount,
    /** OpenAI 標準でないトップレベルキー（Hume 固有のものはここに出る） */
    extra_body_keys: extraBodyKeys,
    /** OpenAI 標準でないメッセージキー（prosody 等はここに出る） */
    extra_message_keys: [...extraMessageKeys],
    /** そのキーの 1 段下のキー名（値は出さない） */
    extra_message_key_paths: [...nestedKeyPaths],
    stream: body?.stream === true,
    model: typeof body?.model === "string" ? body.model : null,
    /** 値は出さない。「来ているか」と「長さ」だけ（生の顧客 ID を入れない約束の監視用） */
    custom_session_id_present: typeof customSessionId === "string" && customSessionId.length > 0,
    custom_session_id_length: typeof customSessionId === "string" ? customSessionId.length : 0,
  };
}

/** level に応じたログ本体を作る。`off` なら null（＝何も出さない）。 */
export function buildRequestLog(
  body: ClmRequestBody,
  level: ClmLogLevel,
): Record<string, unknown> | null {
  if (level === "off") return null;

  const shape = describeRequestShape(body);
  if (level === "shape") return { level, ...shape };

  if (level === "full") return { level, ...shape, raw_body: body };

  // redacted: system は全文（設定であって発話ではない）、それ以外は伏字の先頭だけ
  const messages = Array.isArray(body?.messages) ? (body.messages as OpenAIMessage[]) : [];
  const preview = messages.map((m) => {
    const role = typeof m?.role === "string" ? m.role : "(missing)";
    const text = flattenContent(m?.content);
    if (role === "system" || role === "developer") {
      return { role, content: text };
    }
    return { role, content_redacted: redactText(text) };
  });
  return { level, ...shape, messages_preview: preview };
}

/* ------------------------------------------------------------------------- *
 * セッション識別子（決定 #7: 生の顧客 ID を持ち込まない）
 * ------------------------------------------------------------------------- */

/**
 * `custom_session_id` を**そのまま鍵として使わない**。
 *
 * Hume の `custom_session_id` はクライアントから任意に送れて、Hume 側に検証の
 * 記載が無い。生の顧客 ID をここに入れると「他人の ID を送るだけで他人になれる」
 * 口ができる。よって受け口では必ず片方向ハッシュに畳み、**当てにならない識別子**
 * として扱う（これで引ける顧客プロファイルは無い＝匿名の人として応答する）。
 *
 * @param raw   相手が送ってきた値
 * @param salt  自社だけが知る塩（未設定でも動くが、その場合は総当たりに弱い）
 */
export async function deriveSessionKey(
  raw: string | undefined,
  salt: string | undefined,
): Promise<string> {
  if (!raw) {
    const rand = crypto?.randomUUID?.() ?? String(Math.random());
    return `clm_eph_${rand.replace(/-/g, "").slice(0, 16)}`;
  }
  const data = new TextEncoder().encode(`${salt ?? ""}|${raw}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `clm_${hex.slice(0, 16)}`;
}

/* ------------------------------------------------------------------------- *
 * 方針フラグ
 * ------------------------------------------------------------------------- */

/**
 * 相手（Hume）から来た system role をどう扱うか。
 *
 * - `own`    … **破棄する**。自社の system prompt を唯一の正本にする（既定）
 * - `append` … 自社の system prompt の後ろに足す（Hume 側を正本の一部として使う）
 */
export type ClmSystemPolicy = "own" | "append";

export function resolveSystemPolicy(declared: string | undefined): ClmSystemPolicy {
  return (declared ?? "").trim().toLowerCase() === "append" ? "append" : "own";
}

/** 音声経路で AI に渡す道具の範囲。意味は `src/agent/tools.ts` の `agentToolsFor`。 */
export type ClmToolPolicy = "none" | "minimal" | "all";

export function resolveToolPolicy(declared: string | undefined): ClmToolPolicy {
  const raw = (declared ?? "").trim().toLowerCase();
  if (raw === "none" || raw === "all") return raw;
  return "minimal";
}
