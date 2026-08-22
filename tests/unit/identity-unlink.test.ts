/**
 * Unit Tests -- 連携解除の HTTP 入口 と 本人解決の逆引き
 *
 * この 2 つは「連携したはずなのに、ログイン手段ごとに別のマイページが見える」
 * 「解除を押しても実は消えていないのに成功が返る」という 2 つの実害を直す変更の中身。
 *
 * 守るべき契約:
 *   1. 認証ゲート（SYNC_API_SECRET）— 未指定 / 不一致 / サーバ側 secret 未設定 → 401（fail-closed）。
 *      認証は入力検証より先に効く（不正入力でも 400 でなく 401）。
 *   2. 入力検証 — shopify_customer_id 欠落・非数値 → 400 / line_user_id の形式不正 → 400 /
 *      linkage-status で両方指定 → 400（どちらを見たのか曖昧なまま答えない）。
 *   3. 逆引き（getLinkageByLineUser）— 未連携は linked=false、連携済みは shopify_customer_id を返す。
 *      **解除済み（shopify_customer_id が null）と友だち解除済み（unfollowed_at）はヒットしない**
 *      ＝解除が本人解決に即座に効く。
 *   4. fail-closed な曖昧性 — 1 つの LINE が複数の顧客を指す異常データでは、どちらかを
 *      推測せず未連携として扱う（他人の注文履歴を見せない）。
 *   5. `.single()` を使わない（罠 G-3）— N:1（世帯共有）で複数行が正常。クエリ形状で固定する。
 *   6. 所有権の確認 — 自分に紐づいていない line_user_id は外せない（resolveUnlinkTargets）。
 *   7. 最小開示 — 応答に LINE の生 ID を載せない。
 *
 * 実 Supabase / 実ネットワークには触れない。認証・検証段は Supabase 到達より前に return する
 * ため mock Context だけで確認でき、判定ロジックは mock SupabaseClient と純関数で観測する。
 *
 * 使用方法:
 *   npx tsx tests/unit/identity-unlink.test.ts
 */

