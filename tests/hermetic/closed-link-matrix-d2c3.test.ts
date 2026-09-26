/**
 * ハーメティック — 閉店中の総当たり (D2c テスト 3): お客さんが LINE で何をしても、閉じたリンクは 1 本も届かない
 *
 * 設計: 実装設計 rev2 第9章 テスト3 (総当たり) / 第1章 / 第6章
 *   https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 *
 * 何を固定するか:
 *   - 署名付き webhook の実経路 (dispatchLineWebhook) で、各シナリオの「届いた全メッセージ」
 *     (本文・Flex の全 uri・quickReply・altText) に閉じたリンクが無い。
 *     判定は storefront.ts の collectLinks + isClosedSiteLink (メールアドレスは対象外)。
 *   - 決まった文の経路 (AI を通らない返事) では、送る関所 (closed-link-gate) が 1 回も働かない (ログ 0 行)。
 *     = 関所が設計の漏れを隠していない証拠。関所のログ (`[closed-link-gate] {...}` の console.warn) を数える。
 *   - AI の経路は Anthropic をこのファイル内だけでモックする (AI がリンクを返しても届かない / 道具の結果が
 *     もともと閉じたリンクを含まない)。
 *   - 自前 push の 2 経路 (dormant-reengagement / marche-activation) は送る文を collectLinks で固定する
 *     (関所の外なので、文そのものが閉じたリンクを含まないことが唯一の保証)。
 *
 * 「総当たり」の作り: 入口の発話から、返事に付いたボタン (quickReply / Flex の message・postback アクション) を
 * 幅優先ですべて押していく。お茶の淹れ方 → 種類 → 銘柄 → お茶カード / 評価 → 次の一杯、好み診断 → 結果まで、
 * ボタンをたどれる所は全部たどる。
 *
 * 閉店中の総当たりなので、開店中 (EC_SITE_OPEN=true) はまるごと飛ばす (開店中の文は別のテストが固定する)。
 * 実ネットワーク非接触・実送信ゼロ (LINE / Supabase / Notion は tests/lib/hermetic のモック)。
 */

import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { env } from "cloudflare:test";
import { getHermetic, type Hermetic } from "../lib/hermetic";
import { dispatchLineWebhook, settle } from "../lib/webhook";
import { SYNTH_REPLY_TOKEN, messageEvent, postbackEvent, synthLineUserId } from "../lib/synthetic";
import { AMAZON_STORE_URL, EC_SITE_OPEN, collectLinks, isClosedSiteLink } from "../../src/lib/storefront";
import { _resetTeaCache } from "../../src/lib/tea-menu";
import { BREW_RICH_MENU_TRIGGER } from "../../src/lib/menu-tap";
import { DIAGNOSIS_TRIGGER } from "../../src/lib/preference-diagnosis";
import { ABOUT_TRIGGER, CONSULTATION_TRIGGER, SUBSCRIPTION_TRIGGER } from "../../src/lib/menu-actions";
import { LINKAGE_TRIGGER, handleLinkageFlow } from "../../src/lib/subscriber-linkage";
import { READING_TRIGGER, READING_TRIGGER_ALT } from "../../src/lib/journal";
import { SURVEY_TRIGGER } from "../../src/lib/roji-survey-copy";
import {
  ACCOUNT_LINK_UNLINK_TRIGGER,
  LINKAGE_PREPARING_BODY,
  MARCHE_ACTIVATION_MESSAGE,
  MARCHE_LINKAGE_SOFT_ACK,
  NON_SUBSCRIBER_DECLINE_BODY_CLOSED,
  READING_PREPARING_BODY,
  SUBSCRIBER_LINKED_BODY,
  TASTING_NOTE_CTA_TEXT_OPEN,
} from "../../src/lib/brand-copy";
import { createResponder } from "../../src/lib/line";
import {
  buildDormantBody,
  runDormantReengagementWith,
  type DormantReengagementDeps,
  type LineUserActivity,
} from "../../src/lib/dormant-reengagement";
import {
  runMarcheActivationWith,
  type MarcheActivationDeps,
  type MarcheUser,
} from "../../src/lib/marche-activation";
import type { NextCupKarte } from "../../src/lib/next-cup";
import type { Env } from "../../src/index";

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

function closedIn(message: unknown): string[] {
  return collectLinks(message).filter((l) => isClosedSiteLink(l, false));
}

