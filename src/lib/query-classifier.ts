/**
 * クエリカテゴリ判定（メタデータフィルタリング用）
 *
 * ユーザーの質問内容から検索対象の source_type を判定する。
 * Claude がクエリ内容に基づいて最適なフィルタを自動設定することで、
 * 検索精度と速度を向上させる。
 *
 * source_type の種類（knowledge_chunks テーブル定義に準拠）:
 *   - 'product'  : 商品情報（商品名・価格・説明・URL）
 *   - 'faq'      : よくある質問（配送・返品・支払いなど）
 *   - 'content'  : コンテンツ（ブログ・読み物・茶の知識）
 *   - 'brand'    : ブランドガイドライン・ポリシー
 *   - null       : フィルタなし（全 source_type を検索）
 */

export type SourceType = "product" | "faq" | "content" | "brand" | null;

// ---------------------------------------------------------------------------
// キーワードマップ（source_type → 判定キーワード）
// ---------------------------------------------------------------------------

/** 商品関連キーワード */
const PRODUCT_KEYWORDS = [
  // 商品名・カテゴリ
  "商品", "お茶", "茶", "ほうじ茶", "煎茶", "緑茶", "玉露", "抹茶",
  "烏龍茶", "ウーロン茶", "紅茶", "白茶", "プーアル茶", "玄米茶",
  "かぶせ茶", "スキンケア", "クリーム", "ローション", "美容",
  // 購入・商品関連行動
  "買いたい", "購入", "注文したい", "欲しい", "おすすめ", "ランキング",
  "人気", "ベストセラー", "新着", "セット", "ギフト", "プレゼント",
  // 価格
  "価格", "値段", "いくら", "円", "費用",
  // 商品特性
  "カフェイン", "産地", "農園", "生産者", "製法", "成分", "原材料",
];

/** FAQ・ポリシー関連キーワード */
const FAQ_KEYWORDS = [
  // 配送
  "送料", "配送", "発送", "届く", "何日", "日数", "ヤマト", "追跡",
  // 返品・交換
  "返品", "交換", "返金", "キャンセル", "クレーム", "不良品", "壊れ",
  // 支払い
  "支払い", "決済", "クレジット", "PayPay", "代引き", "振込",
  "Apple Pay", "Google Pay",
  // アカウント・会員
  "会員", "登録", "ログイン", "パスワード", "メールアドレス", "住所変更",
  // 問い合わせ
  "問い合わせ", "連絡", "電話", "メール", "営業時間", "対応時間",
];

/** コンテンツ（知識・読み物）関連キーワード */
const CONTENT_KEYWORDS = [
  // 茶の知識
  "淹れ方", "飲み方", "作り方", "温度", "茶葉", "量", "蒸らし",
  // 効能・健康
  "効能", "健康", "栄養", "ポリフェノール", "テアニン", "カテキン",
  "リラックス", "睡眠", "疲労",
  // 季節・シーン
  "旬", "新茶", "夏", "冬", "朝", "夜", "食後", "ペアリング",
  // ブランドストーリー
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
    product: 0,
    faq: 0,
    content: 0,
  };

  // 各カテゴリのスコアを計算
  for (const kw of PRODUCT_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) {
      scores.product++;
    }
  }
  for (const kw of FAQ_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) {
      scores.faq++;
    }
  }
  for (const kw of CONTENT_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) {
      scores.content++;
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
    product: 0,
    faq: 0,
    content: 0,
  };

  for (const kw of PRODUCT_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) scores.product++;
  }
  for (const kw of FAQ_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) scores.faq++;
  }
  for (const kw of CONTENT_KEYWORDS) {
    if (normalized.includes(kw.toLowerCase())) scores.content++;
  }

  return { result: classifyQuery(queryText), scores };
}
