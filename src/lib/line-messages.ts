/**
 * LINE 送信拡張（T6）: multicast / broadcast の message 配列を text/image 可変化。
 *
 * 設計: 「Notion駆動 LINE配信 設計確定版 v1.0」§7 / Must-fix 11
 *   - 全員 = /message/broadcast（全友だち・受信者ID不要）
 *   - ペルソナ = /message/multicast（500件上限バッチ）
 *   - text と image（画像は恒久HTTPS。Notion署名URL不可）
 *
 * ⚠ 実送信の絶対制約:
 *   実際の LINE 送信系 API（multicast / broadcast / push）は `LineSender` インターフェース
 *   の *実装* に閉じ込める。オーケストレータは注入された sender 経由でしか送らない。
 *   本タスクでは実 sender を発火させない（feature flag off + テストは stub）。
 */

import type { DeliveryChannel } from "./delivery-channel";

// ---------------------------------------------------------------------------
// メッセージ型・ビルダー（純粋）
// ---------------------------------------------------------------------------

/** LINE メッセージオブジェクト（text / image のみ対応）。 */
export type LineMessage =
  | { type: "text"; text: string }
  | { type: "image"; originalContentUrl: string; previewImageUrl: string };

/** multicast の 1 リクエスト最大宛先数（LINE API 制限）。 */
export const MULTICAST_MAX_RECIPIENTS = 500;

/** LINE テキスト上限（5000 字）。超過は切り詰める（line.ts と同一方針）。 */
const TEXT_MAX = 5000;

/** 配信コンテンツ（形式別）。 */
export interface DeliveryContent {
  format: "text" | "image";
  body: string | null;
  imageUrl: string | null;
}

/** https:// の恒久 URL か（Notion 署名 URL / http は拒否）。 */
export function isPermanentHttpsUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string") return false;
  if (!url.startsWith("https://")) return false;
  // Notion の署名付き一時 URL（file.notion.so / secure.notion-static.com 等）は拒否。
  if (/notion(-static)?\.(so|com|site)/i.test(url)) return false;
  if (url.includes("X-Amz-Signature") || url.includes("prod-files-secure")) {
    return false;
  }
  return true;
}

/** 配信コンテンツの検証結果。 */
export type BuildMessagesResult =
  | { ok: true; messages: LineMessage[] }
  | { ok: false; reason: string };

/**
 * 配信コンテンツを LINE message 配列に変換する（fail-closed 検証込み）。
 * - text: 本文必須・空不可・5000 字で切り詰め
 * - image: 恒久 HTTPS URL 必須（Notion 署名 URL 不可）
 */
export function buildMessages(content: DeliveryContent): BuildMessagesResult {
  if (content.format === "text") {
    const body = (content.body ?? "").trim();
    if (body.length === 0) {
      return { ok: false, reason: "text 形式だが本文が空" };
    }
    const text = body.length > TEXT_MAX ? body.slice(0, TEXT_MAX - 3) + "..." : body;
    return { ok: true, messages: [{ type: "text", text }] };
  }

  if (content.format === "image") {
    const url = content.imageUrl ?? "";
    if (!isPermanentHttpsUrl(url)) {
      return {
        ok: false,
        reason: "image 形式だが画像URLが恒久HTTPSでない（Notion署名URL不可）",
      };
    }
    return {
      ok: true,
      messages: [{ type: "image", originalContentUrl: url, previewImageUrl: url }],
    };
  }

  return { ok: false, reason: `未知の形式: ${String(content.format)}` };
}

/** userIds を multicast バッチ（最大 500）に分割する（純粋）。 */
export function chunkForMulticast(
  userIds: string[],
  size: number = MULTICAST_MAX_RECIPIENTS,
): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < userIds.length; i += size) {
    batches.push(userIds.slice(i, i + size));
  }
  return batches;
}

// ---------------------------------------------------------------------------
// 送信ポート（実 I/O はこの実装にのみ存在。テストは stub を注入）
// ---------------------------------------------------------------------------

/** 1 送信の結果。deliveredRecipients は実際に送信した受信者数（台帳計上に使う）。 */
export interface SendOutcome {
  ok: boolean;
  /** 実送信人数（multicast は成功バッチの合計、broadcast は 1 リクエスト分の見積）。 */
  deliveredRecipients: number;
  /** バッチ単位の部分失敗があれば true。 */
  partial: boolean;
  /** エラー要約（PII 非記載）。 */
  error?: string;
}

/**
 * LINE 送信ポート。オーケストレータはこのインターフェース経由でのみ送る。
 * - 実 fetch 実装: `createLineSender`
 * - 送らない（dry-run）: `noopSender`
 * - テスト記録用: `createRecordingSender`
 */
