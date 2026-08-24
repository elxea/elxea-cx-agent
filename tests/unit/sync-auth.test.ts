/**
 * Unit Tests -- sync-auth（X-API-Key / SYNC_API_SECRET 認証ガード）
 *
 * server-to-server エンドポイント（identity/link・identity/link-line・survey）に
 * 付与した X-API-Key 認証を検証する。実 Supabase / 実ネットワークには触れない。
 * 認証ガードは各ハンドラの冒頭で発火し、Supabase 到達より前に return するため、
 * mock Context だけで「無認証は 401 / 正しい key は認証を通過」を検証できる。
 *
 * 使用方法:
 *   npx tsx tests/unit/sync-auth.test.ts
 */

import type { Context } from "hono";
import type { Env } from "../../src/index";
import { isValidSyncApiKey, requireSyncApiKey } from "../../src/lib/sync-auth";
import {
  identityLinkHandler,
  identityLinkLineHandler,
} from "../../src/routes/identity";
import { surveyHandler } from "../../src/routes/survey";

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
// mock Context
//
// ハンドラが使うのは c.req.header / c.req.json / c.env / c.json のみ（認証段階）。
// c.json(obj, status) は { __status, __body } を返すスタブにして status を検証する。
// ---------------------------------------------------------------------------

const TEST_SECRET = "test-sync-secret-abc123";

type MockResult = { __status: number; __body: unknown };

function makeCtx(opts: {
  apiKey?: string;
  body?: unknown;
  secret?: string; // env.SYNC_API_SECRET。undefined なら未設定を再現
  path?: string;
}): Context<{ Bindings: Env }> {
  return {
    req: {
      header: (name: string) =>
        name === "X-API-Key" ? opts.apiKey : undefined,
      json: async () => opts.body ?? {},
      // 拒否ログに載る route。実 Hono では `c.req.path` が入る。
      path: opts.path ?? "/api/identity/linkage-status",
    },
    env: { SYNC_API_SECRET: opts.secret } as unknown as Env,
    json: (body: unknown, status = 200): MockResult => ({
      __status: status,
      __body: body,
    }),
  } as unknown as Context<{ Bindings: Env }>;
}

function statusOf(res: unknown): number {
  return (res as MockResult).__status;
}

// ハンドラごとに「無認証パターンで 401 / 正しい key で認証通過（非 401）」を検証する。
// 正しい key の場合、認証は通過し、後段の body バリデーションで 400 になる
// （空 body を渡すため）。401 でないこと = 認証を通過したこと、を確認する。
type Handler = (c: Context<{ Bindings: Env }>) => Promise<unknown>;

function authContractFor(name: string, handler: Handler) {
  describe(`${name} -- X-API-Key auth contract`, () => {
    it("X-API-Key 無し → 401", async () => {
      const res = await handler(makeCtx({ secret: TEST_SECRET }));
      assertEqual(statusOf(res), 401, "missing key");
    });

    it("X-API-Key 不一致 → 401", async () => {
      const res = await handler(
        makeCtx({ apiKey: "wrong-key", secret: TEST_SECRET }),
      );
      assertEqual(statusOf(res), 401, "mismatched key");
    });

    it("SYNC_API_SECRET 未設定 → 正しそうな key でも 401（fail-closed）", async () => {
      const res = await handler(
        makeCtx({ apiKey: TEST_SECRET, secret: undefined }),
      );
      assertEqual(statusOf(res), 401, "fail-closed when secret unset");
    });

    it("正しい X-API-Key → 認証通過（401 ではない）", async () => {
      const res = await handler(
        makeCtx({ apiKey: TEST_SECRET, secret: TEST_SECRET, body: {} }),
      );
      assertTrue(statusOf(res) !== 401, "valid key must pass auth gate");
    });
  });
}

// ---------------------------------------------------------------------------
// 純粋関数 isValidSyncApiKey
// ---------------------------------------------------------------------------

