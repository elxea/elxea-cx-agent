/**
 * Question Generator -- AI persona-based question generation
 *
 * Uses Claude Haiku to generate natural questions that a customer
 * matching a specific persona/depth would ask the CX Agent.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type Persona,
  type DepthLevel,
  PERSONA_DESCRIPTIONS,
  QUESTION_CATEGORIES,
  getSeasonalContext,
} from "./types";

/**
 * Generate a question for the given persona and depth level.
 *
 * Avoids duplicates by referencing recent questions from probe_history.
 */
export async function generateQuestion(
  client: Anthropic,
  supabase: SupabaseClient,
  persona: Persona,
  depthLevel: DepthLevel,
): Promise<string> {
  // Fetch recent questions to avoid duplicates
  const { data: recentProbes } = await supabase
    .from("probe_history")
    .select("question")
    .order("created_at", { ascending: false })
    .limit(50);

  const recentQuestions = (recentProbes ?? [])
    .map((r) => `- ${r.question}`)
    .join("\n");

  const personaDescription = PERSONA_DESCRIPTIONS[persona][depthLevel];
  const seasonalContext = getSeasonalContext();
  const categories = QUESTION_CATEGORIES.join("\n- ");

  const prompt = `あなたは elxea（お茶ブランド）の顧客です。
ペルソナ: ${persona} / 深度: ${depthLevel}

以下のペルソナ特性に基づいて、elxea の CX Agent に聞きそうな質問を 1 つ生成してください。

[ペルソナ特性]
${personaDescription}

[季節コンテキスト]
${seasonalContext}

[過去に生成した質問（重複回避）]
${recentQuestions || "（なし）"}

[質問カテゴリ候補]
- ${categories}

質問は自然な日本語で、1文で。質問文のみを出力してください（説明は不要）。`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 100,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude for question generation");
  }

  return textBlock.text.trim();
}