export interface LineSender {
  multicast(
    batches: string[][],
    messages: LineMessage[],
  ): Promise<SendOutcome>;
  broadcast(
    messages: LineMessage[],
    estimatedRecipients: number,
  ): Promise<SendOutcome>;
}

/**
 * 実送信 sender（fetch で LINE API を叩く）。
 *
 * ⚠ 本タスクでは発火しない。オーケストレータは feature flag off で noopSender を使う。
 * この実装が呼ばれるのは Setaka 承認後・staging 検証済みの本番/テスト実送信時のみ。
 */
export function createLineSender(channel: DeliveryChannel): LineSender {
  const authHeader = { Authorization: `Bearer ${channel.accessToken}` };

  return {
    async multicast(batches, messages) {
      let delivered = 0;
      const errors: string[] = [];
      for (const batch of batches) {
        if (batch.length === 0) continue;
        try {
          const res = await fetch("https://api.line.me/v2/bot/message/multicast", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeader },
            body: JSON.stringify({ to: batch, messages }),
          });
          if (res.ok) {
            delivered += batch.length;
          } else {
            const t = await res.text().catch(() => "unknown");
            errors.push(`multicast ${res.status}: ${t.slice(0, 120)}`);
          }
        } catch (err) {
          errors.push(
            `multicast exception: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return {
        ok: errors.length === 0,
        deliveredRecipients: delivered,
        partial: errors.length > 0 && delivered > 0,
        error: errors.length > 0 ? errors.join("; ") : undefined,
      };
    },

    async broadcast(messages, estimatedRecipients) {
      try {
        const res = await fetch("https://api.line.me/v2/bot/message/broadcast", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify({ messages }),
        });
        if (res.ok) {
          return {
            ok: true,
            deliveredRecipients: estimatedRecipients,
            partial: false,
          };
        }
        const t = await res.text().catch(() => "unknown");
        return {
          ok: false,
          deliveredRecipients: 0,
          partial: false,
          error: `broadcast ${res.status}: ${t.slice(0, 120)}`,
        };
      } catch (err) {
        return {
          ok: false,
          deliveredRecipients: 0,
          partial: false,
          error: `broadcast exception: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}

/**
 * dry-run 用 sender。送信せず、成功したかのように見積り件数を返す。
 * feature flag off のときにオーケストレータへ注入する（実送信を発火させない）。
 */
export const noopSender: LineSender = {
  async multicast(batches) {
    const count = batches.reduce((s, b) => s + b.length, 0);
    console.log(`[delivery:dry-run] multicast skipped (${count} recipients)`);
    return { ok: true, deliveredRecipients: count, partial: false };
  },
  async broadcast(_messages, estimatedRecipients) {
    console.log(
      `[delivery:dry-run] broadcast skipped (~${estimatedRecipients} recipients)`,
    );
    return { ok: true, deliveredRecipients: estimatedRecipients, partial: false };
  },
};

/** テスト用の記録 sender。呼び出しを記録し、ネットワークに触れない。 */
export function createRecordingSender(
  outcome?: Partial<SendOutcome>,
): LineSender & { calls: Array<{ kind: "multicast" | "broadcast"; recipients: number }> } {
  const calls: Array<{ kind: "multicast" | "broadcast"; recipients: number }> = [];
  return {
    calls,
    async multicast(batches, _messages) {
      const count = batches.reduce((s, b) => s + b.length, 0);
      calls.push({ kind: "multicast", recipients: count });
      return {
        ok: outcome?.ok ?? true,
        deliveredRecipients: outcome?.deliveredRecipients ?? count,
        partial: outcome?.partial ?? false,
        error: outcome?.error,
      };
    },
    async broadcast(_messages, estimatedRecipients) {
      calls.push({ kind: "broadcast", recipients: estimatedRecipients });
      return {
        ok: outcome?.ok ?? true,
        deliveredRecipients: outcome?.deliveredRecipients ?? estimatedRecipients,
        partial: outcome?.partial ?? false,
        error: outcome?.error,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// pushImageMessage（T6）: 単一ユーザーへの画像 push（実 I/O・本タスクでは未使用）
// ---------------------------------------------------------------------------

/**
 * LINE Push API で画像メッセージを送信する（会話 push 用の拡張）。
 *
 * ⚠ 実送信。本タスクでは呼び出さない。将来の会話 push（image）で使う想定。
 * 画像は恒久 HTTPS のみ。
 */
export async function pushImageMessage(
  userId: string,
  imageUrl: string,
  channel: DeliveryChannel,
): Promise<void> {
  if (!isPermanentHttpsUrl(imageUrl)) {
    throw new Error("pushImageMessage: imageUrl must be a permanent https URL");
  }
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${channel.accessToken}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: [
        { type: "image", originalContentUrl: imageUrl, previewImageUrl: imageUrl },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "unknown");
    throw new Error(`pushImageMessage failed ${res.status}: ${t}`);
  }
}
