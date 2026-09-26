/**
 * ハーメティック — web の逐次送信 (SSE) の実経路で、送る関所が閉じたリンクを外す
 *
 * 設計: 実装設計 rev2 第5章 / 第9章 テスト4
 *   https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 * 出どころ: D2b QA 2 回目の指摘 (web は関所の部品テストだけで、実経路を通していない)
 *   https://app.notion.com/p/3e770c9d064c81d88fd6e8c51d16ee50
 *
 * 経路: POST /api/chat (routes/web.ts) → 本物の runAgentStreaming (agent/core.ts・関所つき) →
 *       SSE (text_delta / quick_replies / done) → onDone → saveMessage (conversations)。
 * Anthropic だけを本ファイル内で差し替え、`stream: true` の要求に Anthropic の SSE 形式の偽ストリームを返す
 * (実 API は呼ばない)。URL は断片をまたいで切る。
 *
 * 確かめること:
 *   (1) SSE の本文と保存に閉じたリンクが無い (Amazon の URL と info@elxea.com は残る・表示と保存が一致)
 *   (2) 返事がリンクだけのとき、fallback 文が SSE に 1 回だけ出て、保存も fallback 文
 *   (3) イベントの順: text_delta → (quick_replies) → done。done は最後に 1 回だけ。
 *       エスカレーション後に返事がリンクだけのときは quick_replies → text_delta(fallback) → done
 *
 * 閉店中だけのケース (実経路はモジュールの開店フラグを読む) は開店フラグが true のとき飛ばし、
 * 開店時の期待 (何も変えない) を 1 本持つ。実ネットワーク非接触・実送信ゼロ。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import { getHermetic, type Hermetic } from "../lib/hermetic";
import { settle } from "../lib/webhook";
import { AMAZON_STORE_URL, EC_SITE_OPEN, EC_STORE_URL, collectLinks, isClosedSiteLink } from "../../src/lib/storefront";
import { AGENT_FALLBACK_REPLY } from "../../src/agent/fallback-reply";

/** 偽ストリームの 1 ターン分: 文字の断片、または道具の呼び出し。 */
type Turn = { text: string[] } | { tool: { name: string; input: Record<string, unknown> } };

let h: Hermetic;
let turns: Turn[];
let streamCalls: number;
let localFetch: typeof fetch | undefined;
let innerFetch: typeof fetch | undefined;

function closedIn(message: unknown): string[] {
  return collectLinks(message).filter((l) => isClosedSiteLink(l, false));
}

