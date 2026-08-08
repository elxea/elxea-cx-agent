/**
 * Knowledge Regression Test -- Weekly regression test runner
 *
 * Re-sends all active regression test cases to the CX Agent,
 * evaluates response quality, and alerts if regressions are detected.
 *
 * Runs weekly (Sunday AM 2:00 JST) via launchd.
 * Only executes if new articles were added to Content Hub this week.
 *
 * Usage:
 *   npx tsx scripts/knowledge-regression.ts
 *   npx tsx scripts/knowledge-regression.ts --force     # Run even if no new articles
 *   npx tsx scripts/knowledge-regression.ts --dry-run   # No Slack notifications
 *
 * Environment (.dev.vars):
 *   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SLACK_WEBHOOK_URL
 */

import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import {
  fetchActiveTestCases,
  hasNewArticlesThisWeek,
  runSingleTest,
  buildRegressionSummary,
  formatSlackMessage,
  type RegressionResult,
} from "../src/prober/regression-runner";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

dotenv.config({ path: ".dev.vars" });

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const forceRun = args.includes("--force");

const CX_AGENT_BASE_URL =
  args.find((a) => a.startsWith("--target="))?.split("=")[1] ??
  process.env.CX_AGENT_BASE_URL ??
  "https://elxea-agent.setaka-on.workers.dev";

/** Delay between API calls to avoid rate limiting (ms) */
const INTER_CALL_DELAY_MS = 10_000;

// ---------------------------------------------------------------------------
// SSE parser (same as knowledge-prober.ts)
// ---------------------------------------------------------------------------

type SSEEvent = {
  type: string;
  content?: string;
  session_id?: string;
  message?: string;
};

async function sendToCxAgent(
  message: string,
  sessionId: string,
): Promise<{ fullText: string; durationMs: number }> {
  const start = Date.now();

  const res = await fetch(`${CX_AGENT_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, session_id: sessionId }),
  });

  const durationMs = Date.now() - start;

  if (!res.ok) {
    const errBody = await res.text().catch(() => "unknown");
    throw new Error(`CX Agent returned ${res.status}: ${errBody}`);
  }

  const rawText = await res.text();
  let fullText = "";

  for (const line of rawText.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        const event: SSEEvent = JSON.parse(line.slice(6));
        if (event.type === "text_delta" && event.content) {
          fullText += event.content;
        }
      } catch {
        // skip malformed SSE lines
      }
    }
  }

  return { fullText, durationMs };
}

// ---------------------------------------------------------------------------
// Slack notification
// ---------------------------------------------------------------------------

async function sendSlackNotification(text: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.log("[regression] SLACK_WEBHOOK_URL not set, skipping notification");
    return;
  }

  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error("[regression] Slack notification failed:", await res.text());
    } else {
      console.log("[regression] Slack notification sent");
    }
  } catch (err) {
    console.error("[regression] Failed to send Slack notification:", err);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Knowledge Regression Test ===");
  console.log(`Target: ${CX_AGENT_BASE_URL}`);
  console.log(`Dry run: ${isDryRun}`);
  console.log(`Force: ${forceRun}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log("");

  // Validate environment
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");
  if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Check if new articles were added this week (skip if not, unless --force)
  if (!forceRun) {
    const hasArticles = await hasNewArticlesThisWeek(supabase);
    if (!hasArticles) {
      console.log("[regression] No new articles this week. Skipping regression tests.");
      console.log("Use --force to run anyway.");
      return;
    }
    console.log("[regression] New articles detected this week. Running regression tests.\n");
  }

  // Fetch active test cases
  const testCases = await fetchActiveTestCases(supabase);

  if (testCases.length === 0) {
    console.log("[regression] No active regression test cases found. Nothing to do.");
    return;
  }

  console.log(`[regression] Running ${testCases.length} test cases...\n`);

  const results: RegressionResult[] = [];
  const startTime = Date.now();

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    console.log(`[${i + 1}/${testCases.length}] Testing: "${tc.question.slice(0, 60)}..."`);
    console.log(`  Persona: ${tc.persona}/${tc.depth_level} | Min score: ${tc.expected_min_score} | Keywords: ${tc.expected_keywords.length}`);

    const result = await runSingleTest(client, tc, sendToCxAgent);

    if (result.error) {
      console.log(`  ERROR: ${result.error}`);
    } else {
      const score = result.evaluation?.quality_score ?? "N/A";
      const kwHit = result.keywordHits.length;
      const kwTotal = tc.expected_keywords.length;
      const status = result.passed ? "PASS" : "FAIL";
      console.log(`  ${status}: Score ${score}/${tc.expected_min_score} | Keywords: ${kwHit}/${kwTotal}`);

      if (!result.passed && result.keywordMisses.length > 0) {
        console.log(`  Missing keywords: ${result.keywordMisses.join(", ")}`);
      }
    }

    results.push(result);

    // Rate limit protection
    if (i < testCases.length - 1) {
      await new Promise((r) => setTimeout(r, INTER_CALL_DELAY_MS));
    }
    console.log("");
  }

  const totalDuration = Date.now() - startTime;
  const summary = buildRegressionSummary(results, totalDuration);

  // Console summary
  console.log("=== Summary ===");
  console.log(`Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed} | Errors: ${summary.errors}`);
  console.log(`Duration: ${Math.round(totalDuration / 1000)}s`);

  if (summary.regressions.length > 0) {
    console.log("\nRegressions:");
    for (const reg of summary.regressions) {
      console.log(`  - "${reg.testCase.question.slice(0, 60)}..." (score: ${reg.evaluation?.quality_score})`);
    }
  }

  // Slack notification
  if (!isDryRun) {
    const slackMessage = formatSlackMessage(summary);
    await sendSlackNotification(slackMessage);
  }

  console.log("\nDone.");

  // Exit with non-zero if regressions detected (useful for CI)
  if (summary.failed >= 2) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
