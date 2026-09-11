/**
 * Unit Tests — ストリーム受信の期限 (H-1) と 例外時の末尾保全 (L-1)
 *
 * 背景: 初回ターンをストリーミング化した際、withTimeout がストリーム確立までしか
 * 掛からなくなり、本文受信ループ (`for await`) が無制限になっていた。
 * iterateWithDeadline は「ターンの応答生成全体」に絶対時刻の期限を戻す。
 *
 * 使用: npx tsx tests/unit/stream-deadline.test.ts
 */

import { iterateWithDeadline } from "../../src/lib/utils";
import { createBrandGuardStream } from "../../src/lib/brand-guard";

let total = 0;
let passed = 0;
const queue: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function it(name: string, fn: () => Promise<void> | void) { queue.push({ name, fn }); }
function assert(cond: boolean, label: string) { if (!cond) throw new Error(label); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Anthropic SDK の Stream を模した最小の擬似ストリーム。 */
function fakeStream(opts: {
  events: string[];
  /** 各イベントの前に入る待ち時間 */
  gapMs?: number;
  /** 全イベントを出し切った後、永久に返さない (上流の停滞を模す) */
  stallAtEnd?: boolean;
  /** n 番目のイベントの前で永久に停滞する */
  stallAfter?: number;
}) {
  const state = { aborted: 0, delivered: [] as string[] };
  const stream = {
    controller: { abort: () => { state.aborted++; } },
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < opts.events.length; i++) {
        if (opts.stallAfter !== undefined && i >= opts.stallAfter) {
          await new Promise<never>(() => { /* 永久に解決しない */ });
        }
        if (opts.gapMs) await sleep(opts.gapMs);
        state.delivered.push(opts.events[i]);
        yield opts.events[i];
      }
      if (opts.stallAtEnd) await new Promise<never>(() => { /* 永久に解決しない */ });
    },
  };
  return { stream, state };
}

// --- H-1: 期限が効く ---------------------------------------------------------

it("期限内に終わるストリームは全イベントを通し、abort しない", async () => {
  const { stream, state } = fakeStream({ events: ["a", "b", "c"], gapMs: 5 });
  const got: string[] = [];
  for await (const ev of iterateWithDeadline(stream, Date.now() + 1_000, "test")) got.push(ev);
  assert(got.join("") === "abc", `全イベント到達: got=${got.join("")}`);
  assert(state.aborted === 0, "正常時は abort しない");
});

it("本文受信の途中で上流が停滞したら期限で打ち切る (無制限に待たない)", async () => {
  const { stream, state } = fakeStream({ events: ["a", "b", "c"], stallAfter: 2 });
  const budget = 300;
  const t0 = Date.now();
  const got: string[] = [];
  let err: Error | null = null;
  try {
    for await (const ev of iterateWithDeadline(stream, t0 + budget, "anthropic turn=0 stream")) got.push(ev);
  } catch (e) { err = e as Error; }
  const elapsed = Date.now() - t0;
  assert(err !== null, "期限超過で例外が投げられる");
  assert(/Timeout: anthropic turn=0 stream/.test(err!.message), `タイムアウト例外である: ${err?.message}`);
  assert(elapsed >= budget - 50 && elapsed < budget + 500, `期限付近で打ち切る: elapsed=${elapsed}ms budget=${budget}ms`);
  assert(got.join("") === "ab", `打ち切り前の delta は消えない: got=${got.join("")}`);
  assert(state.aborted === 1, "打ち切り時に上流接続を abort する");
});

it("ストリーム確立後に 1 件も届かない場合も期限で打ち切る", async () => {
  const { stream } = fakeStream({ events: [], stallAtEnd: true });
  const budget = 200;
  const t0 = Date.now();
  let err: Error | null = null;
  try {
    for await (const _ of iterateWithDeadline(stream, t0 + budget, "test")) { /* noop */ }
  } catch (e) { err = e as Error; }
  assert(err !== null, "無応答でも例外になる");
  assert(Date.now() - t0 < budget + 500, "期限付近で打ち切る");
});

it("既に期限を過ぎていれば即座に打ち切る", async () => {
  const { stream, state } = fakeStream({ events: ["a"], stallAfter: 0 });
  const t0 = Date.now();
  let err: Error | null = null;
  try {
    for await (const _ of iterateWithDeadline(stream, t0 - 1_000, "test")) { /* noop */ }
  } catch (e) { err = e as Error; }
  assert(err !== null, "期限切れで例外になる");
  assert(Date.now() - t0 < 200, "待たずに返る");
  assert(state.aborted === 1, "abort する");
});

// --- L-1: 例外時に保留中の末尾を捨てない -------------------------------------

it("受信途中の例外でも、増分ガードの保留分 (末尾) が失われない", async () => {
  // core.ts の delta ループと同じ形 (try { ... } catch { flush して投げ直す })
  const sent: string[] = [];
  const guard = createBrandGuardStream({ channel: "web", userId: "test" });
  const body = "お問い合わせありがとうございます。エルクシアのお茶は日本各地の産地から選んでいます。";
  let thrown: Error | null = null;
  try {
    try {
      for (const ch of body) {
        const out = guard.push(ch);
        if (out) sent.push(out);
      }
      throw new Error("Timeout: anthropic turn=0 stream exceeded 18000ms");
    } catch (err) {
      const tail = guard.flush();
      if (tail) sent.push(tail);
      throw err;
    }
  } catch (e) { thrown = e as Error; }
  assert(thrown !== null, "例外はそのまま上位へ伝わる");
  assert(sent.join("") === body, `送信済み本文が全文と一致する (末尾欠落なし): got=${sent.join("")}`);
});

// --- 配線の確認: core.ts の delta ループが実際に期限を使っているか -------------

it("core.ts の本文受信ループがストリーム確立と同じ期限で包まれている", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../src/agent/core.ts", import.meta.url), "utf-8");
  assert(/const turnDeadlineAt = Date\.now\(\) \+ TIMEOUT_LLM_CALL_MS;/.test(src), "ターン期限を絶対時刻で持つ");
  assert(/client\.messages\.create\(\{ \.\.\.apiParams, messages, stream: true \}\),\s*\n\s*Math\.max\(0, turnDeadlineAt - Date\.now\(\)\),/.test(src), "ストリーム確立も同じ期限を使う");
  assert(/for await \(const event of iterateWithDeadline\(stream, turnDeadlineAt,/.test(src), "本文受信ループが iterateWithDeadline で包まれている");
  assert(!/for await \(const event of stream\)/.test(src), "素の for await (無期限) が残っていない");
});

(async () => {
  for (const t of queue) {
    total++;
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      console.log(`  [FAIL] ${t.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("\n============================================================");
  console.log("stream-deadline Test Results");
  console.log("============================================================");
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${total - passed}`);
  if (passed < total) process.exit(1);
})();
