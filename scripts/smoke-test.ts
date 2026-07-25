/**
 * スモークテスト -- ソフトローンチ前の動作確認
 *
 * Web Chat API に3つのテストケースを送信し、応答を検証する。
 * LINE テストは Web Chat API 経由では実施できないため、
 * Web チャネルのみの検証となる。LINE は手動確認が必要。
 *
 * テストケース:
 *   1. 「おすすめのお茶を教えて」 -> 商品カードが返る
 *   2. 「このお茶の特徴は？」 -> RAG 引用を含む応答
 *   3. 「人間に相談したい」 -> エスカレーション発動
 *
 * Usage:
 *   npx tsx scripts/smoke-test.ts
 *   npx tsx scripts/smoke-test.ts --target=https://elxea-agent-staging.setaka-on.workers.dev
 *
 * 環境変数:
 *   WEB_CHAT_BASE_URL -- 省略時は本番 Worker URL を使用
 */

import * as crypto from "node:crypto";

const args = process.argv.slice(2);
const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1];

const BASE_URL =
  targetArg ??
  process.env.WEB_CHAT_BASE_URL ??
  "https://elxea-agent.elxea.workers.dev";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SSEEvent = {
  type: string;
  content?: string;
  products?: Array<{
    name: string;
    price: string;
    url: string;
    image: string | null;
    description: string;
  }>;
  items?: Array<{ label: string; text: string }>;
  checkout_url?: string;
  session_id?: string;
};

type TestResult = {
  name: string;
  pass: boolean;
  responseTimeMs: number;
  details: string;
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function sendMessage(
  message: string,
  sessionId: string,
): Promise<{
  status: number;
  events: SSEEvent[];
  fullText: string;
  durationMs: number;
  error?: string;
}> {
  const start = Date.now();

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, session_id: sessionId }),
    });
  } catch (err) {
    return {
      status: 0,
      events: [],
      fullText: "",
      durationMs: Date.now() - start,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const durationMs = Date.now() - start;

  if (!res.ok) {
    let errorBody: string;
    try {
      errorBody = JSON.stringify(await res.json());
    } catch {
      errorBody = await res.text();
    }
    return { status: res.status, events: [], fullText: "", durationMs, error: errorBody };
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
        // skip
      }
    }
  }

  return { status: res.status, events, fullText, durationMs };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

async function testProductRecommendation(sessionId: string): Promise<TestResult> {
  const r = await sendMessage("おすすめのお茶を教えて", sessionId);

  if (r.error) {
    return {
      name: "商品おすすめ -> 商品カード",
      pass: false,
      responseTimeMs: r.durationMs,
      details: `Error: ${r.error}`,
    };
  }

  const hasText = r.fullText.length > 0;
  const hasDone = r.events.some((e) => e.type === "done");
  const hasProductCard = r.events.some((e) => e.type === "product_card");
  const hasQuickReplies = r.events.some((e) => e.type === "quick_replies");

  const pass = hasText && hasDone;

  const details = [
    `HTTP ${r.status}`,
    `Response: ${r.fullText.slice(0, 80)}...`,
    `Product card: ${hasProductCard ? "YES" : "NO"}`,
    `Quick replies: ${hasQuickReplies ? "YES" : "NO"}`,
    hasProductCard
      ? `Products: ${r.events
          .filter((e) => e.type === "product_card")
          .flatMap((e) => e.products?.map((p) => p.name) ?? [])
          .join(", ")}`
      : "",
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    name: "商品おすすめ -> 商品カード",
    pass,
    responseTimeMs: r.durationMs,
    details,
  };
}

async function testRAGResponse(sessionId: string): Promise<TestResult> {
  const r = await sendMessage("このお茶の特徴は？", sessionId);

  if (r.error) {
    return {
      name: "お茶の特徴 -> RAG 引用応答",
      pass: false,
      responseTimeMs: r.durationMs,
      details: `Error: ${r.error}`,
    };
  }

  const hasText = r.fullText.length > 0;
  const hasDone = r.events.some((e) => e.type === "done");

  // RAG 引用の兆候: お茶関連のキーワードが含まれているか
  const teaKeywords = [
    "茶", "味", "香り", "産地", "品種", "フレーバー", "淹れ",
    "飲み", "おすすめ", "特徴", "甘", "渋", "まろやか",
  ];
  const hasTeaContent = teaKeywords.some((kw) => r.fullText.includes(kw));

  const pass = hasText && hasDone;

  return {
    name: "お茶の特徴 -> RAG 引用応答",
    pass,
    responseTimeMs: r.durationMs,
    details: `HTTP ${r.status} | Response: ${r.fullText.slice(0, 80)}... | Tea content: ${hasTeaContent ? "YES" : "NO"}`,
  };
}

