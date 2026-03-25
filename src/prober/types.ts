/**
 * Knowledge Prober -- Shared type definitions
 */

/** AI persona types (CRM personalization design) */
export type Persona = "serenity" | "explorer" | "sensory";

/** Depth levels for persona questions */
export type DepthLevel = "entry" | "explore" | "deep";

/** Gap categories for knowledge gaps */
export type GapCategory =
  | "tea_knowledge"
  | "brewing"
  | "pairing"
  | "brand_story"
  | "product_detail"
  | "wellness"
  | "seasonal"
  | "gift"
  | "order_support";

/** Quality evaluation result from Claude */
export type EvaluationResult = {
  quality_score: number;
  grounding: "grounded" | "partially_grounded" | "ungrounded" | "escalated";
  gap_category: GapCategory | null;
  missing_info: string;
  evaluation_notes: string;
};

/** Probe history record (matches Supabase table) */
export type ProbeRecord = {
  id?: string;
  persona: Persona;
  depth_level: DepthLevel;
  question: string;
  response: string | null;
  quality_score: number | null;
  evaluation_notes: string | null;
  gap_category: string | null;
  article_generated: boolean;
  content_hub_page_id: string | null;
  created_at?: string;
};

/** 9 persona-depth patterns */
export const PERSONA_DEPTH_MATRIX: Array<{ persona: Persona; depth: DepthLevel }> = [
  { persona: "serenity", depth: "entry" },
  { persona: "serenity", depth: "explore" },
  { persona: "serenity", depth: "deep" },
  { persona: "explorer", depth: "entry" },
  { persona: "explorer", depth: "explore" },
  { persona: "explorer", depth: "deep" },
  { persona: "sensory", depth: "entry" },
  { persona: "sensory", depth: "explore" },
  { persona: "sensory", depth: "deep" },
];

/** Persona descriptions for question generation prompts */
export const PERSONA_DESCRIPTIONS: Record<Persona, Record<DepthLevel, string>> = {
  serenity: {
    entry: "お茶初心者。リラックス目的で、癒しや安らぎを求めている。「寝る前に飲めるお茶ありますか？」のような質問をする。",
    explore: "ほうじ茶・ハーブティーの違いを知りたい。産地に少し興味がある。お茶で心を整える方法に関心。",
    deep: "茶師のこだわりや、製法の違いによる癒し効果を深掘りしたい。お茶と瞑想・マインドフルネスの関係にも興味。",
  },
  explorer: {
    entry: "お茶に興味を持ち始めた。「日本茶の種類を教えて」のような基本的な質問をする。",
    explore: "品種・産地・製法の違いを比較したい。シングルオリジンに興味。お茶の歴史や文化的背景にも関心。",
    deep: "希少品種のテロワール、季節限定品、生産者の哲学。産地訪問や茶畑のストーリーに興味。",
  },
  sensory: {
    entry: "味わいが気になる。「甘いお茶はどれ？」のような味覚ベースの質問をする。",
    explore: "フレーバーノート・ペアリングを詳しく知りたい。食事やスイーツとの組み合わせに興味。",
    deep: "テイスティング技法、ブレンド提案、抽出条件（温度・時間・茶葉量）の微調整。プロのような楽しみ方。",
  },
};

/** Question category candidates */
export const QUESTION_CATEGORIES = [
  "商品について（種類・価格・在庫）",
  "お茶の知識（淹れ方・保存方法・効能）",
  "ペアリング・シーン提案",
  "ブランドストーリー・産地",
  "注文・配送・返品",
  "季節のおすすめ",
  "ギフト選び",
] as const;

/** Target layer mapping from persona */
export const PERSONA_TARGET_LAYER: Record<Persona, "wellbeing" | "tea_lover" | "gourmet"> = {
  serenity: "wellbeing",
  explorer: "tea_lover",
  sensory: "gourmet",
};

/** Article generation result from Claude Sonnet */
export type GeneratedArticle = {
  title: string;
  content: string;
  content_persona: Persona[];
  depth_level: DepthLevel;
  target_layer: Array<"tea_lover" | "wellbeing" | "gourmet">;
  channel: "LINE CRM";
};

/** Content Hub write result */
export type ContentHubWriteResult = {
  pageId: string;
  title: string;
  url: string;
};

/** Article generation context (passed from evaluation) */
export type ArticleContext = {
  question: string;
  missing_info: string;
  gap_category: GapCategory;
  persona: Persona;
  depth_level: DepthLevel;
  probeHistoryId?: string;
};

/** Max articles per day */
export const MAX_DAILY_ARTICLES = 3;

/** Gap categories that should NOT trigger article generation */
export const SKIP_GAP_CATEGORIES: GapCategory[] = ["order_support"];

/** Days to check for duplicate article generation per gap_category */
export const DUPLICATE_CHECK_DAYS = 7;

/** Seasonal keywords by month */
export function getSeasonalContext(): string {
  const month = new Date().getMonth() + 1;
  if (month >= 3 && month <= 5) return "春: 新茶、桜、春摘み、お花見";
  if (month >= 6 && month <= 8) return "夏: 水出し、アイスティー、冷茶、涼";
  if (month >= 9 && month <= 11) return "秋: ほうじ茶、紅葉、深蒸し、秋摘み";
  return "冬: 温かい、ギフト、年末年始、お歳暮";
}
