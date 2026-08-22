/**
 * 売り込み面（sales surface）の機能ゲート — roji「物販の匂いを出さない」への適合。
 *
 * 背景（正本）:
 *   elxea CX Agent 機能定義 v1.5 の 3-2 / 3-5 と Phase 0 タスク4。
 *   roji 正本の「やらないこと」に「物販の匂いを出さない / 買う導線を置かない」があり、
 *   現行実装の (1) 購入ボタンを作る道具 (2) 商品カードを出す道具 (3) 定期便案内の常設枠
 *   が正面から衝突する。**表に出す前に外すことが確定**（判断1・2026-08-11 Setaka）。
 *
 * 方式（削除ではなくフラグ無効化）:
 *   実体（Shopify カート生成・Flex 商品カード・定期便案内の文面）は**消さずに残し**、
 *   顧客に見える面への露出だけを本フラグで止める。EC サイト側へ購入導線を寄せたあと、
 *   「EC への送客リンク」等として転用できる余地を残すため（機能定義 第9節 実装時の確認事項）。
 *
 * 既定は **無効（外れている）**。`SALES_SURFACE_ENABLED === "true"` のときだけ有効になる。
 *   → 未設定・空・"false"・"1" などはすべて無効（fail-closed）。本番/検証で明示的に
 *     "true" を置かない限り、購入導線は AI にも顧客にも露出しない。
 *   → 既存の ROJI_SURVEY_ENABLED と同じ「明示 opt-in」規約に揃えた。
 *
 * 購入導線の受け皿（機能定義 第9節「実装時の確認事項」への回答）:
 *   購入・在庫・カートの話は **EC サイト（https://elxea.com/ja）側に寄せられる**。
 *   Shopify が商品ページ・カート・チェックアウトをすべて持っており、CX Agent 側は
 *   URL を案内するだけで導線が閉じる。CX Agent 内で保持が必要なのは注文照会
 *   （lookup_my_orders / get_order_detail）だけで、これは購入後のサポートであり売り込みではない。
 */

/** EC サイト（購入導線の受け皿）。CX Agent は買う場所を持たず、ここに寄せる。 */
export const EC_SITE_URL = "https://elxea.com/ja";

/** 売り込み面に属するツール名（フラグ無効時は AI に露出させず、実行も拒否する）。 */
export const SALES_TOOL_NAMES = ["recommend_product", "create_cart_link"] as const;

export type SalesToolName = (typeof SALES_TOOL_NAMES)[number];

/** env の最小形（Env 全体に依存させないことでテスト・純粋関数化を容易にする）。 */
export interface SalesSurfaceEnv {
  SALES_SURFACE_ENABLED?: string;
}

/**
 * 売り込み面が有効か（既定 false）。
 * 本フラグの参照点はここ 1 箇所に集約する（`=== "true"` を各所に散らさない）。
 */
export function isSalesSurfaceEnabled(env: SalesSurfaceEnv | undefined | null): boolean {
  return env?.SALES_SURFACE_ENABLED === "true";
}

/** 与えられたツール名が売り込み面に属するか。 */
export function isSalesTool(name: string): name is SalesToolName {
  return (SALES_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * 売り込みツールがフラグ無効下で呼ばれたときに LLM へ返す文字列（fail-closed の受け皿）。
 * 「道具は無い」ことだけを伝え、AI が存在しない購入導線を約束しないようにする。
 */
export const SALES_TOOL_DISABLED_RESULT =
  "この道具は現在使用できません。商品カード・カートリンクは提示せず、" +
  `購入や在庫のご相談は elxea のサイト（${EC_SITE_URL}）でご覧いただける旨を、控えめに一度だけ案内してください。`;
