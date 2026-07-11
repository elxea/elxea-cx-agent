/**
 * Unit Tests -- [SEC-A] getOrderDetail の IDOR 対策（本人の注文だけに限定）
 *
 * 注文番号だけで他人の注文が見えてしまう脆弱性を塞いだことを検証する。
 * 実 Shopify / 実 Supabase / 実ネットワークには一切触れない（deps 注入で mock）。
 *
 *   - 他人の注文番号 → 見えない（連携済みでも自分の注文集合に無ければ not found）
 *   - 本人の注文     → 返る
 *   - 未連携ユーザー → Shopify に問い合わせず連携要求メッセージを返す
 *
 * 使用方法:
 *   npx tsx tests/unit/order-idor.test.ts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../../src/index";
import { getOrderDetail } from "../../src/lib/shopify";

// ---------------------------------------------------------------------------
// async 対応テストハーネス（外部依存なし）
// ---------------------------------------------------------------------------
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function describe(suiteName: string, fn: () => void) {
  queue.push({ name: `--- ${suiteName} ---`, fn: () => {} });
  fn();
}
function it(testName: string, fn: () => void | Promise<void>) {
  queue.push({ name: testName, fn });
}
function assertTrue(value: boolean, label = "") {
  if (!value) throw new Error(`${label ? label + ": " : ""}expected true`);
}
function assertIncludes(haystack: string, needle: string, label = "") {
  if (!haystack.includes(needle)) {
    throw new Error(
      `${label ? label + ": " : ""}expected to include ${JSON.stringify(needle)}, got ${JSON.stringify(haystack)}`,
    );
  }
}
function assertNotIncludes(haystack: string, needle: string, label = "") {
  if (haystack.includes(needle)) {
    throw new Error(
      `${label ? label + ": " : ""}expected NOT to include ${JSON.stringify(needle)}, got ${JSON.stringify(haystack)}`,
    );
  }
}

const env = {} as Env;
const fakeSupabase = {} as SupabaseClient;

/** customer(id).orders(query) の Admin レスポンスを生成する（1 件 or 空）。 */
function customerOrderResponse(hasOrder: boolean, orderName = "#1234") {
  return {
    customer: {
      orders: {
        edges: hasOrder
          ? [
              {
                node: {
                  name: orderName,
                  displayFinancialStatus: "PAID",
                  displayFulfillmentStatus: "FULFILLED",
                  createdAt: "2026-01-01T00:00:00Z",
                  totalPriceSet: { shopMoney: { amount: "5000", currencyCode: "JPY" } },
                  lineItems: {
                    edges: [
                      { node: { title: "テスト商品", quantity: 1, variant: null } },
                    ],
                  },
                  fulfillments: [],
                  shippingAddress: null,
                },
              },
            ]
          : [],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe("[SEC-A] getOrderDetail 未連携ユーザー", () => {
  it("未連携（linkage=null）→ Shopify に問い合わせず連携要求を返す", async () => {
    let adminCalled = false;
    const res = await getOrderDetail("1234", env, { userId: "Uattacker", channel: "line" }, {
      supabase: fakeSupabase,
      resolveCustomerId: async () => null, // 未連携
      adminQuery: async () => {
        adminCalled = true;
        return {};
      },
    });
    assertTrue(!adminCalled, "未連携時に Shopify Admin API を呼んではいけない（fail-closed）");
    assertIncludes(res.text, "連携", "連携要求メッセージであること");
    assertTrue(res.data === undefined, "注文データを返してはいけない");
  });
});

describe("[SEC-A] getOrderDetail 本人の注文", () => {
  it("連携済み本人の注文 → 詳細が返り、customer スコープで問い合わせる", async () => {
    let capturedVars: Record<string, unknown> | null = null;
    let capturedQuery = "";
    const res = await getOrderDetail("1234", env, { userId: "Uowner", channel: "line" }, {
      supabase: fakeSupabase,
      resolveCustomerId: async () => "111", // 本人の Shopify customer id
      adminQuery: async (query, vars) => {
        capturedQuery = query;
        capturedVars = vars;
        return customerOrderResponse(true, "#1234");
      },
    });
    assertIncludes(res.text, "#1234", "本人の注文詳細が返ること");
    assertTrue(res.data?.orderName === "#1234", "構造化データが返ること");
    // customer スコープであること（グローバル orders 検索ではない）
    assertIncludes(capturedQuery, "customer(id:", "customer スコープの GraphQL であること");
    assertTrue(
      capturedVars?.customerId === "gid://shopify/Customer/111",
      "呼び出しユーザーの customer id でスコープしていること",
    );
    assertTrue(capturedVars?.query === "name:#1234", "注文番号でフィルタしていること");
  });
});

describe("[SEC-A] 他人の注文番号（IDOR）", () => {
  it("連携済みでも自分の注文集合に無い番号 → 見つからない（他人の注文は漏れない）", async () => {
    let capturedVars: Record<string, unknown> | null = null;
    // 攻撃者は customer 111 に連携済みだが、#9999 は他人（customer 222）の注文。
    // customer(id:111).orders(query:"name:#9999") は空を返す。
    const res = await getOrderDetail("9999", env, { userId: "Uattacker", channel: "line" }, {
      supabase: fakeSupabase,
      resolveCustomerId: async () => "111",
      adminQuery: async (_query, vars) => {
        capturedVars = vars;
        return customerOrderResponse(false); // 自分の注文集合には無い
      },
    });
    assertIncludes(res.text, "見つかりませんでした", "他人の注文は not found にする");
    assertNotIncludes(res.text, "追跡番号", "他人の注文情報を一切漏らさない");
    assertTrue(res.data === undefined, "他人の注文データを返さない");
    // 必ず攻撃者自身の customer に限定して問い合わせている（グローバル検索していない）
    assertTrue(
      capturedVars?.customerId === "gid://shopify/Customer/111",
      "常に呼び出しユーザーの customer に限定して照会していること",
    );
  });
});

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------
(async () => {
  for (const { name, fn } of queue) {
    if (name.startsWith("---")) {
      console.log(`\n${name}`);
      continue;
    }
    totalTests++;
    try {
      await fn();
      passedTests++;
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      failedTests++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${name}: ${msg}`);
      failures.push({ name, error: msg });
    }
  }
  console.log("\n============================================================");
  console.log("order-idor (SEC-A) Test Results");
  console.log("============================================================");
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
  if (failedTests > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})();