import type { Context } from "hono";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../../src/index";
import {
  identityUnlinkHandler,
  identityLinkageStatusHandler,
} from "../../src/routes/identity";
import {
  getLinkageByLineUser,
  listLinkedLineUserIds,
  resolveUnlinkTargets,
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
// 固定値
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-sync-secret-abc123";
const VALID_SHOPIFY_GID = "gid://shopify/Customer/900800400001";
const VALID_SHOPIFY_NUMERIC = "900800400001";
const OTHER_SHOPIFY_NUMERIC = "900800400002";
const LINE_A = "U0123456789abcdef0123456789abcdef";
const LINE_B = "Uabcdef0123456789abcdef0123456789";

type MockResult = { __status: number; __body: unknown };

function statusOf(res: unknown): number {
  return (res as MockResult).__status;
}
function bodyOf(res: unknown): Record<string, unknown> {
  return (res as MockResult).__body as Record<string, unknown>;
}

/** GET 用（クエリ文字列を持つ） */
function makeGetCtx(opts: {
  apiKey?: string;
  query?: Record<string, string | undefined>;
  secret?: string;
}): Context<{ Bindings: Env }> {
  return {
    req: {
      header: (name: string) => (name === "X-API-Key" ? opts.apiKey : undefined),
      query: (name: string) => opts.query?.[name],
    },
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

/** POST 用（JSON body を持つ） */
function makePostCtx(opts: {
  apiKey?: string;
  body?: unknown;
  invalidJson?: boolean;
  secret?: string;
}): Context<{ Bindings: Env }> {
  return {
    req: {
      header: (name: string) => (name === "X-API-Key" ? opts.apiKey : undefined),
      json: async () => {
        if (opts.invalidJson) throw new Error("invalid json");
        return opts.body;
      },
    },
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

// ---------------------------------------------------------------------------
// mock SupabaseClient（select クエリの観測用）
// ---------------------------------------------------------------------------

type SelectCall = {
  table: string;
  columns: string;
  eq: Array<[string, unknown]>;
  is: Array<[string, unknown]>;
  not: Array<[string, string, unknown]>;
  usedSingle: boolean;
  usedOrder: boolean;
};

function makeMockSupabase(
  rows: Array<Record<string, unknown>>,
  errorMessage: string | null = null,
): { client: SupabaseClient; calls: SelectCall[] } {
  const calls: SelectCall[] = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          const call: SelectCall = {
            table,
            columns,
            eq: [],
            is: [],
            not: [],
            usedSingle: false,
            usedOrder: false,
          };
          calls.push(call);
          const settled = () =>
            Promise.resolve({
              data: errorMessage ? null : rows,
              error: errorMessage ? { message: errorMessage } : null,
            });
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
              call.usedOrder = true;
              return settled();
            },
            single() {
              call.usedSingle = true;
              return settled();
            },
            // order() を挟まない呼び出し（listLinkedLineUserIds）は
            // builder 自身が await される。
            then(
              resolve: (v: unknown) => unknown,
              reject?: (e: unknown) => unknown,
            ) {
              return settled().then(resolve, reject);
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
// 1. 認証ゲート（fail-closed）— unlink
// ---------------------------------------------------------------------------

describe("identityUnlinkHandler / 認証（SYNC_API_SECRET）", () => {
  it("X-API-Key 無し → 401（ブラウザ直叩きで他人の連携を外せない）", async () => {
    const res = await identityUnlinkHandler(
      makePostCtx({
        body: { shopify_customer_id: VALID_SHOPIFY_GID },
        secret: TEST_SECRET,
      }),
    );
    assertEqual(statusOf(res), 401);
  });

  it("X-API-Key 不一致 → 401", async () => {
    const res = await identityUnlinkHandler(
      makePostCtx({
        apiKey: "wrong-secret",
        body: { shopify_customer_id: VALID_SHOPIFY_GID },
        secret: TEST_SECRET,
      }),
    );
    assertEqual(statusOf(res), 401);
  });

  it("サーバ側 SYNC_API_SECRET 未設定 → 401（誤設定で無認証開放しない）", async () => {
    const res = await identityUnlinkHandler(
      makePostCtx({
        apiKey: TEST_SECRET,
        body: { shopify_customer_id: VALID_SHOPIFY_GID },
        secret: undefined,
      }),
    );
    assertEqual(statusOf(res), 401);
  });

  it("認証は入力検証より先に効く（不正 body でも 400 でなく 401）", async () => {
    const res = await identityUnlinkHandler(
      makePostCtx({ invalidJson: true, secret: TEST_SECRET }),
    );
    assertEqual(statusOf(res), 401);
  });
});

// ---------------------------------------------------------------------------
// 2. 入力検証 — unlink
// ---------------------------------------------------------------------------

describe("identityUnlinkHandler / 入力検証", () => {
  it("body が JSON でない → 400", async () => {
    const res = await identityUnlinkHandler(
      makePostCtx({ apiKey: TEST_SECRET, invalidJson: true, secret: TEST_SECRET }),
    );
    assertEqual(statusOf(res), 400);
  });

  it("shopify_customer_id 欠落 → 400（誰の連携か決まらないまま外さない）", async () => {
    const res = await identityUnlinkHandler(
      makePostCtx({ apiKey: TEST_SECRET, body: {}, secret: TEST_SECRET }),
    );
    assertEqual(statusOf(res), 400);
  });

  it("shopify_customer_id が非数値 → 400", async () => {
    const res = await identityUnlinkHandler(
      makePostCtx({
        apiKey: TEST_SECRET,
        body: { shopify_customer_id: "not-a-number" },
        secret: TEST_SECRET,
      }),
    );
    assertEqual(statusOf(res), 400);
  });

  it("line_user_id の形式が不正 → 400（U + 32 hex 以外を受けない）", async () => {
    const res = await identityUnlinkHandler(
      makePostCtx({
        apiKey: TEST_SECRET,
        body: {
          shopify_customer_id: VALID_SHOPIFY_GID,
          line_user_id: "not-a-line-id",
        },
        secret: TEST_SECRET,
      }),
    );
    assertEqual(statusOf(res), 400);
  });
});

// ---------------------------------------------------------------------------
// 3. 所有権の確認（純関数）
// ---------------------------------------------------------------------------

describe("resolveUnlinkTargets / 所有権", () => {
  it("line_user_id 省略 → その顧客の連携をすべて対象にする（N:1 の一括解除）", () => {
    const r = resolveUnlinkTargets([LINE_A, LINE_B]);
    assertTrue(r.ok, "ok");
    if (r.ok) assertEqual(r.targets.join(","), [LINE_A, LINE_B].join(","));
  });

  it("line_user_id 指定 → その 1 件だけを対象にする", () => {
    const r = resolveUnlinkTargets([LINE_A, LINE_B], LINE_B);
    assertTrue(r.ok, "ok");
    if (r.ok) assertEqual(r.targets.join(","), LINE_B);
  });

  it("自分に紐づいていない line_user_id は拒否する（他人の連携を外せない）", () => {
    const r = resolveUnlinkTargets([LINE_A], LINE_B);
    assertEqual(r.ok, false);
  });

  it("連携が 1 件も無い顧客で省略 → 対象ゼロ（冪等・エラーにしない）", () => {
    const r = resolveUnlinkTargets([]);
    assertTrue(r.ok, "ok");
    if (r.ok) assertEqual(r.targets.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. 逆引き（本人解決）
// ---------------------------------------------------------------------------

describe("getLinkageByLineUser / 判定", () => {
  it("行が無い → linked=false・顧客 ID は返さない（未連携は従来どおりの人格）", async () => {
    const { client } = makeMockSupabase([]);
    const r = await getLinkageByLineUser(client, LINE_A);
    assertTrue(r.ok, "ok");
    if (r.ok) {
      assertEqual(r.linkage.linked, false);
      assertEqual(r.linkage.shopifyCustomerId, null);
      assertEqual(r.linkage.count, 0);
    }
  });

  it("有効な行が 1 件 → linked=true・その Shopify 顧客に解決する", async () => {
    const { client } = makeMockSupabase([
      { shopify_customer_id: VALID_SHOPIFY_NUMERIC, linked_at: "2026-08-01T00:00:00Z" },
    ]);
    const r = await getLinkageByLineUser(client, LINE_A);
    assertTrue(r.ok, "ok");
    if (r.ok) {
      assertEqual(r.linkage.linked, true);
      assertEqual(r.linkage.shopifyCustomerId, VALID_SHOPIFY_NUMERIC);
      assertEqual(r.linkage.linkedAt, "2026-08-01T00:00:00Z");
    }
  });

  it("1 つの LINE が別々の顧客を指す異常データ → 推測せず未連携扱い（fail-closed）", async () => {
    const { client } = makeMockSupabase([
      { shopify_customer_id: VALID_SHOPIFY_NUMERIC, linked_at: "2026-08-01T00:00:00Z" },
      { shopify_customer_id: OTHER_SHOPIFY_NUMERIC, linked_at: "2026-08-02T00:00:00Z" },
    ]);
    const r = await getLinkageByLineUser(client, LINE_A);
    assertTrue(r.ok, "ok");
    if (r.ok) {
      assertEqual(r.linkage.linked, false, "曖昧なら他人の棚を見せない");
      assertEqual(r.linkage.shopifyCustomerId, null);
      assertEqual(r.linkage.count, 2, "件数は隠さない（観測できるようにする）");
    }
  });

  it("解除済み・友だち解除済みを除外する条件がクエリに載っている（解除が即座に効く）", async () => {
    const { client, calls } = makeMockSupabase([]);
    await getLinkageByLineUser(client, LINE_A);
    const call = calls[0];
    assertEqual(call.table, "customer_linkages");
    assertTrue(
      call.is.some(([col, val]) => col === "unfollowed_at" && val === null),
      "unfollowed_at IS NULL",
    );
    assertTrue(
      call.not.some(([col, op]) => col === "shopify_customer_id" && op === "is"),
      "shopify_customer_id IS NOT NULL（clearCustomerLinkage 後はヒットしない）",
    );
  });

  it("`.single()` を使わない（N:1 で静かに未連携へ落ちる罠 G-3 を踏まない）", async () => {
    const { client, calls } = makeMockSupabase([]);
    await getLinkageByLineUser(client, LINE_A);
    assertEqual(calls[0].usedSingle, false);
  });

  it("クエリ失敗は握り潰さず ok:false（未連携と取り違えない）", async () => {
    const { client } = makeMockSupabase([], "boom");
    const r = await getLinkageByLineUser(client, LINE_A);
    assertEqual(r.ok, false);
  });

  it("lineUserId が空 → ok:false（空文字で全件を引かない）", async () => {
    const { client } = makeMockSupabase([]);
    const r = await getLinkageByLineUser(client, "");
    assertEqual(r.ok, false);
  });
});

// ---------------------------------------------------------------------------
// 5. 解除対象の列挙
// ---------------------------------------------------------------------------

describe("listLinkedLineUserIds / 列挙", () => {
  it("その顧客に紐づく LINE userId を全件返す（N:1 を取りこぼさない）", async () => {
    const { client } = makeMockSupabase([
      { line_user_id: LINE_A },
      { line_user_id: LINE_B },
    ]);
    const r = await listLinkedLineUserIds(client, VALID_SHOPIFY_NUMERIC);
    assertTrue(r.ok, "ok");
    if (r.ok) assertEqual(r.lineUserIds.join(","), [LINE_A, LINE_B].join(","));
  });

  it("null / 空の行は落とす", async () => {
    const { client } = makeMockSupabase([
      { line_user_id: LINE_A },
      { line_user_id: null },
      { line_user_id: "" },
    ]);
    const r = await listLinkedLineUserIds(client, VALID_SHOPIFY_NUMERIC);
    assertTrue(r.ok, "ok");
    if (r.ok) assertEqual(r.lineUserIds.length, 1);
  });

  it("`.single()` を使わない（N:1 で複数行が正常）", async () => {
    const { client, calls } = makeMockSupabase([{ line_user_id: LINE_A }]);
    await listLinkedLineUserIds(client, VALID_SHOPIFY_NUMERIC);
    assertEqual(calls[0].usedSingle, false);
  });

  it("クエリ失敗は ok:false（0 件と取り違えて「解除するものが無い」と言わない）", async () => {
    const { client } = makeMockSupabase([], "boom");
    const r = await listLinkedLineUserIds(client, VALID_SHOPIFY_NUMERIC);
    assertEqual(r.ok, false);
  });
});

// ---------------------------------------------------------------------------
// 6. linkage-status の逆引き入口（認証・排他・形式）
// ---------------------------------------------------------------------------

describe("identityLinkageStatusHandler / 逆引き入口", () => {
  it("X-API-Key 無しの逆引き → 401（LINE ID の総当たりで顧客 ID を引けない）", async () => {
    const res = await identityLinkageStatusHandler(
      makeGetCtx({ query: { line_user_id: LINE_A }, secret: TEST_SECRET }),
    );
    assertEqual(statusOf(res), 401);
  });

  it("shopify_customer_id と line_user_id の両方指定 → 400（曖昧なまま答えない）", async () => {
    const res = await identityLinkageStatusHandler(
      makeGetCtx({
        apiKey: TEST_SECRET,
        query: { shopify_customer_id: VALID_SHOPIFY_GID, line_user_id: LINE_A },
        secret: TEST_SECRET,
      }),
    );
    assertEqual(statusOf(res), 400);
  });

  it("line_user_id の形式が不正 → 400", async () => {
    const res = await identityLinkageStatusHandler(
      makeGetCtx({
        apiKey: TEST_SECRET,
        query: { line_user_id: "not-a-line-id" },
        secret: TEST_SECRET,
      }),
    );
    assertEqual(statusOf(res), 400);
  });

  it("どちらも未指定 → 400（従来の順引き検証がそのまま効く）", async () => {
    const res = await identityLinkageStatusHandler(
      makeGetCtx({ apiKey: TEST_SECRET, query: {}, secret: TEST_SECRET }),
    );
    assertEqual(statusOf(res), 400);
  });

  it("400 応答に LINE の生 ID を載せない（最小開示）", async () => {
    const res = await identityLinkageStatusHandler(
      makeGetCtx({
        apiKey: TEST_SECRET,
        query: { shopify_customer_id: VALID_SHOPIFY_GID, line_user_id: LINE_A },
        secret: TEST_SECRET,
      }),
    );
    assertTrue(!JSON.stringify(bodyOf(res)).includes(LINE_A), "生 ID が応答に無い");
  });
});

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

(async () => {
  console.log("\nRunning identity-unlink / reverse-linkage unit tests...\n");
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
  console.log("identity-unlink Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failedTests > 0 ? 1 : 0);
})();
