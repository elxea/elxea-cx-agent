/**
 * Load Test -- elxea-cx-agent
 *
 * 10同時ユーザーが各5メッセージ送信（計50リクエスト）のシナリオで
 * ステージング環境の負荷テストを実行する。
 *
 * 使用方法:
 *   npx tsx tests/load/run-load-test.ts [--base-url <url>] [--users <n>] [--messages <n>]
 *
 * オプション:
 *   --base-url  テスト対象 URL（デフォルト: http://localhost:8787）
 *   --users     同時ユーザー数（デフォルト: 10）
 *   --messages  ユーザーあたりのメッセージ数（デフォルト: 5）
 *   --output    結果出力ファイル（デフォルト: tests/load/results.json）
 *
 * 計測項目:
 *   - p50 / p95 / p99 レスポンスタイム
 *   - エラー率
 *   - タイムアウト率（30秒超過）
 *   - スループット（req/sec）
 */

// ---------------------------------------------------------------------------
// 引数パース
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(name: string, defaultValue: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultValue;
}

const BASE_URL = getArg("base-url", "http://localhost:8787");
const NUM_USERS = parseInt(getArg("users", "10"), 10);
const MESSAGES_PER_USER = parseInt(getArg("messages", "5"), 10);
const OUTPUT_FILE = getArg(
  "output",
  `${__dirname}/results.json`,
);

const TIMEOUT_MS = 30_000; // 30 seconds
const TOTAL_REQUESTS = NUM_USERS * MESSAGES_PER_USER;

// ---------------------------------------------------------------------------
// テストメッセージ（バリエーション）
// ---------------------------------------------------------------------------

const TEST_MESSAGES = [
  "おすすめのお茶を教えてください",
  "ほうじ茶の値段はいくらですか？",
  "注文状況を確認したいです",
  "配送について教えてください",
  "緑茶と紅茶の違いを教えて",
  "ギフト用のおすすめはありますか？",
  "カフェインが少ないお茶はどれですか？",
  "返品について教えてください",
  "定期購入はできますか？",
  "お茶の淹れ方のコツを教えて",
];

// ---------------------------------------------------------------------------
// UUID v4 生成（外部依存なし）
// ---------------------------------------------------------------------------

function uuidv4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

type RequestResult = {
  userId: number;
  messageIndex: number;
  durationMs: number;
  status: number | "timeout" | "error";
  error?: string;
  isTimeout: boolean;
  isError: boolean;
};

type TestReport = {
  config: {
    baseUrl: string;
    numUsers: number;
    messagesPerUser: number;
    totalRequests: number;
    timeoutMs: number;
  };
  summary: {
    totalDurationMs: number;
    throughputReqPerSec: number;
    successCount: number;
    errorCount: number;
    timeoutCount: number;
    errorRate: number;
    timeoutRate: number;
  };
  latency: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    minMs: number;
    maxMs: number;
    avgMs: number;
  };
  results: RequestResult[];
  bottlenecks: string[];
  timestamp: string;
};

// ---------------------------------------------------------------------------
// リクエスト実行
// ---------------------------------------------------------------------------

