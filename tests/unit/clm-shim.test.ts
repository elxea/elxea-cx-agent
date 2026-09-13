/**
 * Unit Tests -- CLM shim（OpenAI 互換 /chat/completions）
 *
 * Hume を 1 秒も使わずに、受け口の「形」を確かめる。
 * 会話本体（runAgentStreaming）と埋め込み（createEmbedding）は差し替えるので、
 * Anthropic にも Supabase にも Workers AI にも触らない。
 *
 * 確かめること（タスクの F-4）:
 *   - SSE の形が OpenAI 互換か（role 宣言 → content → finish_reason=stop → [DONE]）
 *   - **本当に流れるか**（全部揃ってからではなく、来た端から出ているか）
 *   - エラー時に黙って固まらないか
 *   - 鍵なしで拒否されるか
 * さらに F-2（messages の観測）/ F-3（system の扱い）/ F-5（道具の範囲）の
 * 判断がコードに入っているかも、ここで固定する。
 *
 * 使用方法:
 *   npx tsx tests/unit/clm-shim.test.ts
 */

import { Hono } from "hono";
import type { Env } from "../../src/index";
import type { StreamCallbacks, StreamingAgentMeta } from "../../src/agent/core";
import { createClmChatCompletionsHandler } from "../../src/routes/clm";
import {
  normalizeMessages,
  describeRequestShape,
  resolveLogLevel,
  buildRequestLog,
  redactText,
  deriveSessionKey,
  resolveSystemPolicy,
  resolveToolPolicy,
} from "../../src/lib/clm-protocol";
import { agentToolsFor } from "../../src/agent/tools";

// ---------------------------------------------------------------------------
// テストハーネス（外部依存なし・既存 tests/unit/*.test.ts と同じ流儀）
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 偽の会話本体（runAgentStreaming の差し替え）
// ---------------------------------------------------------------------------

const TEST_SECRET = "clm-test-secret";

/** 会話本体が受け取った引数を覗くための記録 */
type Captured = {
  userMessage: string;
  history: Array<{ role: string; content: string }>;
  userId: string;
  channel: string;
  options: Record<string, unknown> | undefined;
};
let captured: Captured | null = null;

type FakeBehavior = {
  /** 流す文字列（1 個ずつ delta で出す） */
  deltas?: string[];
  /** delta の間に入れる待ち（ms）。「本当に流れているか」を見るため */
  gapMs?: number;
  /** true なら例外を投げる */
  throws?: boolean;
  /** onError を呼んでから正常終了する */
  errorMessage?: string;
};

function makeFakeAgent(behavior: FakeBehavior) {
  return async function fakeRunAgentStreaming(
    userMessage: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    _embedding: number[],
    userId: string,
    channel: string,
    _env: unknown,
    callbacks: StreamCallbacks,
    options?: Record<string, unknown>,
  ): Promise<StreamingAgentMeta> {
    captured = { userMessage, history, userId, channel, options };
    if (behavior.throws) throw new Error("boom");
    if (behavior.errorMessage) callbacks.onError(behavior.errorMessage);

    let full = "";
    for (const d of behavior.deltas ?? []) {
      callbacks.onTextDelta(d);
      full += d;
      if (behavior.gapMs) await new Promise((r) => setTimeout(r, behavior.gapMs));
    }
    callbacks.onDone(full);
    return {
      escalated: false,
      flexMessages: [],
      productCards: [],
      quickReplies: [],
    } as StreamingAgentMeta;
  } as unknown as Parameters<typeof createClmChatCompletionsHandler>[0]["runAgentStreaming"];
}

function makeApp(behavior: FakeBehavior) {
  const handler = createClmChatCompletionsHandler({
    runAgentStreaming: makeFakeAgent(behavior),
    createEmbedding: async () => new Array(8).fill(0),
  });
  const app = new Hono<{ Bindings: Env }>();
  app.post("/v1/chat/completions", handler);
  return app;
}

