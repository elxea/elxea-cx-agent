/**
 * ハーメティック — 送る関所 (閉店中、AI の返事から閉じたリンクを外す) を実 webhook 経路で確かめる
 *
 * 設計: 実装設計 rev2 第5章 / 第9章 テスト4 (「画像メッセージの経路でも同じ」を含む)
 *   https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 *
 * AI (Anthropic) の返事に `https://elxea.com/ja` と `elxea.com/ja/subscription` を入れ、過去の会話にも
 * 切替前の `elxea.com` 入りの返事を置いたうえで、LINE の文字と画像の 2 経路を流す。
 *   - お客さんに届いた LINE のメッセージに閉じたリンクが 1 本も無い (Amazon の URL と info@elxea.com は残る)
 *   - 保存された AI の発言に閉じたリンクが無い
 *   - AI に渡った過去の会話 (履歴) の AI の発言に閉じたリンクが無い
 *
 * 実ネットワーク非接触・実送信ゼロ。Anthropic は本ファイル内だけで差し替える。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { getHermetic, type Hermetic } from "../lib/hermetic";
import { dispatchLineWebhook, settle } from "../lib/webhook";
import { messageEvent, synthLineUserId } from "../lib/synthetic";
import { AMAZON_STORE_URL, collectLinks, isClosedSiteLink } from "../../src/lib/storefront";

const AI_REPLY =
  "ほうじ茶がおすすめです。ご購入はこちら https://elxea.com/ja からどうぞ。\n" +
  "定期便は elxea.com/ja/subscription をご覧ください。\n" +
  `Amazon のストア: ${AMAZON_STORE_URL}\n` +
  "ご不明点は info@elxea.com まで。";

const OLD_ASSISTANT = "以前のご案内です。定期便は https://elxea.com/ja/subscription からどうぞ。";

let h: Hermetic;
let llmMessages: Array<Array<{ role: string; content: unknown }>>;
let localFetch: typeof fetch | undefined;
let innerFetch: typeof fetch | undefined;

function closedIn(message: unknown): string[] {
  return collectLinks(message).filter((l) => isClosedSiteLink(l, false));
}

beforeEach(() => {
  h = getHermetic();
  llmMessages = [];
  const inner = globalThis.fetch;
  innerFetch = inner;
  const wrapper = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes("api.anthropic.com")) {
      try {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ role: string; content: unknown }> };
        llmMessages.push(Array.isArray(body.messages) ? body.messages : []);
      } catch {
        llmMessages.push([]);
      }
      return new Response(
        JSON.stringify({
          id: "msg_e2e_flow28",
          type: "message",
          role: "assistant",
          model: "claude-mock",
          content: [{ type: "text", text: AI_REPLY }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return inner(input, init);
  }) as typeof fetch;
  localFetch = wrapper;
  globalThis.fetch = wrapper;
});

afterEach(() => {
  if (localFetch !== undefined && innerFetch !== undefined && globalThis.fetch === localFetch) {
    globalThis.fetch = innerFetch;
  }
  localFetch = undefined;
  innerFetch = undefined;
});

/** 切替前の返事 (elxea.com 入り) が残っている過去の会話を置く。 */
function seedOldConversation(userId: string): void {
  const t = Date.now() - 60_000;
  h.supabase.seed("conversations", [
    { user_id: userId, channel: "line", role: "user", content: "定期便はありますか", created_at: new Date(t).toISOString() },
    { user_id: userId, channel: "line", role: "assistant", content: OLD_ASSISTANT, created_at: new Date(t + 1000).toISOString() },
  ]);
}

async function dispatch(event: Record<string, unknown>): Promise<void> {
  const res = await dispatchLineWebhook({
    env,
    channelSecret: String(env.LINE_CHANNEL_SECRET),
    events: [event],
  });
  expect(res.status, "webhook が 200 で受理されていない").toBe(200);
  await settle();
}

/** 届いた・保存された・AI に渡った、の 3 か所に閉じたリンクが無いこと。 */
function expectNoClosedLinks(userId: string): void {
  expect(llmMessages.length, "AI 会話に到達していない").toBeGreaterThan(0);

  const sent = h.line.allMessages();
  expect(sent.length, "LINE に何も届いていない").toBeGreaterThan(0);
  expect(closedIn(sent), "お客さんに届いたメッセージに閉じたリンクがある").toEqual([]);
  const texts = h.line.texts().join("\n");
  expect(texts, "Amazon の URL が消えた").toContain(AMAZON_STORE_URL);
  expect(texts, "問い合わせメールが消えた").toContain("info@elxea.com");

  const saved = (h.supabase.all("conversations") as unknown as Array<Record<string, unknown>>).filter(
    (r) => r.user_id === userId && r.role === "assistant",
  );
  expect(saved.length, "AI の発言が保存されていない").toBeGreaterThan(1);
  expect(closedIn(saved.filter((r) => r.content !== OLD_ASSISTANT).map((r) => r.content)), "保存された AI の発言に閉じたリンクがある").toEqual([]);

  const history = llmMessages[0].filter((m) => m.role === "assistant");
  expect(history.length, "過去の AI の発言が履歴に入っていない").toBeGreaterThan(0);
  expect(closedIn(history), "AI に渡った履歴の AI の発言に閉じたリンクがある").toEqual([]);
}

describe("送る関所: 閉店中、AI の返事の閉じたリンクはお客さんにも記録にも届かない", () => {
  it("LINE の文字の返事", async () => {
    const userId = synthLineUserId("flow28-text");
    seedOldConversation(userId);
    await dispatch(messageEvent(userId, "ほうじ茶の香りについて教えてください"));
    expectNoClosedLinks(userId);
  });

  it("LINE の画像の返事", async () => {
    const userId = synthLineUserId("flow28-image");
    seedOldConversation(userId);
    const base = messageEvent(userId, "");
    await dispatch({
      ...base,
      message: { type: "image", id: `e2e-img-${Date.now()}`, contentProvider: { type: "line" } },
    });
    expectNoClosedLinks(userId);
  });
});