async function sendMessage(
  sessionId: string,
  message: string,
): Promise<{ durationMs: number; status: number | "timeout" | "error"; error?: string }> {
  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, session_id: sessionId }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const durationMs = Date.now() - start;

    // SSE レスポンスのボディを読み完了を待つ
    await res.text();

    return { durationMs, status: res.status };
  } catch (err) {
    const durationMs = Date.now() - start;
    if (err instanceof Error && err.name === "AbortError") {
      return { durationMs, status: "timeout", error: "Request timed out" };
    }
    return {
      durationMs,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// ユーザーシミュレーション
// ---------------------------------------------------------------------------

async function simulateUser(userId: number): Promise<RequestResult[]> {
  const sessionId = uuidv4();
  const results: RequestResult[] = [];

  for (let i = 0; i < MESSAGES_PER_USER; i++) {
    const message = TEST_MESSAGES[(userId * MESSAGES_PER_USER + i) % TEST_MESSAGES.length];
    const res = await sendMessage(sessionId, message);

    results.push({
      userId,
      messageIndex: i,
      durationMs: res.durationMs,
      status: res.status,
      error: res.error,
      isTimeout: res.status === "timeout",
      isError: res.status === "error" || (typeof res.status === "number" && res.status >= 400),
    });

    // リクエスト間に短い待機（現実的なユーザー行動を模倣）
    if (i < MESSAGES_PER_USER - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 500));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// パーセンタイル計算
// ---------------------------------------------------------------------------

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

// ---------------------------------------------------------------------------
// ボトルネック分析
// ---------------------------------------------------------------------------

function analyzeBottlenecks(results: RequestResult[]): string[] {
  const bottlenecks: string[] = [];

  const successResults = results.filter((r) => !r.isError && !r.isTimeout);
  const durations = successResults.map((r) => r.durationMs).sort((a, b) => a - b);

  if (durations.length === 0) {
    bottlenecks.push("CRITICAL: All requests failed or timed out");
    return bottlenecks;
  }

  const p50 = percentile(durations, 50);
  const p99 = percentile(durations, 99);

  if (p50 > 5000) {
    bottlenecks.push(`HIGH: Median response time ${p50}ms exceeds 5s threshold`);
  }
  if (p99 > 15000) {
    bottlenecks.push(`HIGH: p99 response time ${p99}ms suggests tail latency issues`);
  }
  if (p99 / p50 > 5) {
    bottlenecks.push(
      `MEDIUM: Large p99/p50 ratio (${(p99 / p50).toFixed(1)}x) indicates inconsistent performance`,
    );
  }

  const errorRate = results.filter((r) => r.isError).length / results.length;
  if (errorRate > 0.05) {
    bottlenecks.push(`HIGH: Error rate ${(errorRate * 100).toFixed(1)}% exceeds 5% threshold`);
  }

  const timeoutRate = results.filter((r) => r.isTimeout).length / results.length;
  if (timeoutRate > 0.02) {
    bottlenecks.push(`HIGH: Timeout rate ${(timeoutRate * 100).toFixed(1)}% exceeds 2% threshold`);
  }

  // ユーザー別の偏り検出
  const userDurations = new Map<number, number[]>();
  for (const r of successResults) {
    const existing = userDurations.get(r.userId) ?? [];
    existing.push(r.durationMs);
    userDurations.set(r.userId, existing);
  }

  for (const [uid, times] of userDurations) {
    const userAvg = times.reduce((a, b) => a + b, 0) / times.length;
    if (userAvg > p50 * 2) {
      bottlenecks.push(
        `LOW: User ${uid} avg ${Math.round(userAvg)}ms is 2x+ the median (possible cold start or resource contention)`,
      );
    }
  }

  if (bottlenecks.length === 0) {
    bottlenecks.push("No significant bottlenecks detected");
  }

  return bottlenecks;
}

// ---------------------------------------------------------------------------
// メイン実行
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(70));
  console.log("elxea-cx-agent Load Test");
  console.log("=".repeat(70));
  console.log(`Target:     ${BASE_URL}`);
  console.log(`Users:      ${NUM_USERS} concurrent`);
  console.log(`Messages:   ${MESSAGES_PER_USER} per user`);
  console.log(`Total:      ${TOTAL_REQUESTS} requests`);
  console.log(`Timeout:    ${TIMEOUT_MS}ms`);
  console.log("=".repeat(70));
  console.log();

  // ヘルスチェック
  console.log("Checking target availability...");
  try {
    const healthRes = await fetch(BASE_URL);
    if (!healthRes.ok) {
      console.error(`Health check failed: ${healthRes.status}`);
      process.exit(1);
    }
    console.log("Target is available.\n");
  } catch (err) {
    console.error(`Cannot reach ${BASE_URL}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }

  // テスト実行
  console.log(`Starting ${NUM_USERS} concurrent users...`);
  const testStart = Date.now();

  const userPromises = Array.from({ length: NUM_USERS }, (_, i) => simulateUser(i));
  const allResults = (await Promise.all(userPromises)).flat();

  const totalDurationMs = Date.now() - testStart;

  // 集計
  const successResults = allResults.filter((r) => !r.isError && !r.isTimeout);
  const durations = successResults.map((r) => r.durationMs).sort((a, b) => a - b);

  const errorCount = allResults.filter((r) => r.isError).length;
  const timeoutCount = allResults.filter((r) => r.isTimeout).length;

  const p50 = percentile(durations, 50);
  const p95 = percentile(durations, 95);
  const p99 = percentile(durations, 99);
  const minMs = durations.length > 0 ? durations[0] : 0;
  const maxMs = durations.length > 0 ? durations[durations.length - 1] : 0;
  const avgMs = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  const bottlenecks = analyzeBottlenecks(allResults);

  const report: TestReport = {
    config: {
      baseUrl: BASE_URL,
      numUsers: NUM_USERS,
      messagesPerUser: MESSAGES_PER_USER,
      totalRequests: TOTAL_REQUESTS,
      timeoutMs: TIMEOUT_MS,
    },
    summary: {
      totalDurationMs,
      throughputReqPerSec: parseFloat((TOTAL_REQUESTS / (totalDurationMs / 1000)).toFixed(2)),
      successCount: successResults.length,
      errorCount,
      timeoutCount,
      errorRate: parseFloat((errorCount / TOTAL_REQUESTS).toFixed(4)),
      timeoutRate: parseFloat((timeoutCount / TOTAL_REQUESTS).toFixed(4)),
    },
    latency: {
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99,
      minMs,
      maxMs,
      avgMs,
    },
    results: allResults,
    bottlenecks,
    timestamp: new Date().toISOString(),
  };

  // レポート出力
  console.log("\n" + "=".repeat(70));
  console.log("RESULTS");
  console.log("=".repeat(70));
  console.log(`Total duration:    ${totalDurationMs}ms (${(totalDurationMs / 1000).toFixed(1)}s)`);
  console.log(`Throughput:        ${report.summary.throughputReqPerSec} req/sec`);
  console.log(`Success:           ${successResults.length}/${TOTAL_REQUESTS}`);
  console.log(`Errors:            ${errorCount} (${(report.summary.errorRate * 100).toFixed(1)}%)`);
  console.log(`Timeouts:          ${timeoutCount} (${(report.summary.timeoutRate * 100).toFixed(1)}%)`);
  console.log();
  console.log("Latency:");
  console.log(`  p50:             ${p50}ms`);
  console.log(`  p95:             ${p95}ms`);
  console.log(`  p99:             ${p99}ms`);
  console.log(`  min:             ${minMs}ms`);
  console.log(`  max:             ${maxMs}ms`);
  console.log(`  avg:             ${avgMs}ms`);
  console.log();
  console.log("Bottleneck Analysis:");
  for (const b of bottlenecks) {
    console.log(`  - ${b}`);
  }
  console.log();

  // JSON 出力
  const { writeFileSync, mkdirSync } = await import("fs");
  const { dirname } = await import("path");
  mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
  console.log(`Full report saved to: ${OUTPUT_FILE}`);

  // 終了コード: エラー率 > 10% なら失敗
  if (report.summary.errorRate > 0.1) {
    console.log("\n[FAIL] Error rate exceeds 10%");
    process.exit(1);
  }

  console.log("\n[PASS] Load test completed successfully");
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
