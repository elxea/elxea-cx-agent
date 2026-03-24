/**
 * 購入データからペルソナシグナルを抽出するモジュール。
 *
 * Shopify 商品タグ → ペルソナシグナルのマッピングを定義し、
 * 購入商品からペルソナスコアへの加算値を計算する。
 *
 * 会話由来のシグナル（+1）より強い重み（+3）を適用する。
 * 購入は実際の行動であり、会話での言及より強いシグナルとみなす。
 */

import type { PersonaType } from "./firestore";
import type { PreferenceSignals } from "./preference-extractor";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/**
 * 購入シグナルの重み。会話由来のシグナル（+1）の3倍。
 * 購入 = 実行動であり、会話での言及より確実な嗜好指標。
 */
export const PURCHASE_SIGNAL_WEIGHT = 3;

// ---------------------------------------------------------------------------
// 商品タグ → ペルソナシグナルマッピング
// ---------------------------------------------------------------------------

/** 商品タグとペルソナシグナルの対応表 */
type TagPersonaMapping = {
  /** マッチするタグパターン（小文字で比較） */
  tag: string;
  /** 対応するペルソナタイプ */
  persona: PersonaType;
};

/**
 * Shopify 商品タグ → ペルソナシグナルマッピング。
 *
 * elxea の商品体系に基づく:
 * - serenity: 癒し・リラックス系（ほうじ茶、ハーブティー、カフェインレス等）
 * - explorer: 探求・発見系（シングルオリジン、希少品種、産地特化等）
 * - sensory: 味わい・体験重視系（フレーバーティー、ペアリング、テイスティング等）
 */
const TAG_PERSONA_MAP: TagPersonaMapping[] = [
  // --- serenity（癒し・穏やかさ） ---
  { tag: "hojicha", persona: "serenity" },
  { tag: "ほうじ茶", persona: "serenity" },
  { tag: "herbal", persona: "serenity" },
  { tag: "ハーブ", persona: "serenity" },
  { tag: "caffeine-free", persona: "serenity" },
  { tag: "カフェインレス", persona: "serenity" },
  { tag: "relaxation", persona: "serenity" },
  { tag: "リラックス", persona: "serenity" },
  { tag: "chamomile", persona: "serenity" },
  { tag: "rooibos", persona: "serenity" },
  { tag: "genmaicha", persona: "serenity" },
  { tag: "玄米茶", persona: "serenity" },
  { tag: "bedtime", persona: "serenity" },

  // --- explorer（探求・発見） ---
  { tag: "single-origin", persona: "explorer" },
  { tag: "シングルオリジン", persona: "explorer" },
  { tag: "rare", persona: "explorer" },
  { tag: "希少", persona: "explorer" },
  { tag: "limited", persona: "explorer" },
  { tag: "限定", persona: "explorer" },
  { tag: "seasonal", persona: "explorer" },
  { tag: "季節限定", persona: "explorer" },
  { tag: "gyokuro", persona: "explorer" },
  { tag: "玉露", persona: "explorer" },
  { tag: "matcha", persona: "explorer" },
  { tag: "抹茶", persona: "explorer" },
  { tag: "oolong", persona: "explorer" },
  { tag: "烏龍茶", persona: "explorer" },
  { tag: "puerh", persona: "explorer" },
  { tag: "プーアル", persona: "explorer" },
  { tag: "white-tea", persona: "explorer" },
  { tag: "白茶", persona: "explorer" },
  { tag: "terroir", persona: "explorer" },

  // --- sensory（味わい・体験重視） ---
  { tag: "flavored", persona: "sensory" },
  { tag: "フレーバー", persona: "sensory" },
  { tag: "pairing", persona: "sensory" },
  { tag: "ペアリング", persona: "sensory" },
  { tag: "tasting", persona: "sensory" },
  { tag: "テイスティング", persona: "sensory" },
  { tag: "blend", persona: "sensory" },
  { tag: "ブレンド", persona: "sensory" },
  { tag: "aroma", persona: "sensory" },
  { tag: "香り", persona: "sensory" },
  { tag: "fruity", persona: "sensory" },
  { tag: "フルーティー", persona: "sensory" },
  { tag: "floral", persona: "sensory" },
  { tag: "フローラル", persona: "sensory" },
  { tag: "smoky", persona: "sensory" },
  { tag: "スモーキー", persona: "sensory" },
];

// ---------------------------------------------------------------------------
// 茶種カテゴリマッピング（購入商品タグ → preferredCategories）
// ---------------------------------------------------------------------------

