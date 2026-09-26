/**
 * Unit Tests -- 送る関所 4 つ (LINE の送信・保存・AI の出口・履歴)
 *
 * 設計: 実装設計 rev2 第5章 / 第9章 テスト4
 *   https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 *
 * 固定すること:
 *   - AI の返事に `https://elxea.com/ja` と `elxea.com/ja/subscription` が入っていても、送信文・保存文・
 *     AI の出口の値に出ない。`info@elxea.com` と Amazon の URL は残る
 *   - AI が出す Flex に閉じたリンクがあれば送らない
 *   - 逐次送信で断片をまたぐ URL も消え、日本語の本文は持ち越されない
 *     (onProductCards / onCartLink も包む: 設計 QA 3 回目 m3)
 *   - 履歴の過去発言からも消える (お客さんの発言は変えない)
 *   - `pushTextMessage` でも消える
 *   - 消した結果が空になった本文は送らず、warn を必ず出す (本文はログに出さない: 設計 QA 3 回目 m4)
 *   - 開店中は何も変えない
 *   - 決まった文 (閉じたリンクを含まない文) では消す数 = 0・入力と同じ文字列
 *
 * 実 I/O は global fetch をスタブして遮断する (LINE には一切送らない)。
 * 使用方法: npx tsx tests/unit/closed-link-gate.test.ts
 */

import {
  createStreamingTextGate,
  gateAgentResult,
  gateLineMessages,
  gateStreamCallbacks,
  gateText,
  hasClosedLink,
  type GateableStreamCallbacks,
} from "../../src/lib/closed-link-gate";
import { AMAZON_STORE_URL, collectLinks, isClosedSiteLink, stripClosedLinks } from "../../src/lib/storefront";
import { createResponder, pushFlexMessage, pushTextMessage } from "../../src/lib/line";
import { saveMessage } from "../../src/lib/supabase";
import { buildHistoryMessages, type Message } from "../../src/agent/core";
import type { Env } from "../../src/index";

let total = 0,
  passed = 0,
  failed = 0;
const failures: Array<{ name: string; error: string }> = [];
const queue: Array<{ name: string; fn: () => Promise<void> | void }> = [];

function it(name: string, fn: () => Promise<void> | void) {
  queue.push({ name, fn });
}
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}
function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** 閉じたリンク (閉店中の判定) を取り出す。 */
function closedIn(message: unknown): string[] {
  return collectLinks(message).filter((l) => isClosedSiteLink(l, false));
}

/** console.warn を捕まえる (関所のログを確かめる)。 */
function captureWarn(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore() {
      console.warn = original;
    },
  };
}

const AI_REPLY =
  "おすすめはほうじ茶です。ご購入はこちら https://elxea.com/ja からどうぞ。\n" +
  "定期便は elxea.com/ja/subscription をご覧ください。\n" +
  `Amazon のストアはこちらです: ${AMAZON_STORE_URL}\n` +
  "ご不明点は info@elxea.com までお知らせください。";

const FIXED_TEXT = `お茶の淹れ方のご案内です。お求めは Amazon のストアから: ${AMAZON_STORE_URL}\nお問い合わせ: info@elxea.com`;

const env = { LINE_CHANNEL_ACCESS_TOKEN: "test-token" } as unknown as Env;

/** fetch をスタブし、送られた JSON body を捕まえる。 */
function stubFetch(): { bodies: Array<Record<string, unknown>>; restore(): void } {
  const bodies: Array<Record<string, unknown>> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return { ok: true, status: 200, text: async () => "" } as Response;
  }) as typeof fetch;
  return {
    bodies,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** conversations.insert を捕まえる偽 Supabase。 */
function fakeSupabase(): { client: Parameters<typeof saveMessage>[0]; inserted: Array<Record<string, unknown>> } {
  const inserted: Array<Record<string, unknown>> = [];
  const client = {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        inserted.push(row);
        return { error: null };
      },
    }),
  } as unknown as Parameters<typeof saveMessage>[0];
  return { client, inserted };
}