describe("isValidSyncApiKey (pure)", () => {
  it("secret 未設定 → false（fail-closed）", () => {
    assertEqual(isValidSyncApiKey("anything", undefined), false);
    assertEqual(isValidSyncApiKey("anything", ""), false);
  });

  it("providedKey 未指定 → false", () => {
    assertEqual(isValidSyncApiKey(undefined, TEST_SECRET), false);
    assertEqual(isValidSyncApiKey(null, TEST_SECRET), false);
    assertEqual(isValidSyncApiKey("", TEST_SECRET), false);
  });

  it("不一致 → false", () => {
    assertEqual(isValidSyncApiKey("nope", TEST_SECRET), false);
  });

  it("一致 → true", () => {
    assertEqual(isValidSyncApiKey(TEST_SECRET, TEST_SECRET), true);
  });
});

// ---------------------------------------------------------------------------
// 拒否ログ（沈黙させない・秘密は出さない）
//
// この 401 は両側から見えない失敗だった。web-app が受け取るのは
// `{"error":"Unauthorized"}` だけで理由が分からず、cx-agent 側は何も出していない。
// 鍵がずれた瞬間、痕跡はどこにも残らず「連携済みのお客さまが未連携に見える」と
// いう症状だけが表に出る。ここで理由の書き分けを機械で固定する。
// ---------------------------------------------------------------------------

/** requireSyncApiKey を呼び、その間に出た console.warn を集める。 */
function warnsFrom(opts: {
  apiKey?: string;
  secret?: string;
  path?: string;
}): { status: number; warns: string[] } {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const res = requireSyncApiKey(makeCtx(opts));
    return { status: res === null ? 200 : statusOf(res), warns };
  } finally {
    console.warn = original;
  }
}

describe("requireSyncApiKey -- 拒否を必ずログに残す", () => {
  it("secret 未設定 → reason=secret-unset", () => {
    const { status, warns } = warnsFrom({ apiKey: TEST_SECRET });
    assertEqual(status, 401);
    assertEqual(warns.length, 1, "拒否は必ず 1 行残る");
    assertTrue(
      warns[0].includes("reason=secret-unset"),
      `got: ${warns[0]}`,
    );
  });

  it("ヘッダー無し → reason=key-absent", () => {
    const { warns } = warnsFrom({ secret: TEST_SECRET });
    assertTrue(warns[0].includes("reason=key-absent"), `got: ${warns[0]}`);
  });

  it("鍵の不一致 → reason=key-mismatch（ローテートの片側漏れ・改行混入）", () => {
    const { warns } = warnsFrom({
      apiKey: `${TEST_SECRET}\n`,
      secret: TEST_SECRET,
    });
    assertTrue(warns[0].includes("reason=key-mismatch"), `got: ${warns[0]}`);
  });

  it("どの route で弾いたかが分かる", () => {
    const { warns } = warnsFrom({
      secret: TEST_SECRET,
      path: "/api/identity/linkage-status",
    });
    assertTrue(
      warns[0].includes("path=/api/identity/linkage-status"),
      `got: ${warns[0]}`,
    );
  });

  it("鍵の値は一切出さない（ログは平文で保存される）", () => {
    const { warns } = warnsFrom({
      apiKey: "attacker-guess-xyz",
      secret: TEST_SECRET,
    });
    assertTrue(!warns[0].includes(TEST_SECRET), "サーバ秘密が漏れている");
    assertTrue(
      !warns[0].includes("attacker-guess-xyz"),
      "提供された鍵が漏れている",
    );
  });

  it("通過したときは何も書かない（正常時に鳴るログにしない）", () => {
    const { status, warns } = warnsFrom({
      apiKey: TEST_SECRET,
      secret: TEST_SECRET,
    });
    assertEqual(status, 200, "認証は通過する");
    assertEqual(warns.length, 0, "通過時は無音");
  });
});

// ---------------------------------------------------------------------------
// 各エンドポイントの認証コントラクト
// ---------------------------------------------------------------------------

authContractFor("POST /api/identity/link", identityLinkHandler);
authContractFor("POST /api/identity/link-line", identityLinkLineHandler);
authContractFor("POST /api/survey", surveyHandler);

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
  console.log("sync-auth Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failedTests > 0 ? 1 : 0);
})();
