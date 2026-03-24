/**
 * 会話内容から嗜好シグナルを抽出し、TasteProfile / PersonaProfile を更新する。
 *
 * コスト管理:
 * - 嗜好キーワード検出: 正規表現で事前フィルタ（API 呼び出し不要）
 * - Claude Haiku（最安モデル）で抽出（input ~500 tokens, output ~200 tokens = ~$0.001/回）
 * - 1日あたりの推定コスト: 20人 x 5会話 x 30% trigger rate = 30回 x $0.001 = $0.03/日
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../index";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** 嗜好シグナルの構造化データ */
export type PreferenceSignals = {
  /** 好みの茶種（green, oolong, black, herbal, hojicha, matcha 等） */
  preferred_categories: string[];
  /** 好みの味わい（sweet, bitter, floral, smoky, mellow, refreshing 等） */
  flavor_preferences: string[];
  /** 飲むシーン（morning, relaxation, focus, gift, after_meal 等） */
  scene_preferences: string[];
  /** ペルソナ傾向シグナル（serenity, explorer, sensory） */
  persona_signals: Array<"serenity" | "explorer" | "sensory">;
  /** ユーザーが明示的に述べた好み（原文） */
  explicit_statements: string[];
};

// ---------------------------------------------------------------------------
// 嗜好キーワード事前フィルタ
// ---------------------------------------------------------------------------

/**
 * 嗜好に関するキーワードパターン。
 * ユーザーの発言にこれらが含まれる場合のみ Claude Haiku で分析する。
 */
const PREFERENCE_KEYWORDS: RegExp = new RegExp(
  [
    // 好み表現
    "好き", "嫌い", "苦手", "お気に入り", "気になる",
    "おすすめ", "オススメ", "教えて",
    // 味覚表現
    "甘い", "甘み", "苦い", "苦み", "渋い", "渋み",
    "まろやか", "すっきり", "さっぱり", "コク", "深み",
    "香ばしい", "香り", "フローラル", "フルーティ", "スモーキー",
    "濃い", "軽い", "飲みやすい",
    // 茶種（直接言及）
    "ほうじ茶", "緑茶", "煎茶", "玉露", "抹茶",
    "烏龍茶", "ウーロン茶", "紅茶", "白茶", "プーアル",
    "玄米茶", "かぶせ茶",
    // シーン
    "朝", "夜", "寝る前", "リラックス", "くつろぎ",
    "仕事中", "集中", "食後", "食事に合う",
    "ギフト", "プレゼント", "贈り物",
    // ペアリング
    "ペアリング", "合わせる", "合う",
  ].join("|"),
  "i",
);

/**
 * ユーザーの発言に嗜好キーワードが含まれるかチェックする。
 * 含まれない場合は Claude Haiku を呼ばず、コストを抑える。
 */
export function containsPreferenceKeywords(
  conversationHistory: Array<{ role: string; content: string }>,
): boolean {
  // ユーザーの発言のみチェック
  const userMessages = conversationHistory.filter((m) => m.role === "user");
  return userMessages.some((m) => PREFERENCE_KEYWORDS.test(m.content));
}

// ---------------------------------------------------------------------------
// 嗜好抽出メイン関数
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `以下の会話から、ユーザーのお茶に関する嗜好シグナルを抽出してください。
嗜好に関する情報がなければ、空の結果を返してください。

以下の JSON 形式で返してください。JSON のみを返し、それ以外のテキストは不要です。

{
  "preferred_categories": ["好みの茶種: green, oolong, black, herbal, hojicha, matcha, sencha, gyokuro, genmaicha 等"],
  "flavor_preferences": ["好みの味わい: sweet, bitter, floral, smoky, mellow, refreshing, rich, light 等"],
  "scene_preferences": ["飲むシーン: morning, relaxation, focus, gift, after_meal, nighttime, work 等"],
  "persona_signals": ["ペルソナ傾向: serenity(穏やかさを求める), explorer(茶の世界を探求), sensory(味わい重視)"],
  "explicit_statements": ["ユーザーが明示的に述べた好み(原文をそのまま)"]
}

注意:
- 配列が空の場合は [] とする
- 推測せず、会話に明示されている嗜好のみ抽出する
- persona_signals は複数あってもよい
- explicit_statements にはユーザーの原文を短く引用する`;

/**
 * 会話内容から嗜好シグナルを抽出する。
 * Claude Haiku で分析し、構造化された嗜好データを返す。
 *
 * @param conversationHistory 会話履歴
 * @param env Cloudflare Workers 環境変数
 * @returns 抽出された嗜好シグナル。嗜好が検出されなければ null
 */
export async function extractPreferences(
  conversationHistory: Array<{ role: string; content: string }>,
  env: Env,
): Promise<PreferenceSignals | null> {
  // 事前フィルタ: 嗜好キーワードがなければスキップ
  if (!containsPreferenceKeywords(conversationHistory)) {
    return null;
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // 会話をテキスト形式に変換（直近10ターンに制限してコスト削減）
  const recentHistory = conversationHistory.slice(-10);
  const conversationText = recentHistory
    .map((m) => `${m.role === "user" ? "ユーザー" : "アシスタント"}: ${m.content}`)
    .join("\n");

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: EXTRACTION_PROMPT,
      messages: [
        {
          role: "user",
          content: conversationText,
        },
      ],
    });

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );

    if (!textBlock?.text) {
      return null;
    }

    // JSON パース
    const parsed = JSON.parse(textBlock.text) as PreferenceSignals;

    // 空チェック: 全配列が空なら null を返す
    if (
      parsed.preferred_categories.length === 0 &&
      parsed.flavor_preferences.length === 0 &&
      parsed.scene_preferences.length === 0 &&
      parsed.persona_signals.length === 0 &&
      parsed.explicit_statements.length === 0
    ) {
      return null;
    }

    // persona_signals のバリデーション
    const validPersonas = ["serenity", "explorer", "sensory"] as const;
    parsed.persona_signals = parsed.persona_signals.filter((p) =>
      validPersonas.includes(p as typeof validPersonas[number]),
    ) as Array<"serenity" | "explorer" | "sensory">;

    return parsed;
  } catch (err) {
    console.warn(
      "[preference-extractor] extraction failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
