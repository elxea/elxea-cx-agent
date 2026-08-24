/**
 * Unit Tests — 合体イベントの通知（M-2 / src/lib/linkage-notify.ts）
 *
 * ## 何を守るテストか
 *
 * 連携が成立したら、web-app 側で `users/line:<LINE ID>/**` を `users/<顧客番号>/**` へ
 * 運ぶ「合体」が走らなければならない。そのきっかけは web-app 側の 4 経路にばらばらに
 * 置かれていて、**LINE トーク内の Account Link だけはどの経路も通らなかった** — その
 * 連携は LINE → cx-agent の webhook だけで完結し、web-app を一度も通らないからである
 * （再設計 D-3）。
 *
 * よって合図を「台帳に行が立った」1 イベントに集約し、書いた側から知らせる。
 * このテストが守るのは 2 点。
 *
 *   1. **連携そのものを絶対に止めない** — 通知が落ちても throw しない
 *   2. **無音で落ちない** — 設定が無い / 届かない / 拒まれた を区別して返す
 *
 * 副作用ゼロ: fetch は差し替え。ネットワークにも LINE にも触れない。
 *
 * 使用方法:
 *   npx tsx tests/unit/linkage-notify.test.ts
 */

import { notifyLinkageEstablished } from "../../src/lib/linkage-notify";

let total = 0;
let passed = 0;
let failed = 0;
const failures: string[] = [];

function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  total++;
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  [PASS] ${name}`);
    })
    .catch((err) => {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${name}: ${msg}`);
      failures.push(`${name}: ${msg}`);
    });
}

function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assertTrue(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const ENV = {
  WEB_APP_BASE_URL: "https://elxea.com",
  LINKAGE_EVENT_SECRET: "test-linkage-secret",
};

const INPUT = {
  lineUserId: "U0123456789abcdef0123456789abcdef",
  shopifyCustomerId: "7654321",
  source: "account_link",
};

/** 記録付きの偽 fetch。 */
function fakeFetch(res: { status: number } | { throws: Error }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if ("throws" in res) throw res.throws;
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function main() {
  console.log("\n--- linkage-notify（合体イベントの通知）---");

  await it("成功したら ok を返す", async () => {
    const { impl } = fakeFetch({ status: 200 });
    const r = await notifyLinkageEstablished(ENV, INPUT, impl);
    assertEqual(r.ok, true, "ok");
  });

  await it("契約どおりの URL / 別鍵の Bearer / body を送る", async () => {
    const { impl, calls } = fakeFetch({ status: 200 });
    await notifyLinkageEstablished(ENV, INPUT, impl);

    assertEqual(calls.length, 1, "呼び出し回数");
    assertEqual(
      calls[0].url,
      "https://elxea.com/api/internal/linkage-established",
      "URL",
    );
    assertEqual(calls[0].init.method, "POST", "method");
    /* SYNC_API_SECRET ではなく専用鍵。この口は「同一人物である」と宣言でき、
       通れば web-app は元の棚を消して荷物を移す。 */
    assertEqual(
      (calls[0].init.headers as Record<string, string>).Authorization,
      "Bearer test-linkage-secret",
      "Authorization",
    );
    const body = JSON.parse(String(calls[0].init.body));
    assertEqual(body.line_user_id, INPUT.lineUserId, "line_user_id");
    assertEqual(body.shopify_customer_id, INPUT.shopifyCustomerId, "shopify_customer_id");
    assertEqual(body.source, "account_link", "source");
  });

  /* ── 連携を止めないこと ── */
  await it("web-app が落ちていても throw しない（連携は成立済み）", async () => {
    const { impl } = fakeFetch({ throws: new Error("network down") });
    const r = await notifyLinkageEstablished(ENV, INPUT, impl);
    assertEqual(r.ok, false, "ok");
    assertTrue(!r.ok && r.reason === "unreachable", "reason=unreachable");
  });

  await it("web-app が 500 を返しても throw しない", async () => {
    const { impl } = fakeFetch({ status: 500 });
    const r = await notifyLinkageEstablished(ENV, INPUT, impl);
    assertTrue(!r.ok && r.reason === "rejected", "reason=rejected");
  });

  await it("401 も rejected として返す（鍵の取り違えを黙って成功にしない）", async () => {
    const { impl } = fakeFetch({ status: 401 });
    const r = await notifyLinkageEstablished(ENV, INPUT, impl);
    assertTrue(!r.ok && r.reason === "rejected", "reason=rejected");
  });

  /* ── 設定が無い ≠ 失敗した ── */
  await it("env 未設定なら not-configured を返し、fetch を呼ばない", async () => {
    const { impl, calls } = fakeFetch({ status: 200 });
    const r = await notifyLinkageEstablished({}, INPUT, impl);
    assertTrue(!r.ok && r.reason === "not-configured", "reason=not-configured");
    assertEqual(calls.length, 0, "呼び出し回数");
  });

  await it("片方だけ設定されていても not-configured（中途半端に投げない）", async () => {
    const { impl, calls } = fakeFetch({ status: 200 });
    const r = await notifyLinkageEstablished(
      { WEB_APP_BASE_URL: "https://elxea.com" },
      INPUT,
      impl,
    );
    assertTrue(!r.ok && r.reason === "not-configured", "reason");
    assertEqual(calls.length, 0, "呼び出し回数");
  });

  /* G12（env は必ず trim して読む / 2026-08-22 の本番障害）。
     `vercel env add < file` / `wrangler secret put < file` は末尾改行まで値にする。 */
  await it("末尾の改行・スラッシュがあっても正しい URL を組む", async () => {
    const { impl, calls } = fakeFetch({ status: 200 });
    await notifyLinkageEstablished(
      { WEB_APP_BASE_URL: " https://elxea.com/\n", LINKAGE_EVENT_SECRET: "s\n" },
      INPUT,
      impl,
    );
    assertEqual(
      calls[0].url,
      "https://elxea.com/api/internal/linkage-established",
      "URL",
    );
    assertEqual(
      (calls[0].init.headers as Record<string, string>).Authorization,
      "Bearer s",
      "Authorization",
    );
  });

  console.log("\n" + "=".repeat(60));
  console.log("Linkage Notify Unit Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main();
