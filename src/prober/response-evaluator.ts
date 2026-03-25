/**
 * Response Evaluator -- CX Agent response quality evaluation
 *
 * Two-stage evaluation:
 * 1. Pattern detection: catch obvious failures (escalation, empty responses)
 * 2. Claude Haiku evaluation: semantic quality scoring for non-obvious cases
 */

import Anthropic from "@anthropic-ai/sdk";
import type { EvaluationResult } from "./types";

/** Patterns that indicate a clear failure (score 1-2) */
const FAILURE_PATTERNS = [
  "確認しますね",
  "お調べしますね",
  "わかりかねます",
  "お答えできません",
  "担当者にお繋ぎ",
  "人間のスタッフ",
  "お問い合わせ",
  "申し訳ございません.*わかりません",
  "確認いたします",
];

/** Escalation marker in response */
const ESCALATION_MARKER = "escalate_to_human";

/**
 * Evaluate a CX Agent response quality.
 *
 * First checks for obvious failure patterns (saves API cost),
 * then uses Claude for semantic evaluation if no pattern matched.
 */
export async function evaluateResponse(
  client: Anthropic,
  question: string,
  response: string | null,
): Promise<EvaluationResult> {
  // Stage 1: Pattern detection
  const patternResult = detectFailurePattern(response);
  if (patternResult) {
    return patternResult;
  }

  // Stage 2: Claude evaluation
  return evaluateWithClaude(client, question, response!);
}

/**
 * Stage 1: Detect obvious failure patterns.
 * Returns evaluation result if a pattern is matched, null otherwise.
 */
function detectFailurePattern(response: string | null): EvaluationResult | null {
  // Empty or very short response
  if (!response || response.trim().length < 20) {
    return {
      quality_score: 1,
      grounding: "escalated",
      gap_category: null,
      missing_info: "Response was empty or extremely short",
      evaluation_notes: "Pattern detection: empty/short response",
    };
  }

  // Escalation detected
  if (response.includes(ESCALATION_MARKER)) {
    return {
      quality_score: 1,
      grounding: "escalated",
      gap_category: null,
      missing_info: "Agent escalated to human -- could not answer",
      evaluation_notes: "Pattern detection: escalation triggered",
    };
  }

  // Known failure expressions
  for (const pattern of FAILURE_PATTERNS) {
    const regex = new RegExp(pattern, "i");
    if (regex.test(response)) {
      return {
        quality_score: 2,
        grounding: "ungrounded",
        gap_category: null,
        missing_info: `Agent used uncertain expression: matched pattern "${pattern}"`,
        evaluation_notes: `Pattern detection: matched failure pattern "${pattern}"`,
      };
    }
  }

  return null;
}

/**
 * Stage 2: Use Claude Haiku for semantic quality evaluation.
 */
async function evaluateWithClaude(
  client: Anthropic,
  question: string,
  response: string,
): Promise<EvaluationResult> {
  const prompt = `あなたは elxea CX Agent の品質評価者です。
以下の質問と回答を評価してください。

[質問]
${question}

[CX Agent の回答]
${response}

[評価基準]
1. グラウンディング: ナレッジに基づいた回答か（推測・ハルシネーションがないか）
2. 具体性: 商品名・価格・特徴など具体的な情報を含むか
3. 完全性: 質問に対して十分に答えているか
4. トーン: elxea らしい温かく押し付けない口調か

以下の JSON で回答してください（JSON のみ出力、他のテキストは不要）:
{
  "quality_score": 1-5,
  "grounding": "grounded" | "partially_grounded" | "ungrounded" | "escalated",
  "gap_category": "tea_knowledge" | "brewing" | "pairing" | "brand_story" | "product_detail" | "wellness" | "seasonal" | "gift" | "order_support" | null,
  "missing_info": "不足している具体的な情報（記事生成のインプット）",
  "evaluation_notes": "評価の理由"
}`;

  const result = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = result.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude for evaluation");
  }

  try {
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = textBlock.text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(jsonStr) as EvaluationResult;

    // Validate score range
    if (parsed.quality_score < 1 || parsed.quality_score > 5) {
      parsed.quality_score = Math.max(1, Math.min(5, Math.round(parsed.quality_score)));
    }

    return parsed;
  } catch (err) {
    console.error("[evaluator] Failed to parse Claude evaluation:", textBlock.text);
    // Fallback: treat as acceptable with warning
    return {
      quality_score: 3,
      grounding: "partially_grounded",
      gap_category: null,
      missing_info: "",
      evaluation_notes: `Evaluation parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
