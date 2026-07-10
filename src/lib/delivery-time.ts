/**
 * 配信予定日時の厳格化（純粋・I/O なし）。
 *
 * 設計: 「Notion駆動 LINE配信 設計確定版 v1.0」§8 / Must-fix 8
 *   送信ゲート: 日時存在 & <=now（時刻必須・空/不正は fail-closed で送信不可）。
 *   JST→UTC 正規化・date-only・空・Invalid は送信不可に倒す。
 *
 * Notion API(2022-06-28) の date プロパティは {start, end} を返す。
 * start が時刻を含む datetime（ISO に "T" とオフセット）なら Date が UTC に正規化する。
 * date-only（"YYYY-MM-DD"）は時刻が無いため送信不可（fail-closed）。
 */

/** 送信可否判定の結果。 */
export type ScheduleDecision =
  | { sendable: true; due: boolean; sendAtUtc: string }
  | { sendable: false; reason: "missing" | "date_only" | "invalid" };

/** date-only（時刻なし）判定用。"2026-07-10" のような純日付。 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Notion date プロパティの start 文字列を厳格評価する。
 *
 * - null / 空 → missing（送信不可）
 * - date-only（時刻なし）→ date_only（送信不可・予定を組めないため）
 * - パース不能 → invalid（送信不可）
 * - datetime → sendable。due = (sendAtUtc <= now)。未来は due:false（エラーではない・まだ時刻前）。
 *
 * @param start Notion date の start（ISO 文字列）。datetime はオフセット付きで JST→UTC 自動正規化される。
 * @param now   判定基準時刻（UTC）。
 */
export function evaluateScheduledTime(
  start: string | null | undefined,
  now: Date,
): ScheduleDecision {
  if (typeof start !== "string" || start.trim().length === 0) {
    return { sendable: false, reason: "missing" };
  }
  const trimmed = start.trim();

  // date-only は時刻を持たない → 送信不可（設計 §8: 時刻必須）。
  if (DATE_ONLY_RE.test(trimmed)) {
    return { sendable: false, reason: "date_only" };
  }

  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    return { sendable: false, reason: "invalid" };
  }

  const sendAt = new Date(ms);
  return {
    sendable: true,
    due: sendAt.getTime() <= now.getTime(),
    sendAtUtc: sendAt.toISOString(),
  };
}