/** Anthropic Messages API のストリーム (SSE) を 1 ターン分組み立てる。 */
function anthropicStream(turn: Turn): Response {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg_e2e_flow28_web",
        type: "message",
        role: "assistant",
        model: "claude-mock",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    },
  ];
  if ("text" in turn) {
    events.push({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    for (const t of turn.text) events.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } });
  } else {
    events.push({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_e2e_1", name: turn.tool.name, input: {} },
    });
    events.push({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.tool.input) },
    });
  }
  events.push({ type: "content_block_stop", index: 0 });
  events.push({
    type: "message_delta",
    delta: { stop_reason: "text" in turn ? "end_turn" : "tool_use", stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  events.push({ type: "message_stop" });
  const body = events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** ストリームでない呼び出し (嗜好抽出など、返事の後ろで走るもの) への空の返事。 */
function anthropicJson(): Response {
  return new Response(
    JSON.stringify({
      id: "msg_e2e_flow28_web_json",
      type: "message",
      role: "assistant",
      model: "claude-mock",
      content: [{ type: "text", text: "{}" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  h = getHermetic();
  turns = [];
  streamCalls = 0;
  const inner = globalThis.fetch;
  innerFetch = inner;
  const wrapper = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.includes("api.anthropic.com")) {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      if (body.stream !== true) return anthropicJson();
      streamCalls++;
      const turn = turns.shift();
      if (!turn) throw new Error("偽ストリームのターンが足りない");
      return anthropicStream(turn);
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

interface SseEvent {
  type: string;
  content?: string;
  items?: unknown[];
  session_id?: string;
}

/** web-app の proxy と同じ形で /api/chat に 1 発話を流し、SSE を読み切って保存まで待つ。 */
async function sayOnWeb(text: string): Promise<{ status: number; events: SseEvent[]; saved: string[] }> {
  const sessionId = crypto.randomUUID();
  const request = new Request("https://elxea-agent.e2e.local/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: text, session_id: sessionId }),
  });
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, env, ctx);
  // SSE 本文を読み切ってからでないとストリーミング側の onDone (保存) が走らない。
  const raw = await res.text();
  await waitOnExecutionContext(ctx);
  await settle();
  const events = raw
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as SseEvent);
  const doneSession = events.find((e) => e.type === "done")?.session_id;
  const saved = (h.supabase.all("conversations") as unknown as Array<Record<string, unknown>>)
    .filter((r) => r.role === "assistant" && r.channel === "web" && (doneSession === undefined || r.user_id === doneSession))
    .map((r) => String(r.content));
  return { status: res.status, events, saved };
}

/** 画面に出る本文 (text_delta の連結)。 */
function shownText(events: SseEvent[]): string {
  return events.filter((e) => e.type === "text_delta").map((e) => e.content ?? "").join("");
}

/** 連続する同じ種類のイベントを 1 つにまとめた並び (順序の確認用)。 */
function eventOrder(events: SseEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) if (out[out.length - 1] !== e.type) out.push(e.type);
  return out;
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe.skipIf(EC_SITE_OPEN)("web の逐次送信 (実経路): 閉店中、閉じたリンクは画面にも保存にも出ない", () => {
  it("(1) 断片をまたぐ閉じたリンクが SSE の本文と保存から消え、Amazon の URL と info@elxea.com は残る", async () => {
    turns = [
      {
        text: [
          "ほうじ茶がおすすめです。ご購入は https://elx",
          "ea.com/ja/subscri",
          "ption から。定期便は elxea.",
          "com/ja をご覧ください。\n",
          `Amazon のストア: ${AMAZON_STORE_URL.slice(0, 25)}`,
          `${AMAZON_STORE_URL.slice(25)}\nご不明点は info@elxea.com まで。`,
        ],
      },
    ];
    const { status, events, saved } = await sayOnWeb("ほうじ茶はどこで買えますか");
    expect(status).toBe(200);
    expect(streamCalls, "本物の runAgentStreaming が Anthropic のストリームを読んでいない").toBe(1);

    const shown = shownText(events);
    expect(closedIn(events), "SSE に閉じたリンクがある").toEqual([]);
    expect(shown, "Amazon の URL が壊れた").toContain(AMAZON_STORE_URL);
    expect(shown, "問い合わせメールが消えた").toContain("info@elxea.com");
    expect(shown, "本文が欠けた").toContain("ほうじ茶がおすすめです。");
    expect(countOf(shown, AGENT_FALLBACK_REPLY), "本文があるのに fallback 文が出た").toBe(0);

    expect(saved, "保存件数").toHaveLength(1);
    expect(closedIn(saved), "保存に閉じたリンクがある").toEqual([]);
    expect(saved[0], "表示と保存が一致しない").toBe(shown);

    expect(eventOrder(events), "イベントの順").toEqual(["text_delta", "done"]);
    expect(events.filter((e) => e.type === "done"), "done は 1 回だけ").toHaveLength(1);
  });

  it("(2) 返事がリンクだけ → fallback 文が SSE に 1 回だけ出て、保存も fallback 文", async () => {
    turns = [{ text: ["https://elx", "ea.com/ja/sub", "scription"] }];
    const { status, events, saved } = await sayOnWeb("定期便はどこから申し込めますか");
    expect(status).toBe(200);
    expect(streamCalls).toBe(1);

    const shown = shownText(events);
    expect(shown, "画面に出た文").toBe(AGENT_FALLBACK_REPLY);
    expect(countOf(shown, AGENT_FALLBACK_REPLY), "fallback 文は 1 回だけ").toBe(1);
    expect(events.filter((e) => e.type === "text_delta" && (e.content ?? "").trim() === ""), "空の text_delta").toEqual([]);
    expect(closedIn(events)).toEqual([]);
    expect(saved, "保存した AI の発言").toEqual([AGENT_FALLBACK_REPLY]);
    expect(eventOrder(events), "イベントの順").toEqual(["text_delta", "done"]);
  });

  it("(3) エスカレーション後に返事がリンクだけ → quick_replies → text_delta(fallback) → done の順で 1 回ずつ", async () => {
    turns = [
      { tool: { name: "escalate_to_human", input: { reason: "e2e", category: "other", summary: "e2e" } } },
      { text: ["（https://elx", "ea.com/ja）"] },
    ];
    const { status, events, saved } = await sayOnWeb("担当の方とお話ししたいです");
    expect(status).toBe(200);
    expect(streamCalls, "道具の後の 2 ターン目まで読んでいない").toBe(2);

    expect(eventOrder(events), "イベントの順").toEqual(["quick_replies", "text_delta", "done"]);
    expect(events.filter((e) => e.type === "quick_replies"), "quick_replies は 1 回").toHaveLength(1);
    expect(shownText(events), "画面に出た文").toBe(AGENT_FALLBACK_REPLY);
    expect(closedIn(events)).toEqual([]);
    expect(saved, "保存した AI の発言").toEqual([AGENT_FALLBACK_REPLY]);
  });
});

describe.runIf(EC_SITE_OPEN)("web の逐次送信 (実経路): 開店時は何も変えない", () => {
  it("公式 EC のリンク入りの返事をそのまま SSE に流し、そのまま保存する", async () => {
    const reply = `ご購入はこちら ${EC_STORE_URL} からどうぞ。`;
    turns = [{ text: [reply.slice(0, 12), reply.slice(12)] }];
    const { status, events, saved } = await sayOnWeb("どこで買えますか");
    expect(status).toBe(200);
    expect(shownText(events)).toBe(reply);
    expect(saved).toEqual([reply]);
    expect(eventOrder(events)).toEqual(["text_delta", "done"]);
  });
});