/** 商品タグから抽出するカテゴリ名のマッピング */
const TAG_CATEGORY_MAP: Record<string, string> = {
  hojicha: "hojicha",
  ほうじ茶: "hojicha",
  herbal: "herbal",
  ハーブ: "herbal",
  green: "green",
  緑茶: "green",
  sencha: "sencha",
  煎茶: "sencha",
  gyokuro: "gyokuro",
  玉露: "gyokuro",
  matcha: "matcha",
  抹茶: "matcha",
  oolong: "oolong",
  烏龍茶: "oolong",
  black: "black",
  紅茶: "black",
  puerh: "puerh",
  プーアル: "puerh",
  genmaicha: "genmaicha",
  玄米茶: "genmaicha",
  "white-tea": "white_tea",
  白茶: "white_tea",
  rooibos: "rooibos",
  chamomile: "chamomile",
};

// ---------------------------------------------------------------------------
// フレーバーマッピング（購入商品タグ → flavorPreferences）
// ---------------------------------------------------------------------------

/** 商品タグから抽出するフレーバーのマッピング */
const TAG_FLAVOR_MAP: Record<string, string> = {
  floral: "floral",
  フローラル: "floral",
  fruity: "fruity",
  フルーティー: "fruity",
  smoky: "smoky",
  スモーキー: "smoky",
  mellow: "mellow",
  まろやか: "mellow",
  refreshing: "refreshing",
  すっきり: "refreshing",
  rich: "rich",
  コク: "rich",
  sweet: "sweet",
  甘い: "sweet",
  aroma: "aromatic",
  香り: "aromatic",
};

// ---------------------------------------------------------------------------
// エクスポート関数
// ---------------------------------------------------------------------------

/**
 * Shopify 商品タグからペルソナシグナルを抽出する。
 *
 * @param productTags 商品に付与されたタグのリスト
 * @returns ペルソナシグナルの配列（重複排除済み）
 */
export function extractPersonaSignalsFromTags(
  productTags: string[],
): PersonaType[] {
  const signals = new Set<PersonaType>();
  const lowerTags = productTags.map((t) => t.toLowerCase().trim());

  for (const mapping of TAG_PERSONA_MAP) {
    if (lowerTags.includes(mapping.tag.toLowerCase())) {
      signals.add(mapping.persona);
    }
  }

  return Array.from(signals);
}

/**
 * Shopify 商品タグからカテゴリを抽出する。
 *
 * @param productTags 商品に付与されたタグのリスト
 * @returns カテゴリ名の配列（重複排除済み）
 */
export function extractCategoriesFromTags(productTags: string[]): string[] {
  const categories = new Set<string>();
  const lowerTags = productTags.map((t) => t.toLowerCase().trim());

  for (const tag of lowerTags) {
    const category = TAG_CATEGORY_MAP[tag];
    if (category) {
      categories.add(category);
    }
  }

  return Array.from(categories);
}

/**
 * Shopify 商品タグからフレーバーを抽出する。
 *
 * @param productTags 商品に付与されたタグのリスト
 * @returns フレーバー名の配列（重複排除済み）
 */
export function extractFlavorsFromTags(productTags: string[]): string[] {
  const flavors = new Set<string>();
  const lowerTags = productTags.map((t) => t.toLowerCase().trim());

  for (const tag of lowerTags) {
    const flavor = TAG_FLAVOR_MAP[tag];
    if (flavor) {
      flavors.add(flavor);
    }
  }

  return Array.from(flavors);
}

/**
 * 購入商品のタグリストから PreferenceSignals 構造を生成する。
 * 複数商品の場合はすべてのタグを統合する。
 *
 * @param allProductTags 各商品のタグ配列の配列
 * @returns 統合された PreferenceSignals。シグナルがなければ null
 */
export function buildPurchaseSignals(
  allProductTags: string[][],
): PreferenceSignals | null {
  // 全商品のタグをフラット化
  const allTags = allProductTags.flat();

  if (allTags.length === 0) {
    return null;
  }

  const personaSignals = extractPersonaSignalsFromTags(allTags);
  const categories = extractCategoriesFromTags(allTags);
  const flavors = extractFlavorsFromTags(allTags);

  // すべて空なら null
  if (
    personaSignals.length === 0 &&
    categories.length === 0 &&
    flavors.length === 0
  ) {
    return null;
  }

  return {
    preferred_categories: categories,
    flavor_preferences: flavors,
    scene_preferences: [],
    persona_signals: personaSignals,
    explicit_statements: [],
  };
}
