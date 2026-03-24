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

/** LINE Push API でテキストメッセージを送信 */
export async function pushTextMessage(
  userId: string,
  text: string,
  env: Env,
  quickReplyItems?: QuickReplyItem[],
): Promise<void> {
  // LINE API テキスト上限: 5000 文字
  const truncatedText = text.length > 5000 ? text.slice(0, 4997) + "..." : text;

  const message: Record<string, unknown> = { type: "text", text: truncatedText };
  if (quickReplyItems && quickReplyItems.length > 0) {
    message.quickReply = { items: quickReplyItems.slice(0, 13) };
  }

  await linePush(userId, [message], env);
}

/** LINE Push API で Flex Message を送信 */
export async function pushFlexMessage(
  userId: string,
  altText: string,
  contents: Record<string, unknown>,
  env: Env,
): Promise<void> {
  // altText も 400 文字制限
  const truncatedAltText =
    altText.length > 400 ? altText.slice(0, 397) + "..." : altText;

  await linePush(
    userId,
    [{ type: "flex", altText: truncatedAltText, contents }],
    env,
  );
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
