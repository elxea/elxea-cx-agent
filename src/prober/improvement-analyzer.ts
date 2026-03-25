/**
 * Improvement Analyzer -- Phase 4 of Knowledge Prober
 *
 * Analyzes probe results to detect problem patterns, then creates
 * Review tasks in All Tasks DB for Setaka to review improvement proposals.
 *
 * Detection patterns:
 *   1. Empty response (0 chars, null, SSE bug)
 *   2. Low-score trend (specific persona/depth consistently low)
 *   3. RAG search miss ("cannot answer" phrases)
 *   4. Excessive escalation (many score-1 results)
 *   5. Score regression (same pattern scoring lower than before)
 *
 * Safety:
 *   - Creates tasks only, never auto-implements
 *   - Deduplicates against tasks created in past 7 days
 *   - Max 3 tasks per run
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Persona, DepthLevel } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Detected problem pattern */
export type ProblemPattern =
  | "empty_response"
  | "low_score_trend"
  | "rag_search_miss"
  | "excessive_escalation"
  | "score_regression";

/** Severity mapping for task priority */
const PATTERN_PRIORITY: Record<ProblemPattern, string> = {
  empty_response: "\uD83D\uDEA9",
  low_score_trend: "High",
  rag_search_miss: "High",
  excessive_escalation: "High",
  score_regression: "High",
};

/** Detected issue for task creation */
export type DetectedIssue = {
  pattern: ProblemPattern;
  summary: string;
  details: string;
  causeAnalysis: string;
  proposal: string;
  priority: string;
  /** Key used for deduplication (pattern + context) */
  dedupeKey: string;
};

/** Probe result shape (subset of what knowledge-prober.ts produces) */
export type ProbeResultForAnalysis = {
  persona: Persona;
  depth: DepthLevel;
  question: string;
  response: string | null;
  evaluation: {
    quality_score: number;
    grounding: string;
    gap_category: string | null;
    missing_info: string;
    evaluation_notes: string;
  } | null;
  durationMs: number;
  error?: string;
};

