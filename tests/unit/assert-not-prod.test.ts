/**
 * Unit Tests — assert-not-prod（テスト宛先ガード）
 *
 * ネットワークには一切出ない（純粋関数のみ）。検証範囲:
 *   - assertAllowedTestTarget: ホワイトリスト方式（staging Worker / localhost のみ許可）
 *   - 本番 Worker（既知サブドメイン全部）・未知ホスト・不正 URL・未設定 → ProdContactError で throw
 *   - resolveStagingBaseUrl: STAGING_BASE_URL / STAGING_WORKER_URL からのみ解決し、
 *     本番 URL を渡された場合は throw する（本番 URL に落ちる経路が存在しないこと）
 *   - assertNotProdEnv: 本番 Supabase ref / 本番 OA / 実送信フラグを fail-closed で拒否
 *   - installTestFetchGuard: 差し替え後の fetch が本番宛を **送信前に** throw で止める
 *
 * 使用: npx tsx tests/unit/assert-not-prod.test.ts
 */

import {
  assertAllowedTestTarget,
  assertNotProdEnv,
  installTestFetchGuard,
  isAllowedTestHost,
  resolveStagingBaseUrl,
  ProdContactError,
  PROD_SUPABASE_REF,
  PROD_OA_ID,
  PROD_WORKER_HOSTS,
  STAGING_WORKER_BASE_URL,
} from "../lib/assert-not-prod";

// ---------------------------------------------------------------------------
// テストハーネス
// ---------------------------------------------------------------------------

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];

function describe(suiteName: string, fn: () => void) {
  console.log(`\n--- ${suiteName} ---`);
  fn();
}

function it(name: string, fn: () => void) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  PASS: ${name}`);
  } catch (err) {
    failedTests++;
    const error = err instanceof Error ? err.message : String(err);
    failures.push({ name, error });
    console.log(`  FAIL: ${name} -- ${error}`);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) {
    throw new Error(`${msg} (expected=${String(expected)} actual=${String(actual)})`);
  }
}

/** fn が ProdContactError を throw することを検査し、そのメッセージを返す。 */
function assertThrowsProdContact(fn: () => unknown, msg: string): string {
  let thrown: unknown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  if (thrown === null) throw new Error(`${msg}: throw しなかった（fail-closed 違反）`);
  if (!(thrown instanceof ProdContactError)) {
    throw new Error(`${msg}: ProdContactError ではない (${String(thrown)})`);
  }
  return (thrown as Error).message;
}

// ---------------------------------------------------------------------------
// assertAllowedTestTarget — 拒否側（本番接触を送信前に止める）
// ---------------------------------------------------------------------------

describe("assertAllowedTestTarget: 本番 Worker は throw して中断する", () => {
  for (const host of PROD_WORKER_HOSTS) {
    it(`本番 Worker host を拒否: ${host}`, () => {
      const m = assertThrowsProdContact(
        () => assertAllowedTestTarget(`https://${host}/webhook/line`, "unit"),
        `prod host ${host}`,
      );
      assert(m.includes("[assert-not-prod]"), "ProdContactError のプレフィックスが付く");
    });
  }

  it("本番カスタムドメイン（www.elxea.com）を拒否", () => {
    assertThrowsProdContact(
      () => assertAllowedTestTarget("https://www.elxea.com/api/chat", "unit"),
      "prod custom domain",
    );
  });

  it("未知の workers.dev サブドメインを拒否（ホワイトリスト方式＝新ドメインを取りこぼさない）", () => {
    assertThrowsProdContact(
      () => assertAllowedTestTarget("https://elxea-agent.brand-new-sub.workers.dev/", "unit"),
      "unknown prod-ish worker",
    );
  });

  it("staging を騙る別ドメインを拒否（サフィックス偽装）", () => {
    assertThrowsProdContact(
      () => assertAllowedTestTarget("https://elxea-agent-staging.setaka-on.workers.dev.evil.example/", "unit"),
      "suffix spoofing",
    );
  });

  it("URL 未設定は throw（fail-closed・既定で通さない）", () => {
    assertThrowsProdContact(() => assertAllowedTestTarget(undefined, "unit"), "undefined");
    assertThrowsProdContact(() => assertAllowedTestTarget("", "unit"), "empty");
  });

  it("URL として解釈できない文字列は throw", () => {
    assertThrowsProdContact(() => assertAllowedTestTarget("not-a-url", "unit"), "invalid url");
  });

  it("http/https 以外のスキームは throw", () => {
    assertThrowsProdContact(() => assertAllowedTestTarget("ftp://localhost/x", "unit"), "scheme");
  });

  it("ホストが許可でも path に本番 Supabase ref があれば throw（二重ガード）", () => {
    assertThrowsProdContact(
      () => assertAllowedTestTarget(`http://localhost:8787/proxy/${PROD_SUPABASE_REF}`, "unit"),
      "prod supabase ref in path",
    );
  });
});

