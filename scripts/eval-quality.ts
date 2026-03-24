/**
 * 会話品質評価スクリプト
 *
 * Supabase の conversations テーブルから直近の会話を取得し、
 * Claude API で5つの評価基準に基づいて品質を自動採点する。
 *
 * 評価基準:
 *   1. 応答精度 (1-5)
 *   2. ブランドトーン (1-5)
 *   3. 商品知識 (1-5)
 *   4. 会話の自然さ (1-5)
 *   5. アクション性 (1-5)
 *
 * Usage:
 *   npx tsx scripts/eval-quality.ts
 *   npx tsx scripts/eval-quality.ts --sample-size=10
 *   npx tsx scripts/eval-quality.ts --json
 *   npx tsx scripts/eval-quality.ts --channel=web
 *
 * 環境変数 (.dev.vars):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
 */

import dotenv from "dotenv";
import { readFileSync } from "fs";
import { join } from "path";

dotenv.config({ path: ".dev.vars" });

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const channelArg = args
  .find((a) => a.startsWith("--channel="))
  ?.split("=")[1] as "line" | "web" | undefined;
const sampleSizeArg = args
  .find((a) => a.startsWith("--sample-size="))
  ?.split("=")[1];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type QualityConfig = {
  min_total_score: number;
  min_per_category: number;
  unanswered_rate_threshold: number;
  sample_size: number;
  categories: Array<{
    key: string;
    label: string;
    description: string;
  }>;
};

const config: QualityConfig = JSON.parse(
  readFileSync(join(process.cwd(), "config/quality-thresholds.json"), "utf-8"),
);

const SAMPLE_SIZE = sampleSizeArg ? parseInt(sampleSizeArg, 10) : config.sample_size;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConversationPair = {
  user_message: string;
  assistant_response: string;
  channel: string;
  created_at: string;
  has_metadata: boolean;
  metadata: Record<string, unknown> | null;
};

type CategoryScore = {
  key: string;
  label: string;
  score: number;
  reasoning: string;
};

type EvalResult = {
  conversation_index: number;
  user_message: string;
  assistant_response_preview: string;
  channel: string;
  created_at: string;
  scores: CategoryScore[];
  total_score: number;
  is_good: boolean;
};

type QualityReport = {
  evaluated_at: string;
  sample_size: number;
  actual_evaluated: number;
  channel_filter: string | null;
  thresholds: {
    min_total_score: number;
    min_per_category: number;
    unanswered_rate_threshold: number;
  };
  summary: {
    avg_total_score: number;
    good_conversation_rate: number;
    good_count: number;
    category_averages: Record<string, number>;
    lowest_category: { key: string; label: string; avg: number };
    highest_category: { key: string; label: string; avg: number };
  };
  unanswered: {
    total_conversations: number;
    unanswered_count: number;
    unanswered_rate: number;
    within_threshold: boolean;
  };
  evaluations: EvalResult[];
};

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

async function supabaseQuery<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!res.ok) {
    throw new Error(
      `Supabase query failed: ${res.status} ${await res.text()}`,
    );
  }

  return res.json() as Promise<T>;
}

/**
 * 直近の会話ペア（user + assistant）を取得する。
 * 1つのユーザーメッセージとそれに対するアシスタント応答をペアにして返す。
 */
async function getRecentConversationPairs(
  limit: number,
  channel?: "line" | "web",
): Promise<ConversationPair[]> {
  let path = `/conversations?order=created_at.desc&limit=${limit * 2}`;
  if (channel) {
    path += `&channel=eq.${channel}`;
  }

  const rows = await supabaseQuery<
    Array<{
      role: string;
      content: string;
      channel: string;
      metadata: Record<string, unknown> | null;
      created_at: string;
    }>
  >(path);

  // 新しい順で取得しているので reverse して古い順にする
  const sorted = rows.reverse();

  // user -> assistant のペアを作成
  const pairs: ConversationPair[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].role === "user" && sorted[i + 1].role === "assistant") {
      pairs.push({
        user_message: sorted[i].content,
        assistant_response: sorted[i + 1].content,
        channel: sorted[i].channel,
        created_at: sorted[i].created_at,
        has_metadata: !!sorted[i + 1].metadata,
        metadata: sorted[i + 1].metadata,
      });
    }
  }

  // 最新の limit 件を返す
  return pairs.slice(-limit);
}