/** Task creation result */
export type CreatedTask = {
  pattern: ProblemPattern;
  summary: string;
  notionPageId?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Notion All Tasks DB ID */
const ALL_TASKS_DB_ID = "50adc342-b98e-4b35-858c-4268c4802ba0";

/** Max tasks per run */
const MAX_TASKS_PER_RUN = 3;

/** Days to check for duplicate tasks */
const DEDUPE_WINDOW_DAYS = 7;

/** Project ID: elxea CX Agent Development */
const PROJECT_ID = "31370c9d-064c-80dc-8750-d9ac7c27a760";

/** Company ID: elxea */
const COMPANY_ID = "8a40a27223f249619f541e707f3ae851";

/** Assignee: Boss */
const ASSIGNEE_BOSS_ID = "31b70c9d-064c-814b-a39f-f2dc9a88de24";

/** Phrases indicating RAG search miss */
const RAG_MISS_PHRASES = [
  "お答えできません",
  "わかりません",
  "わかりかねます",
  "確認しますね",
  "お調べします",
  "担当者に確認",
  "お答えしかねます",
  "情報がありません",
  "把握しておりません",
];

// ---------------------------------------------------------------------------
// Pattern detection functions
// ---------------------------------------------------------------------------

/**
 * Pattern 1: Detect empty or null responses.
 * Indicates SSE streaming bugs, API timeouts, or error handling issues.
 */
function detectEmptyResponses(
  results: ProbeResultForAnalysis[],
): DetectedIssue | null {
  const emptyResults = results.filter(
    (r) => !r.response || r.response.trim().length === 0,
  );

  if (emptyResults.length === 0) return null;

  const affected = emptyResults
    .map((r) => `${r.persona}/${r.depth}`)
    .join(", ");

  return {
    pattern: "empty_response",
    summary: `空レスポンス ${emptyResults.length}件検出`,
    details: [
      `${emptyResults.length}/${results.length} 件のプローブで空レスポンスを検出。`,
      `対象パターン: ${affected}`,
      emptyResults[0]?.error
        ? `エラー例: ${emptyResults[0].error.substring(0, 200)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    causeAnalysis: [
      "想定される原因:",
      "- SSE ストリーミングの接続切断またはパースエラー",
      "- CX Agent の API タイムアウト（Cloudflare Workers の 30s 制限）",
      "- Claude API のレートリミットまたはエラーレスポンス",
      "- エラーハンドリングで空文字列が返されている可能性",
    ].join("\n"),
    proposal: [
      "改善提案:",
      "1. CX Agent のエラーログを確認し、該当時刻のリクエストを特定する",
      "2. SSE レスポンスの raw データをログに追加して原因を切り分ける",
      "3. 空レスポンス時のリトライロジックを検討する",
    ].join("\n"),
    priority: PATTERN_PRIORITY.empty_response,
    dedupeKey: "empty_response",
  };
}

/**
 * Pattern 2: Detect low-score trends for specific persona/depth combinations.
 * Indicates knowledge gaps in specific areas.
 */
function detectLowScoreTrend(
  results: ProbeResultForAnalysis[],
): DetectedIssue | null {
  // Group scores by persona/depth
  const groups = new Map<string, number[]>();
  for (const r of results) {
    if (!r.evaluation) continue;
    const key = `${r.persona}/${r.depth}`;
    const scores = groups.get(key) || [];
    scores.push(r.evaluation.quality_score);
    groups.set(key, scores);
  }

  // Find groups where average score <= 2.5
  const lowGroups: Array<{ key: string; avg: number; scores: number[] }> = [];
  for (const [key, scores] of groups) {
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg <= 2.5) {
      lowGroups.push({ key, avg: Math.round(avg * 10) / 10, scores });
    }
  }

  if (lowGroups.length === 0) return null;

  const worstGroup = lowGroups.sort((a, b) => a.avg - b.avg)[0];

  return {
    pattern: "low_score_trend",
    summary: `低スコア傾向: ${worstGroup.key} (平均 ${worstGroup.avg})`,
    details: [
      `以下のペルソナ/深度パターンで平均スコアが低い:`,
      ...lowGroups.map(
        (g) =>
          `- ${g.key}: 平均 ${g.avg} (スコア分布: [${g.scores.join(", ")}])`,
      ),
    ].join("\n"),
    causeAnalysis: [
      "想定される原因:",
      `- ${worstGroup.key} に対応するナレッジ（RAG コンテンツ）が不足している`,
      "- Content Hub に該当カテゴリの記事が少ない、または浅い内容のみ",
      "- 質問の深度に対してナレッジの粒度が合っていない",
    ].join("\n"),
    proposal: [
      "改善提案:",
      `1. Content Hub で ${worstGroup.key} 関連の記事数と内容を確認する`,
      "2. 不足しているカテゴリの記事を手動で追加する（Phase 2 の自動生成だけでは不十分な領域）",
      "3. 既存記事の depth_level を見直し、deep レベルの質問に対応できる詳細記事を追加する",
    ].join("\n"),
    priority: PATTERN_PRIORITY.low_score_trend,
    dedupeKey: `low_score_trend:${worstGroup.key}`,
  };
}

/**
 * Pattern 3: Detect RAG search misses (responses containing "cannot answer" phrases).
 * Indicates missing knowledge chunks in pgvector.
 */
function detectRagSearchMiss(
  results: ProbeResultForAnalysis[],
): DetectedIssue | null {
  const misses = results.filter((r) => {
    if (!r.response) return false;
    return RAG_MISS_PHRASES.some((phrase) => r.response!.includes(phrase));
  });

  if (misses.length === 0) return null;

  const examples = misses.slice(0, 3).map((r) => {
    const matchedPhrase = RAG_MISS_PHRASES.find((p) => r.response!.includes(p));
    return `- Q: "${r.question.substring(0, 80)}..." -> "${matchedPhrase}"`;
  });

  return {
    pattern: "rag_search_miss",
    summary: `RAG 検索空振り ${misses.length}件`,
    details: [
      `${misses.length}/${results.length} 件で「答えられない」系の応答を検出。`,
      "",
      "検出例:",
      ...examples,
    ].join("\n"),
    causeAnalysis: [
      "想定される原因:",
      "- 該当トピックの knowledge_chunks が Supabase に存在しない",
      "- Content Hub に記事はあるが knowledge.ts の同期対象外（Draft ステータス等）",
      "- 埋め込みベクトルの類似度が閾値を下回っている（質問の表現とチャンクの表現が乖離）",
    ].join("\n"),
    proposal: [
      "改善提案:",
      "1. 該当質問で Supabase pgvector の類似度検索を手動実行し、ヒットするチャンクがあるか確認する",
      "2. Content Hub の Draft 記事を確認し、Ready にすべき記事がないかレビューする",
      "3. 既存記事のチャンク分割を見直し、質問に直接回答する文が独立したチャンクになっているか確認する",
    ].join("\n"),
    priority: PATTERN_PRIORITY.rag_search_miss,
    dedupeKey: "rag_search_miss",
  };
}

/**
 * Pattern 4: Detect excessive escalation (too many score-1 results).
 * Indicates system prompt constraints may be too strict.
 */
function detectExcessiveEscalation(
  results: ProbeResultForAnalysis[],
): DetectedIssue | null {
  const score1Results = results.filter(
    (r) => r.evaluation && r.evaluation.quality_score === 1,
  );

  // Threshold: more than 30% of evaluated probes are score 1
  const evaluated = results.filter((r) => r.evaluation);
  if (evaluated.length === 0) return null;

  const ratio = score1Results.length / evaluated.length;
  if (ratio < 0.3) return null;

  const escalatedExamples = score1Results.slice(0, 3).map((r) => {
    return `- ${r.persona}/${r.depth}: "${r.question.substring(0, 60)}..." (${r.evaluation!.grounding})`;
  });

  return {
    pattern: "excessive_escalation",
    summary: `エスカレーション多発: ${score1Results.length}/${evaluated.length}件がスコア1`,
    details: [
      `評価済みプローブの ${Math.round(ratio * 100)}% がスコア1（完全回答不能）。`,
      "",
      "例:",
      ...escalatedExamples,
    ].join("\n"),
    causeAnalysis: [
      "想定される原因:",
      "- system-prompt.ts のグラウンディングルールが厳しすぎる可能性",
      "- escalate_to_human の発火条件が広すぎる",
      "- ナレッジベース全体のカバレッジが不足している",
    ].join("\n"),
    proposal: [
      "改善提案:",
      "1. エスカレーション発火した質問を分析し、回答可能だった質問がないか確認する",
      "2. system-prompt.ts のエスカレーション条件を見直す（変更は慎重に。Brand tone を維持すること）",
      "3. ナレッジベースのカバレッジマップを作成し、不足領域を特定する",
    ].join("\n"),
    priority: PATTERN_PRIORITY.excessive_escalation,
    dedupeKey: "excessive_escalation",
  };
}

/**
 * Pattern 5: Detect score regression by comparing with historical data.
 * Queries probe_history for the same persona/depth over the past 14 days.
 */
async function detectScoreRegression(
  supabase: SupabaseClient,
  results: ProbeResultForAnalysis[],
): Promise<DetectedIssue | null> {
  // Get historical averages per persona/depth (past 14 days, excluding today)
  const today = new Date();
  const twoWeeksAgo = new Date(today);
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const { data: history, error } = await supabase
    .from("probe_history")
    .select("persona, depth_level, quality_score")
    .gte("created_at", twoWeeksAgo.toISOString())
    .lte("created_at", yesterday.toISOString())
    .not("quality_score", "is", null);

  if (error || !history || history.length === 0) {
    return null; // Not enough historical data
  }

  // Calculate historical averages
  const histAvg = new Map<string, { total: number; count: number }>();
  for (const row of history) {
    const key = `${row.persona}/${row.depth_level}`;
    const entry = histAvg.get(key) || { total: 0, count: 0 };
    entry.total += row.quality_score;
    entry.count++;
    histAvg.set(key, entry);
  }

  // Compare today's results
  const regressions: Array<{
    key: string;
    todayScore: number;
    historicalAvg: number;
    drop: number;
  }> = [];

  for (const r of results) {
    if (!r.evaluation) continue;
    const key = `${r.persona}/${r.depth}`;
    const hist = histAvg.get(key);
    if (!hist || hist.count < 3) continue; // Need at least 3 historical data points

    const avg = hist.total / hist.count;
    const drop = avg - r.evaluation.quality_score;

    // Significant regression: drop of 1.5+ points from historical average
    if (drop >= 1.5) {
      regressions.push({
        key,
        todayScore: r.evaluation.quality_score,
        historicalAvg: Math.round(avg * 10) / 10,
        drop: Math.round(drop * 10) / 10,
      });
    }
  }

  if (regressions.length === 0) return null;

  const worst = regressions.sort((a, b) => b.drop - a.drop)[0];

  return {
    pattern: "score_regression",
    summary: `スコア低下: ${worst.key} (${worst.historicalAvg} -> ${worst.todayScore})`,
    details: [
      "以下のパターンで過去14日間の平均スコアから有意な低下を検出:",
      ...regressions.map(
        (r) =>
          `- ${r.key}: 過去平均 ${r.historicalAvg} -> 今回 ${r.todayScore} (${r.drop}pt 低下)`,
      ),
    ].join("\n"),
    causeAnalysis: [
      "想定される原因:",
      "- 最近の knowledge.ts 同期で不適切なチャンクが追加された",
      "- Content Hub の記事が更新・削除され、以前回答できていた質問に答えられなくなった",
      "- CX Agent のデプロイで挙動が変化した",
    ].join("\n"),
    proposal: [
      "改善提案:",
      "1. 直近の knowledge.ts 同期ログを確認し、チャンク数の増減を把握する",
      "2. Content Hub の最近の記事ステータス変更を確認する",
      "3. regression_tests テーブルの結果と照合し、影響範囲を特定する",
    ].join("\n"),
    priority: PATTERN_PRIORITY.score_regression,
    dedupeKey: `score_regression:${worst.key}`,
  };
}

// ---------------------------------------------------------------------------
// Notion: Task creation + deduplication
// ---------------------------------------------------------------------------

/**
 * Check if a similar task was already created in the past DEDUPE_WINDOW_DAYS days.
 */
async function isDuplicateTask(
  notionToken: string,
  dedupeKey: string,
): Promise<boolean> {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - DEDUPE_WINDOW_DAYS);

  // Search All Tasks DB for tasks matching our pattern marker
  const res = await fetch(
    `https://api.notion.com/v1/databases/${ALL_TASKS_DB_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          and: [
            {
              property: "Task",
              title: {
                starts_with: "CX Agent 改善提案:",
              },
            },
            {
              property: "Created time",
              created_time: {
                on_or_after: sinceDate.toISOString(),
              },
            },
          ],
        },
        page_size: 50,
      }),
    },
  );

  if (!res.ok) {
    console.error(
      `[phase4] Dedupe check failed (${res.status}):`,
      (await res.text()).substring(0, 200),
    );
    return false; // On error, allow creation (fail open)
  }

  const data = (await res.json()) as {
    results: Array<{
      properties: {
        Details?: {
          rich_text: Array<{ plain_text: string }>;
        };
      };
    }>;
  };

  // Check if any existing task contains our dedupe key in Details
  for (const page of data.results) {
    const detailsText = page.properties?.Details?.rich_text
      ?.map((t: { plain_text: string }) => t.plain_text)
      .join("");
    if (detailsText && detailsText.includes(`[dedupe:${dedupeKey}]`)) {
      return true;
    }
  }

  return false;
}

