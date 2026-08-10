/**
 * roji 月次処理 — 締め対象月（period）の導出だけを持つ純粋モジュール。
 *
 * 設計正本: roji出し分けの仕組み 設計書（S1シンプル版）
 *   https://www.notion.so/3b870c9d064c8191b807c59c1c2a6e74  第4-1節「1. 締める」
 * 締め時刻の確定（設計では「M2-06で確定待ち」だった箇所）:
 *   **2026-08-11 Setaka 回答 Q1 = 月末日 23:59 JST で締め、翌月 1 日に計算する。**
 *   よって period（＝台帳・締め記録に書く年月）は「実行時刻を JST に直したときの **前月**」。
 *   例: 2026-09-01 のいつ実行しても period = "2026-08"（8 月分の締め）。
 *
 * ここを別ファイルに切ったのは、月の境界の計算だけを時刻に依存しない形で単体テストするため
 * （実行本体 `monthly-run.ts` は `period` を受け取るだけで、時計を一度も読まない）。
 */

/** period の形（YYYY-MM）。台帳・締め記録の CHECK 制約と同一（migration 033）。 */
export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** JST の UTC からの時差（分）。日本は夏時間が無いため定数でよい。 */
export const JST_OFFSET_MINUTES = 9 * 60;

/** period の形式検査（純粋）。 */
export function isValidPeriod(period: string): boolean {
  return PERIOD_RE.test((period ?? "").trim());
}

/** 形式外の period を弾く（呼び出し側の打ち間違いを DB まで持ち込まない）。 */
export function assertValidPeriod(period: string): string {
  const p = (period ?? "").trim();
  if (!isValidPeriod(p)) {
    throw new Error(`roji monthly: period は "YYYY-MM" 形式で指定してください（受領: ${JSON.stringify(period)}）`);
  }
  return p;
}

/**
 * 実行時刻 → 締め対象月（純粋・決定的）。
 *
 * 「月末 23:59 JST 締め・翌月 1 日に計算」（Q1 回答）なので、**JST の暦で 1 か月戻した月**を返す。
 * 月末 23:59:59 JST までは当月が締まっていないため、当月を対象にすることは無い。
 *
 * @param now 実行時刻（UTC の瞬間）。テストは固定値を渡す。
 */
export function derivePeriod(now: Date): string {
  const jst = new Date(now.getTime() + JST_OFFSET_MINUTES * 60_000);
  // JST に平行移動した後は UTC ゲッタがそのまま JST の暦フィールドになる。
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth(); // 0-11。ここから 1 引くと「前月」。
  const prev = new Date(Date.UTC(year, month - 1, 1)); // 月 -1 は Date が年跨ぎを吸収する。
  const yyyy = String(prev.getUTCFullYear()).padStart(4, "0");
  const mm = String(prev.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}