// ---------------------------------------------------------------------------
// 本文の関所 (共通)
// ---------------------------------------------------------------------------

it("AI の返事から閉じたリンクが消え、Amazon の URL と info@elxea.com は残る", () => {
  const w = captureWarn();
  const g = gateText(AI_REPLY, "agent_exit", "test", false);
  w.restore();
  assertEqual(g.removed, 2, "消した数");
  assertEqual(closedIn(g.text).length, 0, "閉じたリンクが残っている");
  assert(g.text.includes(AMAZON_STORE_URL), "Amazon の URL が消えた");
  assert(g.text.includes("info@elxea.com"), "問い合わせメールが消えた");
  assert(!g.emptied, "空ではない");
  assertEqual(w.lines.length, 1, "ログは 1 行");
  assert(w.lines[0].includes('"gate":"agent_exit"') && w.lines[0].includes('"removed":2'), `ログ: ${w.lines[0]}`);
  assert(!w.lines[0].includes("ほうじ茶"), "ログに本文が出ている");
});

it("決まった文では消す数 = 0 で、入力とまったく同じ文字列を返し、ログを出さない", () => {
  const w = captureWarn();
  const g = gateText(FIXED_TEXT, "line_send", "test", false);
  w.restore();
  assertEqual(g.removed, 0, "消した数");
  assertEqual(g.text, FIXED_TEXT, "文字列");
  assertEqual(w.lines.length, 0, "ログ");
});

it("開店中は何も変えない (本文・LINE メッセージ・AI の結果)", () => {
  assertEqual(gateText(AI_REPLY, "save", "test", true).text, AI_REPLY, "本文");
  const msgs = [{ type: "text", text: AI_REPLY }, { type: "flex", altText: "x", contents: { uri: "https://elxea.com/ja" } }];
  assertEqual(gateLineMessages(msgs, "test", true), msgs, "LINE メッセージ");
  const result = { response: AI_REPLY, cartLink: { checkoutUrl: "https://x.myshopify.com/cart/1" } };
  assertEqual(gateAgentResult(result, "test", true), result, "AI の結果");
  assert(!hasClosedLink(msgs, true), "開店中は閉じたリンクなし");
});

// ---------------------------------------------------------------------------
// 関所 1: LINE の送信
// ---------------------------------------------------------------------------

it("LINE の送信: responder.text の本文から閉じたリンクが消える", async () => {
  const s = stubFetch();
  const w = captureWarn();
  try {
    await createResponder("Uuser", "rt", env).text(AI_REPLY);
  } finally {
    s.restore();
    w.restore();
  }
  assertEqual(s.bodies.length, 1, "送信回数");
  const messages = s.bodies[0].messages as Array<Record<string, unknown>>;
  assertEqual(closedIn(messages).length, 0, "閉じたリンクが送られた");
  assert(String(messages[0].text).includes(AMAZON_STORE_URL), "Amazon の URL が消えた");
  assert(String(messages[0].text).includes("info@elxea.com"), "問い合わせメールが消えた");
});

it("LINE の送信: 決まった文は 1 文字も変えずに送る (消した数 = 0)", async () => {
  const s = stubFetch();
  const w = captureWarn();
  try {
    await createResponder("Uuser", "rt", env).text(FIXED_TEXT);
  } finally {
    s.restore();
    w.restore();
  }
  assertEqual((s.bodies[0].messages as Array<{ text: string }>)[0].text, FIXED_TEXT, "本文");
  assertEqual(w.lines.filter((l) => l.includes("closed-link-gate")).length, 0, "関所のログ");
});