// ---------------------------------------------------------------------------
// assertAllowedTestTarget — 許可側（staging / localhost は通る）
// ---------------------------------------------------------------------------

describe("assertAllowedTestTarget: staging と localhost のみ通す", () => {
  it("staging Worker は通り、同じ URL を返す", () => {
    const u = `${STAGING_WORKER_BASE_URL}/webhook/line`;
    assertEqual(assertAllowedTestTarget(u, "unit"), u, "staging worker passes through");
  });

  it("staging の version preview も通る", () => {
    const u = "https://a1b2c3d4-elxea-agent-staging.setaka-on.workers.dev/";
    assertEqual(assertAllowedTestTarget(u, "unit"), u, "staging version preview passes");
  });

  it("localhost / 127.0.0.1 / IPv6 loopback は通る", () => {
    assertEqual(
      assertAllowedTestTarget("http://localhost:8787", "unit"),
      "http://localhost:8787",
      "localhost",
    );
    assertEqual(
      assertAllowedTestTarget("http://127.0.0.1:8787/webhook", "unit"),
      "http://127.0.0.1:8787/webhook",
      "127.0.0.1",
    );
    assertEqual(
      assertAllowedTestTarget("http://[::1]:8787/", "unit"),
      "http://[::1]:8787/",
      "IPv6 loopback",
    );
  });

  it("isAllowedTestHost は本番ホストに false / staging・localhost に true", () => {
    for (const host of PROD_WORKER_HOSTS) {
      assert(!isAllowedTestHost(host), `prod host は許可しない: ${host}`);
    }
    assert(isAllowedTestHost("elxea-agent-staging.setaka-on.workers.dev"), "staging は許可");
    assert(isAllowedTestHost("localhost"), "localhost は許可");
    assert(!isAllowedTestHost("www.elxea.com"), "本番カスタムドメインは許可しない");
  });
});

// ---------------------------------------------------------------------------
// resolveStagingBaseUrl — 本番 URL に落ちる経路が無い
// ---------------------------------------------------------------------------