function envWith(extra: Record<string, string> = {}) {
  return { CLM_API_SECRET: TEST_SECRET, ...extra } as unknown as Env;
}

function req(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const authed = { "X-API-Key": TEST_SECRET };

/** 偽の OpenAI クライアント: SSE を最後まで読んでフレーム文字列の配列にする */
async function readSse(res: Response): Promise<string[]> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
  }
  return buf.split("\n\n").filter((s) => s.trim().length > 0);
}

const simpleBody = {
  model: "elxea-cx-agent",
  stream: true,
  messages: [{ role: "user", content: "こんにちは" }],
};

// ---------------------------------------------------------------------------
// F-4: 認証
// ---------------------------------------------------------------------------

describe("F-4 認証（鍵なしで拒否されるか）", () => {
  it("鍵なしは 401", async () => {
    const res = await makeApp({ deltas: ["a"] }).fetch(req(simpleBody), envWith());
    assertEqual(res.status, 401, "status");
  });

  it("違う鍵は 401", async () => {
    const res = await makeApp({ deltas: ["a"] }).fetch(
      req(simpleBody, { "X-API-Key": "wrong" }),
      envWith(),
    );
    assertEqual(res.status, 401, "status");
  });

  it("サーバ側の鍵が未設定なら、何を送っても 401（fail-closed）", async () => {
    const res = await makeApp({ deltas: ["a"] }).fetch(
      req(simpleBody, authed),
      {} as unknown as Env,
    );
    assertEqual(res.status, 401, "status");
  });

  it("X-API-Key が正しければ通る", async () => {
    const res = await makeApp({ deltas: ["a"] }).fetch(req(simpleBody, authed), envWith());
    assertEqual(res.status, 200, "status");
    await readSse(res);
  });

  it("Authorization: Bearer でも通る（相手がどちらの形でも繋がる）", async () => {
    const res = await makeApp({ deltas: ["a"] }).fetch(
      req(simpleBody, { Authorization: `Bearer ${TEST_SECRET}` }),
      envWith(),
    );
    assertEqual(res.status, 200, "status");
    await readSse(res);
  });

  it("鍵に前後の空白が混ざっても通る（wrangler secret put の落とし穴対策）", async () => {
    const res = await makeApp({ deltas: ["a"] }).fetch(
      req(simpleBody, { "X-API-Key": ` ${TEST_SECRET}\n` }),
      envWith(),
    );
    assertEqual(res.status, 200, "status");
    await readSse(res);
  });
});

// ---------------------------------------------------------------------------
// F-4: SSE の形
// ---------------------------------------------------------------------------

