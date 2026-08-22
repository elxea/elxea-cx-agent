/**
 * Unit Tests -- identity/linkage-status（P1: マイページに LINE 連携状態を表示）
 *
 * 検証対象:
 *   1. 認証ゲート（SYNC_API_SECRET）— 未指定 / 不一致 / サーバ側 secret 未設定 → 401（fail-closed）
 *   2. 入力検証 — shopify_customer_id 欠落 / 非数値 → 400
 *   3. 判定ロジック（getLinkageStatus）— 連携行が 1 件以上で linked=true、
 *      N:1（世帯共有）で count が増える、最古の linked_at を返す
 *   4. 最小開示 — クエリが line_user_id を select しない / 応答に生 ID が現れない（QA 要件 3）
 *   5. 連携可否と配信可否の分離（P4・2026-08-22）— ブロック（unfollowed_at）で連携が
 *      消えない。順引き・逆引きの両方で linked=true のまま unfollowed=true が付く
 *
 * 実 Supabase / 実ネットワークには触れない。認証・検証段は Supabase 到達より前に return するため
 * mock Context だけで確認でき、判定ロジックは mock SupabaseClient で行を差し替えて観測する。
 *
 * 使用方法:
 *   npx tsx tests/unit/identity-linkage-status.test.ts
 */

import type { Context } from "hono";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../../src/index";
import { identityLinkageStatusHandler } from "../../src/routes/identity";
import {
  getLinkageStatus,
  getLinkageByLineUser,
} from "../../src/lib/customer-linkage";

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
// mock Context（認証・検証段の観測用。GET なのでクエリ文字列を持つ）
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-sync-secret-abc123";
const VALID_SHOPIFY_GID = "gid://shopify/Customer/900800400001";
const VALID_SHOPIFY_NUMERIC = "900800400001";
/** 生値が応答に混ざっていないことを見るための番兵。 */
const SENTINEL_LINE_ID = "U0123456789abcdef0123456789abcdef";

type MockResult = { __status: number; __body: unknown };