it("LINE の送信: AI が出す Flex に閉じたリンクがあれば送らない (altText・入れ子の uri)", async () => {
  const s = stubFetch();
  const w = captureWarn();
  try {
    const r = createResponder("Uuser", "rt", env);
    await r.flex("商品のご案内", { type: "bubble", footer: { contents: [{ action: { type: "uri", uri: "https://elxea.com/ja/products/x" } }] } });
    await r.flex("詳しくは elxea.com/ja で", { type: "bubble" });
    await r.flex("Amazon のご案内", { type: "bubble", footer: { contents: [{ action: { type: "uri", uri: AMAZON_STORE_URL } }] } });
  } finally {
    s.restore();
    w.restore();
  }
  assertEqual(s.bodies.length, 1, "送ったのは閉じたリンクの無い 1 通だけ");
  assertEqual(closedIn(s.bodies[0].messages).length, 0, "閉じたリンク");
  assertEqual(w.lines.filter((l) => l.includes('"dropped":1')).length, 2, "送らなかった 2 通のログ");
});

it("LINE の送信: 消した結果が空の本文は送らず、reply token も使わず、emptied の warn を出す (m4)", async () => {
  const s = stubFetch();
  const w = captureWarn();
  try {
    const r = createResponder("Uuser", "rt", env);
    await r.text("https://elxea.com/ja/subscription");
    await r.text("続きの本文です。");
  } finally {
    s.restore();
    w.restore();
  }
  assertEqual(s.bodies.length, 1, "空の本文は送らない");
  assertEqual(String(s.bodies[0].replyToken ?? ""), "rt", "reply token は次の本文で使う");
  assert(w.lines.some((l) => l.includes('"emptied":true') && l.includes('"gate":"line_send"')), `emptied の warn: ${w.lines.join(" | ")}`);
  assert(!w.lines.some((l) => l.includes("subscription")), "ログに本文が出ている");
});

it("LINE の送信: pushTextMessage でも消え、pushFlexMessage は閉じたリンク入りを送らない", async () => {
  const s = stubFetch();
  const w = captureWarn();
  try {
    await pushTextMessage("Uuser", AI_REPLY, env);
    await pushFlexMessage("Uuser", "記事", { action: { type: "uri", uri: "https://www.elxea.com/ja/journal/1" } }, env);
  } finally {
    s.restore();
    w.restore();
  }
  assertEqual(s.bodies.length, 1, "push は本文の 1 通だけ");
  assertEqual(closedIn(s.bodies[0].messages).length, 0, "閉じたリンク");
  assert(String((s.bodies[0].messages as Array<{ text: string }>)[0].text).includes(AMAZON_STORE_URL), "Amazon の URL");
});

it("LINE の送信: quickReply の閉じたリンク入りの item だけを外す", () => {
  const w = captureWarn();
  const out = gateLineMessages(
    [
      {
        type: "text",
        text: "どうぞ",
        quickReply: {
          items: [
            { type: "action", action: { type: "uri", label: "EC", uri: "https://elxea.com/ja" } },
            { type: "action", action: { type: "message", label: "はい", text: "はい" } },
          ],
        },
      },
    ],
    "test",
    false,
  );
  w.restore();
  const items = (out[0].quickReply as { items: unknown[] }).items;
  assertEqual(items.length, 1, "残る item");
  assertEqual(closedIn(out).length, 0, "閉じたリンク");
});

// ---------------------------------------------------------------------------
// 関所 2: 保存
// ---------------------------------------------------------------------------

it("保存: AI の発言は閉じたリンクを消して保存し、お客さんの発言は変えない", async () => {
  const { client, inserted } = fakeSupabase();
  const w = captureWarn();
  await saveMessage(client, { userId: "u", channel: "line", role: "assistant", content: AI_REPLY });
  await saveMessage(client, { userId: "u", channel: "web", role: "user", content: "elxea.com/ja は開いていますか" });
  w.restore();
  assertEqual(inserted.length, 2, "保存件数");
  assertEqual(closedIn(inserted[0].content).length, 0, "AI の発言に閉じたリンク");
  assert(String(inserted[0].content).includes(AMAZON_STORE_URL), "Amazon の URL");
  assertEqual(inserted[1].content, "elxea.com/ja は開いていますか", "お客さんの発言は変えない");
});

