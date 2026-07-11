/**
 * Unit Tests -- cron-routing（T3 到達性）
 *
 * 配信 cron と同期 cron の両立を検証する。配信パターンだけが "delivery"、
 * それ以外（同期パターン + 想定外の安全網）は必ず "sync" に倒れることを保証する。
 *
 * 使用方法:
 *   npx tsx tests/unit/cron-routing.test.ts
 */

import {
  classifyCron,
  DELIVERY_CRON_PATTERN,
  SYNC_CRON_PATTERN,
} from "../../src/lib/cron-routing";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];

function it(testName: string, fn: () => void) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  [PASS] ${testName}`);
  } catch (err) {
    failedTests++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${testName}: ${msg}`);
    failures.push({ name: testName, error: msg });
  }
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

console.log("\n--- classifyCron ---");

it("配信パターン → delivery", () => {
  assertEqual(classifyCron(DELIVERY_CRON_PATTERN), "delivery");
  assertEqual(classifyCron("*/15 * * * *"), "delivery");
});

it("同期パターン → sync（死蔵解消の核心）", () => {
  assertEqual(classifyCron(SYNC_CRON_PATTERN), "sync");
  assertEqual(classifyCron("0 18 * * *"), "sync");
});

it("想定外パターン → sync（安全網）", () => {
  assertEqual(classifyCron("0 21 1,15 * *"), "sync");
  assertEqual(classifyCron("unknown"), "sync");
  assertEqual(classifyCron(""), "sync");
});

it("配信と同期のパターンは異なる（両立の前提）", () => {
  assertEqual(DELIVERY_CRON_PATTERN !== SYNC_CRON_PATTERN, true);
});

console.log("\n" + "=".repeat(60));
console.log("Cron Routing Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failedTests > 0 ? 1 : 0);