/**
 * unanswered_queries テーブルから未回答率を集計する。
 */
async function getUnansweredStats(
  channel?: "line" | "web",
): Promise<{ total: number; unanswered: number }> {
  // 直近30日の会話数
  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  let convPath = `/conversations?created_at=gte.${thirtyDaysAgo}&role=eq.user&select=id`;
  let unansweredPath = `/unanswered_queries?created_at=gte.${thirtyDaysAgo}&select=id`;

  if (channel) {
    convPath += `&channel=eq.${channel}`;
    unansweredPath += `&channel=eq.${channel}`;
  }

  const [conversations, unanswered] = await Promise.all([
    supabaseQuery<Array<{ id: string }>>(convPath),
    supabaseQuery<Array<{ id: string }>>(unansweredPath),
  ]);

  return {
    total: conversations.length,
    unanswered: unanswered.length,
  };
}

// ---------------------------------------------------------------------------
// Claude API -- quality evaluation
// ---------------------------------------------------------------------------

const EVAL_SYSTEM_PROMPT = `あなたは elxea（エルシア）の AI カスタマーエージェントの品質評価者です。
顧客との会話ペア（ユーザーメッセージ + AIの応答）を分析し、5つの評価基準でスコアリングしてください。

## elxea のブランド情報
- お茶とスキンケアのD2Cブランド
- 鹿児島の生産者と直接つながり、品質にこだわった商品を提供
- 温かく、対等な関係。友人のように接する
- 敬語ベースだが堅すぎない口調

## 評価基準

1. **応答精度** (accuracy): 質問に正しく答えているか。的外れな回答や未回答がないか。
2. **ブランドトーン** (brand_tone): elxea のブランドに合った温かく丁寧なトーンか。過度な敬語や冷たい表現がないか。
3. **商品知識** (product_knowledge): 商品情報が正確か。根拠のない情報の捏造がないか。
4. **会話の自然さ** (naturalness): 不自然な文脈切り替えや繰り返しがないか。簡潔な応答か。
5. **アクション性** (actionability): 商品提案時に商品カードやリンクなど、次のアクションへの導線があるか。一般的な質問への回答で導線不要な場合は 3 を基準とする。

## 出力形式

以下の JSON 形式で出力してください。JSON 以外のテキストは一切出力しないでください。

{
  "scores": [
    {"key": "accuracy", "score": 4, "reasoning": "質問に的確に回答している"},
    {"key": "brand_tone", "score": 5, "reasoning": "温かく親しみやすいトーン"},
    {"key": "product_knowledge", "score": 3, "reasoning": "基本情報は正確だが詳細が不足"},
    {"key": "naturalness", "score": 4, "reasoning": "自然な会話の流れ"},
    {"key": "actionability", "score": 4, "reasoning": "商品カードが提示されている"}
  ]
}`;

