/**
 * Unit Tests -- line-insight（LINE Insight unit 別統計・P0-7b 取得側）
 *
 * 純粋パース + date range + 実 fetch アダプタ（globalThis.fetch を stub）を検証する。
 * 実 LINE API には触れない（fetch を差し替える）。
 *
 * 使用方法:
 *   npx tsx tests/unit/line-insight.test.ts
 */

import {
  parseUnitEventStats,
  insightDateRange,
  createLineUnitStatsFetcher,
  LINE_INSIGHT_EVENT_AGGREGATION_URL,
} from "../../src/lib/line-insight";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function it(name: string, fn: () => void | Promise<void>) {
  queue.push({ name, fn });
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ---- parseUnitEventStats ----
it("overview の数値をそのまま取り出す", () => {
  const r = parseUnitEventStats({
    overview: { uniqueImpression: 40, uniqueClick: 12 },
  });
  assertEqual(r.ok, true, "ok");
  assertEqual(r.uniqueImpression, 40, "impression");
  assertEqual(r.uniqueClick, 12, "click");
});

it("ユニーク20人未満の null をそのまま透過する（LINE 仕様）", () => {
  const r = parseUnitEventStats({
    overview: { uniqueImpression: null, uniqueClick: null },
  });
  assertEqual(r.ok, true, "ok（取得は成功）");
  assertEqual(r.uniqueImpression, null, "impression null");
  assertEqual(r.uniqueClick, null, "click null");
});

it("overview 欠落は ok:true・値 null（対象期間イベント無し等）", () => {
  const r = parseUnitEventStats({});
  assertEqual(r.ok, true);
  assertEqual(r.uniqueImpression, null);
  assertEqual(r.uniqueClick, null);
});

it("非 object（null / 文字列）は ok:false・値 null", () => {
  assertEqual(parseUnitEventStats(null).ok, false);
  assertEqual(parseUnitEventStats("x").ok, false);
  assertEqual(parseUnitEventStats(null).uniqueImpression, null);
});

it("NaN / Infinity / 非数値は null に正規化する", () => {
  const r = parseUnitEventStats({
    overview: { uniqueImpression: Number.NaN, uniqueClick: "3" },
  });
  assertEqual(r.uniqueImpression, null, "NaN→null");
  assertEqual(r.uniqueClick, null, "文字列→null");
});

// ---- insightDateRange ----
it("insightDateRange は JST の YYYYMMDD で from<=to を返す", () => {
  // 2026-08-07 10:00 UTC = 2026-08-07 19:00 JST
  const delivered = new Date("2026-08-07T10:00:00Z");
  const now = new Date("2026-08-10T10:00:00Z");
  const { from, to } = insightDateRange(delivered, now);
  assertEqual(from, "20260807", "from");
  assertEqual(to, "20260810", "to");
});

it("JST 日跨ぎ: UTC 前日 15:30 は JST 翌日 00:30", () => {
  // 2026-08-06 15:30 UTC = 2026-08-07 00:30 JST
  const d = new Date("2026-08-06T15:30:00Z");
  const { from } = insightDateRange(d, d);
  assertEqual(from, "20260807", "JST 日付");
});

// ---- createLineUnitStatsFetcher（globalThis.fetch stub）----
it("アダプタ: 200 を parse し、正しい URL/認証で GET する", async () => {
  const realFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedAuth = "";
  // @ts-expect-error test stub
  globalThis.fetch = async (url: string, init: RequestInit) => {
    capturedUrl = String(url);
    capturedAuth = String(
      (init?.headers as Record<string, string>)?.Authorization ?? "",
    );
    return {
      ok: true,
      json: async () => ({ overview: { uniqueImpression: 40, uniqueClick: 5 } }),
    } as unknown as Response;
  };
  try {
    const fetcher = createLineUnitStatsFetcher("TOKEN123");
    const r = await fetcher("s20260807_ser", "20260807", "20260810");
    assertEqual(r.ok, true, "ok");
    assertEqual(r.uniqueImpression, 40, "impression");
    assertEqual(
      capturedUrl.startsWith(LINE_INSIGHT_EVENT_AGGREGATION_URL),
      true,
      "endpoint",
    );
    assertEqual(
      capturedUrl.includes("customAggregationUnit=s20260807_ser"),
      true,
      "unit param",
    );
    assertEqual(capturedUrl.includes("from=20260807"), true, "from param");
    assertEqual(capturedUrl.includes("to=20260810"), true, "to param");
    assertEqual(capturedAuth, "Bearer TOKEN123", "auth header");
  } finally {
    globalThis.fetch = realFetch;
  }
});

it("アダプタ: 非2xx は fail-soft（ok:false・null）", async () => {
  const realFetch = globalThis.fetch;
  // @ts-expect-error test stub
  globalThis.fetch = async () =>
    ({ ok: false, json: async () => ({}) }) as unknown as Response;
  try {
    const fetcher = createLineUnitStatsFetcher("T");
    const r = await fetcher("u", "20260807", "20260810");
    assertEqual(r.ok, false, "ok false");
    assertEqual(r.uniqueImpression, null, "impression null");
  } finally {
    globalThis.fetch = realFetch;
  }
});

it("アダプタ: 例外は fail-soft（ok:false）", async () => {
  const realFetch = globalThis.fetch;
  // @ts-expect-error test stub
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const fetcher = createLineUnitStatsFetcher("T");
    const r = await fetcher("u", "20260807", "20260810");
    assertEqual(r.ok, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- runner ----
(async () => {
  console.log("\n--- line-insight ---");
  for (const t of queue) {
    totalTests++;
    try {
      await t.fn();
      passedTests++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failedTests++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${t.name}: ${msg}`);
      failures.push({ name: t.name, error: msg });
    }
  }
  console.log("\n" + "=".repeat(60));
  console.log("line-insight Unit Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failedTests > 0 ? 1 : 0);
})();