describe("resolveStagingBaseUrl: 本番 URL に落ちる経路が存在しない", () => {
  const saved = {
    STAGING_BASE_URL: process.env.STAGING_BASE_URL,
    STAGING_WORKER_URL: process.env.STAGING_WORKER_URL,
    CX_AGENT_BASE_URL: process.env.CX_AGENT_BASE_URL,
  };
  function restore() {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  it("env 未設定なら staging 既定値になる", () => {
    delete process.env.STAGING_BASE_URL;
    delete process.env.STAGING_WORKER_URL;
    // `.dev.vars` 由来の本番 URL が入っていても参照しないことを示す。
    process.env.CX_AGENT_BASE_URL = "https://elxea-agent.setaka-on.workers.dev";
    try {
      assertEqual(resolveStagingBaseUrl(), STAGING_WORKER_BASE_URL, "default is staging");
    } finally {
      restore();
    }
  });

  it("STAGING_BASE_URL に本番 URL を入れると throw（env 経由でも本番へ行けない）", () => {
    process.env.STAGING_BASE_URL = "https://elxea-agent.setaka-on.workers.dev";
    try {
      assertThrowsProdContact(() => resolveStagingBaseUrl(), "prod via STAGING_BASE_URL");
    } finally {
      restore();
    }
  });

  it("明示引数（--target 相当）に本番 URL を渡しても throw", () => {
    assertThrowsProdContact(
      () => resolveStagingBaseUrl("https://elxea-agent.setaka1103.workers.dev"),
      "prod via explicit override",
    );
  });

  it("末尾スラッシュは落とす（`${BASE}/path` の二重スラッシュ防止）", () => {
    assertEqual(
      resolveStagingBaseUrl(`${STAGING_WORKER_BASE_URL}///`),
      STAGING_WORKER_BASE_URL,
      "trailing slashes trimmed",
    );
  });
});

// ---------------------------------------------------------------------------
// assertNotProdEnv — env 経由の本番接触
// ---------------------------------------------------------------------------

describe("assertNotProdEnv: 本番 ref / OA / 実送信フラグを拒否", () => {
  it("本番 Supabase ref を含む SUPABASE_URL は throw", () => {
    assertThrowsProdContact(
      () => assertNotProdEnv({ SUPABASE_URL: `https://${PROD_SUPABASE_REF}.supabase.co` }),
      "prod supabase",
    );
  });

  it("本番 OA を含む LIFF URL は throw", () => {
    assertThrowsProdContact(
      () => assertNotProdEnv({ LIFF_LINKAGE_URL: `https://line.me/R/ti/p/${PROD_OA_ID}` }),
      "prod OA",
    );
  });

  it("DELIVERY_TARGET_ENV=prod は throw", () => {
    assertThrowsProdContact(() => assertNotProdEnv({ DELIVERY_TARGET_ENV: "prod" }), "target env");
  });

  it("実送信フラグ ON は throw（外部送信の芽を摘む）", () => {
    assertThrowsProdContact(
      () => assertNotProdEnv({ DELIVERY_SEND_ENABLED: "true" }),
      "delivery send",
    );
    assertThrowsProdContact(
      () => assertNotProdEnv({ DORMANT_SEND_ENABLED: "true" }),
      "dormant send",
    );
  });

  it("staging 相当の env は通る", () => {
    assertNotProdEnv({
      SUPABASE_URL: "https://espeokdhutgztksdrpzt.supabase.co",
      DELIVERY_TARGET_ENV: "test",
    });
  });
});

// ---------------------------------------------------------------------------
// installTestFetchGuard — 実際に「送信前に」止まることの実証
// ---------------------------------------------------------------------------

describe("installTestFetchGuard: 本番宛は fetch が呼ばれる前に throw する", () => {
  const originalFetch = globalThis.fetch;
  let realFetchCalls: string[] = [];

  // 実ネットワークに出ないよう、素の fetch をスパイに差し替えてからガードを敷く。
  globalThis.fetch = ((input: RequestInfo | URL) => {
    realFetchCalls.push(String(input));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  installTestFetchGuard("unit-guard");
  const guardedFetch = globalThis.fetch;

  it("本番 Worker 宛は同期 throw し、下層 fetch は 1 度も呼ばれない", () => {
    realFetchCalls = [];
    const m = assertThrowsProdContact(
      () => guardedFetch("https://elxea-agent.setaka-on.workers.dev/webhook/line", { method: "POST" }),
      "guarded prod POST",
    );
    assert(m.includes("elxea-agent.setaka-on.workers.dev"), "エラーに宛先が出る");
    assertEqual(realFetchCalls.length, 0, "本番へは 1 度も送信されていない");
  });

  it("未知の workers.dev 宛も throw し、下層 fetch は呼ばれない", () => {
    realFetchCalls = [];
    assertThrowsProdContact(
      () => guardedFetch("https://elxea-agent.some-new-sub.workers.dev/"),
      "guarded unknown worker",
    );
    assertEqual(realFetchCalls.length, 0, "未知 Worker へは送信されていない");
  });

  it("staging Worker 宛は通る（下層 fetch に到達する）", () => {
    realFetchCalls = [];
    void guardedFetch(`${STAGING_WORKER_BASE_URL}/`);
    assertEqual(realFetchCalls.length, 1, "staging は素通り");
  });

  it("第三者ホスト（staging Supabase 等）は本番マーカーが無ければ通る", () => {
    realFetchCalls = [];
    void guardedFetch("https://espeokdhutgztksdrpzt.supabase.co/rest/v1/flow_events");
    assertEqual(realFetchCalls.length, 1, "staging Supabase は素通り");
  });

  it("第三者ホストでも本番 Supabase ref を含めば throw", () => {
    realFetchCalls = [];
    assertThrowsProdContact(
      () => guardedFetch(`https://${PROD_SUPABASE_REF}.supabase.co/rest/v1/customers`),
      "prod supabase via guarded fetch",
    );
    assertEqual(realFetchCalls.length, 0, "本番 Supabase へは送信されていない");
  });

  it("二重 install しても二重ラップされない（idempotent）", () => {
    installTestFetchGuard("unit-guard");
    assert(globalThis.fetch === guardedFetch, "同一インスタンスのまま");
  });

  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// 結果サマリー
// ---------------------------------------------------------------------------

console.log("\n" + "=".repeat(60));
console.log("assert-not-prod (test target guard) Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failedTests > 0 ? 1 : 0);
