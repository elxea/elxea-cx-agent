/**
 * Regression Runner -- Weekly regression test execution
 *
 * Sends all active regression test cases to the CX Agent,
 * evaluates responses, and reports any quality regressions.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { evaluateResponse } from "./response-evaluator";
import type { EvaluationResult } from "./types";

/** A single regression test case from the DB */
export type RegressionTestCase = {
  id: string;
  question: string;
  expected_keywords: string[];
  expected_min_score: number;
  persona: string;
  depth_level: string;
  source_probe_id: string | null;
};

/** Result of a single regression test run */
export type RegressionResult = {
  testCase: RegressionTestCase;
  response: string | null;
  evaluation: EvaluationResult | null;
  keywordHits: string[];
  keywordMisses: string[];
  passed: boolean;
  error?: string;
};

/** Summary of a full regression run */
export type RegressionSummary = {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  regressions: RegressionResult[];
  durationMs: number;
};

/**
 * Extract keywords from a high-quality response for regression testing.
 *
 * Uses Claude Haiku to identify key factual terms that should appear
 * in any correct answer to the question.
 */
export async function extractKeywords(
  client: Anthropic,
  question: string,
  response: string,
): Promise<string[]> {
  const prompt = `以下の質問と回答から、回答の品質を検証するためのキーワードを抽出してください。
キーワードは「正しい回答にはこれらの単語/フレーズが含まれるべき」というものです。

[質問]
${question}

[回答]
${response}

[ルール]
- 3-8個のキーワード/フレーズを抽出
- 商品名、具体的な情報（温度、時間等）、重要な概念を優先
- 一般的すぎる語（「お茶」「おすすめ」等）は避ける
- JSON 配列で出力（例: ["キーワード1", "キーワード2"]）
- JSON のみ出力、他のテキストは不要`;

  const result = await client.messages.create({
    model: "claude-haiku-4-5-20241022",
    max_tokens: 200,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = result.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude for keyword extraction");
  }

  try {
    let jsonStr = textBlock.text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const keywords = JSON.parse(jsonStr) as string[];
    return Array.isArray(keywords) ? keywords.filter((k) => typeof k === "string" && k.length > 0) : [];
  } catch {
    console.error("[regression] Failed to parse keywords:", textBlock.text);
    return [];
  }
}

/**
 * Save a high-scoring probe as a regression test case.
 */
export async function saveRegressionTest(
  client: Anthropic,
  supabase: SupabaseClient,
  question: string,
  response: string,
  persona: string,
  depthLevel: string,
  probeHistoryId: string,
): Promise<string | undefined> {
  // Extract keywords from the high-quality response
  const keywords = await extractKeywords(client, question, response);

  if (keywords.length === 0) {
    console.warn("[regression] No keywords extracted, skipping test case save");
    return undefined;
  }

  // Check for duplicate question (avoid storing near-identical test cases)
  const { data: existing } = await supabase
    .from("regression_tests")
    .select("id, question")
    .eq("active", true)
    .limit(200);

  if (existing && existing.length > 0) {
    // Simple dedup: skip if question text is very similar (shared prefix > 80%)
    const isDuplicate = existing.some((row) => {
      const shorter = Math.min(row.question.length, question.length);
      let matching = 0;
      for (let i = 0; i < shorter; i++) {
        if (row.question[i] === question[i]) matching++;
        else break;
      }
      return matching / shorter > 0.8;
    });

    if (isDuplicate) {
      console.log("[regression] Duplicate question detected, skipping");
      return undefined;
    }
  }

  const { data, error } = await supabase
    .from("regression_tests")
    .insert({
      question,
      expected_keywords: keywords,
      expected_min_score: 4,
      persona,
      depth_level: depthLevel,
      source_probe_id: probeHistoryId,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[regression] Failed to save test case:", error);
    return undefined;
  }

  console.log(`[regression] Saved test case: ${data?.id} (${keywords.length} keywords)`);
  return data?.id;
}

/**
 * Fetch all active regression test cases.
 */
export async function fetchActiveTestCases(
  supabase: SupabaseClient,
): Promise<RegressionTestCase[]> {
  const { data, error } = await supabase
    .from("regression_tests")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch regression tests: ${error.message}`);
  }

  return (data ?? []) as RegressionTestCase[];
}

/**
 * Check if new articles were added to Content Hub this week.
 * Uses probe_history.article_generated to detect recent article creation.
 */
export async function hasNewArticlesThisWeek(
  supabase: SupabaseClient,
): Promise<boolean> {
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  const { count, error } = await supabase
    .from("probe_history")
    .select("id", { count: "exact", head: true })
    .eq("article_generated", true)
    .gte("created_at", oneWeekAgo.toISOString());

  if (error) {
    console.error("[regression] Failed to check recent articles:", error);
    // On error, run the tests anyway to be safe
    return true;
  }

  return (count ?? 0) > 0;
}

/**
 * Run a single regression test case.
 */
export async function runSingleTest(
  client: Anthropic,
  testCase: RegressionTestCase,
  sendToCxAgent: (message: string, sessionId: string) => Promise<{ fullText: string; durationMs: number }>,
): Promise<RegressionResult> {
  const result: RegressionResult = {
    testCase,
    response: null,
    evaluation: null,
    keywordHits: [],
    keywordMisses: [],
    passed: false,
  };

  try {
    // Send question to CX Agent
    const sessionId = `regression_${testCase.id}_${Date.now()}`;
    const agentResult = await sendToCxAgent(testCase.question, sessionId);
    result.response = agentResult.fullText;

    // Evaluate response quality
    result.evaluation = await evaluateResponse(client, testCase.question, result.response);

    // Check keywords
    const responseLower = result.response.toLowerCase();
    for (const keyword of testCase.expected_keywords) {
      if (responseLower.includes(keyword.toLowerCase())) {
        result.keywordHits.push(keyword);
      } else {
        result.keywordMisses.push(keyword);
      }
    }

    // Pass criteria: score >= expected_min_score AND at least 50% keywords hit
    const scoreOk = result.evaluation.quality_score >= testCase.expected_min_score;
    const keywordRatio =
      testCase.expected_keywords.length > 0
        ? result.keywordHits.length / testCase.expected_keywords.length
        : 1;
    const keywordsOk = keywordRatio >= 0.5;

    result.passed = scoreOk && keywordsOk;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

/**
 * Build a regression summary from individual results.
 */
export function buildRegressionSummary(
  results: RegressionResult[],
  durationMs: number,
): RegressionSummary {
  const regressions = results.filter((r) => !r.passed && !r.error);
  const errors = results.filter((r) => !!r.error);

  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: regressions.length,
    errors: errors.length,
    regressions,
    durationMs,
  };
}

/**
 * Format regression summary for Slack notification.
 */
export function formatSlackMessage(summary: RegressionSummary): string {
  const status = summary.failed >= 2 ? ":rotating_light:" : summary.failed > 0 ? ":warning:" : ":white_check_mark:";

  const lines = [
    `*[Regression Test] Weekly Summary* ${status}`,
    `Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed} | Errors: ${summary.errors}`,
    `Duration: ${Math.round(summary.durationMs / 1000)}s`,
  ];

  if (summary.regressions.length > 0) {
    lines.push("");
    lines.push("*Regressions detected:*");
    for (const reg of summary.regressions) {
      const score = reg.evaluation?.quality_score ?? "N/A";
      const expected = reg.testCase.expected_min_score;
      const missingKw = reg.keywordMisses.length > 0 ? ` | Missing: ${reg.keywordMisses.join(", ")}` : "";
      lines.push(`  - Score: ${score}/${expected} | Q: "${reg.testCase.question.slice(0, 60)}..."${missingKw}`);
    }
  }

  if (summary.failed >= 2) {
    lines.push("");
    lines.push("*Action required:* 2+ regressions detected. Review recent Content Hub changes.");
  }

  return lines.join("\n");
}