describe("F-4 SSE の形（OpenAI 互換）", () => {
  it("Content-Type は text/event-stream", async () => {
    const res = await makeApp({ deltas: ["お"] }).fetch(req(simpleBody, authed), envWith());
    assertTrue(
      (res.headers.get("Content-Type") ?? "").startsWith("text/event-stream"),
      "content-type",
    );
    await readSse(res);
  });

  it("role 宣言 → content → finish_reason=stop → [DONE] の順に並ぶ", async () => {
    const res = await makeApp({ deltas: ["こん", "にちは"] }).fetch(
      req(simpleBody, authed),
      envWith(),
    );
    const frames = await readSse(res);

    // 全フレームが `data: ` で始まる
    for (const f of frames) assertTrue(f.startsWith("data: "), `frame prefix: ${f.slice(0, 20)}`);

    // 最後は [DONE]
    assertEqual(frames[frames.length - 1], "data: [DONE]", "last frame");

    const payloads = frames
      .slice(0, -1)
      .map((f) => JSON.parse(f.slice("data: ".length)) as Record<string, any>);

    assertEqual(payloads[0].object, "chat.completion.chunk", "object");
    assertEqual(payloads[0].choices[0].delta.role, "assistant", "first delta role");
    assertEqual(payloads[1].choices[0].delta.content, "こん", "delta 1");
    assertEqual(payloads[2].choices[0].delta.content, "にちは", "delta 2");
    assertEqual(
      payloads[payloads.length - 1].choices[0].finish_reason,
      "stop",
      "finish_reason",
    );

    // id / model / created が全フレームで揃っている
    const id = payloads[0].id as string;
    assertTrue(id.startsWith("chatcmpl-"), "id prefix");
    for (const p of payloads) {
      assertEqual(p.id, id, "id consistency");
      assertEqual(p.model, "elxea-cx-agent", "model echo");
      assertTrue(typeof p.created === "number", "created");
    }
  });

  it("stream:false なら chat.completion を JSON で返す", async () => {
    const res = await makeApp({ deltas: ["こん", "にちは"] }).fetch(
      req({ ...simpleBody, stream: false }, authed),
      envWith(),
    );
    assertEqual(res.status, 200, "status");
    const json = (await res.json()) as Record<string, any>;
    assertEqual(json.object, "chat.completion", "object");
    assertEqual(json.choices[0].message.role, "assistant", "role");
    assertEqual(json.choices[0].message.content, "こんにちは", "content");
    assertEqual(json.choices[0].finish_reason, "stop", "finish_reason");
  });
});

// ---------------------------------------------------------------------------
// F-4: 本当に流れているか
// ---------------------------------------------------------------------------

describe("F-4 ストリーミングが本当に流れるか", () => {
  it("最初の content が、会話が終わり切る前に届く", async () => {
    // delta 3 個 × 各 60ms の待ち。全文待ちなら最初の content は 180ms 以降にしか来ない。
    const res = await makeApp({ deltas: ["あ", "い", "う"], gapMs: 60 }).fetch(
      req(simpleBody, authed),
      envWith(),
    );
    const t0 = Date.now();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let firstContentAt = -1;
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (firstContentAt < 0 && buf.includes('"content":"あ"')) {
        firstContentAt = Date.now() - t0;
        break;
      }
    }
    await reader.cancel().catch(() => {});
    assertTrue(firstContentAt >= 0, "first content frame arrived");
    assertTrue(
      firstContentAt < 150,
      `first content should arrive before the whole turn finishes (got ${firstContentAt}ms)`,
    );
  });
});

// ---------------------------------------------------------------------------
// F-4: エラー時の挙動
// ---------------------------------------------------------------------------

describe("F-4 エラー時の挙動", () => {
  it("会話本体が落ちても、エラーを流して [DONE] で必ず閉じる（固まらない）", async () => {
    const res = await makeApp({ throws: true }).fetch(req(simpleBody, authed), envWith());
    assertEqual(res.status, 200, "status（ヘッダは既に送っているので 200 のまま）");
    const frames = await readSse(res);
    assertEqual(frames[frames.length - 1], "data: [DONE]", "closed with [DONE]");
    assertTrue(
      frames.some((f) => f.includes('"error"')),
      "error frame present",
    );
    assertTrue(
      frames.some((f) => f.includes('"finish_reason":"stop"')),
      "finish_reason=stop present",
    );
  });

  it("onError が呼ばれた場合もエラーフレームを流す", async () => {
    const res = await makeApp({ errorMessage: "upstream timeout", deltas: [] }).fetch(
      req(simpleBody, authed),
      envWith(),
    );
    const frames = await readSse(res);
    assertTrue(frames.some((f) => f.includes("upstream timeout")), "error message relayed");
    assertEqual(frames[frames.length - 1], "data: [DONE]", "closed with [DONE]");
  });

  it("壊れた JSON は 400", async () => {
    const res = await makeApp({ deltas: ["a"] }).fetch(req("{not json", authed), envWith());
    assertEqual(res.status, 400, "status");
  });

  it("user 発言が 1 件も無ければ 400", async () => {
    const res = await makeApp({ deltas: ["a"] }).fetch(
      req({ stream: true, messages: [{ role: "system", content: "x" }] }, authed),
      envWith(),
    );
    assertEqual(res.status, 400, "status");
  });

  it("長すぎる発話は 400", async () => {
    const res = await makeApp({ deltas: ["a"] }).fetch(
      req(
        { stream: true, messages: [{ role: "user", content: "あ".repeat(2001) }] },
        authed,
      ),
      envWith(),
    );
    assertEqual(res.status, 400, "status");
  });

  it("埋め込みが失敗したら、SSE を開かずに 500 を返す", async () => {
    const handler = createClmChatCompletionsHandler({
      runAgentStreaming: makeFakeAgent({ deltas: ["a"] }),
      createEmbedding: async () => { throw new Error("embedding down"); },
    });
    const app = new Hono<{ Bindings: Env }>();
    app.post("/v1/chat/completions", handler);
    const res = await app.fetch(req(simpleBody, authed), envWith());
    assertEqual(res.status, 500, "status");
  });
});