// ---------------------------------------------------------------------------
// Anthropic のモック (このファイル内だけ) と、関所のログの捕捉
// ---------------------------------------------------------------------------

type ContentBlock = Record<string, unknown>;
type LlmRequest = { messages: Array<{ role: string; content: unknown }> };
/** 1 回の AI 呼び出しの返事 (content blocks)。関数なら、その回の要求を見て組み立てる。 */
type AiTurn = ContentBlock[] | ((req: LlmRequest) => ContentBlock[]);

/** 既定の AI の返事 (リンクなし)。総当たりの途中で AI に届いても関所が働かないようにする。 */
const BENIGN_AI_REPLY = "ほうじ茶の香りは焙煎からきています。ゆっくりお楽しみください。";
/** AI が閉じたリンクを返すモック (画像・売り込み面の経路で使う)。 */
const LEAKY_AI_REPLY =
  "ほうじ茶がおすすめです。ご購入はこちら https://elxea.com/ja からどうぞ。\n" +
  "定期便は elxea.com/ja/subscription をご覧ください。\n" +
  `Amazon のストア: ${AMAZON_STORE_URL}\n` +
  "ご不明点は info@elxea.com まで。";

/** 売り込み面 ON のときの Shopify (Storefront) のモック先。カートの URL は閉じたリンク (*.myshopify.com)。 */
const MOCK_SHOP_DOMAIN = "e2e-mock.myshopify.com";
const MOCK_CHECKOUT_URL = `https://${MOCK_SHOP_DOMAIN}/cart/c/e2e-cart-token`;

let h: Hermetic;
let aiQueue: AiTurn[] = [];
let aiDefault = BENIGN_AI_REPLY;
let llmRequests: LlmRequest[] = [];
type GateLog = { gate: string; caller: string; removed?: number; dropped?: number; emptied?: boolean; fallback?: boolean };
let gateLogs: GateLog[] = [];
let localFetch: typeof fetch | undefined;
let innerFetch: typeof fetch | undefined;
let originalWarn: typeof console.warn | undefined;
/** 今のテストの context (シナリオの数を annotate でテスト出力に残す)。 */
let currentCtx: TestContext | undefined;
let pendingNotes: Array<Promise<unknown>> = [];

/**
 * シナリオの数をテスト出力に残す。このプールでは通ったテストの console が表示されないため、
 * vitest の annotate (テストの注記。`--reporter=verbose` などで表示) にも同じ行を付ける。
 */
function note(line: string): void {
  console.warn(line);
  if (currentCtx) pendingNotes.push(currentCtx.annotate(line).catch(() => undefined));
}

