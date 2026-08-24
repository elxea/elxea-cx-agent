/**
 * Unit Tests — 毎日の照合（M-2 / J-2 / src/lib/linkage-reconcile.ts）
 *
 * ## 何を守るテストか
 *
 * 合体イベントは、連携そのものを止めないよう **fire-and-forget** で送っている。その裏返しで
 * **通知が 1 度落ちるとその人の合体は二度と起きない**。唯一の回収経路「次にメールで
 * ログインしたとき」は、LINE トーク内で連携した人には来ないかもしれない。
 * J-2 が「(a) 通知 **+ 照合ジョブ**」と決めたのはこの穴のためで、片方だけでは決裁を
 * 満たさない。
 *
 * このテストが守るのは 4 点。
 *
 *   1. **台帳に在るものは全部送り直す** — 「最近の分だけ」に絞ると、古い取りこぼしが
 *      永久に残る（＝収束しない）
 *   2. **cron を落とさない** — 設定不足・台帳の読み取り失敗・通知の例外、どれでも throw しない
 *   3. **上限で黙って一部だけ送り続けない** — 打ち切ったら自己申告する
 *   4. **出所を分ける** — 「連携の瞬間」と「毎日の照合」を混ぜると、どちらが落ちているか
 *      分からなくなる
 *
 * 副作用ゼロ: Supabase も fetch も差し替え。ネットワークに触れない。
 *
 * 使用方法:
 *   npx tsx tests/unit/linkage-reconcile.test.ts
 */

import { runLinkageReconcile } from "../../src/lib/linkage-reconcile";
import type { Env } from "../../src/index";
import type { LinkageNotifyInput, LinkageNotifyResult } from "../../src/lib/linkage-notify";

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
} as unknown as Env;

function pairs(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    lineUserId: `U${String(i).padStart(32, "0")}`,
    shopifyCustomerId: String(7000000 + i),
  }));
}

/** 記録付きの偽 notify。 */
function fakeNotify(
  outcome: (i: number) => LinkageNotifyResult | { throws: Error },
): {
  impl: (
    env: Env,
    input: LinkageNotifyInput,
    fetchImpl?: typeof fetch,
  ) => Promise<LinkageNotifyResult>;
  calls: LinkageNotifyInput[];
} {
  const calls: LinkageNotifyInput[] = [];
  const impl = async (_env: Env, input: LinkageNotifyInput) => {
    const r = outcome(calls.length);
    calls.push(input);
    if ("throws" in r) throw r.throws;
    return r;
  };
  return { impl, calls };
}

const OK: LinkageNotifyResult = { ok: true, status: 200 };
const REJECTED: LinkageNotifyResult = {
  ok: false,
  reason: "rejected",
  detail: "status=500",
};

async function main() {
  console.log("\n--- linkage-reconcile（毎日の照合）---");

  await it("台帳の連携を全件送り直す（「最近の分だけ」に絞らない）", async () => {
    const rows = pairs(5);
    const { impl, calls } = fakeNotify(() => OK);

    const r = await runLinkageReconcile(ENV, {
      listLinkages: async () => rows,
      notify: impl,
    });

    assertEqual(r.scanned, 5, "scanned");
    assertEqual(r.merged, 5, "merged");
    assertEqual(r.failed, 0, "failed");
    assertEqual(r.budgetReached, false, "budgetReached");
    assertEqual(calls.length, 5, "通知回数");
    assertEqual(r.notRun, null, "notRun");
  });

  await it("出所は reconcile。連携の瞬間の通知と混ぜない", async () => {
    const { impl, calls } = fakeNotify(() => OK);

    await runLinkageReconcile(ENV, { listLinkages: async () => pairs(1), notify: impl });

    assertEqual(calls[0].source, "reconcile", "source");
  });

  await it("台帳の値をそのまま渡す（ここで正規化し直さない）", async () => {
    const rows = pairs(1);
    const { impl, calls } = fakeNotify(() => OK);

    await runLinkageReconcile(ENV, { listLinkages: async () => rows, notify: impl });

    assertEqual(calls[0].lineUserId, rows[0].lineUserId, "lineUserId");
    assertEqual(calls[0].shopifyCustomerId, rows[0].shopifyCustomerId, "shopifyCustomerId");
  });

  await it("届かなかった分は failed に数え、残りを止めない", async () => {
    /* 2 件目だけ落ちる。1 件の失敗で全体を止めると、後ろの人が永久に拾われない。 */
    const { impl, calls } = fakeNotify((i) => (i === 1 ? REJECTED : OK));

    const r = await runLinkageReconcile(ENV, {
      listLinkages: async () => pairs(3),
      notify: impl,
    });

    assertEqual(r.merged, 2, "merged");
    assertEqual(r.failed, 1, "failed");
    assertEqual(calls.length, 3, "3 件とも試している");
  });

  await it("通知が例外で落ちても throw しない（cron を落とさない）", async () => {
    const { impl } = fakeNotify((i) =>
      i === 0 ? { throws: new Error("boom") } : OK,
    );

    const r = await runLinkageReconcile(ENV, {
      listLinkages: async () => pairs(2),
      notify: impl,
    });

    assertEqual(r.failed, 1, "failed");
    assertEqual(r.merged, 1, "merged");
  });

  await it("台帳が読めなくても throw しない。理由を notRun に出す", async () => {
    const r = await runLinkageReconcile(ENV, {
      listLinkages: async () => {
        throw new Error("supabase down");
      },
      notify: fakeNotify(() => OK).impl,
    });

    assertEqual(r.notRun, "linkage query failed", "notRun");
    assertEqual(r.scanned, 0, "scanned");
  });

  await it("送り先が未設定なら台帳を読みにも行かない", async () => {
    let queried = false;
    const r = await runLinkageReconcile({} as Env, {
      listLinkages: async () => {
        queried = true;
        return pairs(1);
      },
      notify: fakeNotify(() => OK).impl,
    });

    assertEqual(r.notRun, "web-app notify target not configured", "notRun");
    assertTrue(!queried, "未設定なのに台帳を読んでいる");
  });

  await it("env は trim して見る（空白だけの値を「設定済み」と読まない）", async () => {
    const r = await runLinkageReconcile(
      { WEB_APP_BASE_URL: "  ", LINKAGE_EVENT_SECRET: "\n" } as unknown as Env,
      { listLinkages: async () => pairs(1), notify: fakeNotify(() => OK).impl },
    );

    assertEqual(r.notRun, "web-app notify target not configured", "notRun");
  });

  await it("上限に当たったら打ち切り、打ち切ったことを自己申告する", async () => {
    /* 黙って前半だけ送り続ける状態を作らない。budgetReached が「印を持つ設計へ
       進む合図」になる。 */
    const { impl, calls } = fakeNotify(() => OK);

    const r = await runLinkageReconcile(ENV, {
      listLinkages: async () => pairs(250),
      notify: impl,
    });

    assertEqual(r.scanned, 250, "scanned は読んだ全件");
    assertEqual(calls.length, 200, "送るのは上限まで");
    assertEqual(r.budgetReached, true, "budgetReached");
  });

  console.log("\n" + "=".repeat(60));
  console.log("Linkage Reconcile Unit Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main();
