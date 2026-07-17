/**
 * Unit Tests -- identity/link-liff（案A: LIFF 連携 → customer_linkages upsert）
 *
 * 検証対象:
 *   1. upsertCustomerLinkage の冪等性（onConflict=line_user_id・二度呼びで安全・付け替え吸収）
 *   2. ハンドラの認証（SYNC_API_SECRET 検証失敗 → 401 / fail-closed）
 *   3. ハンドラの入力検証（不正 Messaging userId・不正 shopify id → 400）
 *   4. web-auth のバリデータ（Messaging userId 形式 / shopify 正規化）
 *
 * 実 Supabase / 実ネットワークには触れない。upsert は mock SupabaseClient で挙動を観測し、
 * 認証・検証段は Supabase 到達より前に return するため mock Context だけで確認できる。
 *
 * 使用方法:
 *   npx tsx tests/unit/identity-link-liff.test.ts
 */

import type { Context } from "hono";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../../src/index";
import { identityLinkLiffHandler } from "../../src/routes/identity";
import { upsertCustomerLinkage } from "../../src/lib/customer-linkage";
import {
  validateLineMessagingUserId,
  normalizeShopifyCustomerId,
} from "../../src/lib/web-auth";

// ---------------------------------------------------------------------------
// テストハーネス（外部依存なし・async 対応）
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
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assertTrue(value: boolean, label = "") {
  if (!value) throw new Error(`${label ? label + ": " : ""}expected true`);
}

// ---------------------------------------------------------------------------
// mock Context（認証・検証段の観測用）
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-sync-secret-abc123";
const VALID_LINE_ID = "U0123456789abcdef0123456789abcdef"; // U + 32 hex
const VALID_SHOPIFY_GID = "gid://shopify/Customer/900800400001";

type MockResult = { __status: number; __body: unknown };

function makeCtx(opts: {
  apiKey?: string;
  body?: unknown;
  secret?: string;
}): Context<{ Bindings: Env }> {
  return {
    req: {
      header: (name: string) =>
        name === "X-API-Key" ? opts.apiKey : undefined,
      json: async () => opts.body ?? {},
    },
    // createSupabaseClient は検証通過後にしか呼ばれないため、認証/検証テストでは
    // SUPABASE_* を空にしても到達しない。
    env: {
      SYNC_API_SECRET: opts.secret,
      SUPABASE_URL: "http://localhost:0",
      SUPABASE_SERVICE_ROLE_KEY: "test",
    } as unknown as Env,
    json: (body: unknown, status = 200): MockResult => ({
      __status: status,
      __body: body,
    }),
  } as unknown as Context<{ Bindings: Env }>;
}
function statusOf(res: unknown): number {
  return (res as MockResult).__status;
}

// ---------------------------------------------------------------------------
// mock SupabaseClient（upsert 挙動の観測用）
// ---------------------------------------------------------------------------

type UpsertCall = { table: string; row: Record<string, unknown>; opts: unknown };