it("保存: 消した結果が空の AI の発言は保存せず、emptied の warn を出す", async () => {
  const { client, inserted } = fakeSupabase();
  const w = captureWarn();
  await saveMessage(client, { userId: "u", channel: "web", role: "assistant", content: " https://elxea.com/ja " });
  w.restore();
  assertEqual(inserted.length, 0, "保存しない");
  assert(w.lines.some((l) => l.includes('"gate":"save"') && l.includes('"emptied":true')), "emptied の warn");
});

// ---------------------------------------------------------------------------
// 関所 3: AI の出口
// ---------------------------------------------------------------------------

it("AI の出口: 本文・Flex・商品カード・カートリンク・クイックリプライから閉じたリンクを外す", () => {
  const w = captureWarn();
  const out = gateAgentResult(
    {
      response: AI_REPLY,
      escalated: false,
      flexMessages: [
        { altText: "商品", contents: { action: { uri: "https://elxea.com/ja/products/a" } } },
        { altText: "注文", contents: { action: { uri: "https://track.example.jp/1" } } },
      ],
      productCards: [
        { name: "A", description: "a", price: "1", productUrl: "https://elxea.com/ja/products/a" },
        { name: "B", description: "b", price: "1", productUrl: AMAZON_STORE_URL },
      ],
      cartLink: { checkoutUrl: "https://elxea-shop.myshopify.com/cart/c/1" },
      quickReplies: [
        { label: "EC", text: "https://elxea.com/ja" },
        { label: "はい", text: "はい" },
      ],
    },
    "test",
    false,
  );
  w.restore();
  assertEqual(closedIn(out).length, 0, "閉じたリンクが残っている");
  assertEqual(out.flexMessages?.length, 1, "Flex");
  assertEqual(out.productCards?.length, 1, "商品カード");
  assertEqual(out.cartLink, undefined, "カートリンク");
  assertEqual(out.quickReplies?.length, 1, "クイックリプライ");
  assertEqual(out.escalated, false, "他の値は変えない");
  assert(out.response.includes(AMAZON_STORE_URL) && out.response.includes("info@elxea.com"), "残すもの");
});

it("逐次送信: 断片をまたぐ URL も消え、日本語の本文は持ち越されない", () => {
  const emitted: string[] = [];
  const g = createStreamingTextGate((s) => emitted.push(s), false);
  g.push("こんにちは。");
  assertEqual(emitted.join(""), "こんにちは。", "日本語の本文はすぐ出す");
  g.push("ご購入は https://elx");
  g.push("ea.com/ja/subscri");
  g.push("ption から。定期便は elxea.");
  g.push("com/ja をご覧ください。");
  g.push(`Amazon: ${AMAZON_STORE_URL.slice(0, 20)}`);
  g.push(AMAZON_STORE_URL.slice(20));
  g.push("\n（https://elxea.com/ja）もどうぞ。");
  g.flush();
  const all = emitted.join("");
  assert(!all.includes("（）"), `括弧だけが残った: ${all}`);
  const full =
    "こんにちは。ご購入は https://elxea.com/ja/subscription から。定期便は elxea.com/ja をご覧ください。" +
    `Amazon: ${AMAZON_STORE_URL}\n（https://elxea.com/ja）もどうぞ。`;
  assertEqual(all, stripClosedLinks(full, false).text, "まとめて消したときと同じ結果");
  assertEqual(closedIn(all).length, 0, `閉じたリンクが出た: ${all}`);
  assert(all.includes(AMAZON_STORE_URL), `Amazon の URL が壊れた: ${all}`);
  assert(all.includes("から。定期便は") && all.includes("をご覧ください。"), "本文が欠けた");
  assertEqual(g.removed, 3, "消した数");
});

