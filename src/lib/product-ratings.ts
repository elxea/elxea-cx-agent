/**
 * product_ratings — 商品評価の器と記録・カルテ変換（P0-3）。
 *
 * 設計: 統合設計書 §B-5b / §C-5 実装ノート I-9
 *   https://app.notion.com/p/39c70c9d064c8129b802e99161b628a0
 *
 * 役割:
 *   (1) お茶カードの「感想ひとこと」1タップ（おいしかった / 好みと少し違った）を product_ratings に記録。
 *   (2) rating=1 は該当商品の Tea Menu タグを既存 TAG_PERSONA_MAP（purchase-signals.ts）で
 *       persona シグナルに変換し、weight=2 でカルテ加算する（変換ロジックは本モジュールが提供）。
 *   (3) rating=-1 は減点しない（好みの学習は加点のみ・既存エンジンの思想と一致）。
 *       AI のおすすめ回避に使う場合は metadata としてのみ利用（本モジュールは加点しない事実だけ担保）。
 *
 * weight=2 の根拠（設計 §B-5b・オーナー承認済みの確定パラメータ）:
 *   明示的な意思表示（会話 +1 より強い）だが単発タップで誤操作余地がある（購入・診断 +3 より弱い）。
 *
 * 追記方針: 同一 user×product の再評価は上書きせず追記（時点分析のため。有効値は最新）。
 * fail-safe: 記録失敗は例外を投げず ok=false を返す（会話フローを止めない）。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { PersonaType } from "./firestore";
import { extractPersonaSignalsFromTags } from "./purchase-signals";
import { identifierForChannel, throughGateway } from "./cdp/events-gateway";

/** product_ratings テーブル名（migration 022）。 */
export const PRODUCT_RATINGS_TABLE = "product_ratings";

/**
 * 商品評価カルテ加算の重み（設計 §B-5b・オーナー承認済み確定値=2）。
 * 会話 +1 < 評価 +2 < 購入/診断 +3。
 */
export const PRODUCT_RATING_WEIGHT = 2;

/** 評価値（1=おいしかった / -1=好みと違った）。 */
export type RatingValue = 1 | -1;

/** 評価の発生源（DB CHECK と一致）。 */
export type RatingSource = "tea_card" | "post_delivery" | "broadcast" | "diagnosis";

/** 記録する 1 評価の入力。 */
export interface ProductRatingInput {
  userRef: string;
  channel?: "line" | "web";
  /** Tea Menu の5桁番号。 */
  productNo: string;
  rating: RatingValue;
  source: RatingSource;
}

const PRODUCT_NO_RE = /^\d{5}$/;

/** 入力が有効か（純粋・fail-closed 検証）。 */
export function isValidRatingInput(input: ProductRatingInput): boolean {
  return (
    typeof input.userRef === "string" &&
    input.userRef.length > 0 &&
    typeof input.productNo === "string" &&
    PRODUCT_NO_RE.test(input.productNo) &&
    (input.rating === 1 || input.rating === -1) &&
    ["tea_card", "post_delivery", "broadcast", "diagnosis"].includes(input.source)
  );
}

/** product_ratings の 1 行（DB カラム名）。 */
export interface ProductRatingRow {
  user_ref: string;
  channel: string;
  product_no: string;
  rating: number;
  source: string;
}

/** 入力を DB 行へ正規化する（純粋）。 */
export function buildProductRatingRow(input: ProductRatingInput): ProductRatingRow {
  return {
    user_ref: input.userRef,
    channel: input.channel ?? "line",
    product_no: input.productNo,
    rating: input.rating,
    source: input.source,
  };
}

/**
 * 評価をカルテ加算用の persona シグナルへ変換する（純粋・weight は呼び出し側で PRODUCT_RATING_WEIGHT）。
 *
 * - rating=1  → 商品タグ（Tea Menu 由来）を TAG_PERSONA_MAP で persona に変換して返す。
 * - rating=-1 → 空配列（減点しない・加点もしない）。
 *
 * タグは Tea Menu の商品タグ（呼び出し側が product_no から解決して渡す）。
 */
export function ratingPersonaSignals(
  rating: RatingValue,
  productTags: string[],
): PersonaType[] {
  if (rating !== 1) return [];
  return extractPersonaSignalsFromTags(productTags);
}