async function testEscalation(sessionId: string): Promise<TestResult> {
  const r = await sendMessage("人間に相談したい", sessionId);

  if (r.error) {
    return {
      name: "人間に相談 -> エスカレーション",
      pass: false,
      responseTimeMs: r.durationMs,
      details: `Error: ${r.error}`,
    };
  }

  const hasText = r.fullText.length > 0;
  const hasDone = r.events.some((e) => e.type === "done");

  // エスカレーション応答の兆候
  const escalationKeywords = ["確認", "お待ち", "スタッフ", "担当", "対応", "お返事"];
  const hasEscalationResponse = escalationKeywords.some((kw) =>
    r.fullText.includes(kw),
  );

  const pass = hasText && hasDone && hasEscalationResponse;

  return {
    name: "人間に相談 -> エスカレーション",
    pass,
    responseTimeMs: r.durationMs,
    details: `HTTP ${r.status} | Response: ${r.fullText.slice(0, 80)}... | Escalation keywords: ${hasEscalationResponse ? "YES" : "NO"}`,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=".repeat(60));
  console.log("elxea CX Agent -- Smoke Test");
  console.log(`Target: ${BASE_URL}`);
  console.log(`Date: ${new Date().toLocaleString("ja-JP")}`);
  console.log("=".repeat(60));

  // Health check
  console.log("\n[0] Health check...");
  try {
    const healthRes = await fetch(`${BASE_URL}/`);
    const healthBody = await healthRes.json() as { status: string };
    console.log(`  HTTP ${healthRes.status}: ${JSON.stringify(healthBody)}`);
    if (healthRes.status !== 200) {
      console.error("  FAIL: Worker is not responding");
      process.exit(1);
    }
  } catch (err) {
    console.error(`  FAIL: Cannot reach ${BASE_URL}`);
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const sessionId = crypto.randomUUID();
  console.log(`\nSession: ${sessionId}`);
  console.log("");

  const results: TestResult[] = [];

  // Test 1: 商品おすすめ
  console.log("[1] 商品おすすめ -> 商品カード");
  const r1 = await testProductRecommendation(sessionId);
  results.push(r1);
  console.log(`  ${r1.pass ? "PASS" : "FAIL"} (${r1.responseTimeMs}ms)`);
  console.log(`  ${r1.details}`);

  await sleep(3000); // レートリミット回避

  // Test 2: お茶の特徴（前のメッセージの文脈を活かす）
  console.log("\n[2] お茶の特徴 -> RAG 引用応答");
  const r2 = await testRAGResponse(sessionId);
  results.push(r2);
  console.log(`  ${r2.pass ? "PASS" : "FAIL"} (${r2.responseTimeMs}ms)`);
  console.log(`  ${r2.details}`);

  await sleep(3000);

  // Test 3: エスカレーション（別セッション）
  const escalationSession = crypto.randomUUID();
  console.log("\n[3] 人間に相談 -> エスカレーション");
  const r3 = await testEscalation(escalationSession);
  results.push(r3);
  console.log(`  ${r3.pass ? "PASS" : "FAIL"} (${r3.responseTimeMs}ms)`);
  console.log(`  ${r3.details}`);

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("Summary");
  console.log("=".repeat(60));

  const allPassed = results.every((r) => r.pass);
  for (const r of results) {
    console.log(`  [${r.pass ? "PASS" : "FAIL"}] ${r.name} (${r.responseTimeMs}ms)`);
  }

  const avgResponseTime =
    results.reduce((sum, r) => sum + r.responseTimeMs, 0) / results.length;
  console.log(`\n  Average response time: ${Math.round(avgResponseTime)}ms`);
  console.log(`  Overall: ${allPassed ? "ALL PASSED" : "SOME FAILED"}`);

  if (!allPassed) {
    console.log("\n  Failed tests:");
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`    - ${r.name}: ${r.details}`);
    }
  }

  console.log("\n  Note: Slack notification for escalation test needs manual verification.");
  console.log("  Note: LINE channel tests require manual verification via LINE app.");

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  process.exit(1);
});
