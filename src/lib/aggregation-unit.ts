/**
 * 配信計測の集計単位（customAggregationUnit）生成 — P0-7a（後付け不可・次回配信までが締切）。
 *
 * 設計: 統合設計書 §B-5c / §C-5 実装ノート I-3
 *   https://app.notion.com/p/39c70c9d064c8129b802e99161b628a0
 *
 * 役割:
 *   LINE の multicast/push は送信時に customAggregationUnits を付与した場合にのみ、
 *   後から開封・クリックの unit 別統計を取得できる（付与しない限り永久に取れない）。
 *   本モジュールは「配信 1 本 = 1 unit」を決定的に命名する純粋関数のみを持つ。
 *   実際の統計 fetch（broadcast_stats への保存）は 7b = P1 のため本モジュールには含めない。
 *
 * ⚠ 命名規約の実装補正（設計書 §B-5c の例からの変更・要判断ではなく LINE 制約由来）:
 *   設計書の例は `s{YYYYMMDD}-{seg}`（ハイフン区切り）だが、LINE の customAggregationUnits は
 *   「半角英数字と _（アンダースコア）のみ・最大30文字」に制約される（ハイフン不可）。
 *   よって本実装では区切りをアンダースコアにし `s{YYYYMMDD}_{seg}` とする。
 *   参照: https://developers.line.biz/en/reference/messaging-api/#send-multicast-message
 *   （customAggregationUnits: 半角英数字と _ のみ / 1リクエスト1 unit / 月1,000 unit 上限）。
 */

import type { AudienceSpec } from "./delivery-audience";
import type { PersonaType } from "./firestore";

/** LINE customAggregationUnits の最大文字数（半角英数字・_ のみ）。 */
export const AGGREGATION_UNIT_MAX_LENGTH = 30;

/** ペルソナ enum → unit セグメント略号（3 文字で month 上限に十分収まる）。 */
const PERSONA_SEG: Record<PersonaType, string> = {
  serenity: "ser",
  explorer: "exp",
  sensory: "sen",
};

/**
 * AudienceSpec を unit のセグメント略号へ写す（純粋）。
 * - all       → "all"（案A で全員も multicast だが計測 unit は全体として "all"）
 * - persona   → ser / exp / sen
 * - allowlist → "int"（社内テスト配信。本番の効果計測対象ではないが unit は付ける）
 */
export function audienceSegmentCode(audience: AudienceSpec): string {
  if (audience.kind === "all") return "all";
  if (audience.kind === "allowlist") return "int";
  return PERSONA_SEG[audience.persona];
}

/**
 * 会計/計測基準の JST 日付を "YYYYMMDD" で返す（純粋）。
 * message-ledger.currentLineMonth と同じ JST 境界（UTC+9）で統一する。
 */
export function jstYyyymmdd(date: Date = new Date()): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(jst.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/**
 * 配信 1 本の集計単位名を決定的に生成する（純粋）。
 * 形式: `s{YYYYMMDD(JST)}_{seg}`（例: s20260807_all / s20260807_ser）。
 * 同一日・同一セグメントの配信は同一 unit に集約される（月2回×4種でも 8 unit/月 = 上限の1%未満）。
 */
export function buildAggregationUnit(
  audience: AudienceSpec,
  date: Date = new Date(),
): string {
  return `s${jstYyyymmdd(date)}_${audienceSegmentCode(audience)}`;
}

/**
 * LINE の制約（半角英数字・_ のみ・1〜30 文字）を満たすかを検証する（純粋・fail-closed 用）。
 * 送信ペイロードに載せる前にこれで弾けば、LINE 側の 400 を未然に防げる。
 */
export function isValidAggregationUnit(unit: string): boolean {
  return (
    typeof unit === "string" &&
    unit.length >= 1 &&
    unit.length <= AGGREGATION_UNIT_MAX_LENGTH &&
    /^[A-Za-z0-9_]+$/.test(unit)
  );
}