async function evaluateConversation(
  pair: ConversationPair,
): Promise<CategoryScore[]> {
  const metadataInfo = pair.metadata
    ? `\n\n[メタデータ]: ${JSON.stringify(pair.metadata)}`
    : "";

  const userContent = `以下の会話ペアを評価してください。

[ユーザーメッセージ]:
${pair.user_message}

[AI の応答]:
${pair.assistant_response}

[チャネル]: ${pair.channel}
[メタデータ有無]: ${pair.has_metadata ? "あり（商品カード等）" : "なし"}${metadataInfo}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      system: EVAL_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Claude API error: ${res.status} ${errorText}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  // JSON を抽出（コードブロック内の場合も対応）
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Failed to parse evaluation JSON: ${text}`);
  }

  const parsed = JSON.parse(jsonMatch[0]) as {
    scores: Array<{ key: string; score: number; reasoning: string }>;
  };

  return parsed.scores.map((s) => {
    const category = config.categories.find((c) => c.key === s.key);
    return {
      key: s.key,
      label: category?.label ?? s.key,
      score: Math.min(5, Math.max(1, s.score)),
      reasoning: s.reasoning,
    };
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
    console.error(
      "Missing required environment variables. Check .dev.vars file.",
    );
    console.error("Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY");
    process.exit(1);
  }

  if (!jsonOutput) {
    console.log("=".repeat(60));
    console.log("elxea CX Agent -- 会話品質評価");
    console.log(`Date: ${new Date().toLocaleString("ja-JP")}`);
    console.log(`Sample size: ${SAMPLE_SIZE}`);
    console.log(`Channel filter: ${channelArg ?? "all"}`);
    console.log("=".repeat(60));
  }

  // 会話ペアを取得
  if (!jsonOutput) console.log("\n会話データを取得中...");
  const pairs = await getRecentConversationPairs(SAMPLE_SIZE, channelArg);
  if (!jsonOutput)
    console.log(`  ${pairs.length} 件の会話ペアを取得しました\n`);

  if (pairs.length === 0) {
    console.error("評価対象の会話がありません。");
    process.exit(1);
  }

  // 各会話を評価
  const evaluations: EvalResult[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (!jsonOutput)
      process.stdout.write(
        `  [${i + 1}/${pairs.length}] 評価中... `,
      );

    try {
      const scores = await evaluateConversation(pair);
      const totalScore = scores.reduce((sum, s) => sum + s.score, 0);
      const isGood = totalScore >= config.min_total_score &&
        scores.every((s) => s.score >= config.min_per_category);

      evaluations.push({
        conversation_index: i + 1,
        user_message: pair.user_message,
        assistant_response_preview: pair.assistant_response.slice(0, 80),
        channel: pair.channel,
        created_at: pair.created_at,
        scores,
        total_score: totalScore,
        is_good: isGood,
      });

      if (!jsonOutput)
        console.log(
          `${totalScore}/25 ${isGood ? "GOOD" : "NEEDS_IMPROVEMENT"}`,
        );
    } catch (err) {
      if (!jsonOutput)
        console.log(
          `ERROR: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    // Claude API レートリミット回避
    if (i < pairs.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // 未回答率を集計
  if (!jsonOutput) console.log("\n未回答率を集計中...");
  const unansweredStats = await getUnansweredStats(channelArg);
  const unansweredRate =
    unansweredStats.total > 0
      ? unansweredStats.unanswered / unansweredStats.total
      : 0;

  // サマリーを計算
  const avgTotal =
    evaluations.length > 0
      ? evaluations.reduce((sum, e) => sum + e.total_score, 0) /
        evaluations.length
      : 0;

  const goodCount = evaluations.filter((e) => e.is_good).length;
  const goodRate =
    evaluations.length > 0 ? goodCount / evaluations.length : 0;

  // カテゴリ別平均
  const categoryAverages: Record<string, number> = {};
  for (const cat of config.categories) {
    const scores = evaluations
      .flatMap((e) => e.scores)
      .filter((s) => s.key === cat.key)
      .map((s) => s.score);
    categoryAverages[cat.key] =
      scores.length > 0
        ? scores.reduce((a, b) => a + b, 0) / scores.length
        : 0;
  }

  // 最低・最高カテゴリ
  const categoryEntries = Object.entries(categoryAverages).map(
    ([key, avg]) => ({
      key,
      label: config.categories.find((c) => c.key === key)?.label ?? key,
      avg,
    }),
  );
  categoryEntries.sort((a, b) => a.avg - b.avg);
  const lowest = categoryEntries[0];
  const highest = categoryEntries[categoryEntries.length - 1];

  // レポート構築
  const report: QualityReport = {
    evaluated_at: new Date().toISOString(),
    sample_size: SAMPLE_SIZE,
    actual_evaluated: evaluations.length,
    channel_filter: channelArg ?? null,
    thresholds: {
      min_total_score: config.min_total_score,
      min_per_category: config.min_per_category,
      unanswered_rate_threshold: config.unanswered_rate_threshold,
    },
    summary: {
      avg_total_score: Math.round(avgTotal * 10) / 10,
      good_conversation_rate: Math.round(goodRate * 1000) / 1000,
      good_count: goodCount,
      category_averages: Object.fromEntries(
        Object.entries(categoryAverages).map(([k, v]) => [
          k,
          Math.round(v * 10) / 10,
        ]),
      ),
      lowest_category: lowest,
      highest_category: highest,
    },
    unanswered: {
      total_conversations: unansweredStats.total,
      unanswered_count: unansweredStats.unanswered,
      unanswered_rate: Math.round(unansweredRate * 1000) / 1000,
      within_threshold:
        unansweredRate <= config.unanswered_rate_threshold,
    },
    evaluations,
  };

  // 出力
  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("\n" + "=".repeat(60));
    console.log("品質レポート");
    console.log("=".repeat(60));

    console.log(`\n## サマリー`);
    console.log(
      `  平均スコア: ${report.summary.avg_total_score}/25`,
    );
    console.log(
      `  良い会話率: ${(report.summary.good_conversation_rate * 100).toFixed(1)}% (${goodCount}/${evaluations.length})`,
    );

    console.log(`\n## カテゴリ別平均`);
    for (const cat of config.categories) {
      const avg = report.summary.category_averages[cat.key];
      const bar = "#".repeat(Math.round(avg));
      const indicator = avg < config.min_per_category ? " ** 要改善" : "";
      console.log(
        `  ${cat.label.padEnd(12)} ${avg.toFixed(1)}/5 ${bar}${indicator}`,
      );
    }

    console.log(
      `\n  最高: ${highest.label} (${highest.avg.toFixed(1)})`,
    );
    console.log(
      `  最低: ${lowest.label} (${lowest.avg.toFixed(1)})`,
    );

    console.log(`\n## 未回答率（直近30日）`);
    console.log(
      `  会話数: ${unansweredStats.total}`,
    );
    console.log(
      `  未回答数: ${unansweredStats.unanswered}`,
    );
    console.log(
      `  未回答率: ${(unansweredRate * 100).toFixed(1)}% (閾値: ${config.unanswered_rate_threshold * 100}%)`,
    );
    console.log(
      `  判定: ${report.unanswered.within_threshold ? "OK" : "** 閾値超過"}`,
    );

    // 低スコアの会話を表示
    const lowScores = evaluations.filter((e) => !e.is_good);
    if (lowScores.length > 0) {
      console.log(`\n## 要改善の会話 (${lowScores.length}件)`);
      for (const ev of lowScores) {
        console.log(
          `\n  [#${ev.conversation_index}] ${ev.total_score}/25 (${ev.channel})`,
        );
        console.log(
          `  User: ${ev.user_message.slice(0, 60)}`,
        );
        console.log(
          `  AI:   ${ev.assistant_response_preview}`,
        );
        for (const s of ev.scores.filter(
          (s) => s.score < config.min_per_category,
        )) {
          console.log(
            `  -> ${s.label}: ${s.score}/5 - ${s.reasoning}`,
          );
        }
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log(
      `評価完了: ${evaluations.length}件処理`,
    );
    console.log("JSON 出力: npx tsx scripts/eval-quality.ts --json");
  }
}

main().catch((err) => {
  console.error("Quality evaluation failed:", err);
  process.exit(1);
});
