/**
 * 検索品質自動テスト — elxea-agent
 *
 * ゴールドスタンダード（gold-standard.json）の50件のテストケースに対して
 * ハイブリッド検索を実行し、以下の指標を測定する:
 *
 *   - Recall@5: 期待チャンクが上位5件に含まれる割合
 *   - Precision@5: 上位5件中、期待された source_type のチャンクの割合
 *   - MRR (Mean Reciprocal Rank): 最初の正解チャンクの順位の逆数の平均
 *   - Classifier Accuracy: クエリ分類の正解率
 *
 * 使用方法:
 *   npx tsx tests/search-quality/run-search-quality.ts [--discover] [--verbose] [--threshold=0.7]
 *
 *   --discover: expected_chunk_ids が空のテストケースに対して、実際の検索結果から正解チャンクを発見してレポート
 *   --verbose:  各テストケースの詳細を出力
 *   --threshold=0.7: Recall@5 の合格閾値（デフォルト 0.7）。この値を下回るとアラート
 *
 * CI での使用:
 *   npx tsx tests/search-quality/run-search-quality.ts --threshold=0.7
 *   終了コード: 0=合格, 1=閾値未達またはエラー
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { classifyQuery, debugClassifyQuery } from "../../src/lib/query-classifier.js";
import { searchKnowledgeHybrid } from "../../src/lib/supabase.js";

dotenv.config({ path: path.resolve(process.cwd(), ".dev.vars") });

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "66e8e422866873db86f63fcf0c09673f";

/** デフォルトの合格閾値（Recall@5） */
const DEFAULT_THRESHOLD = 0.7;

/** 検索上位件数 */
const TOP_K = 5;

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

type TestCase = {
  id: string;
  category: string;
  query: string;
  expected_source_types: string[];
  expected_chunk_ids: string[];
  expected_classifier_result: string | null;
  min_similarity: number;
  notes: string;
};

type GoldStandard = {
  version: string;
  description: string;
  notes: string[];
  test_cases: TestCase[];
};

type TestResult = {
  testCase: TestCase;
  retrievedChunks: Array<{
    id: string;
    source_type: string;
    source_title: string;
    similarity: number;
  }>;
  classifierResult: string | null;
  classifierScores: Record<string, number>;
  // 各メトリクス
  recallAt5: number | null;      // expected_chunk_ids が設定されている場合のみ計算
  precisionAt5: number;           // source_type ベースの精度
  reciprocalRank: number | null;  // expected_chunk_ids が設定されている場合のみ計算
  classifierCorrect: boolean | null; // expected_classifier_result が設定されている場合のみ
  topSimilarity: number;
  meetsMinSimilarity: boolean;
};

// ---------------------------------------------------------------------------
// Embedding 生成（Cloudflare Workers AI REST API — sync-knowledge.ts と同じ方式）
// ---------------------------------------------------------------------------

let cachedCfToken: string | null = null;

function getWranglerOAuthToken(): string {
  const configPath = path.join(
    os.homedir(),
    "Library",
    "Preferences",
    ".wrangler",
    "config",
    "default.toml",
  );
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (!match) throw new Error("oauth_token not found in wrangler config");
    return match[1];
  } catch {
    throw new Error("wrangler OAuth token not found. Run `npx wrangler login` first.");
  }
}

