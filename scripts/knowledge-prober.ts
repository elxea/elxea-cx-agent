/**
 * Knowledge Prober -- AI persona probing script
 *
 * Generates questions from 9 persona-depth patterns, sends them to the
 * CX Agent POST /api/chat endpoint, evaluates response quality, and
 * stores results in probe_history table.
 *
 * Phase 1: Question generation + CX Agent call + response evaluation + Slack summary.
 * Phase 2 (future): Article generation for low-scoring responses.
 *
 * Usage:
 *   npx tsx scripts/knowledge-prober.ts
 *   npx tsx scripts/knowledge-prober.ts --dry-run        # No DB writes or API calls to CX Agent
 *   npx tsx scripts/knowledge-prober.ts --target=URL      # Override CX Agent base URL
 *   npx tsx scripts/knowledge-prober.ts --limit=3         # Limit number of probes (for testing)
 *
 * Schedule: Daily AM 2:00 JST via launchd (com.elxea.knowledge-prober.plist)
 *
 * Environment (.dev.vars):
 *   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SLACK_WEBHOOK_URL
 */

import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { generateQuestion } from "../src/prober/question-generator";
import { evaluateResponse } from "../src/prober/response-evaluator";
import {
  PERSONA_DEPTH_MATRIX,
  type Persona,
  type DepthLevel,
  type ProbeRecord,
  type EvaluationResult,
} from "../src/prober/types";

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
const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1];
const limitArg = args.find((a) => a.startsWith("--limit="))?.split("=")[1];

const CX_AGENT_BASE_URL =
  targetArg ??
  process.env.CX_AGENT_BASE_URL ??
  "https://elxea-agent.elxea.workers.dev";

/** Probe session prefix (to separate from real users) */
const PROBE_SESSION_PREFIX = "probe_";

/** Delay between API calls to avoid rate limiting (ms) */
const INTER_CALL_DELAY_MS = 10_000;

// ---------------------------------------------------------------------------
// SSE parser (reused from smoke-test.ts)
// ---------------------------------------------------------------------------

type SSEEvent = {
  type: string;
  content?: string;
  products?: unknown[];
  items?: unknown[];
  checkout_url?: string;
  session_id?: string;
  message?: string;
};

/**
 * Send a message to the CX Agent and collect the full response from SSE.
 */
async function sendToCxAgent(
  message: string,
  sessionId: string,
): Promise<{ fullText: string; events: SSEEvent[]; durationMs: number }> {
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
  const events: SSEEvent[] = [];
  let fullText = "";

  for (const line of rawText.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        const event: SSEEvent = JSON.parse(line.slice(6));
        events.push(event);
        if (event.type === "text_delta" && event.content) {
          fullText += event.content;
        }
      } catch {
        // skip malformed SSE lines
      }
    }
  }

  return { fullText, events, durationMs };
}

// ---------------------------------------------------------------------------
// Probe execution
// ---------------------------------------------------------------------------

type ProbeResult = {
  persona: Persona;
  depth: DepthLevel;
  question: string;
  response: string | null;
  evaluation: EvaluationResult | null;
  durationMs: number;
  error?: string;
};

/**
 * Execute a single probe: generate question -> send to CX Agent -> evaluate.
 */