function makeMockSupabase(errorMessage: string | null = null): {
  client: SupabaseClient;
  calls: UpsertCall[];
} {
  const calls: UpsertCall[] = [];
  const client = {
    from(table: string) {
      return {
        upsert(row: Record<string, unknown>, opts: unknown) {
          calls.push({ table, row, opts });
          return Promise.resolve({
            error: errorMessage ? { message: errorMessage } : null,
          });
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

// ---------------------------------------------------------------------------
// 1. web-auth バリデータ
// ---------------------------------------------------------------------------

describe("validateLineMessagingUserId", () => {
  it("正しい Messaging userId（U + 32 hex）→ null", () => {
    assertEqual(validateLineMessagingUserId(VALID_LINE_ID), null);
  });
  it("空 / undefined → エラー", () => {
    assertTrue(validateLineMessagingUserId("") !== null);
    assertTrue(validateLineMessagingUserId(undefined) !== null);
  });
  it("U 始まりでない → エラー", () => {
    assertTrue(
      validateLineMessagingUserId("X0123456789abcdef0123456789abcdef") !== null,
    );
  });
  it("hex でない文字混入 → エラー", () => {
    assertTrue(
      validateLineMessagingUserId("U0123456789abcdef0123456789abcdeZ") !== null,
    );
  });
  it("長さ不足 → エラー", () => {
    assertTrue(validateLineMessagingUserId("Uabc") !== null);
  });
});

describe("normalizeShopifyCustomerId", () => {
  it("GID → 数値文字列", () => {
    const r = normalizeShopifyCustomerId(VALID_SHOPIFY_GID);
    assertTrue("numericId" in r);
    assertEqual((r as { numericId: string }).numericId, "900800400001");
  });
  it("既に数値 → そのまま", () => {
    const r = normalizeShopifyCustomerId("7654321");
    assertEqual((r as { numericId: string }).numericId, "7654321");
  });
  it("空 → error", () => {
    assertTrue("error" in normalizeShopifyCustomerId(""));
  });
  it("非数値混入 → error", () => {
    assertTrue("error" in normalizeShopifyCustomerId("gid://shopify/Customer/abc"));
    assertTrue("error" in normalizeShopifyCustomerId("12a34"));
  });
});

// ---------------------------------------------------------------------------
// 2. upsertCustomerLinkage（冪等・付け替え吸収・エラー伝播）
// ---------------------------------------------------------------------------

describe("upsertCustomerLinkage", () => {
  it("成功 → ok:true / customer_linkages に onConflict=line_user_id で upsert", async () => {
    const { client, calls } = makeMockSupabase(null);
    const res = await upsertCustomerLinkage(client, {
      lineUserId: VALID_LINE_ID,
      shopifyCustomerId: "900800400001",
    });
    assertTrue(res.ok, "expected ok:true");
    assertEqual(calls.length, 1);
    assertEqual(calls[0].table, "customer_linkages");
    assertEqual(calls[0].row.line_user_id, VALID_LINE_ID);
    assertEqual(calls[0].row.shopify_customer_id, "900800400001");
    assertEqual((calls[0].opts as { onConflict: string }).onConflict, "line_user_id");
  });

  it("二度呼び（冪等）→ 常に onConflict=line_user_id・throw しない", async () => {
    const { client, calls } = makeMockSupabase(null);
    const first = await upsertCustomerLinkage(client, {
      lineUserId: VALID_LINE_ID,
      shopifyCustomerId: "900800400001",
    });
    const second = await upsertCustomerLinkage(client, {
      lineUserId: VALID_LINE_ID,
      shopifyCustomerId: "900800400001",
    });
    assertTrue(first.ok && second.ok, "both upserts ok");
    assertEqual(calls.length, 2);
    // 二度目も同じ line_user_id をキーに upsert（DB 側で 1 行に収束）。
    assertEqual(calls[1].row.line_user_id, VALID_LINE_ID);
    assertEqual((calls[1].opts as { onConflict: string }).onConflict, "line_user_id");
  });

  it("連携先の付け替え（同 line_user_id で shopify 変更）→ 同じキーで更新", async () => {
    const { client, calls } = makeMockSupabase(null);
    await upsertCustomerLinkage(client, {
      lineUserId: VALID_LINE_ID,
      shopifyCustomerId: "111",
    });
    await upsertCustomerLinkage(client, {
      lineUserId: VALID_LINE_ID,
      shopifyCustomerId: "222",
    });
    assertEqual(calls[0].row.line_user_id, calls[1].row.line_user_id);
    assertEqual(calls[1].row.shopify_customer_id, "222");
  });

  it("email 指定なし → shopify_email 列を書かない（既存値を null で消さない）", async () => {
    const { client, calls } = makeMockSupabase(null);
    await upsertCustomerLinkage(client, {
      lineUserId: VALID_LINE_ID,
      shopifyCustomerId: "900800400001",
    });
    assertTrue(!("shopify_email" in calls[0].row), "shopify_email must be absent");
  });

  it("Supabase エラー → ok:false でエラー理由を返す（throw しない）", async () => {
    const { client } = makeMockSupabase("duplicate key value");
    const res = await upsertCustomerLinkage(client, {
      lineUserId: VALID_LINE_ID,
      shopifyCustomerId: "900800400001",
    });
    assertEqual(res.ok, false);
    assertTrue(!res.ok && res.error.includes("duplicate key"));
  });
});

// ---------------------------------------------------------------------------
// 3. identityLinkLiffHandler（認証 401 / 検証 400）
// ---------------------------------------------------------------------------

describe("identityLinkLiffHandler -- auth (SYNC_API_SECRET)", () => {
  it("X-API-Key 無し → 401", async () => {
    const res = await identityLinkLiffHandler(makeCtx({ secret: TEST_SECRET }));
    assertEqual(statusOf(res), 401);
  });
  it("X-API-Key 不一致 → 401", async () => {
    const res = await identityLinkLiffHandler(
      makeCtx({ apiKey: "wrong", secret: TEST_SECRET }),
    );
    assertEqual(statusOf(res), 401);
  });
  it("SYNC_API_SECRET 未設定 → fail-closed 401", async () => {
    const res = await identityLinkLiffHandler(
      makeCtx({ apiKey: TEST_SECRET, secret: undefined }),
    );
    assertEqual(statusOf(res), 401);
  });
});

describe("identityLinkLiffHandler -- 入力検証（認証通過後）", () => {
  it("不正 Messaging userId → 400", async () => {
    const res = await identityLinkLiffHandler(
      makeCtx({
        apiKey: TEST_SECRET,
        secret: TEST_SECRET,
        body: {
          line_messaging_user_id: "not-a-line-id",
          shopify_customer_id: VALID_SHOPIFY_GID,
        },
      }),
    );
    assertEqual(statusOf(res), 400);
  });
  it("Messaging userId 欠落 → 400", async () => {
    const res = await identityLinkLiffHandler(
      makeCtx({
        apiKey: TEST_SECRET,
        secret: TEST_SECRET,
        body: { shopify_customer_id: VALID_SHOPIFY_GID },
      }),
    );
    assertEqual(statusOf(res), 400);
  });
  it("不正 shopify_customer_id → 400", async () => {
    const res = await identityLinkLiffHandler(
      makeCtx({
        apiKey: TEST_SECRET,
        secret: TEST_SECRET,
        body: {
          line_messaging_user_id: VALID_LINE_ID,
          shopify_customer_id: "gid://shopify/Customer/abc",
        },
      }),
    );
    assertEqual(statusOf(res), 400);
  });
  it("shopify_customer_id 欠落 → 400", async () => {
    const res = await identityLinkLiffHandler(
      makeCtx({
        apiKey: TEST_SECRET,
        secret: TEST_SECRET,
        body: { line_messaging_user_id: VALID_LINE_ID },
      }),
    );
    assertEqual(statusOf(res), 400);
  });
  it("不正 JSON body → 400", async () => {
    const ctx = makeCtx({ apiKey: TEST_SECRET, secret: TEST_SECRET });
    // json() が throw するケースを再現
    (ctx.req as unknown as { json: () => Promise<unknown> }).json = async () => {
      throw new Error("bad json");
    };
    const res = await identityLinkLiffHandler(ctx);
    assertEqual(statusOf(res), 400);
  });
});

// ---------------------------------------------------------------------------
// ランナー（直列 await）
// ---------------------------------------------------------------------------

(async () => {
  for (const t of queue) {
    if (t.name.startsWith("--- ")) {
      console.log(`\n${t.name}`);
      continue;
    }
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
  console.log("identity-link-liff Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failedTests > 0 ? 1 : 0);
})();