/**
 * Calculate the next Monday at 12:00 JST (03:00 UTC).
 */
function getNextMondayNoonJST(): string {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, ...
  const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilMonday);
  // 12:00 JST = 03:00 UTC
  nextMonday.setUTCHours(3, 0, 0, 0);
  return nextMonday.toISOString();
}

/**
 * Create a Review task in All Tasks DB.
 */
async function createReviewTask(
  notionToken: string,
  issue: DetectedIssue,
): Promise<string | undefined> {
  const dueDate = getNextMondayNoonJST();

  const detailsContent = [
    issue.details,
    "",
    issue.causeAnalysis,
    "",
    issue.proposal,
    "",
    `[dedupe:${issue.dedupeKey}]`,
  ].join("\n");

  const properties: Record<string, unknown> = {
    Task: {
      title: [
        {
          text: {
            content: `CX Agent 改善提案: ${issue.summary}`.substring(0, 200),
          },
        },
      ],
    },
    Status: { status: { name: "Review" } },
    Priority: { select: { name: issue.priority } },
    "Approval Tier": { select: { name: "Tier 1" } },
    Project: {
      relation: [{ id: PROJECT_ID }],
    },
    Company: {
      relation: [{ id: COMPANY_ID }],
    },
    "Assignee for Task": {
      relation: [{ id: ASSIGNEE_BOSS_ID }],
    },
    Details: {
      rich_text: [
        {
          text: {
            content: detailsContent.substring(0, 2000),
          },
        },
      ],
    },
    "Due Date": {
      date: {
        start: dueDate,
      },
    },
  };

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: ALL_TASKS_DB_ID },
      properties,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(
      `[phase4] Task creation failed (${res.status}):`,
      errText.substring(0, 300),
    );
    return undefined;
  }

  const page = (await res.json()) as { id: string };
  return page.id;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run Phase 4: Analyze probe results, detect problem patterns, and create
 * Review tasks in All Tasks DB for each detected issue.
 *
 * @returns Array of created tasks (max 3)
 */
