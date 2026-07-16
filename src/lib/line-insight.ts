/**
 * LINE Insight API — unit 別イベント統計の取得（P0-7b の取得側・読み取り専用）。
 *
 * 設計: 統合設計書 §B-5c / §C-5 実装ノート I-3
 *   https://app.notion.com/p/39c70c9d064c8129b802e99161b628a0
 *
 * 役割:
 *   送信時に customAggregationUnits を付けた配信（multicast/push）について、
 *   「Get statistics per unit」= GET /v2/bot/insight/message/event/aggregation で
 *   開封（uniqueImpression）・クリック（uniqueClick）のユニーク数を後から引く。
 *   本モジュールは GET のみ（読み取り専用）。送信系 API（push/multicast/broadcast）は一切呼ばない。
 *
 * ⚠ LINE 仕様（後付け不可・null 挙動）:
 *   (1) 照会は「当月＋前月」のみ。それ以前の期間は取得できない（= 送信時に unit を仕込む以外に道はない）。
 *   (2) ユニーク 20 人未満のイベントは uniqueImpression / uniqueClick が **null** で返る（プライバシー保護）。
 *       現状 友だち約48人・multicast の宛先は更に少数のため、当面 null が返るのが「正常挙動」。
 *   参照: https://developers.line.biz/en/docs/messaging-api/unit-based-statistics-aggregation/
 *         https://developers.line.biz/en/reference/messaging-api/#get-statistics-per-unit
 *
 * fail 方針: これは計測ジョブなので送信ガードのような fail-closed ではなく **fail-soft**。
 *   取得不能（非2xx / 例外 / 不正 body）は ok:false・値 null に倒し、ジョブ全体は止めない
 *   （delivered / unfollow は自前データで算出できるため、insight 欠落でも行は記録する）。
 */

import { jstYyyymmdd } from "./aggregation-unit";

/** unit 別イベント統計の取得エンドポイント（GET のみ・読み取り専用）。 */
export const LINE_INSIGHT_EVENT_AGGREGATION_URL =
  "https://api.line.me/v2/bot/insight/message/event/aggregation";

/** unit 1 本のイベント統計（overview 由来の必要最小）。 */
export interface UnitEventStats {
  /** 取得成功（HTTP 200 かつ body パース可）なら true。false は取得不能（fail-soft）。 */
  ok: boolean;
  /** 開封ユニーク数。<20 は null（LINE 仕様）。未取得も null。 */
  uniqueImpression: number | null;
  /** クリックユニーク数。<20 は null（LINE 仕様）。未取得も null。 */
  uniqueClick: number | null;
}

/** unit 統計の取得関数（DI 可能にしてユニットテストを純粋に保つ）。 */
export type UnitStatsFetcher = (
  unit: string,
  from: string,
  to: string,
) => Promise<UnitEventStats>;

/** 取得不能時の既定値（ok:false・全 null）。 */
const EMPTY_STATS: UnitEventStats = {
  ok: false,
  uniqueImpression: null,
  uniqueClick: null,
};

/**
 * number|null 正規化（純粋）。number 以外（LINE の null / 欠落 / NaN / Infinity）は null にする。
 * これにより「<20 人で null」も「フィールド欠落」も一様に null として扱える。
 */
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * LINE Insight レスポンス（raw JSON）を UnitEventStats にパースする（純粋）。
 *
 * - raw が object でない → 取得失敗扱い（ok:false・null）。
 * - overview が無い（対象期間にイベント無し等） → 取得は成功（ok:true）だが値は null。
 * - overview.uniqueImpression / uniqueClick を numOrNull で正規化（<20 の null をそのまま透過）。
 */
export function parseUnitEventStats(raw: unknown): UnitEventStats {
  if (!raw || typeof raw !== "object") return { ...EMPTY_STATS };
  const overview = (raw as { overview?: unknown }).overview;
  if (!overview || typeof overview !== "object") {
    return { ok: true, uniqueImpression: null, uniqueClick: null };
  }
  const o = overview as { uniqueImpression?: unknown; uniqueClick?: unknown };
  return {
    ok: true,
    uniqueImpression: numOrNull(o.uniqueImpression),
    uniqueClick: numOrNull(o.uniqueClick),
  };
}

/**
 * Insight 照会の from / to を YYYYMMDD(JST) で返す（純粋）。
 * from = 配信日、to = 現在日。LINE は from<=to・当月＋前月のみを要求する
 * （範囲の当月＋前月チェックは呼び出し側の isInsightFetchable で行う）。
 * JST 境界は aggregation-unit.jstYyyymmdd に合わせる（unit 命名と同一基準）。
 */
export function insightDateRange(
  deliveredAt: Date,
  now: Date,
): { from: string; to: string } {
  return { from: jstYyyymmdd(deliveredAt), to: jstYyyymmdd(now) };
}

/**
 * 実 LINE Insight API を叩く UnitStatsFetcher（GET のみ・読み取り専用・fail-soft）。
 * accessToken は「配信を送った OA のトークン」を渡すこと（unit は OA 単位で紐づくため）。
 * 非 2xx・不正 body・ネットワーク例外はすべて ok:false（値 null）に倒す（ジョブは止めない）。
 */
export function createLineUnitStatsFetcher(accessToken: string): UnitStatsFetcher {
  return async (unit, from, to): Promise<UnitEventStats> => {
    try {
      const url =
        `${LINE_INSIGHT_EVENT_AGGREGATION_URL}` +
        `?customAggregationUnit=${encodeURIComponent(unit)}` +
        `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return { ...EMPTY_STATS };
      const data = await res.json();
      return parseUnitEventStats(data);
    } catch {
      return { ...EMPTY_STATS };
    }
  };
}
