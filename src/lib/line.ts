import type { Env } from "../index";

/**
 * LINE Webhook の署名を検証する（Web Crypto API — Workers 互換）。
 * X-Line-Signature ヘッダーと request body の HMAC-SHA256 を比較。
 */
export async function verifyLineSignature(
  body: string,
  signature: string,
  channelSecret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(channelSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));

  // 定数時間比較（タイミング攻撃防止）
  if (computed.length !== signature.length) return false;
  let result = 0;
  for (let i = 0; i < computed.length; i++) {
    result |= computed.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

/** Quick Reply のアイテム型 */
export type QuickReplyItem = {
  type: "action";
  action: {
    type: "message";
    label: string;
    text: string;
  };
};

/** リトライ可能な HTTP ステータスコード */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** リトライの最大回数 */
const MAX_RETRIES = 2;

/** リトライ間隔（ミリ秒） */
const RETRY_DELAY_MS = 500;

/**
 * LINE Push API の共通送信ロジック（MS5 5.9）。
 * - リトライ: 429/5xx 系エラー時に最大2回リトライ（指数バックオフ）
 * - エラー分類: ログにステータスコードとエラー詳細を記録
 * - テキスト長制限: LINE API の 5000 文字制限を超える場合は切り詰め
 */
async function linePush(
  userId: string,
  messages: Array<Record<string, unknown>>,
  env: Env,
): Promise<void> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAY_MS * attempt),
      );
    }

    const res = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ to: userId, messages }),
    });

    if (res.ok) return;

    lastError = await res.text().catch(() => "unknown error");
    const statusCode = res.status;

    // リトライ不可能なエラー（4xx 系、429 を除く）は即座に失敗
    if (!RETRYABLE_STATUS_CODES.has(statusCode)) {
      console.error(
        `LINE Push API error [${statusCode}] (non-retryable):`,
        lastError,
      );
      throw new Error(`LINE Push API failed: ${statusCode}`);
    }

    console.warn(
      `LINE Push API error [${statusCode}] (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
      lastError,
    );
  }

  // 全リトライ失敗
  console.error("LINE Push API failed after all retries:", lastError);
  throw new Error(`LINE Push API failed after ${MAX_RETRIES + 1} attempts`);
}

/**
 * LINE Reply API の共通送信ロジック（無料 — 通数にカウントされない）。
 *
 * push と同じリトライ方針（429/5xx を最大2回・指数バックオフ）だが、
 * reply token 固有のエラー（400 = Invalid reply token: 期限切れ / 使用済み）は
 * リトライ不能として即 throw する。呼び出し側（Responder）がこれを捕捉して
 * push にフォールバックする（＝配信は必ず担保しつつ、可能な限り無料化する）。
 *
 * reply token 現行仕様（LINE 公式 2026-07 確認）:
 *   - webhook 受信後「1分以内」に使用（時間制限は予告なく変わり得るため実装で依存しない）
 *   - 1 回のみ使用可（使用済み / 期限切れは 400 Invalid reply token）
 *   - 1 リクエストで最大 5 message object
 *   出典: https://developers.line.biz/en/docs/messaging-api/sending-messages/
 *         https://developers.line.biz/en/reference/messaging-api/#send-reply-message
 */
async function lineReply(
  replyToken: string,
  messages: Array<Record<string, unknown>>,
  env: Env,
): Promise<void> {
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAY_MS * attempt),
      );
    }

    const res = await fetch("https://api.line.me/v2/bot/message/reply", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
      body: JSON.stringify({ replyToken, messages }),
    });

    if (res.ok) return;

    lastError = await res.text().catch(() => "unknown error");
    const statusCode = res.status;

    // リトライ不能なエラー（4xx 系、429 を除く。reply token 期限切れ/使用済みを含む）は即失敗。
    // 呼び出し側はこれを捕捉して push フォールバックする。
    if (!RETRYABLE_STATUS_CODES.has(statusCode)) {
      throw new Error(`LINE Reply API failed: ${statusCode}: ${lastError}`);
    }

    console.warn(
      `LINE Reply API error [${statusCode}] (attempt ${attempt + 1}/${MAX_RETRIES + 1}):`,
      lastError,
    );
  }

  throw new Error(`LINE Reply API failed after ${MAX_RETRIES + 1} attempts`);
}

/** テキスト message object を組み立てる（5000 文字上限 + quickReply 最大 13）。 */
function buildTextMessage(
  text: string,
  quickReplyItems?: QuickReplyItem[],
): Record<string, unknown> {
  const truncatedText = text.length > 5000 ? text.slice(0, 4997) + "..." : text;
  const message: Record<string, unknown> = { type: "text", text: truncatedText };
  if (quickReplyItems && quickReplyItems.length > 0) {
    message.quickReply = { items: quickReplyItems.slice(0, 13) };
  }
  return message;
}

/**
 * Flex message object を組み立てる（altText 400 文字上限 + quickReply 最大 13）。
 * quickReplyItems（UX③ の additive 拡張）は buildTextMessage と同一実装。省略時は付けない（無回帰）。
 */
function buildFlexMessage(
  altText: string,
  contents: Record<string, unknown>,
  quickReplyItems?: QuickReplyItem[],
): Record<string, unknown> {
  const truncatedAltText =
    altText.length > 400 ? altText.slice(0, 397) + "..." : altText;
  const message: Record<string, unknown> = {
    type: "flex",
    altText: truncatedAltText,
    contents,
  };
  if (quickReplyItems && quickReplyItems.length > 0) {
    message.quickReply = { items: quickReplyItems.slice(0, 13) };
  }
  return message;
}

/** LINE Push API でテキストメッセージを送信 */
export async function pushTextMessage(
  userId: string,
  text: string,
  env: Env,
  quickReplyItems?: QuickReplyItem[],
): Promise<void> {
  await linePush(userId, [buildTextMessage(text, quickReplyItems)], env);
}

/** LINE Push API で Flex Message を送信 */
export async function pushFlexMessage(
  userId: string,
  altText: string,
  contents: Record<string, unknown>,
  env: Env,
): Promise<void> {
  await linePush(userId, [buildFlexMessage(altText, contents)], env);
}

/**
 * 1 ターン（1 webhook イベント）分の応答送信を担う Responder。
 *
 * 会計方針（最大の節約）:
 *   - reply token が生きていて未使用なら **reply（無料 — 通数非消費）** で送る。
 *   - reply token が無い / 既に使用済み / reply が失敗した場合は **push（有料）** にフォールバック。
 *   - reply token は「1 ターンで 1 回だけ」使えるため、ターン内の最初の送信のみ無料化される。
 *     2 通目以降（例: テキストの後の Flex）は push になる（＝現行のメッセージ境界・quickReply
 *     配置を一切変えずに、支配的コストである本文 1 通を無料化する非回帰設計）。
 *
 * 配信は常に担保する: reply が期限切れ/使用済み等で失敗しても push で必ず届ける。
 */
export interface LineResponder {
  /** テキストを送る（reply 優先・push フォールバック）。 */
  text(text: string, quickReplyItems?: QuickReplyItem[]): Promise<void>;
  /** Flex を送る（reply 優先・push フォールバック）。quickReplyItems は任意（UX③・省略で無回帰）。 */
  flex(
    altText: string,
    contents: Record<string, unknown>,
    quickReplyItems?: QuickReplyItem[],
  ): Promise<void>;
}

/**
 * Responder を生成する。`replyToken` が undefined のイベント（例: unfollow）では
 * 常に push になる。
 */
export function createResponder(
  userId: string,
  replyToken: string | undefined,
  env: Env,
): LineResponder {
  // reply token は 1 ターン 1 回のみ。並行送信での二重使用を避けるため、
  // reply を試みる前に楽観的に consumed=true にする。
  let consumed = false;

  async function sendOne(messages: Array<Record<string, unknown>>): Promise<void> {
    if (replyToken && !consumed) {
      consumed = true;
      try {
        await lineReply(replyToken, messages, env);
        return;
      } catch (err) {
        console.warn(
          "[line] reply failed, falling back to push:",
          err instanceof Error ? err.message : err,
        );
        // フォールスルーして push で必ず届ける
      }
    }
    await linePush(userId, messages, env);
  }

  return {
    async text(text: string, quickReplyItems?: QuickReplyItem[]): Promise<void> {
      await sendOne([buildTextMessage(text, quickReplyItems)]);
    },
    async flex(
      altText: string,
      contents: Record<string, unknown>,
      quickReplyItems?: QuickReplyItem[],
    ): Promise<void> {
      await sendOne([buildFlexMessage(altText, contents, quickReplyItems)]);
    },
  };
}

/**
 * LINE Content API で画像をダウンロードし、base64 エンコードして返す。
 *
 * LINE v2 Content API: GET https://api-data.line.me/v2/bot/message/{messageId}/content
 * 画像は JPEG/PNG で返却される。
 *
 * @param messageId メッセージ ID
 * @param env 環境変数
 * @returns { base64: string; mediaType: "image/jpeg" | "image/png" }
 */
export async function getImageContent(
  messageId: string,
  env: Env,
): Promise<{ base64: string; mediaType: "image/jpeg" | "image/png" }> {
  const res = await fetch(
    `https://api-data.line.me/v2/bot/message/${messageId}/content`,
    {
      headers: {
        Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    },
  );

  if (!res.ok) {
    const err = await res.text().catch(() => "unknown error");
    throw new Error(`LINE Content API error (${res.status}): ${err}`);
  }

  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const mediaType = contentType.includes("png") ? "image/png" as const : "image/jpeg" as const;

  const arrayBuffer = await res.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  // base64 encode (Workers 環境対応)
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  return { base64, mediaType };
}

/** LINE Webhook のイベント型定義 */
export type LineEvent = {
  type: string;
  message?: {
    type: string;
    id: string;
    text?: string;
  };
  /** follow イベント固有のプロパティ（LINE Messaging API） */
  follow?: {
    isUnblocked: boolean;
  };
  /** postback イベントのデータ */
  postback?: {
    data: string;
  };
  source: {
    type: string;
    userId?: string;
  };
  replyToken?: string;
  webhookEventId: string;
  deliveryContext: {
    isRedelivery: boolean;
  };
  timestamp: number;
};

export type LineWebhookBody = {
  destination: string;
  events: LineEvent[];
};