export async function analyzeAndCreateProposals(
  supabase: SupabaseClient,
  notionToken: string,
  results: ProbeResultForAnalysis[],
): Promise<CreatedTask[]> {
  console.log("\n=== Phase 4: Improvement Proposal Analysis ===");

  if (results.length === 0) {
    console.log("[phase4] No probe results to analyze");
    return [];
  }

  // Step 1: Detect all problem patterns
  const issues: DetectedIssue[] = [];

  const emptyIssue = detectEmptyResponses(results);
  if (emptyIssue) issues.push(emptyIssue);

  const lowScoreIssue = detectLowScoreTrend(results);
  if (lowScoreIssue) issues.push(lowScoreIssue);

  const ragMissIssue = detectRagSearchMiss(results);
  if (ragMissIssue) issues.push(ragMissIssue);

  const escalationIssue = detectExcessiveEscalation(results);
  if (escalationIssue) issues.push(escalationIssue);

  try {
    const regressionIssue = await detectScoreRegression(supabase, results);
    if (regressionIssue) issues.push(regressionIssue);
  } catch (err) {
    console.error(
      "[phase4] Regression detection failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (issues.length === 0) {
    console.log("[phase4] No problem patterns detected");
    return [];
  }

  console.log(`[phase4] ${issues.length} problem pattern(s) detected`);

  // Step 2: Deduplicate and create tasks (max MAX_TASKS_PER_RUN)
  const createdTasks: CreatedTask[] = [];

  for (const issue of issues) {
    if (createdTasks.length >= MAX_TASKS_PER_RUN) {
      console.log("[phase4] Max tasks per run reached, stopping");
      break;
    }

    // Check for duplicate
    console.log(`[phase4] Checking duplicate for: ${issue.dedupeKey}`);
    const isDuplicate = await isDuplicateTask(notionToken, issue.dedupeKey);
    if (isDuplicate) {
      console.log(`[phase4] Skipping (duplicate in past ${DEDUPE_WINDOW_DAYS} days): ${issue.summary}`);
      continue;
    }

    // Create task
    console.log(`[phase4] Creating task: ${issue.summary}`);
    const pageId = await createReviewTask(notionToken, issue);

    if (pageId) {
      console.log(`[phase4] Task created: ${pageId}`);
      createdTasks.push({
        pattern: issue.pattern,
        summary: issue.summary,
        notionPageId: pageId,
      });
    }
  }

  console.log(
    `[phase4] Total tasks created: ${createdTasks.length}/${issues.length} issues`,
  );

  return createdTasks;
}