async function createEmbedding(text: string): Promise<number[]> {
  if (!cachedCfToken) {
    cachedCfToken = getWranglerOAuthToken();
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/baai/bge-m3`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cachedCfToken}`,
      },
      body: JSON.stringify({ text: [text] }),
    },
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Cloudflare AI API error: ${res.status} ${errorText}`);
  }

  const json = (await res.json()) as {
    result: { data: number[][] };
    success: boolean;
  };

  if (!json.success || !json.result?.data?.[0]) {
    throw new Error(`Cloudflare AI returned unexpected response`);
  }

  return json.result.data[0];
}

// ---------------------------------------------------------------------------
// テスト実行
// ---------------------------------------------------------------------------

async function runTestCase(
  tc: TestCase,
  supabase: ReturnType<typeof createClient>,
  verbose: boolean,
): Promise<TestResult> {
  // Embedding 生成
  const embedding = await createEmbedding(tc.query);

  // クエリ分類
  const { result: classifierResult, scores: classifierScores } = debugClassifyQuery(tc.query);

  // ハイブリッド検索（フィルタなし — ゴールドスタンダードは実際の検索パフォーマンスを測定）
  const chunks = await searchKnowledgeHybrid(
    supabase,
    embedding,
    tc.query,
    TOP_K,
    0.1, // 低い閾値で多くの結果を取得して評価
    null, // フィルタなし（素の検索性能を測定）
  );

  const retrievedChunks = chunks.map((c) => ({
    id: c.id,
    source_type: c.source_type,
    source_title: c.source_title,
    similarity: c.similarity,
  }));

  const topSimilarity = retrievedChunks.length > 0 ? retrievedChunks[0].similarity : 0;
  const meetsMinSimilarity = topSimilarity >= tc.min_similarity;

  // Recall@5: expected_chunk_ids が設定されている場合のみ計算
  let recallAt5: number | null = null;
  let reciprocalRank: number | null = null;
  if (tc.expected_chunk_ids.length > 0) {
    const retrievedIds = new Set(retrievedChunks.map((c) => c.id));
    const matchCount = tc.expected_chunk_ids.filter((id) => retrievedIds.has(id)).length;
    recallAt5 = matchCount / tc.expected_chunk_ids.length;

    // MRR: 最初の正解チャンクの順位
    for (let i = 0; i < retrievedChunks.length; i++) {
      if (tc.expected_chunk_ids.includes(retrievedChunks[i].id)) {
        reciprocalRank = 1 / (i + 1);
        break;
      }
    }
    if (reciprocalRank === null) reciprocalRank = 0;
  }

  // Precision@5: source_type ベースの精度
  let precisionAt5 = 0;
  if (retrievedChunks.length > 0 && tc.expected_source_types.length > 0) {
    const relevantCount = retrievedChunks.filter((c) =>
      tc.expected_source_types.includes(c.source_type)
    ).length;
    precisionAt5 = relevantCount / retrievedChunks.length;
  }

  // Classifier 正解率
  let classifierCorrect: boolean | null = null;
  if (tc.expected_classifier_result !== undefined) {
    classifierCorrect = classifierResult === tc.expected_classifier_result;
  }

  if (verbose) {
    console.log(`\n  [${tc.id}] ${tc.query}`);
    console.log(`    分類: ${classifierResult ?? "null"} (期待: ${tc.expected_classifier_result ?? "null"})`);
    console.log(`    取得チャンク数: ${retrievedChunks.length}`);
    if (retrievedChunks.length > 0) {
      console.log(`    トップ類似度: ${topSimilarity.toFixed(3)} (最小閾値: ${tc.min_similarity})`);
      console.log(`    Precision@5: ${(precisionAt5 * 100).toFixed(0)}%`);
      retrievedChunks.slice(0, 3).forEach((c, i) => {
        console.log(`      ${i + 1}. [${c.source_type}] ${c.source_title} (${c.similarity.toFixed(3)})`);
      });
    }
    if (!meetsMinSimilarity) {
      console.log(`    WARNING: 類似度が最小閾値 ${tc.min_similarity} を下回っています`);
    }
  }

  return {
    testCase: tc,
    retrievedChunks,
    classifierResult,
    classifierScores,
    recallAt5,
    precisionAt5,
    reciprocalRank,
    classifierCorrect,
    topSimilarity,
    meetsMinSimilarity,
  };
}

// ---------------------------------------------------------------------------
// メトリクス集計
// ---------------------------------------------------------------------------

type Metrics = {
  totalCases: number;
  casesWithChunkIds: number;
  casesWithClassifierExpectation: number;
  avgRecallAt5: number | null;
  avgPrecisionAt5: number;
  avgMRR: number | null;
  classifierAccuracy: number | null;
  minSimilarityPassRate: number;
  failedCases: string[];
  alertTriggered: boolean;
};

function computeMetrics(results: TestResult[], threshold: number): Metrics {
  const casesWithChunkIds = results.filter((r) => r.recallAt5 !== null);
  const casesWithClassifier = results.filter((r) => r.classifierCorrect !== null);

  const avgRecallAt5 =
    casesWithChunkIds.length > 0
      ? casesWithChunkIds.reduce((sum, r) => sum + (r.recallAt5 ?? 0), 0) / casesWithChunkIds.length
      : null;

  const avgPrecisionAt5 =
    results.reduce((sum, r) => sum + r.precisionAt5, 0) / results.length;

  const avgMRR =
    casesWithChunkIds.length > 0
      ? casesWithChunkIds.reduce((sum, r) => sum + (r.reciprocalRank ?? 0), 0) / casesWithChunkIds.length
      : null;

  const classifierAccuracy =
    casesWithClassifier.length > 0
      ? casesWithClassifier.filter((r) => r.classifierCorrect).length / casesWithClassifier.length
      : null;

  const minSimilarityPassRate =
    results.filter((r) => r.meetsMinSimilarity).length / results.length;

  const failedCases = results
    .filter((r) => !r.meetsMinSimilarity || r.precisionAt5 < 0.4)
    .map((r) => r.testCase.id);

  // アラート条件: Precision@5 が閾値を下回る
  const alertTriggered = avgPrecisionAt5 < threshold;

  return {
    totalCases: results.length,
    casesWithChunkIds: casesWithChunkIds.length,
    casesWithClassifierExpectation: casesWithClassifier.length,
    avgRecallAt5,
    avgPrecisionAt5,
    avgMRR,
    classifierAccuracy,
    minSimilarityPassRate,
    failedCases,
    alertTriggered,
  };
}

// ---------------------------------------------------------------------------
// Discover モード: 正解チャンクを発見してレポート
// ---------------------------------------------------------------------------

function generateDiscoverReport(results: TestResult[]): void {
  console.log("\n" + "=".repeat(60));
  console.log("DISCOVER モード — 期待チャンク候補");
  console.log("=".repeat(60));
  console.log("以下の内容を gold-standard.json の expected_chunk_ids に設定してください\n");

  const updates: Record<string, string[]> = {};
  for (const r of results) {
    if (r.testCase.expected_chunk_ids.length === 0 && r.retrievedChunks.length > 0) {
      // 上位3件を候補として提示
      const candidates = r.retrievedChunks
        .slice(0, 3)
        .filter((c) => c.similarity >= r.testCase.min_similarity)
        .filter((c) => r.testCase.expected_source_types.includes(c.source_type));

      if (candidates.length > 0) {
        updates[r.testCase.id] = candidates.map((c) => c.id);
        console.log(`[${r.testCase.id}] ${r.testCase.query}`);
        candidates.forEach((c) => {
          console.log(`  - "${c.id}" (${c.source_type}: ${c.source_title}, sim=${c.similarity.toFixed(3)})`);
        });
      }
    }
  }

  console.log(`\n合計 ${Object.keys(updates).length} 件の候補を発見`);
}

// ---------------------------------------------------------------------------
// メイン実行
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const discoverMode = args.includes("--discover");
  const verbose = args.includes("--verbose");
  const thresholdArg = args.find((a) => a.startsWith("--threshold="))?.split("=")[1];
  const threshold = thresholdArg ? parseFloat(thresholdArg) : DEFAULT_THRESHOLD;

  console.log("=".repeat(60));
  console.log("elxea-agent 検索品質自動テスト");
  console.log(`日時: ${new Date().toLocaleString("ja-JP")}`);
  console.log(`合格閾値 (Precision@5): ${(threshold * 100).toFixed(0)}%`);
  if (discoverMode) console.log("モード: DISCOVER（正解チャンク候補を発見）");
  console.log("=".repeat(60));

  // 環境変数チェック
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("ERROR: SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が設定されていません");
    process.exit(1);
  }

  // ゴールドスタンダードを読み込む
  const goldStandardPath = path.resolve(
    process.cwd(),
    "tests/search-quality/gold-standard.json",
  );
  const goldStandard: GoldStandard = JSON.parse(
    fs.readFileSync(goldStandardPath, "utf-8"),
  );

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  console.log(`\nテストケース数: ${goldStandard.test_cases.length}`);
  console.log("テスト実行中...\n");

  const results: TestResult[] = [];
  let processed = 0;

  for (const tc of goldStandard.test_cases) {
    try {
      const result = await runTestCase(tc, supabase, verbose);
      results.push(result);
      processed++;
      if (!verbose) {
        process.stdout.write(`\r進捗: ${processed}/${goldStandard.test_cases.length}`);
      }
      // Rate limit 対策
      await new Promise((r) => setTimeout(r, 300));
    } catch (error) {
      console.error(`\nERROR [${tc.id}]: ${error}`);
      processed++;
    }
  }

  if (!verbose) console.log();

  // メトリクス集計
  const metrics = computeMetrics(results, threshold);

  // レポート出力
  console.log("\n" + "=".repeat(60));
  console.log("テスト結果サマリー");
  console.log("=".repeat(60));
  console.log(`テストケース数:           ${metrics.totalCases}`);
  console.log(`Precision@5:             ${(metrics.avgPrecisionAt5 * 100).toFixed(1)}% (閾値: ${(threshold * 100).toFixed(0)}%)`);
  if (metrics.avgRecallAt5 !== null) {
    console.log(`Recall@5:                ${(metrics.avgRecallAt5 * 100).toFixed(1)}% (正解チャンク設定済み: ${metrics.casesWithChunkIds}件)`);
  } else {
    console.log(`Recall@5:                N/A (expected_chunk_ids が未設定 — --discover モードで設定してください)`);
  }
  if (metrics.avgMRR !== null) {
    console.log(`MRR:                     ${metrics.avgMRR.toFixed(3)}`);
  }
  if (metrics.classifierAccuracy !== null) {
    console.log(`Classifier Accuracy:     ${(metrics.classifierAccuracy * 100).toFixed(1)}% (${metrics.casesWithClassifierExpectation}件)`);
  }
  console.log(`Min Similarity Pass:     ${(metrics.minSimilarityPassRate * 100).toFixed(1)}%`);

  if (metrics.failedCases.length > 0) {
    console.log(`\n要注意テストケース (${metrics.failedCases.length}件):`);
    metrics.failedCases.forEach((id) => {
      const r = results.find((r) => r.testCase.id === id);
      if (r) {
        console.log(`  [${id}] "${r.testCase.query}" — Precision: ${(r.precisionAt5 * 100).toFixed(0)}%, TopSim: ${r.topSimilarity.toFixed(3)}`);
      }
    });
  }

  if (metrics.alertTriggered) {
    console.log("\nALERT: Precision@5 が閾値を下回っています！");
    console.log("パイプライン変更によるリグレッションの可能性があります。");
    console.log("検索パラメータ・ナレッジ同期・Embedding 変更を確認してください。");
  } else {
    console.log("\nOK: Precision@5 が閾値を満たしています。");
  }

  // Discover モード
  if (discoverMode) {
    generateDiscoverReport(results);
  }

  // 結果をファイルに保存（CI レポート用）
  const reportPath = path.resolve(process.cwd(), "tests/search-quality/latest-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        threshold,
        metrics,
        results: results.map((r) => ({
          id: r.testCase.id,
          query: r.testCase.query,
          category: r.testCase.category,
          classifierResult: r.classifierResult,
          classifierCorrect: r.classifierCorrect,
          precisionAt5: r.precisionAt5,
          recallAt5: r.recallAt5,
          reciprocalRank: r.reciprocalRank,
          topSimilarity: r.topSimilarity,
          meetsMinSimilarity: r.meetsMinSimilarity,
          topChunks: r.retrievedChunks.slice(0, 3),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nレポート保存: ${reportPath}`);

  process.exit(metrics.alertTriggered ? 1 : 0);
}

main().catch((err) => {
  console.error("検索品質テスト実行エラー:", err);
  process.exit(1);
});