/** 読み取り時の 1 評価（最小列）。 */
export interface UserRatingRow {
  product_no: string;
  rating: number;
}

/**
 * 追記式評価から「銘柄ごとの最新評価」を導出する（純粋）。
 * 同一 product_no に複数行があるとき、配列後方（＝より新しい）を有効値とする。
 * 呼び出し側は created_at 昇順で渡す（getUserRatings がそう並べる）。
 */
export function latestRatingByProduct(rows: UserRatingRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    if (PRODUCT_NO_RE.test(r.product_no)) m.set(r.product_no, r.rating);
  }
  return m;
}

/** 評価済み（+1・-1 いずれも）の銘柄番号（A-2a の除外集合・純粋）。 */
export function allRatedProductNos(rows: UserRatingRow[]): string[] {
  return [...latestRatingByProduct(rows).keys()];
}

/** 最新評価が +1 の銘柄番号（A-1 の positive 事実注入・純粋）。 */
export function positiveRatedProductNos(rows: UserRatingRow[]): string[] {
  return [...latestRatingByProduct(rows).entries()]
    .filter(([, rating]) => rating === 1)
    .map(([no]) => no);
}

/**
 * ユーザーの評価履歴を取得する（fail-safe・created_at 昇順）。
 * A-2a（除外集合）と A-1（+1 事実）の両方が参照する。失敗時は空配列（フローを止めない）。
 */
export async function getUserRatings(
  supabase: SupabaseClient,
  userRef: string,
): Promise<UserRatingRow[]> {
  if (!userRef) return [];
  try {
    const { data, error } = await supabase
      .from(PRODUCT_RATINGS_TABLE)
      .select("product_no, rating")
      .eq("user_ref", userRef)
      .order("created_at", { ascending: true });
    if (error) {
      console.warn("[product-ratings] read failed (non-blocking):", error.message);
      return [];
    }
    return (data ?? []).map((r) => ({
      product_no: String((r as { product_no: unknown }).product_no),
      rating: Number((r as { rating: unknown }).rating),
    }));
  } catch (err) {
    console.warn(
      "[product-ratings] read unexpected error (non-blocking):",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/**
 * 評価を product_ratings に追記する（fail-safe・上書きしない）。
 * 無効入力は記録せず ok=false（送信は止めない）。
 */
export async function recordProductRating(
  supabase: SupabaseClient,
  input: ProductRatingInput,
): Promise<{ ok: boolean }> {
  if (!isValidRatingInput(input)) return { ok: false };

  // CDP 統合 Stage 1: 既存の直書きを透過で通しつつ、同じ出来事を L0 にも積む。
  //   gateway を外すときは throughGateway(...) を writeProductRatingRow(...) に戻す。
  const occurredAt = new Date().toISOString();
  const channel = input.channel ?? "line";
  return throughGateway(
    supabase,
    {
      eventType: "rating.submitted",
      channel,
      identifier: identifierForChannel(channel, input.userRef),
      // 同じ商品を後から付け直したら別の出来事なので、時刻まで含めて 1 回を決める。
      dedupe: `${input.productNo}@${occurredAt}`,
      source: "cx-agent.product-ratings",
      occurredAt,
      payload: { product_no: input.productNo, rating: input.rating, rating_source: input.source },
    },
    () => writeProductRatingRow(supabase, input),
    (result) => (result.ok ? { status: "ok" } : { status: "failed", reason: "insert_failed" }),
  );
}

/** product_ratings への直書き（Stage 1 以前の recordProductRating の中身そのまま）。 */
async function writeProductRatingRow(
  supabase: SupabaseClient,
  input: ProductRatingInput,
): Promise<{ ok: boolean }> {
  try {
    const { error } = await supabase
      .from(PRODUCT_RATINGS_TABLE)
      .insert(buildProductRatingRow(input));
    if (error) {
      console.warn("[product-ratings] insert failed (non-blocking):", error.message);
      return { ok: false };
    }
    return { ok: true };
  } catch (err) {
    console.warn(
      "[product-ratings] unexpected error (non-blocking):",
      err instanceof Error ? err.message : err,
    );
    return { ok: false };
  }
}
