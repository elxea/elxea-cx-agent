/**
 * Unit Tests -- LineResponder（reply 優先・push フォールバックの通数会計）
 *
 * 検証する不変条件（このタスクの本質 = 通数の無料化）:
 *   (a) reply token が生きていれば最初の送信は /message/reply（無料）に行く
 *   (b) reply token は 1 ターン 1 回のみ — 2 通目は /message/push（有料）にフォールバック
 *   (c) reply token が無いイベント（例: unfollow）は常に /message/push
 *   (d) reply が 4xx（Invalid reply token: 期限切れ/使用済み）で失敗しても
 *       push で必ず届ける（配信の非回帰 = fail-safe）
 *
 * 実 I/O は global fetch をスタブして遮断する（LINE には一切送らない）。
 * 使用方法: npx tsx tests/unit/line-responder.test.ts
 */

import { createResponder } from "../../src/lib/line";
import type { Env } from "../../src/index";

let total = 0,
  passed = 0,
  failed = 0;
const failures: Array<{ name: string; error: string }> = [];

function it(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      total++;
      passed++;
      console.log(`  [PASS] ${name}`);
    })
    .catch((err) => {
      total++;
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${name}: ${msg}`);
      failures.push({ name, error: msg });
    });
}
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const env = { LINE_CHANNEL_ACCESS_TOKEN: "test-token" } as unknown as Env;

/** fetch をスタブし、呼ばれた URL 列と各レスポンスを制御する。 */
function stubFetch(handler: (url: string) => { ok: boolean; status: number }) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const { ok, status } = handler(url);
    return {
      ok,
      status,
      text: async () => (ok ? "" : `error ${status}`),
    } as Response;
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** fetch をスタブし、送信された JSON body を捕捉する（UX③ の quickReply 検証用）。 */
function stubFetchWithBody(handler: (url: string) => { ok: boolean; status: number }) {
  const bodies: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    try {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    } catch {
      bodies.push({});
    }
    const { ok, status } = handler(String(input));
    return { ok, status, text: async () => (ok ? "" : `error ${status}`) } as Response;
  }) as typeof fetch;
  return {
    bodies,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const REPLY = "https://api.line.me/v2/bot/message/reply";
const PUSH = "https://api.line.me/v2/bot/message/push";

async function main() {
  console.log("\n--- (a) reply token 生存 → 最初の送信は reply（無料） ---");
  await it("最初の text は /message/reply に行く", async () => {
    const f = stubFetch(() => ({ ok: true, status: 200 }));
    try {
      const r = createResponder("U1", "rt-live", env);
      await r.text("hello");
      assert(f.calls.length === 1, `1 call, got ${f.calls.length}`);
      assert(f.calls[0] === REPLY, `expected reply, got ${f.calls[0]}`);
    } finally {
      f.restore();
    }
  });

  console.log("\n--- (b) reply token は 1 回のみ → 2 通目は push ---");
  await it("2 通目（Flex 相当）は /message/push にフォールバック", async () => {
    const f = stubFetch(() => ({ ok: true, status: 200 }));
    try {
      const r = createResponder("U1", "rt-live", env);
      await r.text("first");
      await r.flex("alt", { type: "bubble" });
      assert(f.calls.length === 2, `2 calls, got ${f.calls.length}`);
      assert(f.calls[0] === REPLY, `1st reply, got ${f.calls[0]}`);
      assert(f.calls[1] === PUSH, `2nd push, got ${f.calls[1]}`);
    } finally {
      f.restore();
    }
  });

  console.log("\n--- (c) reply token 無し → 常に push ---");
  await it("replyToken undefined は最初から /message/push", async () => {
    const f = stubFetch(() => ({ ok: true, status: 200 }));
    try {
      const r = createResponder("U1", undefined, env);
      await r.text("hello");
      assert(f.calls.length === 1 && f.calls[0] === PUSH, `expected push, got ${f.calls[0]}`);
    } finally {
      f.restore();
    }
  });

  console.log("\n--- (d) reply 失敗（400）→ push で必ず届ける（非回帰） ---");
  await it("reply 400 でも push フォールバックで配信を担保", async () => {
    const f = stubFetch((url) => (url === REPLY ? { ok: false, status: 400 } : { ok: true, status: 200 }));
    try {
      const r = createResponder("U1", "rt-expired", env);
      await r.text("hello");
      assert(f.calls.length === 2, `reply then push = 2 calls, got ${f.calls.length}`);
      assert(f.calls[0] === REPLY && f.calls[1] === PUSH, `reply→push, got ${f.calls.join(",")}`);
    } finally {
      f.restore();
    }
  });

  console.log("\n--- (UX③) flex に quickReply を additive で付ける ---");
  await it("flex(alt, contents, qr) は message に quickReply.items を付ける（≤13 に丸め）", async () => {
    const f = stubFetchWithBody(() => ({ ok: true, status: 200 }));
    try {
      const r = createResponder("U1", "rt-live", env);
      const items = Array.from({ length: 15 }, (_, i) => ({
        type: "action" as const,
        action: { type: "message" as const, label: `l${i}`, text: `t${i}` },
      }));
      await r.flex("alt", { type: "bubble" }, items);
      const msg = (f.bodies[0].messages as Array<Record<string, unknown>>)[0];
      assert(msg.type === "flex", "flex message");
      const qr = msg.quickReply as { items?: unknown[] } | undefined;
      assert(!!qr && Array.isArray(qr.items), "quickReply.items present");
      assert(qr!.items!.length === 13, `slice to 13 (got ${qr!.items!.length})`);
    } finally {
      f.restore();
    }
  });

  await it("flex(alt, contents) は quickReply を付けない（無回帰・省略時）", async () => {
    const f = stubFetchWithBody(() => ({ ok: true, status: 200 }));
    try {
      const r = createResponder("U1", "rt-live", env);
      await r.flex("alt", { type: "bubble" });
      const msg = (f.bodies[0].messages as Array<Record<string, unknown>>)[0];
      assert(msg.type === "flex", "flex message");
      assert(msg.quickReply === undefined, "no quickReply when omitted");
    } finally {
      f.restore();
    }
  });

  console.log("\n" + "=".repeat(60));
  console.log("LINE Responder Unit Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const fl of failures) console.log(`  - ${fl.name}: ${fl.error}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main();