// ---------------------------------------------------------------------------
// F-2: messages の観測
// ---------------------------------------------------------------------------

describe("F-2 messages の観測（中身を漏らさずに形を残す）", () => {
  it("既定の level は shape（中身を 1 文字も出さない）", () => {
    assertEqual(resolveLogLevel(undefined, undefined).level, "shape");
    assertEqual(resolveLogLevel("", "test").level, "shape");
    assertEqual(resolveLogLevel("がらくた", "test").level, "shape");
  });

  it("本番では redacted / full を受け付けず shape に落とす", () => {
    const r1 = resolveLogLevel("full", "prod");
    assertEqual(r1.level, "shape", "full on prod");
    assertEqual(r1.downgradedFrom, "full", "downgrade は黙って起きない");
    const r2 = resolveLogLevel("redacted", "prod");
    assertEqual(r2.level, "shape", "redacted on prod");
    // 本番以外では申告どおり
    assertEqual(resolveLogLevel("full", "test").level, "full", "full on staging");
  });

  it("shape ログに発話の中身が 1 文字も含まれない", () => {
    const body = {
      model: "m",
      messages: [
        { role: "system", content: "あなたは案内係です" },
        { role: "user", content: "煎茶の淹れ方を教えて" },
      ],
    };
    const log = JSON.stringify(buildRequestLog(body, "shape"));
    assertTrue(!log.includes("煎茶"), "user content must not appear");
    assertTrue(!log.includes("案内係"), "system content must not appear");
    assertTrue(log.includes('"system_message_count":1'), "system の有無は分かる");
    assertTrue(log.includes('"content_lengths"'), "長さは分かる");
  });

  it("prosody のような未知キーは、値を出さずにキー名だけ発見できる", () => {
    const shape = describeRequestShape({
      messages: [
        {
          role: "user",
          content: "こんにちは",
          models: { prosody: { scores: { joy: 0.42 } } },
          time: { begin: 1, end: 2 },
        },
      ],
      custom_session_id: "abc123",
    });
    const keys = shape.extra_message_keys as string[];
    assertTrue(keys.includes("models"), "models key found");
    assertTrue(keys.includes("time"), "time key found");
    const paths = shape.extra_message_key_paths as string[];
    assertTrue(paths.includes("models.prosody"), "nested key path found");
    assertTrue(!JSON.stringify(shape).includes("0.42"), "スコアの値は出さない");
    assertEqual(shape.custom_session_id_present, true, "presence だけ出す");
    assertTrue(!JSON.stringify(shape).includes("abc123"), "生の値は出さない");
  });

  it("redacted は数字・メール・URL を伏せる", () => {
    const out = redactText("注文1234について a@b.com https://x.test を見て");
    assertTrue(!out.includes("1234"), "digits masked");
    assertTrue(!out.includes("a@b.com"), "email masked");
    assertTrue(!out.includes("https://x.test"), "url masked");
  });

  it("off なら何も作らない", () => {
    assertEqual(buildRequestLog({ messages: [] }, "off"), null);
  });
});