it("逐次送信: 開店中は断片をそのまま渡す", () => {
  const emitted: string[] = [];
  const g = createStreamingTextGate((s) => emitted.push(s), true);
  g.push("https://elx");
  g.push("ea.com/ja");
  g.flush();
  assertEqual(emitted.join("|"), "https://elx|ea.com/ja", "そのまま");
});

it("逐次送信のコールバック: 商品カード・カートリンクも包み、持ち越しを先に出して順序を保つ (m3)", () => {
  const events: string[] = [];
  let done = "";
  const base: GateableStreamCallbacks = {
    onTextDelta: (t) => events.push(`text:${t}`),
    onProductCards: (p) => events.push(`cards:${p.map((x) => x.url).join(",")}`),
    onCartLink: (u) => events.push(`cart:${u}`),
    onQuickReplies: (q) => events.push(`qr:${q.length}`),
    onDone: (full) => {
      done = full;
      events.push("done");
    },
    onError: () => events.push("error"),
  };
  const w = captureWarn();
  const { callbacks, finish } = gateStreamCallbacks(base, "test", false);
  callbacks.onTextDelta("こちらです ");
  callbacks.onTextDelta("abc");
  callbacks.onProductCards([
    { name: "A", price: "1", url: "https://elxea.com/ja/products/a", image: null, description: "" },
    { name: "B", price: "1", url: AMAZON_STORE_URL, image: null, description: "" },
  ]);
  callbacks.onCartLink("https://elxea-shop.myshopify.com/cart/c/1");
  callbacks.onTextDelta("続きは https://elxea.com/ja");
  callbacks.onDone(`こちらです abc続きは https://elxea.com/ja`);
  finish();
  w.restore();
  assertEqual(
    events.join(" | "),
    // 「続きは」の後ろの空白は、消えたリンクと一緒に持ち越して消える。
    `text:こちらです  | text:abc | cards:${AMAZON_STORE_URL} | text:続きは | done`,
    "順序と中身",
  );
  assertEqual(closedIn(done).length, 0, "保存用の全文");
  assert(w.lines.some((l) => l.includes("cartLink")), "カートリンクを外したログ");
});

// ---------------------------------------------------------------------------
// 関所 4: 履歴
// ---------------------------------------------------------------------------

it("履歴: AI の過去の発言から閉じたリンクが消え、お客さんの発言は変えず、空になった発言は渡さない", () => {
  const history: Message[] = [
    { role: "user", content: "どこで買えますか elxea.com/ja ?", channel: "line" },
    { role: "assistant", content: "こちらからどうぞ https://elxea.com/ja", channel: "line" },
    { role: "user", content: "定期便は？", channel: "line" },
    { role: "assistant", content: "https://elxea.com/ja/subscription", channel: "line" },
  ];
  const w = captureWarn();
  const out = buildHistoryMessages(history, false);
  w.restore();
  assertEqual(out.length, 3, "空になった発言は渡さない");
  assertEqual(out[0].content, "どこで買えますか elxea.com/ja ?", "お客さんの発言");
  assertEqual(closedIn(out.filter((m) => m.role === "assistant")).length, 0, "AI の発言に閉じたリンク");
  assert(w.lines.some((l) => l.includes('"gate":"history"') && l.includes('"emptied":true')), "履歴のログ");
  const open = buildHistoryMessages(history, true);
  assertEqual(open.length, 4, "開店中は何も変えない");
  assertEqual(open[1].content, "こちらからどうぞ https://elxea.com/ja", "開店中の AI の発言");
});

// ---------------------------------------------------------------------------

(async () => {
  for (const t of queue) {
    try {
      await t.fn();
      total++;
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      total++;
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${t.name}: ${msg}`);
      failures.push({ name: t.name, error: msg });
    }
  }
  console.log("\n============================================================");
  console.log("closed-link-gate.test Results");
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})();
