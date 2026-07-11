/**
 * Unit Tests -- subscription（定期便判定）
 *
 * 使用方法:
 *   npx tsx tests/unit/subscription.test.ts
 */

import { detectSubscriptionFromOrder } from "../../src/lib/subscription";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];

function describe(suiteName: string, fn: () => void) {
  console.log(`\n--- ${suiteName} ---`);
  fn();
}
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

describe("detectSubscriptionFromOrder — タグ判定", () => {
  it("comma 区切り文字列タグに subscription → true", () => {
    assertEqual(
      detectSubscriptionFromOrder({ tags: "vip, subscription, gift" }),
      true,
    );
  });
  it("日本語タグ 定期便 → true", () => {
    assertEqual(detectSubscriptionFromOrder({ tags: "定期便" }), true);
  });
  it("部分一致 monthly-subscription → true", () => {
    assertEqual(
      detectSubscriptionFromOrder({ tags: "monthly-subscription" }),
      true,
    );
  });
  it("配列タグ対応", () => {
    assertEqual(
      detectSubscriptionFromOrder({ tags: ["gift", "Subscribe"] }),
      true,
    );
  });
  it("無関係タグのみ → false", () => {
    assertEqual(detectSubscriptionFromOrder({ tags: "gift, vip" }), false);
  });
  it("タグ空 → false", () => {
    assertEqual(detectSubscriptionFromOrder({ tags: "" }), false);
    assertEqual(detectSubscriptionFromOrder({ tags: null }), false);
  });
});

describe("detectSubscriptionFromOrder — selling plan 判定", () => {
  it("line_item に selling_plan_allocation → true", () => {
    assertEqual(
      detectSubscriptionFromOrder({
        line_items: [{ selling_plan_allocation: { selling_plan: { id: 1 } } }],
      }),
      true,
    );
  });
  it("line_item に selling_plan_id → true", () => {
    assertEqual(
      detectSubscriptionFromOrder({ line_items: [{ selling_plan_id: 123 }] }),
      true,
    );
  });
  it("selling plan 無しの通常ライン → false", () => {
    assertEqual(
      detectSubscriptionFromOrder({
        line_items: [{ selling_plan_id: null, selling_plan_allocation: null }],
      }),
      false,
    );
  });
});

describe("detectSubscriptionFromOrder — 境界", () => {
  it("null/undefined 注文 → false", () => {
    assertEqual(detectSubscriptionFromOrder(null), false);
    assertEqual(detectSubscriptionFromOrder(undefined), false);
  });
  it("空注文 → false", () => {
    assertEqual(detectSubscriptionFromOrder({}), false);
  });
});

console.log("\n" + "=".repeat(60));
console.log("Subscription Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failedTests > 0 ? 1 : 0);