// ---------------------------------------------------------------------------
// 入力の正規化
// ---------------------------------------------------------------------------

describe("入力の正規化", () => {
  it("system は履歴に混ぜず分離し、末尾の user を今の問いにする", () => {
    const n = normalizeMessages([
      { role: "system", content: "指示" },
      { role: "user", content: "1回目" },
      { role: "assistant", content: "返事" },
      { role: "user", content: "2回目" },
    ]);
    assertEqual(n.systemTexts.length, 1, "system 分離");
    assertEqual(n.latestUserText, "2回目", "latest");
    assertEqual(n.history.length, 2, "history len");
    assertEqual(n.history[0].content, "1回目", "history order");
    assertTrue(
      !n.history.some((h) => h.content === "指示"),
      "system must not leak into history",
    );
  });

  it("content がパート配列でもテキストを拾う", () => {
    const n = normalizeMessages([
      { role: "user", content: [{ type: "text", text: "あ" }, { type: "text", text: "い" }] },
    ]);
    assertEqual(n.latestUserText, "あい");
  });

  it("tool role は落とし、落としたことを残す", () => {
    const n = normalizeMessages([
      { role: "tool", content: "結果" },
      { role: "user", content: "問い" },
    ]);
    assertEqual(n.droppedRoles.length, 1, "dropped count");
    assertEqual(n.droppedRoles[0], "tool", "dropped role");
  });

  it("messages が配列でなくても壊れない", () => {
    const n = normalizeMessages(undefined);
    assertEqual(n.latestUserText, "", "empty");
  });
});

// ---------------------------------------------------------------------------
// F-3: system の扱い
// ---------------------------------------------------------------------------

describe("F-3 相手から来た system の扱い", () => {
  it("既定（own）は破棄する — 会話本体に extraSystem を渡さない", async () => {
    captured = null;
    const res = await makeApp({ deltas: ["a"] }).fetch(
      req(
        {
          stream: true,
          messages: [
            { role: "system", content: "Humeの指示文" },
            { role: "user", content: "問い" },
          ],
        },
        authed,
      ),
      envWith(),
    );
    await readSse(res);
    assertTrue(captured !== null, "agent called");
    assertEqual(captured!.options?.extraSystem, undefined, "extraSystem must be absent");
  });

  it("append に倒せば併用できる（切替可能）", async () => {
    captured = null;
    const res = await makeApp({ deltas: ["a"] }).fetch(
      req(
        {
          stream: true,
          messages: [
            { role: "system", content: "Humeの指示文" },
            { role: "user", content: "問い" },
          ],
        },
        authed,
      ),
      envWith({ CLM_SYSTEM_POLICY: "append" }),
    );
    await readSse(res);
    assertEqual(captured!.options?.extraSystem, "Humeの指示文", "extraSystem applied");
  });

  it("resolveSystemPolicy の既定は own", () => {
    assertEqual(resolveSystemPolicy(undefined), "own");
    assertEqual(resolveSystemPolicy("APPEND"), "append");
    assertEqual(resolveSystemPolicy("がらくた"), "own");
  });
});

// ---------------------------------------------------------------------------
// F-5: 道具の範囲
// ---------------------------------------------------------------------------

