/**
 * 定期便（サブスク）判定モジュール（純粋・I/O なし）。
 *
 * 目的（T2 土台）:
 *   注文 webhook の入力から「この注文は定期便か」を判定し、cx-agent 側の顧客属性
 *   （CustomerProfile.isSubscriber）に持てるようにする。実際の出し分け描画は web-app 側
 *   の別タスク。ここは「フラグを持てる/渡せる」入力判定までを担う。
 *
 * 判定の入力ソース（いずれかが真なら定期便とみなす）:
 *   1. 注文タグ（order.tags）に定期便を示す語が含まれる（運用側のタグ付け）。
 *   2. line_items のいずれかに Shopify ネイティブ定期便の selling plan 割当がある
 *      （selling_plan_allocation / selling_plan_id）。
 *
 * web-app の admin-queries 相当（会員のサブスク状態）は web-app が正本として持つため、
 * ここでは「注文由来の観測」だけを扱う（越境しない）。cx-agent はこの観測を属性化する。
 */

/** 注文タグに含まれ得る「定期便」を示す語（小文字比較・部分一致）。 */
export const SUBSCRIPTION_TAG_TOKENS = [
  "subscription",
  "subscribe",
  "recurring",
  "定期便",
  "定期",
] as const;

/** 定期便判定に必要な注文の最小形（webhook payload の部分型）。 */
export type SubscriptionOrderInput = {
  /** 注文タグ。Shopify REST では comma 区切り文字列、配列で来る実装もあるため両対応。 */
  tags?: string | string[] | null;
  line_items?: Array<{
    /** ネイティブ定期便の selling plan 割当（存在すれば定期便ライン）。 */
    selling_plan_allocation?: unknown;
    /** selling plan の ID（存在すれば定期便ライン）。 */
    selling_plan_id?: string | number | null;
  }> | null;
};

/** order.tags を小文字トークン配列に正規化する。 */
function normalizeTags(tags: string | string[] | null | undefined): string[] {
  if (!tags) return [];
  const arr = Array.isArray(tags) ? tags : tags.split(",");
  return arr.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
}

/**
 * 注文から定期便かどうかを判定する（純粋）。
 *
 * @param order 注文（webhook payload の部分型）
 * @returns 定期便と判定できれば true
 */
export function detectSubscriptionFromOrder(
  order: SubscriptionOrderInput | null | undefined,
): boolean {
  if (!order) return false;

  // 1. タグ判定（部分一致 — "monthly-subscription" 等も拾う）
  const tags = normalizeTags(order.tags);
  const tagHit = tags.some((tag) =>
    SUBSCRIPTION_TAG_TOKENS.some((token) => tag.includes(token)),
  );
  if (tagHit) return true;

  // 2. selling plan 判定（ネイティブ定期便のライン有無）
  const items = order.line_items ?? [];
  const planHit = items.some((item) => {
    if (item.selling_plan_allocation != null) return true;
    if (item.selling_plan_id != null && item.selling_plan_id !== "") return true;
    return false;
  });

  return planHit;
}
