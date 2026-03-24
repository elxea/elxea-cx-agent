/**
 * クエリカテゴリ判定（メタデータフィルタリング用）
 *
 * ユーザーの質問内容から検索対象の source_type を判定する。
 * Claude がクエリ内容に基づいて最適なフィルタを自動設定することで、
 * 検索精度と速度を向上させる。
 *
 * source_type の種類（knowledge_chunks テーブルの実データに準拠）:
 *   - 'tea'       : 個別のお茶メニュー（品種・産地・フレーバー）
 *   - 'set_menu'  : セットメニュー（茜シリーズ等）
 *   - 'article'   : Roji 記事（淹れ方・知識・ストーリー）
 *   - 'crm'       : LINE CRM コンテンツ
 *   - null         : フィルタなし（全 source_type を検索）
 *
 * NOTE: 以前は product/faq/content/brand を返していたが、
 *       DB に存在しない source_type だったため検索結果が常に 0 件になっていた。
 *       2026-03-24 修正: DB の実際の値に合わせてマッピングを変更。
 */

export type SourceType = "tea" | "set_menu" | "article" | "crm" | null;

// ---------------------------------------------------------------------------
// キーワードマップ（source_type → 判定キーワード）
// ---------------------------------------------------------------------------

/** お茶メニュー関連キーワード → source_type: "tea" */
const TEA_KEYWORDS = [
  // 茶種
  "ほうじ茶", "煎茶", "緑茶", "玉露", "抹茶",
  "烏龍茶", "ウーロン茶", "紅茶", "白茶", "プーアル茶", "玄米茶",
  "かぶせ茶",
  // 茶の特性
  "品種", "フレーバー", "テイスティング", "味わい", "香り",
  "カフェイン", "産地", "農園", "製法",
  // 抽出
  "温度", "蒸らし",
];

/** セットメニュー関連キーワード → source_type: "set_menu" */
const SET_MENU_KEYWORDS = [
  // セット・ギフト
  "セット", "ギフト", "プレゼント", "アソート", "詰め合わせ",
  // シリーズ名
  "茜", "あかね",
  // 購入行動
  "買いたい", "購入", "注文", "欲しい", "おすすめ", "人気",
  // 価格
  "価格", "値段", "いくら", "円",
  // 商品特性
  "内容量", "原材料", "賞味期限",
];

/** 記事（Roji）関連キーワード → source_type: "article" */
const ARTICLE_KEYWORDS = [
  // 茶の知識・読み物
  "淹れ方", "飲み方", "作り方", "茶葉", "量",
  // 季節・シーン
  "旬", "新茶", "夏", "冬", "朝", "夜", "食後", "ペアリング",
  "アイスティー", "水出し",
  // 効能・健康
  "効能", "健康", "栄養", "ポリフェノール", "テアニン", "カテキン",
  "リラックス", "睡眠",
  // ブランド・ストーリー
  "歴史", "こだわり", "ストーリー", "想い", "鹿児島",
];

// ---------------------------------------------------------------------------
// 判定ロジック
// ---------------------------------------------------------------------------

/**
 * クエリテキストから最適な source_type フィルタを判定する。
 *
 * 判定方式:
 *   1. 各 source_type のキーワードに対してマッチ数をカウント
 *   2. 最もスコアが高い source_type を選択
 *   3. スコアが同点または0点の場合は null（フィルタなし）を返す
 *
 * @param queryText ユーザーのクエリテキスト
 * @returns 判定された source_type（フィルタなしの場合は null）
 */
export function classifyQuery(queryText: string): SourceType {
  const normalized = queryText.toLowerCase();

  const scores: Record<string, number> = {
    tea: 0,
    set_menu: 0,
    article: 0,
  };

  // 各カテゴリのスコアを計算
  for (const kw of TEA_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) {
      scores.tea++;
    }
  }
  for (const kw of SET_MENU_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) {
      scores.set_menu++;
    }
  }
  for (const kw of ARTICLE_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) {
      scores.article++;
    }
  }

  // 最高スコアを取得
  const maxScore = Math.max(...Object.values(scores));

  // スコアが 0（どのカテゴリにも該当しない）または同点の場合はフィルタなし
  if (maxScore === 0) {
    return null;
  }

  // 最高スコアのカテゴリが複数ある場合はフィルタなし（絞り込みすぎを防止）
  const topCategories = Object.entries(scores).filter(([, s]) => s === maxScore);
  if (topCategories.length > 1) {
    return null;
  }

  const [topCategory] = topCategories[0];
  return topCategory as SourceType;
}

/**
 * デバッグ用: クエリの分類スコアを返す。
 */
export function debugClassifyQuery(queryText: string): {
  result: SourceType;
  scores: Record<string, number>;
} {
  const normalized = queryText.toLowerCase();

  const scores: Record<string, number> = {
    tea: 0,
    set_menu: 0,
    article: 0,
  };

  for (const kw of TEA_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) scores.tea++;
  }
  for (const kw of SET_MENU_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) scores.set_menu++;
  }
  for (const kw of ARTICLE_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) scores.article++;
  }

  return { result: classifyQuery(queryText), scores };
}