describe("F-5 音声経路の道具の範囲", () => {
  it("既定は minimal（エスカレーションだけ残す）", () => {
    assertEqual(resolveToolPolicy(undefined), "minimal");
    const tools = agentToolsFor({} as never, "minimal");
    assertEqual(tools.length, 1, "tool count");
    assertEqual(tools[0].name, "escalate_to_human", "the one kept");
  });

  it("注文照会は音声経路では渡さない", () => {
    const names = agentToolsFor({} as never, "minimal").map((t) => t.name);
    assertTrue(!names.includes("lookup_my_orders"), "lookup_my_orders dropped");
    assertTrue(!names.includes("get_order_detail"), "get_order_detail dropped");
  });

  it("none なら 1 つも渡さない", () => {
    assertEqual(agentToolsFor({} as never, "none").length, 0);
  });

  it("all は従来どおり（文字チャットの既定を変えない）", () => {
    const names = agentToolsFor({} as never, "all").map((t) => t.name);
    assertTrue(names.includes("escalate_to_human"), "escalation");
    assertTrue(names.includes("lookup_my_orders"), "orders");
    assertTrue(names.includes("get_order_detail"), "order detail");
  });

  it("受け口は既定で minimal を会話本体に渡す", async () => {
    captured = null;
    const res = await makeApp({ deltas: ["a"] }).fetch(req(simpleBody, authed), envWith());
    await readSse(res);
    assertEqual(captured!.options?.toolPolicy, "minimal", "toolPolicy");
  });

  it("env で none に倒せる", async () => {
    captured = null;
    const res = await makeApp({ deltas: ["a"] }).fetch(
      req(simpleBody, authed),
      envWith({ CLM_TOOL_POLICY: "none" }),
    );
    await readSse(res);
    assertEqual(captured!.options?.toolPolicy, "none", "toolPolicy");
  });
});

// ---------------------------------------------------------------------------
// 決定 #7: custom_session_id に生の顧客 ID を持ち込まない
// ---------------------------------------------------------------------------

describe("決定 #7 custom_session_id を鍵として信じない", () => {
  it("同じ値は同じ鍵になり、生の値は残らない", async () => {
    const a = await deriveSessionKey("customer-gid-12345", "salt");
    const b = await deriveSessionKey("customer-gid-12345", "salt");
    assertEqual(a, b, "deterministic");
    assertTrue(a.startsWith("clm_"), "prefix");
    assertTrue(!a.includes("12345"), "raw id must not survive");
  });

  it("塩が違えば別の鍵になる", async () => {
    const a = await deriveSessionKey("x", "salt-1");
    const b = await deriveSessionKey("x", "salt-2");
    assertTrue(a !== b, "salted");
  });

  it("未指定ならその場限りの鍵になる", async () => {
    const a = await deriveSessionKey(undefined, "salt");
    const b = await deriveSessionKey(undefined, "salt");
    assertTrue(a !== b, "ephemeral");
    assertTrue(a.startsWith("clm_eph_"), "prefix");
  });

  it("会話本体に渡る userId は畳んだ鍵（生の値ではない）", async () => {
    captured = null;
    const res = await makeApp({ deltas: ["a"] }).fetch(
      req({ ...simpleBody, custom_session_id: "raw-customer-999" }, authed),
      envWith({ CLM_SESSION_SALT: "s" }),
    );
    await readSse(res);
    assertTrue(!captured!.userId.includes("raw-customer-999"), "raw id must not reach the agent");
    assertTrue(captured!.userId.startsWith("clm_"), "hashed key");
    assertEqual(captured!.channel, "web", "channel は既存の 2 値のまま");
  });
});

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

(async () => {
  console.log("\n=== CLM shim Unit Tests ===\n");
  for (const t of queue) {
    if (t.name.startsWith("---")) {
      console.log(`\n${t.name}`);
      continue;
    }
    try {
      await t.fn();
      passedTests++;
      console.log(`  [OK] ${t.name}`);
    } catch (err) {
      failedTests++;
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ name: t.name, error: msg });
      console.log(`  [FAIL] ${t.name}\n         ${msg}`);
    }
  }
  console.log(`\n--- Result: ${passedTests} passed, ${failedTests} failed ---\n`);
  if (failedTests > 0) {
    for (const f of failures) console.log(`FAIL: ${f.name} -- ${f.error}`);
    process.exit(1);
  }
})();
