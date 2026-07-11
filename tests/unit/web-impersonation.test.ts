/**
 * Unit Tests -- [SEC-B] Web なりすまし対策
 *
 * ブラウザ自己申告の shopify_customer_id を無検証で信頼していた問題を塞いだことを検証する。
 * 実 Supabase / 実ネットワークには一切触れない（mock context / mock supabase）。
 *
 *   - ブラウザ自己申告（X-API-Key 無し）の customer_id を信用しない
 *   - サーバ経由（X-API-Key 一致）でのみ customer_id を採用する（fail-closed）
 *   - resolveWithShopifyCustomerId が web_session_id を再束縛しない（乗っ取り防止）
 *   - 未知の session_id は isLinked=false（history がクロスチャネルを返さない前提）
 *
 * 使用方法:
 *   npx tsx tests/unit/web-impersonation.test.ts
 */
import type { Context } from "hono";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../../src/index";
import { isTrustedServerCaller, effectiveEventUserId } from "../../src/routes/web";
import { getClientIp } from "../../src/lib/web-auth";
import {
  resolveWithShopifyCustomerId,
  resolveUnifiedUserId,
} from "../../src/lib/identity";

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

const TEST_SECRET = "test-sync-secret-xyz";

/** X-API-Key ヘッダー有無だけを制御する mock Context。 */
function makeCtx(opts: { apiKey?: string; secret?: string }): Context<{ Bindings: Env }> {
  return {
    req: {
      header: (name: string) => (name === "X-API-Key" ? opts.apiKey : undefined),
    },
    env: { SYNC_API_SECRET: opts.secret } as unknown as Env,
  } as unknown as Context<{ Bindings: Env }>;
}

/**
 * resolveWithShopifyCustomerId / resolveUnifiedUserId 用の mock supabase。
 * select→eq→single は既定レコードを返し、update 呼び出しを記録する。
 */
function makeSupabase(existing: unknown) {
  const updates: unknown[] = [];
  const supabase = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                single: async () => {
                  if (existing) return { data: existing, error: null };
                  return { data: null, error: { code: "PGRST116", message: "no rows" } };
                },
              };
            },
          };
        },
        update(payload: unknown) {
          updates.push(payload);
          return { eq: async () => ({ data: null, error: null }) };
        },
      };
    },
  };
  return { supabase: supabase as unknown as SupabaseClient, updates };
}