function aiResponse(content: ContentBlock[]): Response {
  const hasTool = content.some((b) => b.type === "tool_use");
  return new Response(
    JSON.stringify({
      id: `msg_e2e_d2c3_${llmRequests.length}`,
      type: "message",
      role: "assistant",
      model: "claude-mock",
      content,
      stop_reason: hasTool ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach((ctx) => {
  currentCtx = ctx;
  pendingNotes = [];
  h = getHermetic();
  _resetTeaCache();
  aiQueue = [];
  aiDefault = BENIGN_AI_REPLY;
  llmRequests = [];
  gateLogs = [];

  const inner = globalThis.fetch;
  innerFetch = inner;
  const wrapper = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes("api.anthropic.com")) {
      let req: LlmRequest = { messages: [] };
      try {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: LlmRequest["messages"] };
        req = { messages: Array.isArray(body.messages) ? body.messages : [] };
      } catch {
        // 解釈できない要求は空の履歴として扱う
      }
      llmRequests.push(req);
      const turn = aiQueue.shift();
      const content = turn === undefined ? [{ type: "text", text: aiDefault }] : typeof turn === "function" ? turn(req) : turn;
      return aiResponse(content);
    }
    if (url.includes(MOCK_SHOP_DOMAIN)) {
      return new Response(
        JSON.stringify({
          data: {
            cartCreate: {
              cart: {
                id: "gid://shopify/Cart/e2e",
                checkoutUrl: MOCK_CHECKOUT_URL,
                lines: {
                  edges: [
                    {
                      node: {
                        merchandise: {
                          title: "50g",
                          product: { title: "ほうじ茶" },
                          price: { amount: "1200.0", currencyCode: "JPY" },
                        },
                        quantity: 1,
                      },
                    },
                  ],
                },
                cost: { totalAmount: { amount: "1200.0", currencyCode: "JPY" } },
              },
              userErrors: [],
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return inner(input, init);
  }) as typeof fetch;
  localFetch = wrapper;
  globalThis.fetch = wrapper;

  // 送る関所のログ (1 行の JSON) を数える。本文は出ない (関所の仕様)。
  const warn = console.warn;
  originalWarn = warn;
  console.warn = (...args: unknown[]): void => {
    const first = typeof args[0] === "string" ? args[0] : "";
    const m = /^\[closed-link-gate\] (.*)$/.exec(first);
    if (m) {
      try {
        gateLogs.push(JSON.parse(m[1]) as GateLog);
      } catch {
        gateLogs.push({ gate: "unparsed", caller: m[1] });
      }
    }
    warn.apply(console, args as []);
  };
});

afterEach(async () => {
  await Promise.all(pendingNotes);
  pendingNotes = [];
  currentCtx = undefined;
  if (localFetch !== undefined && innerFetch !== undefined && globalThis.fetch === localFetch) {
    globalThis.fetch = innerFetch;
  }
  localFetch = undefined;
  innerFetch = undefined;
  if (originalWarn !== undefined) console.warn = originalWarn;
  originalWarn = undefined;
});

// ---------------------------------------------------------------------------
// 1 手 (1 イベント) の実行と記録
// ---------------------------------------------------------------------------

interface StepResult {
  label: string;
  /** この手で届いた全メッセージ (reply / push)。 */
  delivered: Array<Record<string, unknown>>;
  /** この手で送る関所が出したログ。 */
  gate: GateLog[];
  /** この手で AI (Anthropic) を呼んだ回数。 */
  llm: number;
  /** 届いたメッセージの中の閉じたリンク。 */
  closed: string[];
}

async function step(label: string, event: Record<string, unknown>, envOverride?: Record<string, unknown>): Promise<StepResult> {
  const sentBefore = h.line.allMessages().length;
  const gateBefore = gateLogs.length;
  const llmBefore = llmRequests.length;
  const res = await dispatchLineWebhook({
    env: envOverride ? { ...(env as Record<string, unknown>), ...envOverride } : env,
    channelSecret: String(env.LINE_CHANNEL_SECRET),
    events: [event],
  });
  expect(res.status, `${label}: webhook が 200 で受理されていない`).toBe(200);
  await settle();
  const delivered = h.line.allMessages().slice(sentBefore);
  return {
    label,
    delivered,
    gate: gateLogs.slice(gateBefore),
    llm: llmRequests.length - llmBefore,
    closed: closedIn(delivered),
  };
}

/** 返事に付いたボタン (quickReply と Flex の中の message / postback アクション) を全部拾う。 */
type Tap = { kind: "message"; text: string } | { kind: "postback"; data: string };
function tapsOf(messages: unknown): Tap[] {
  const out: Tap[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v === null || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.type === "message" && typeof o.text === "string" && "label" in o) out.push({ kind: "message", text: o.text });
    if (o.type === "postback" && typeof o.data === "string") out.push({ kind: "postback", data: o.data });
    Object.values(o).forEach(walk);
  };
  walk(messages);
  return out;
}

/**
 * 入口の発話から、返事のボタンを幅優先で全部押す (同じボタンは 1 回だけ)。
 * AI を通った返事のボタン (👍/👎 など AI の側のもの) はたどらない (決まった文の総当たりに絞る)。
 */
async function crawl(
  root: string,
  userId: string,
  opts: { maxSteps?: number; envOverride?: Record<string, unknown> } = {},
): Promise<StepResult[]> {
  const maxSteps = opts.maxSteps ?? 250;
  const queue: Tap[] = [{ kind: "message", text: root }];
  const seen = new Set<string>([`m:${root}`]);
  const results: StepResult[] = [];
  let idx = 0;
  while (queue.length > 0 && results.length < maxSteps) {
    const tap = queue.shift() as Tap;
    idx++;
    const event = tap.kind === "message" ? messageEvent(userId, tap.text, idx) : postbackEvent(userId, tap.data, idx);
    const r = await step(tap.kind === "message" ? tap.text : `postback:${tap.data}`, event, opts.envOverride);
    results.push(r);
    if (r.llm > 0) continue;
    for (const t of tapsOf(r.delivered)) {
      const key = t.kind === "message" ? `m:${t.text}` : `p:${t.data}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(t);
    }
  }
  expect(queue.length, `${root}: 総当たりが上限 ${maxSteps} 手で打ち切られた (上限を上げる)`).toBe(0);
  return results;
}

/** シナリオの結果を 1 行でテスト出力に出す (届いたメッセージ数・関所が働いた数・AI 呼び出し数)。 */
function report(scenario: string, results: StepResult[]): void {
  const delivered = results.reduce((n, r) => n + r.delivered.length, 0);
  const gate = results.reduce((n, r) => n + r.gate.length, 0);
  const llm = results.reduce((n, r) => n + r.llm, 0);
  note(`[d2c3] ${scenario}: 手=${results.length} 届いた=${delivered} 関所が消した(ログ行)=${gate} AI呼び出し=${llm}`);
}

/** 届いたものに閉じたリンクが無い / 決まった文 (AI を通らない手) では関所が 1 回も働いていない。 */
function expectCleanDeterministic(scenario: string, results: StepResult[]): void {
  report(scenario, results);
  expect(results.reduce((n, r) => n + r.delivered.length, 0), `${scenario}: 何も届いていない`).toBeGreaterThan(0);
  for (const r of results) {
    expect(r.closed, `${scenario} / 「${r.label}」: 届いたメッセージに閉じたリンクがある`).toEqual([]);
    if (r.llm === 0) {
      expect(r.gate, `${scenario} / 「${r.label}」: 決まった文なのに送る関所が働いた (文の対の実装漏れ)`).toEqual([]);
    }
  }
}

function texts(results: StepResult[]): string[] {
  return results
    .flatMap((r) => r.delivered)
    .filter((m) => m.type === "text")
    .map((m) => String(m.text ?? ""));
}

function linkUser(userId: string): void {
  h.supabase.seed("customer_linkages", [{ line_user_id: userId, shopify_customer_id: "900800400123" }]);
}

// ---------------------------------------------------------------------------
// シナリオ
// ---------------------------------------------------------------------------

describe.skipIf(EC_SITE_OPEN)("閉店中の総当たり: 決まった文の経路 (署名付き webhook)", () => {
  it("① お茶の淹れ方 → 種類 → 銘柄 → お茶カード / 評価 → 次の一杯 (全ボタン)", { timeout: 180_000 }, async () => {
    const results = await crawl(BREW_RICH_MENU_TRIGGER, synthLineUserId("d2c3a1"));
    expectCleanDeterministic("① お茶の淹れ方", results);
    // たどれた深さの確認: お茶カード (Flex) と評価の返事まで届いている。
    expect(results.filter((r) => r.delivered.some((m) => m.type === "flex")).length, "お茶カードまで届いていない").toBeGreaterThan(0);
    expect(results.some((r) => /^感想/.test(r.label)), "評価 (感想) のボタンまでたどれていない").toBe(true);
    // altText も調べている (collectLinks は altText を含む)。Flex の altText に閉じたリンクが無いことを明示。
    const alts = results.flatMap((r) => r.delivered).filter((m) => m.type === "flex").map((m) => m.altText);
    expect(closedIn(alts), "Flex の altText に閉じたリンク").toEqual([]);
  });

  it("② 好み診断を最後まで (結果カードのボタン = Amazon ストア)", { timeout: 180_000 }, async () => {
    const results = await crawl(DIAGNOSIS_TRIGGER, synthLineUserId("d2c3b1"));
    expectCleanDeterministic("② 好み診断", results);
    const links = collectLinks(results.flatMap((r) => r.delivered));
    expect(
      links.some((l) => l === AMAZON_STORE_URL || l.includes("/go/store")),
      `結果カードに Amazon ストアへのボタンが無い (届いたリンク: ${JSON.stringify([...new Set(links)])})`,
    ).toBe(true);
  });

  describe("定期便について知りたい", () => {
    it("未連携 (売り込み面 OFF / ON)", { timeout: 60_000 }, async () => {
      const off = await crawl(SUBSCRIPTION_TRIGGER, synthLineUserId("d2c3c1"), {});
      expectCleanDeterministic("定期便 / 未連携", off);
      const on = await crawl(SUBSCRIPTION_TRIGGER, synthLineUserId("d2c3c2"), {
        
        envOverride: { SALES_SURFACE_ENABLED: "true" },
      });
      expectCleanDeterministic("定期便 / 未連携 / 売り込み面 ON", on);
    });

    it("連携済みで定期便でない (売り込み面 OFF / ON)", { timeout: 60_000 }, async () => {
      const u1 = synthLineUserId("d2c3c3");
      linkUser(u1);
      expectCleanDeterministic("定期便 / 未利用者", await crawl(SUBSCRIPTION_TRIGGER, u1, {}));
      const u2 = synthLineUserId("d2c3c4");
      linkUser(u2);
      expectCleanDeterministic(
        "定期便 / 未利用者 / 売り込み面 ON",
        await crawl(SUBSCRIPTION_TRIGGER, u2, { envOverride: { SALES_SURFACE_ENABLED: "true" } }),
      );
    });

    it("定期便の利用者 (売り込み面 OFF / ON)", { timeout: 60_000 }, async () => {
      const u1 = synthLineUserId("d2c3c5");
      linkUser(u1);
      expectCleanDeterministic(
        "定期便 / 利用者",
        await crawl(SUBSCRIPTION_TRIGGER, u1, { envOverride: { TEST_SUBSCRIBER_LINE_IDS: u1 } }),
      );
      const u2 = synthLineUserId("d2c3c6");
      linkUser(u2);
      expectCleanDeterministic(
        "定期便 / 利用者 / 売り込み面 ON",
        await crawl(SUBSCRIPTION_TRIGGER, u2, {
          
          envOverride: { TEST_SUBSCRIBER_LINE_IDS: u2, SALES_SURFACE_ENABLED: "true" },
        }),
      );
    });
  });

  it("読みもの / ジャーナル (C-22 の 1 通だけ)", async () => {
    for (const [i, trigger] of [READING_TRIGGER, READING_TRIGGER_ALT].entries()) {
      const r = await step(trigger, messageEvent(synthLineUserId(`d2c3d${i}`), trigger));
      expectCleanDeterministic(`読みもの (${trigger})`, [r]);
      expect(r.delivered, `${trigger}: C-22 の 1 通だけではない`).toHaveLength(1);
      expect(r.delivered[0].text, `${trigger}: C-22 の文ではない`).toBe(READING_PREPARING_BODY);
    }
  });

  it("elxeaについて教えて", { timeout: 60_000 }, async () => {
    expectCleanDeterministic("elxeaについて", await crawl(ABOUT_TRIGGER, synthLineUserId("d2c3e1"), {}));
  });

  describe("アカウントを連携する / 連携を解除する", () => {
    it("未連携 → C-13", async () => {
      const r = await step("連携 / 未連携", messageEvent(synthLineUserId("d2c3f1"), LINKAGE_TRIGGER));
      expectCleanDeterministic("連携 / 未連携", [r]);
      expect(texts([r]), "未連携に C-13 が届いていない").toContain(LINKAGE_PREPARING_BODY);
    });

    it("未連携のマルシェ客 → MARCHE_LINKAGE_SOFT_ACK のまま (実の LINE 送信の関所を通す)", async () => {
      // マルシェ客の判定は Firestore (lineUsers/{id}.onboarding.source) を読む。ハーメティックは Firestore を
      // 持たないため、判定だけを注入し、返事は本物の createResponder (送る関所つき) で LINE モックへ送る。
      const userId = synthLineUserId("d2c3f2");
      const sentBefore = h.line.allMessages().length;
      const handled = await handleLinkageFlow(userId, LINKAGE_TRIGGER, env as unknown as Env, createResponder(userId, SYNTH_REPLY_TOKEN, env as unknown as Env), {
        isMarcheSource: async () => true,
      });
      await settle();
      expect(handled, "連携の導線が横取りしていない").toBe(true);
      const r: StepResult = {
        label: "連携 / 未連携マルシェ客",
        delivered: h.line.allMessages().slice(sentBefore),
        gate: [...gateLogs],
        llm: 0,
        closed: closedIn(h.line.allMessages().slice(sentBefore)),
      };
      expectCleanDeterministic("連携 / 未連携マルシェ客", [r]);
      expect(texts([r]), "マルシェ客に MARCHE_LINKAGE_SOFT_ACK が届いていない").toContain(MARCHE_LINKAGE_SOFT_ACK);
    });

    it("連携済みで定期便でない → C-14", async () => {
      const userId = synthLineUserId("d2c3f3");
      linkUser(userId);
      const r = await step("連携 / 連携済み非定期便", messageEvent(userId, LINKAGE_TRIGGER));
      expectCleanDeterministic("連携 / 連携済み非定期便", [r]);
      expect(texts([r]), "連携済み非定期便に C-14 が届いていない").toContain(NON_SUBSCRIBER_DECLINE_BODY_CLOSED);
    });

    it("連携済みで定期便 → 今の文", async () => {
      const userId = synthLineUserId("d2c3f4");
      linkUser(userId);
      const r = await step("連携 / 連携済み定期便", messageEvent(userId, LINKAGE_TRIGGER), { TEST_SUBSCRIBER_LINE_IDS: userId });
      expectCleanDeterministic("連携 / 連携済み定期便", [r]);
      expect(texts([r]), "連携済み定期便に今の文が届いていない").toContain(SUBSCRIBER_LINKED_BODY);
    });

    it("連携を解除する (未連携 / 連携済み)", async () => {
      const r1 = await step("解除 / 未連携", messageEvent(synthLineUserId("d2c3f5"), ACCOUNT_LINK_UNLINK_TRIGGER));
      expectCleanDeterministic("解除 / 未連携", [r1]);
      const linked = synthLineUserId("d2c3f6");
      linkUser(linked);
      const r2 = await step("解除 / 連携済み", messageEvent(linked, ACCOUNT_LINK_UNLINK_TRIGGER));
      expectCleanDeterministic("解除 / 連携済み", [r2]);
    });
  });

  it("マイカルテ (全ボタン)", { timeout: 60_000 }, async () => {
    expectCleanDeterministic("マイカルテ", await crawl("マイカルテ", synthLineUserId("d2c3g1"), {}));
  });

  it("rojiをつくっています (全ボタン)", { timeout: 120_000 }, async () => {
    expectCleanDeterministic("roji アンケート", await crawl(SURVEY_TRIGGER, synthLineUserId("d2c3g2"), {}));
  });

  it("相談したいことがあります (全ボタン)", { timeout: 60_000 }, async () => {
    expectCleanDeterministic("相談", await crawl(CONSULTATION_TRIGGER, synthLineUserId("d2c3g3"), {}));
  });
});

describe.skipIf(EC_SITE_OPEN)("閉店中の総当たり: AI を通る経路 (Anthropic はモック)", () => {
  it("未連携の注文照会: 道具の結果にも届いた文にも閉じたリンクが無く、関所は働かない", async () => {
    const userId = synthLineUserId("d2c3h1");
    // 1 回目: 注文を調べる道具を 2 つ呼ぶ。2 回目: 道具の結果をそのまま読み上げる (AI が結果を足し引きしない)。
    aiQueue = [
      [
        { type: "tool_use", id: "toolu_e2e_orders", name: "lookup_my_orders", input: {} },
        { type: "tool_use", id: "toolu_e2e_detail", name: "get_order_detail", input: { order_number: "1001" } },
      ],
      (req) => {
        const results = toolResultsOf(req);
        return [{ type: "text", text: `ご注文について確認しました。\n${results.join("\n")}` }];
      },
    ];
    const r = await step("注文照会 / 未連携", messageEvent(userId, "注文した商品はいつ届きますか"));
    report("注文照会 / 未連携 (AI)", [r]);
    expect(r.llm, "AI に到達していない").toBeGreaterThanOrEqual(2);
    const toolResults = toolResultsOf(llmRequests[1]);
    expect(toolResults.length, "道具の結果が AI に渡っていない").toBe(2);
    expect(closedIn(toolResults), "道具の結果 (AI に渡る文) に閉じたリンクがある").toEqual([]);
    expect(r.delivered.length, "何も届いていない").toBeGreaterThan(0);
    expect(r.closed, "届いたメッセージに閉じたリンクがある").toEqual([]);
    expect(r.gate, "道具の結果を読み上げただけなのに関所が働いた (道具の文の漏れ)").toEqual([]);
  });

  it("画像メッセージ: AI がリンクを返しても閉じたリンクは届かない", async () => {
    const userId = synthLineUserId("d2c3h2");
    aiDefault = LEAKY_AI_REPLY;
    const base = messageEvent(userId, "");
    const r = await step("画像", { ...base, message: { type: "image", id: `e2e-img-d2c3-${Date.now()}`, contentProvider: { type: "line" } } });
    report("画像 (AI がリンクを返すモック)", [r]);
    expect(r.llm, "AI に到達していない").toBeGreaterThan(0);
    expect(r.delivered.length, "何も届いていない").toBeGreaterThan(0);
    expect(r.closed, "届いたメッセージに閉じたリンクがある").toEqual([]);
    expect(texts([r]).join("\n"), "Amazon の URL が消えた").toContain(AMAZON_STORE_URL);
    expect(texts([r]).join("\n"), "問い合わせメールが消えた").toContain("info@elxea.com");
    expect(r.gate.length, "AI の閉じたリンクを関所が消していない").toBeGreaterThan(0);
  });

  it("AI 会話 5 回目: 「体験を記録する」は閉店中は付かない (C-15)", async () => {
    const userId = synthLineUserId("d2c3h3");
    const t = Date.now() - 10 * 60_000;
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 4; i++) {
      rows.push({ user_id: userId, channel: "line", role: "user", content: `質問 ${i + 1}`, created_at: new Date(t + i * 2000).toISOString() });
      rows.push({ user_id: userId, channel: "line", role: "assistant", content: `お答え ${i + 1}`, created_at: new Date(t + i * 2000 + 1000).toISOString() });
    }
    h.supabase.seed("conversations", rows);
    const r = await step("AI 5 回目", messageEvent(userId, "ほうじ茶の淹れ方のコツは？"));
    report("AI 会話 5 回目", [r]);
    expect(r.llm, "AI に到達していない").toBeGreaterThan(0);
    const history = llmRequests[0].messages.filter((m) => m.role === "assistant");
    expect(history.length, "過去 4 回の AI の発言が履歴に入っていない (5 回目になっていない)").toBeGreaterThanOrEqual(4);
    const joined = texts([r]).join("\n");
    expect(joined, "閉店中なのに「体験を記録する」が付いた").not.toContain(TASTING_NOTE_CTA_TEXT_OPEN.trim());
    expect(joined, "閉店中なのに体験記録のリンクが付いた").not.toContain("tasting-note");
    expect(r.closed, "届いたメッセージに閉じたリンクがある").toEqual([]);
    expect(r.gate, "リンクの無い AI の返事なのに関所が働いた").toEqual([]);
  });

  it("売り込み面 ON の会話: 商品カード・カートリンクの閉じたリンクは届かない", async () => {
    const userId = synthLineUserId("d2c3h4");
    aiQueue = [
      [
        {
          type: "tool_use",
          id: "toolu_e2e_rec",
          name: "recommend_product",
          input: {
            products: [
              { name: "ほうじ茶", description: "香ばしい焙煎の香り", price: "¥1,200", product_url: "https://elxea.com/products/hojicha" },
            ],
          },
        },
        { type: "tool_use", id: "toolu_e2e_cart", name: "create_cart_link", input: { items: [{ variant_id: "4000000000001", quantity: 1 }] } },
      ],
      [{ type: "text", text: `おすすめはほうじ茶です。https://elxea.com/products/hojicha\nAmazon のストア: ${AMAZON_STORE_URL}` }],
    ];
    const r = await step("売り込み面 ON の会話", messageEvent(userId, "おすすめのお茶を買いたいです"), {
      SALES_SURFACE_ENABLED: "true",
      SHOPIFY_STOREFRONT_ACCESS_TOKEN: "e2e-mock-storefront-token",
      SHOPIFY_STORE_DOMAIN: MOCK_SHOP_DOMAIN,
    });
    report("売り込み面 ON の会話 (AI が商品カード・カートを作るモック)", [r]);
    expect(r.llm, "AI に到達していない").toBeGreaterThanOrEqual(2);
    expect(r.delivered.length, "何も届いていない").toBeGreaterThan(0);
    expect(r.closed, "届いたメッセージに閉じたリンクがある").toEqual([]);
    expect(texts([r]).join("\n"), "Amazon の URL が消えた").toContain(AMAZON_STORE_URL);
    // 商品カード (elxea.com) とカート (*.myshopify.com) は AI の出口で外れている。
    expect(r.gate.some((g) => g.gate === "agent_exit" && (g.dropped ?? 0) > 0), "商品カード・カートを AI の出口で外していない").toBe(true);
    expect(r.delivered.filter((m) => m.type === "flex"), "閉じたリンク入りの Flex が届いた").toEqual([]);
  });
});

function toolResultsOf(req: LlmRequest | undefined): string[] {
  if (!req) return [];
  const out: string[] = [];
  for (const m of req.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (b.type !== "tool_result") continue;
      if (typeof b.content === "string") out.push(b.content);
      else if (Array.isArray(b.content)) {
        out.push((b.content as Array<Record<string, unknown>>).map((c) => String(c.text ?? "")).join("\n"));
      }
    }
  }
  return out;
}

describe.skipIf(EC_SITE_OPEN)("閉店中の総当たり: 自前 push の 2 経路 (関所の外。送る文そのものを固定)", () => {
  const NOW = new Date("2026-09-26T00:00:00Z");
  const daysAgo = (d: number): string => new Date(NOW.getTime() - d * 86_400_000).toISOString();

  it("休眠の再案内 (dormant-reengagement.ts): どのカルテでも送る文に閉じたリンクが無い", async () => {
    const kartes: Record<string, NextCupKarte> = {};
    const users: LineUserActivity[] = [];
    const variants: NextCupKarte[] = [
      { persona: null, tasteProfile: null },
      { persona: null, tasteProfile: { preferredCategories: ["oolong"], flavorPreferences: [], scenePref: null } },
      { persona: null, tasteProfile: { preferredCategories: ["green"], flavorPreferences: [], scenePref: null } },
      { persona: null, tasteProfile: { preferredCategories: ["black"], flavorPreferences: [], scenePref: null } },
    ];
    variants.forEach((k, i) => {
      const id = synthLineUserId(`d2c3i${i}`);
      kartes[id] = k;
      users.push({ lineUserId: id, lastActiveAt: daysAgo(120) });
    });
    const sends: Array<{ body: string }> = [];
    const deps: DormantReengagementDeps = {
      now: NOW,
      sendEnabled: true, // 送信は下の fake が捕捉するだけ (実 I/O 非接触)
      thresholdDays: 60,
      perRunCap: 20,
      loadLineUsers: async () => users,
      loadRecentlySent: async () => new Set<string>(),
      loadKarte: async (id) => kartes[id] ?? { persona: null, tasteProfile: null },
      recordDecision: async () => {},
      claimBudget: async () => ({ ok: true }),
      sendMessage: async (_id, body) => {
        sends.push({ body });
      },
      markSent: async () => {},
    };
    await runDormantReengagementWith(deps);
    const pushed = sends.map((s) => ({ type: "text", text: s.body }));
    note(`[d2c3] 休眠の再案内 (自前 push): 届く文=${pushed.length} 閉じたリンク=${closedIn(pushed).length}`);
    expect(pushed.length, "休眠の再案内が 1 通も組み立てられていない").toBe(users.length);
    expect(closedIn(pushed), "休眠の再案内の文に閉じたリンクがある").toEqual([]);
    expect(closedIn(variants.map((k) => buildDormantBody(k))), "buildDormantBody の文に閉じたリンクがある").toEqual([]);
    expect(closedIn(buildDormantBody(null)), "buildDormantBody(null) の文に閉じたリンクがある").toEqual([]);
    expect(h.line.sends, "実の LINE 送信に触れた").toEqual([]);
  });

  it("マルシェ客の活性化 (marche-activation.ts): 送る文に閉じたリンクが無い", async () => {
    const users: MarcheUser[] = [0, 1].map((i) => ({ lineUserId: synthLineUserId(`d2c3j${i}`), createdAt: daysAgo(3), source: "marche" }));
    const sends: Array<{ body: string }> = [];
    const deps: MarcheActivationDeps = {
      now: NOW,
      sendEnabled: true, // 送信は下の fake が捕捉するだけ (実 I/O 非接触)
      thresholdDays: 1,
      windowDays: 14,
      perRunCap: 20,
      loadMarcheUsers: async () => users,
      loadUsersWithCard: async () => new Set<string>(),
      loadAlreadyNudged: async () => new Set<string>(),
      recordDecision: async () => {},
      claimBudget: async () => ({ ok: true }),
      sendMessage: async (_id, body) => {
        sends.push({ body });
      },
      markSent: async () => {},
    };
    await runMarcheActivationWith(deps);
    const pushed = sends.map((s) => ({ type: "text", text: s.body }));
    note(`[d2c3] マルシェ客の活性化 (自前 push): 届く文=${pushed.length} 閉じたリンク=${closedIn(pushed).length}`);
    expect(pushed.length, "マルシェ客の活性化が 1 通も組み立てられていない").toBe(users.length);
    expect(closedIn(pushed), "マルシェ客の活性化の文に閉じたリンクがある").toEqual([]);
    expect(closedIn(MARCHE_ACTIVATION_MESSAGE), "MARCHE_ACTIVATION_MESSAGE に閉じたリンクがある").toEqual([]);
    expect(h.line.sends, "実の LINE 送信に触れた").toEqual([]);
  });
});