function makeCtx(opts: {
  apiKey?: string;
  query?: Record<string, string | undefined>;
  secret?: string;
}): Context<{ Bindings: Env }> {
  return {
    req: {
      header: (name: string) =>
        name === "X-API-Key" ? opts.apiKey : undefined,
      query: (name: string) => opts.query?.[name],
    },
    // createSupabaseClient は認証・検証通過後にしか呼ばれないため、
    // 401/400 のテストでは SUPABASE_* に到達しない。
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
// mock SupabaseClient（select クエリの観測用）
// ---------------------------------------------------------------------------

type SelectCall = {
  table: string;
  columns: string;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  not: Array<[string, string, unknown]>;
};

/** 行の形は順引き（linked_at / unfollowed_at）と逆引き（+ shopify_customer_id）の和集合。 */
type MockRow = {
  linked_at?: string | null;
  unfollowed_at?: string | null;
  shopify_customer_id?: string | null;
  line_user_id?: string;
};

function makeMockSupabase(
  rows: MockRow[],
  errorMessage: string | null = null,
): { client: SupabaseClient; calls: SelectCall[] } {
  const calls: SelectCall[] = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          const call: SelectCall = { table, columns, eq: [], is: [], not: [] };
          calls.push(call);
          const builder = {
            eq(column: string, value: unknown) {
              call.eq.push([column, value]);
              return builder;
            },
            is(column: string, value: unknown) {
              call.is.push([column, value]);
              return builder;
            },
            not(column: string, op: string, value: unknown) {
              call.not.push([column, op, value]);
              return builder;
            },
            order() {
              // 実 PostgREST の並びを模す代わりに、与えた rows をそのまま返す。
              return Promise.resolve({
                data: errorMessage ? null : rows,
                error: errorMessage ? { message: errorMessage } : null,
              });
            },
          };
          return builder;
        },
      };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

// ---------------------------------------------------------------------------
// 1. 認証ゲート（fail-closed）
// ---------------------------------------------------------------------------

describe("identityLinkageStatusHandler / 認証（SYNC_API_SECRET）", () => {
  it("X-API-Key 無し → 401（ブラウザ直叩きを塞ぐ）", async () => {
    const res = await identityLinkageStatusHandler(
      makeCtx({ query: { shopify_customer_id: VALID_SHOPIFY_GID }, secret: TEST_SECRET }),
    );
    assertEqual(statusOf(res), 401);
  });

  it("X-API-Key 不一致 → 401", async () => {
    const res = await identityLinkageStatusHandler(
      makeCtx({
        apiKey: "wrong-secret",
        query: { shopify_customer_id: VALID_SHOPIFY_GID },
        secret: TEST_SECRET,
      }),
    );
    assertEqual(statusOf(res), 401);
  });

  it("サーバ側 SYNC_API_SECRET 未設定 → 401（誤設定で無認証開放しない）", async () => {
    const res = await identityLinkageStatusHandler(
      makeCtx({
        apiKey: TEST_SECRET,
        query: { shopify_customer_id: VALID_SHOPIFY_GID },
        secret: undefined,
      }),
    );
    assertEqual(statusOf(res), 401);
  });

  it("認証は入力検証より先に効く（不正入力でも 400 でなく 401）", async () => {
    const res = await identityLinkageStatusHandler(
      makeCtx({ query: { shopify_customer_id: "not-a-number" }, secret: TEST_SECRET }),
    );
    assertEqual(statusOf(res), 401, "無認証は入力の当否を漏らさない");
  });
});

// ---------------------------------------------------------------------------
// 2. 入力検証
// ---------------------------------------------------------------------------

describe("identityLinkageStatusHandler / 入力検証", () => {
  it("shopify_customer_id 欠落 → 400", async () => {
    const res = await identityLinkageStatusHandler(
      makeCtx({ apiKey: TEST_SECRET, query: {}, secret: TEST_SECRET }),
    );
    assertEqual(statusOf(res), 400);
  });

  it("非数値の shopify_customer_id → 400", async () => {
    const res = await identityLinkageStatusHandler(
      makeCtx({
        apiKey: TEST_SECRET,
        query: { shopify_customer_id: "12ab" },
        secret: TEST_SECRET,
      }),
    );
    assertEqual(statusOf(res), 400);
  });
});

// ---------------------------------------------------------------------------
// 3. 判定ロジック（getLinkageStatus）
// ---------------------------------------------------------------------------

describe("getLinkageStatus / 連携済み判定", () => {
  it("行 0 件 → linked=false, linkedAt=null, count=0", async () => {
    const { client } = makeMockSupabase([]);
    const r = await getLinkageStatus(client, VALID_SHOPIFY_NUMERIC);
    assertTrue(r.ok);
    if (!r.ok) return;
    assertEqual(r.status.linked, false);
    assertEqual(r.status.linkedAt, null);
    assertEqual(r.status.count, 0);
  });

  it("行 1 件 → linked=true, linkedAt=その行, count=1", async () => {
    const { client } = makeMockSupabase([{ linked_at: "2026-08-19T21:13:00.000Z" }]);
    const r = await getLinkageStatus(client, VALID_SHOPIFY_NUMERIC);
    assertTrue(r.ok);
    if (!r.ok) return;
    assertEqual(r.status.linked, true);
    assertEqual(r.status.linkedAt, "2026-08-19T21:13:00.000Z");
    assertEqual(r.status.count, 1);
  });

  it("N:1（世帯共有で 2 件）→ linked=true, count=2, linkedAt は最古", async () => {
    const { client } = makeMockSupabase([
      { linked_at: "2026-07-01T00:00:00.000Z" },
      { linked_at: "2026-08-19T21:13:00.000Z" },
    ]);
    const r = await getLinkageStatus(client, VALID_SHOPIFY_NUMERIC);
    assertTrue(r.ok);
    if (!r.ok) return;
    assertEqual(r.status.linked, true);
    assertEqual(r.status.count, 2);
    assertEqual(r.status.linkedAt, "2026-07-01T00:00:00.000Z");
  });

  it("linked_at が null の行だけ → linked=true だが linkedAt=null（日付は言い切らない）", async () => {
    const { client } = makeMockSupabase([{ linked_at: null }]);
    const r = await getLinkageStatus(client, VALID_SHOPIFY_NUMERIC);
    assertTrue(r.ok);
    if (!r.ok) return;
    assertEqual(r.status.linked, true);
    assertEqual(r.status.linkedAt, null);
    assertEqual(r.status.count, 1);
  });

  it("shopifyCustomerId が空 → ok:false（全件走査に化けさせない）", async () => {
    const { client, calls } = makeMockSupabase([{ linked_at: "2026-01-01T00:00:00.000Z" }]);
    const r = await getLinkageStatus(client, "");
    assertEqual(r.ok, false);
    assertEqual(calls.length, 0, "クエリを投げない");
  });

  it("Supabase エラー → ok:false（throw しない）", async () => {
    const { client } = makeMockSupabase([], "connection refused");
    const r = await getLinkageStatus(client, VALID_SHOPIFY_NUMERIC);
    assertEqual(r.ok, false);
  });
});

// ---------------------------------------------------------------------------
// 4. クエリ条件と最小開示（QA 要件 3 / 5）
// ---------------------------------------------------------------------------

describe("getLinkageStatus / クエリ条件と最小開示", () => {
  it("unfollowed_at で絞らない（P4: ブロックは連携の取り消しではない）", async () => {
    const { client, calls } = makeMockSupabase([]);
    await getLinkageStatus(client, VALID_SHOPIFY_NUMERIC);
    assertEqual(calls.length, 1);
    assertEqual(calls[0].table, "customer_linkages");
    assertTrue(
      !calls[0].is.some(([col]) => col === "unfollowed_at"),
      "unfollowed_at IS NULL 条件が無い（連携可否と配信可否を混ぜない）",
    );
  });

  it("指定顧客だけに絞る（他人の連携を数えない）", async () => {
    const { client, calls } = makeMockSupabase([]);
    await getLinkageStatus(client, VALID_SHOPIFY_NUMERIC);
    assertTrue(
      calls[0].eq.some(
        ([col, val]) => col === "shopify_customer_id" && val === VALID_SHOPIFY_NUMERIC,
      ),
      "shopify_customer_id で絞っている",
    );
  });

  it("select に line_user_id を含めない（生値を DB から持ち出さない）", async () => {
    const { client, calls } = makeMockSupabase([]);
    await getLinkageStatus(client, VALID_SHOPIFY_NUMERIC);
    assertEqual(calls[0].columns, "linked_at, unfollowed_at");
    assertTrue(
      !calls[0].columns.includes("line_user_id"),
      "select 句に line_user_id が無い",
    );
  });

  it("行に line_user_id が混ざっていても戻り値に載らない（QA 要件 3）", async () => {
    // PostgREST が余計な列を返しても、戻り値は linked / linkedAt / count に畳まれる。
    const rows = [
      { linked_at: "2026-08-19T21:13:00.000Z", line_user_id: SENTINEL_LINE_ID },
    ] as Array<{ linked_at?: string | null }>;
    const { client } = makeMockSupabase(rows);
    const r = await getLinkageStatus(client, VALID_SHOPIFY_NUMERIC);
    assertTrue(r.ok);
    if (!r.ok) return;
    assertTrue(
      !JSON.stringify(r.status).includes(SENTINEL_LINE_ID),
      "戻り値に LINE の生 ID が現れない",
    );
    assertEqual(
      Object.keys(r.status).sort().join(","),
      "count,linked,linkedAt,unfollowed",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. 連携可否と配信可否の分離（P4・2026-08-22 の回帰テスト）
//
//    本番に「連携済みだが LINE をブロック中」の行が実在し、旧実装ではその人が
//    未連携として返っていた。ブロックしても連携は残る、を両方向で固定する。
// ---------------------------------------------------------------------------

describe("P4 / ブロック中でも連携は維持される（順引き）", () => {
  it("unfollowed_at 入りの行 1 件 → linked=true（連携は消えない）", async () => {
    const { client } = makeMockSupabase([
      { linked_at: "2026-07-24T19:58:27.657Z", unfollowed_at: "2026-08-01T00:00:00.000Z" },
    ]);
    const r = await getLinkageStatus(client, VALID_SHOPIFY_NUMERIC);
    assertTrue(r.ok);
    if (!r.ok) return;
    assertEqual(r.status.linked, true, "ブロックで連携が消えない");
    assertEqual(r.status.count, 1);
    assertEqual(r.status.linkedAt, "2026-07-24T19:58:27.657Z");
  });

  it("全行が unfollowed → unfollowed=true（届かないことは別に伝える）", async () => {
    const { client } = makeMockSupabase([
      { linked_at: "2026-07-24T19:58:27.657Z", unfollowed_at: "2026-08-01T00:00:00.000Z" },
    ]);
    const r = await getLinkageStatus(client, VALID_SHOPIFY_NUMERIC);
    assertTrue(r.ok);
    if (!r.ok) return;
    assertEqual(r.status.unfollowed, true);
  });

  it("N:1 で 1 件でも生きていれば unfollowed=false（世帯の誰かには届く）", async () => {
    const { client } = makeMockSupabase([
      { linked_at: "2026-07-01T00:00:00.000Z", unfollowed_at: "2026-08-01T00:00:00.000Z" },
      { linked_at: "2026-08-19T21:13:00.000Z", unfollowed_at: null },
    ]);
    const r = await getLinkageStatus(client, VALID_SHOPIFY_NUMERIC);
    assertTrue(r.ok);
    if (!r.ok) return;
    assertEqual(r.status.linked, true);
    assertEqual(r.status.count, 2);
    assertEqual(r.status.unfollowed, false);
  });

  it("連携 0 件 → unfollowed=false（届かないのではなく相手がいない）", async () => {
    const { client } = makeMockSupabase([]);
    const r = await getLinkageStatus(client, VALID_SHOPIFY_NUMERIC);
    assertTrue(r.ok);
    if (!r.ok) return;
    assertEqual(r.status.linked, false);
    assertEqual(r.status.unfollowed, false);
  });
});

describe("P4 / ブロック中でも連携は維持される（逆引き）", () => {
  it("unfollowed_at 入りでも shopifyCustomerId を返す（棚が分裂しない）", async () => {
    const { client } = makeMockSupabase([
      {
        shopify_customer_id: "900800400001",
        linked_at: "2026-07-24T19:58:27.657Z",
        unfollowed_at: "2026-08-01T00:00:00.000Z",
      },
    ]);
    const r = await getLinkageByLineUser(client, SENTINEL_LINE_ID);
    assertTrue(r.ok);
    if (!r.ok) return;
    assertEqual(r.linkage.linked, true, "ブロックで本人解決が切れない");
    assertEqual(r.linkage.shopifyCustomerId, "900800400001");
    assertEqual(r.linkage.unfollowed, true);
  });

  it("逆引きも unfollowed_at で絞らない（クエリ条件の回帰）", async () => {
    const { client, calls } = makeMockSupabase([]);
    await getLinkageByLineUser(client, SENTINEL_LINE_ID);
    assertEqual(calls.length, 1);
    assertTrue(
      !calls[0].is.some(([col]) => col === "unfollowed_at"),
      "unfollowed_at IS NULL 条件が無い",
    );
    assertTrue(
      calls[0].not.some(
        ([col, op, val]) => col === "shopify_customer_id" && op === "is" && val === null,
      ),
      "連携の有無は shopify_customer_id IS NOT NULL だけで決める",
    );
  });

  it("解除済み（該当行なし）→ linked=false / unfollowed=false", async () => {
    const { client } = makeMockSupabase([]);
    const r = await getLinkageByLineUser(client, SENTINEL_LINE_ID);
    assertTrue(r.ok);
    if (!r.ok) return;
    assertEqual(r.linkage.linked, false);
    assertEqual(r.linkage.shopifyCustomerId, null);
    assertEqual(r.linkage.unfollowed, false);
  });

  it("2 顧客に割れている → fail-closed（推測で棚を選ばない）", async () => {
    const { client } = makeMockSupabase([
      { shopify_customer_id: "111", linked_at: "2026-07-01T00:00:00.000Z", unfollowed_at: null },
      { shopify_customer_id: "222", linked_at: "2026-08-01T00:00:00.000Z", unfollowed_at: null },
    ]);
    const r = await getLinkageByLineUser(client, SENTINEL_LINE_ID);
    assertTrue(r.ok);
    if (!r.ok) return;
    assertEqual(r.linkage.linked, false);
    assertEqual(r.linkage.shopifyCustomerId, null);
    assertEqual(r.linkage.count, 2);
  });
});

// ---------------------------------------------------------------------------
// Runner
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
  console.log("identity-linkage-status Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failedTests > 0 ? 1 : 0);
})();