// ---------------------------------------------------------------------------
// isTrustedServerCaller: ブラウザ自己申告を信用しない
// ---------------------------------------------------------------------------
describe("[SEC-B] isTrustedServerCaller", () => {
  it("X-API-Key 無し（ブラウザ直呼び）→ false（信用しない）", () => {
    assertEqual(isTrustedServerCaller(makeCtx({ secret: TEST_SECRET })), false);
  });
  it("X-API-Key 不一致 → false", () => {
    assertEqual(
      isTrustedServerCaller(makeCtx({ apiKey: "wrong", secret: TEST_SECRET })),
      false,
    );
  });
  it("SYNC_API_SECRET 未設定 → 正しそうな key でも false（fail-closed）", () => {
    assertEqual(
      isTrustedServerCaller(makeCtx({ apiKey: TEST_SECRET, secret: undefined })),
      false,
    );
  });
  it("X-API-Key 一致（サーバ経由）→ true", () => {
    assertEqual(
      isTrustedServerCaller(makeCtx({ apiKey: TEST_SECRET, secret: TEST_SECRET })),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// effectiveEventUserId: 他人の customer_id を採用しない
// ---------------------------------------------------------------------------
describe("[SEC-B] effectiveEventUserId", () => {
  const session = "11111111-1111-4111-8111-111111111111";
  it("ブラウザ自己申告（trusted=false）の他人 customer_id は無視 → session_id を使う", () => {
    assertEqual(
      effectiveEventUserId(false, "gid://shopify/Customer/999", session),
      session,
      "なりすまし customer_id を採用してはいけない",
    );
  });
  it("サーバ経由（trusted=true）+ customer_id → customer_id を採用", () => {
    assertEqual(
      effectiveEventUserId(true, "gid://shopify/Customer/999", session),
      "gid://shopify/Customer/999",
    );
  });
  it("サーバ経由でも customer_id 無し → session_id", () => {
    assertEqual(effectiveEventUserId(true, undefined, session), session);
  });
});

// ---------------------------------------------------------------------------
// getClientIp: 転送ヘッダは信頼済み proxy 由来のときだけ採用（なりすまし防止）
// ---------------------------------------------------------------------------
/** cf.connectingIp と任意ヘッダを持つ mock Request を作る。 */
function makeReq(opts: {
  cfIp?: string;
  headers?: Record<string, string>;
}): Request {
  const headers = opts.headers ?? {};
  return {
    cf: opts.cfIp ? { connectingIp: opts.cfIp } : undefined,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  } as unknown as Request;
}

describe("[B2] getClientIp 転送元 IP レート制限 (なりすまし防止)", () => {
  const CF_IP = "203.0.113.9"; // Vercel egress (proxy 化後の接続元) 相当
  const REAL_IP = "198.51.100.7"; // ブラウザの実クライアント IP

  it("直叩き (trustedProxy=false) は転送ヘッダを無視し cf.connectingIp を使う", () => {
    const req = makeReq({
      cfIp: CF_IP,
      headers: {
        "x-forwarded-for": `${REAL_IP}, ${CF_IP}`,
        "x-real-client-ip": REAL_IP,
      },
    });
    assertEqual(getClientIp(req, false), CF_IP, "詐称ヘッダを採用してはいけない");
  });

  it("引数省略 (既定 false) でも転送ヘッダを無視する", () => {
    const req = makeReq({ cfIp: CF_IP, headers: { "x-real-client-ip": REAL_IP } });
    assertEqual(getClientIp(req), CF_IP);
  });

  it("信頼済み proxy (trustedProxy=true) は X-Real-Client-IP の実 IP を採用", () => {
    const req = makeReq({ cfIp: CF_IP, headers: { "x-real-client-ip": REAL_IP } });
    assertEqual(getClientIp(req, true), REAL_IP);
  });

  it("信頼済み proxy: X-Real-Client-IP 不在なら X-Forwarded-For 最左を採用", () => {
    const req = makeReq({
      cfIp: CF_IP,
      headers: { "x-forwarded-for": `${REAL_IP}, ${CF_IP}` },
    });
    assertEqual(getClientIp(req, true), REAL_IP, "XFF 最左 = proxy が置いた実 IP");
  });

  it("信頼済み proxy でも転送ヘッダ不在なら cf.connectingIp にフォールバック", () => {
    const req = makeReq({ cfIp: CF_IP });
    assertEqual(getClientIp(req, true), CF_IP);
  });

  it("cf 不在時は CF-Connecting-IP ヘッダにフォールバック (直叩き)", () => {
    const req = makeReq({ headers: { "cf-connecting-ip": CF_IP } });
    assertEqual(getClientIp(req, false), CF_IP);
  });

  it("全て不在なら unknown", () => {
    assertEqual(getClientIp(makeReq({}), true), "unknown");
  });
});

// ---------------------------------------------------------------------------
// resolveWithShopifyCustomerId: 再束縛（web_session_id 上書き）を行わない
// ---------------------------------------------------------------------------
describe("[SEC-B] resolveWithShopifyCustomerId 再束縛防止", () => {
  it("既存レコードの web_session_id を別 session_id で上書きしない", async () => {
    // 被害者 unified_user が既に別 session を持つ。攻撃者が自身の session で来ても上書きしない。
    const existing = {
      unified_user_id: "victim-unified",
      web_session_id: "victim-session",
      line_user_id: "Uvictim-line",
    };
    const { supabase, updates } = makeSupabase(existing);
    const result = await resolveWithShopifyCustomerId(
      supabase,
      "gid://shopify/Customer/555",
      "attacker-session",
    );
    // 既存の unified は返るが、web_session_id の再束縛 update は発生しない
    assertEqual(result.unifiedUserId, "victim-unified", "既存 unified を返す");
    assertEqual(updates.length, 0, "web_session_id を上書きする update を発行してはいけない");
  });
});

// ---------------------------------------------------------------------------
// resolveUnifiedUserId: 未知の session は isLinked=false（history クロスチャネル遮断の前提）
// ---------------------------------------------------------------------------
describe("[SEC-B] resolveUnifiedUserId 未知セッション", () => {
  it("map に無い session_id → isLinked=false（クロスチャネル履歴の対象にしない）", async () => {
    const { supabase } = makeSupabase(null); // レコード無し
    const result = await resolveUnifiedUserId(supabase, "unknown-session", "web");
    assertEqual(result.isLinked, false, "未知 session は linked 扱いにしない");
    assertEqual(result.unifiedUserId, "unknown-session", "自身の session_id にフォールバック");
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
  console.log("web-impersonation (SEC-B) Test Results");
  console.log("============================================================");
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
  if (failedTests > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})();