async function executeSingleProbe(
  client: Anthropic,
  supabase: SupabaseClient,
  persona: Persona,
  depth: DepthLevel,
): Promise<ProbeResult> {
  const result: ProbeResult = {
    persona,
    depth,
    question: "",
    response: null,
    evaluation: null,
    durationMs: 0,
  };

  try {
    // Step 1: Generate question
    console.log(`[probe] Generating question for ${persona}/${depth}...`);
    result.question = await generateQuestion(client, supabase, persona, depth);
    console.log(`[probe] Question: ${result.question}`);

    if (isDryRun) {
      console.log("[probe] (dry-run) Skipping CX Agent call and evaluation");
      return result;
    }

    // Step 2: Send to CX Agent
    const sessionId = `${PROBE_SESSION_PREFIX}${persona}_${depth}_${Date.now()}`;
    console.log(`[probe] Sending to CX Agent (session: ${sessionId})...`);

    const agentResult = await sendToCxAgent(result.question, sessionId);
    result.response = agentResult.fullText;
    result.durationMs = agentResult.durationMs;

    console.log(`[probe] Response received (${result.response.length} chars, ${agentResult.durationMs}ms)`);

    // Check for error events
    const errorEvent = agentResult.events.find((e) => e.type === "error");
    if (errorEvent) {
      console.warn(`[probe] CX Agent error event: ${errorEvent.message}`);
    }

    // Step 3: Evaluate response
    console.log("[probe] Evaluating response...");
    result.evaluation = await evaluateResponse(client, result.question, result.response);
    console.log(`[probe] Score: ${result.evaluation.quality_score}/5 (${result.evaluation.grounding})`);

    if (result.evaluation.gap_category) {
      console.log(`[probe] Gap detected: ${result.evaluation.gap_category}`);
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.error(`[probe] Error for ${persona}/${depth}:`, result.error);
  }

  return result;
}

/**
 * Save probe result to probe_history table.
 */
async function saveProbeResult(
  supabase: SupabaseClient,
  result: ProbeResult,
): Promise<void> {
  const record: Omit<ProbeRecord, "id" | "created_at"> = {
    persona: result.persona,
    depth_level: result.depth,
    question: result.question,
    response: result.response,
    quality_score: result.evaluation?.quality_score ?? null,
    evaluation_notes: result.evaluation
      ? `${result.evaluation.evaluation_notes}${result.error ? ` | Error: ${result.error}` : ""}`
      : result.error ?? null,
    gap_category: result.evaluation?.gap_category ?? null,
    article_generated: false,
    content_hub_page_id: null,
  };

  const { error } = await supabase.from("probe_history").insert(record);
  if (error) {
    console.error("[probe] Failed to save probe result:", error);
  }
}

// ---------------------------------------------------------------------------
// Slack notification
// ---------------------------------------------------------------------------

type ProbeSummary = {
  total: number;
  scores: Record<number, number>;
  gaps: Record<string, number>;
  avgScore: number;
  errors: number;
  durationMs: number;
};

function buildSummary(results: ProbeResult[], durationMs: number): ProbeSummary {
  const scores: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const gaps: Record<string, number> = {};
  let totalScore = 0;
  let scored = 0;
  let errors = 0;

  for (const r of results) {
    if (r.error) errors++;
    if (r.evaluation) {
      const s = r.evaluation.quality_score;
      scores[s] = (scores[s] || 0) + 1;
      totalScore += s;
      scored++;
      if (r.evaluation.gap_category) {
        gaps[r.evaluation.gap_category] = (gaps[r.evaluation.gap_category] || 0) + 1;
      }
    }
  }

  return {
    total: results.length,
    scores,
    gaps,
    avgScore: scored > 0 ? Math.round((totalScore / scored) * 10) / 10 : 0,
    errors,
    durationMs,
  };
}

async function sendSlackSummary(summary: ProbeSummary): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    console.log("[probe] SLACK_WEBHOOK_URL not set, skipping notification");
    return;
  }

  const scoreBar = Object.entries(summary.scores)
    .map(([score, count]) => `${score}: ${"#".repeat(count)} (${count})`)
    .join("\n");

  const gapList = Object.entries(summary.gaps)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `  - ${cat}: ${count}`)
    .join("\n");

  const text = [
    "*[Knowledge Prober] Daily Summary*",
    `Total probes: ${summary.total} | Avg score: ${summary.avgScore} | Errors: ${summary.errors}`,
    `Duration: ${Math.round(summary.durationMs / 1000)}s`,
    "",
    "*Score distribution:*",
    "```",
    scoreBar,
    "```",
    ...(Object.keys(summary.gaps).length > 0
      ? ["*Knowledge gaps detected:*", gapList]
      : ["No knowledge gaps detected."]),
  ].join("\n");

  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error("[probe] Slack notification failed:", await res.text());
    } else {
      console.log("[probe] Slack summary sent");
    }
  } catch (err) {
    console.error("[probe] Failed to send Slack notification:", err);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Knowledge Prober ===");
  console.log(`Target: ${CX_AGENT_BASE_URL}`);
  console.log(`Dry run: ${isDryRun}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log("");

  // Validate environment
  if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");
  if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Determine probe patterns (optionally limited for testing)
  const maxProbes = limitArg ? parseInt(limitArg, 10) : PERSONA_DEPTH_MATRIX.length;
  const patterns = PERSONA_DEPTH_MATRIX.slice(0, maxProbes);

  // Shuffle patterns for variety (different order each day)
  const shuffled = [...patterns].sort(() => Math.random() - 0.5);

  console.log(`Running ${shuffled.length} probes...\n`);

  const allResults: ProbeResult[] = [];
  const startTime = Date.now();

  for (const { persona, depth } of shuffled) {
    const result = await executeSingleProbe(client, supabase, persona, depth);
    allResults.push(result);

    // Save to DB
    if (!isDryRun && result.question) {
      await saveProbeResult(supabase, result);
    }

    // Rate limit protection (skip delay after last probe)
    if (allResults.length < shuffled.length) {
      console.log(`[probe] Waiting ${INTER_CALL_DELAY_MS / 1000}s before next probe...`);
      await new Promise((r) => setTimeout(r, INTER_CALL_DELAY_MS));
    }
    console.log("");
  }

  const totalDuration = Date.now() - startTime;

  // Summary
  const summary = buildSummary(allResults, totalDuration);
  console.log("=== Summary ===");
  console.log(`Total: ${summary.total} | Avg: ${summary.avgScore} | Errors: ${summary.errors}`);
  console.log(`Scores: ${JSON.stringify(summary.scores)}`);
  if (Object.keys(summary.gaps).length > 0) {
    console.log(`Gaps: ${JSON.stringify(summary.gaps)}`);
  }
  console.log(`Duration: ${Math.round(totalDuration / 1000)}s`);

  // Slack notification
  if (!isDryRun) {
    await sendSlackSummary(summary);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
