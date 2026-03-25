/**
 * Article Generator -- RAG article generation for knowledge gaps
 *
 * Uses Claude Sonnet to generate high-quality articles for knowledge gaps
 * detected by the Knowledge Prober. Articles are written to Content Hub
 * as Draft status for human review.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type ArticleContext,
  type GeneratedArticle,
  type Persona,
  PERSONA_TARGET_LAYER,
} from "./types";

/**
 * Fetch existing knowledge snippets from Supabase for context.
 * Retrieves chunks related to the gap category to avoid duplication
 * and provide grounding for the article.
 */
async function fetchExistingKnowledge(
  supabase: SupabaseClient,
  gapCategory: string,
  limit: number = 5,
): Promise<string[]> {
  // Fetch recent knowledge chunks that may be related
  const { data } = await supabase
    .from("knowledge_chunks")
    .select("content, source_type")
    .order("updated_at", { ascending: false })
    .limit(limit * 3);

  if (!data || data.length === 0) return [];

  // Filter to most relevant snippets (simple keyword matching)
  const categoryKeywords: Record<string, string[]> = {
    tea_knowledge: ["お茶", "日本茶", "種類", "品種", "緑茶", "煎茶"],
    brewing: ["淹れ方", "温度", "抽出", "急須", "水出し", "蒸らし"],
    pairing: ["ペアリング", "食事", "スイーツ", "組み合わせ", "合う"],
    brand_story: ["elxea", "和束", "産地", "茶畑", "生産者", "ストーリー"],
    product_detail: ["商品", "価格", "内容量", "特徴", "おすすめ"],
    wellness: ["リラックス", "効能", "健康", "カフェイン", "癒し", "睡眠"],
    seasonal: ["季節", "新茶", "春", "夏", "秋", "冬", "限定"],
    gift: ["ギフト", "贈り物", "セット", "ラッピング", "プレゼント"],
  };

  const keywords = categoryKeywords[gapCategory] || [];
  const scored = data.map((chunk) => {
    const score = keywords.reduce(
      (acc, kw) => acc + (chunk.content?.includes(kw) ? 1 : 0),
      0,
    );
    return { content: chunk.content, score };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((s) => s.content)
    .map((s) => s.content);
}

/**
 * Generate a RAG article for a detected knowledge gap.
 *
 * Uses Claude Sonnet for higher quality output (per Spec requirement).
 */
export async function generateArticle(
  client: Anthropic,
  supabase: SupabaseClient,
  context: ArticleContext,
): Promise<GeneratedArticle> {
  const existingKnowledge = await fetchExistingKnowledge(
    supabase,
    context.gap_category,
  );

  const knowledgeSnippets =
    existingKnowledge.length > 0
      ? existingKnowledge.map((s, i) => `${i + 1}. ${s}`).join("\n")
      : "(既存ナレッジなし)";

  const targetLayer = PERSONA_TARGET_LAYER[context.persona];

  const prompt = `あなたは elxea のコンテンツライターです。
CX Agent が答えられなかった以下の質問領域について、RAG ナレッジベース用の記事を作成してください。

[不足領域]
- カテゴリ: ${context.gap_category}
- 元の質問: ${context.question}
- CX Agent が答えられなかった情報: ${context.missing_info}

[既存のナレッジ]
${knowledgeSnippets}

[記事要件]
- RAG 検索で使われるため、質問に対する直接的な回答を含めること
- elxea の商品に関連付けること（可能な場合）
- 事実のみ記載。推測や誇大表現は禁止
- 300-600文字程度
- elxea のブランドトーン（温かく、押し付けない）

[ハルシネーション防止]
- elxea の商品情報は [既存のナレッジ] に含まれるもののみ使用
- お茶の一般知識（カフェイン量、効能等）は広く認知された事実のみ
- 不確実な情報には「一般的に」等の留保を付けること

以下の JSON で回答してください（JSON のみ出力、他のテキストは不要）:
{
  "title": "記事タイトル",
  "content": "記事本文",
  "content_persona": ${JSON.stringify([context.persona])},
  "depth_level": "${context.depth_level}",
  "target_layer": ${JSON.stringify([targetLayer])},
  "channel": "LINE CRM"
}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude for article generation");
  }

  try {
    let jsonStr = textBlock.text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(jsonStr) as GeneratedArticle;

    // Validate and enforce constraints
    if (!parsed.title || !parsed.content) {
      throw new Error("Generated article missing title or content");
    }

    // Enforce persona/depth from context (don't trust LLM to echo correctly)
    parsed.content_persona = [context.persona];
    parsed.depth_level = context.depth_level;
    parsed.target_layer = [targetLayer];
    parsed.channel = "LINE CRM";

    return parsed;
  } catch (err) {
    console.error(
      "[article-gen] Failed to parse Claude article response:",
      textBlock.text.slice(0, 200),
    );
    throw new Error(
      `Article generation parse error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
