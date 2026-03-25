/**
 * Streaming SSE テスト
 *
 * SSE イベントのフォーマットとストリーミングコールバックの動作を検証する。
 * 外部依存（Anthropic API, Supabase 等）は不要。
 *
 * 使用方法:
 *   npx tsx tests/unit/streaming-sse.test.ts
 */

import type { StreamCallbacks, StreamingAgentMeta } from "../../src/agent/core";

// ---------------------------------------------------------------------------
// テストハーネス
// ---------------------------------------------------------------------------

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];

function describe(suiteName: string, fn: () => void) {
  console.log(`\n--- ${suiteName} ---`);
  fn();
}

function it(testName: string, fn: () => void | Promise<void>) {
  totalTests++;
  const result = fn();
  if (result instanceof Promise) {
    result
      .then(() => {
        passedTests++;
        console.log(`  [PASS] ${testName}`);
      })
      .catch((err) => {
        failedTests++;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  [FAIL] ${testName}: ${msg}`);
        failures.push({ name: testName, error: msg });
      });
  } else {
    passedTests++;
    console.log(`  [PASS] ${testName}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assert(condition: boolean, label = "") {
  if (!condition) {
    throw new Error(`${label ? label + ": " : ""}assertion failed`);
  }
}

// ---------------------------------------------------------------------------
// SSE イベントフォーマットテスト
// ---------------------------------------------------------------------------

/** SSE イベント文字列をパースする */
function parseSSEEvents(raw: string): Array<Record<string, unknown>> {
  return raw
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.replace("data: ", "")));
}

describe("SSE Event Format", () => {
  it("text_delta イベントが正しい形式を持つ", () => {
    const event = { type: "text_delta", content: "こんにちは" };
    const raw = `data: ${JSON.stringify(event)}\n\n`;
    const parsed = parseSSEEvents(raw);
    assertEqual(parsed.length, 1);
    assertEqual(parsed[0].type, "text_delta");
    assertEqual(parsed[0].content, "こんにちは");
  });

  it("product_card イベントが正しい形式を持つ", () => {
    const event = {
      type: "product_card",
      products: [
        { name: "宇治抹茶", price: "¥3,000", url: "https://elxea.com/products/uji", image: null, description: "京都産" },
      ],
    };
    const raw = `data: ${JSON.stringify(event)}\n\n`;
    const parsed = parseSSEEvents(raw);
    assertEqual(parsed.length, 1);
    assertEqual(parsed[0].type, "product_card");
    assert(Array.isArray(parsed[0].products), "products should be array");
  });

  it("quick_replies イベントが正しい形式を持つ", () => {
    const event = {
      type: "quick_replies",
      items: [
        { label: "詳しく", text: "詳しく教えてください" },
      ],
    };
    const raw = `data: ${JSON.stringify(event)}\n\n`;
    const parsed = parseSSEEvents(raw);
    assertEqual(parsed[0].type, "quick_replies");
    assert(Array.isArray(parsed[0].items), "items should be array");
  });

  it("done イベントが session_id を含む", () => {
    const event = { type: "done", session_id: "sess_abc123" };
    const raw = `data: ${JSON.stringify(event)}\n\n`;
    const parsed = parseSSEEvents(raw);
    assertEqual(parsed[0].type, "done");
    assertEqual(parsed[0].session_id, "sess_abc123");
  });

  it("cart_link イベントが checkout_url を含む", () => {
    const event = { type: "cart_link", checkout_url: "https://elxea.com/cart/xxx" };
    const raw = `data: ${JSON.stringify(event)}\n\n`;
    const parsed = parseSSEEvents(raw);
    assertEqual(parsed[0].type, "cart_link");
    assertEqual(parsed[0].checkout_url, "https://elxea.com/cart/xxx");
  });

  it("複数イベントの連続パースが正しく動作する", () => {
    const events = [
      `data: ${JSON.stringify({ type: "text_delta", content: "おすすめ" })}\n\n`,
      `data: ${JSON.stringify({ type: "text_delta", content: "のお茶は" })}\n\n`,
      `data: ${JSON.stringify({ type: "product_card", products: [{ name: "抹茶", price: "¥2000", url: "/", image: null, description: "" }] })}\n\n`,
      `data: ${JSON.stringify({ type: "done", session_id: "test-sess" })}\n\n`,
    ];
    const raw = events.join("");
    const parsed = parseSSEEvents(raw);
    assertEqual(parsed.length, 4);
    assertEqual(parsed[0].type, "text_delta");
    assertEqual(parsed[1].type, "text_delta");
    assertEqual(parsed[2].type, "product_card");
    assertEqual(parsed[3].type, "done");
  });
});

// ---------------------------------------------------------------------------
// StreamCallbacks テスト
// ---------------------------------------------------------------------------

describe("StreamCallbacks integration", () => {
  it("コールバックが SSE イベント列を正しく生成する", () => {
    const encoder = new TextEncoder();
    const events: string[] = [];

    function writeSSE(data: Record<string, unknown>) {
      events.push(`data: ${JSON.stringify(data)}\n\n`);
    }

    const callbacks: StreamCallbacks = {
      onTextDelta: (text) => writeSSE({ type: "text_delta", content: text }),
      onProductCards: (products) => writeSSE({ type: "product_card", products }),
      onCartLink: (url) => writeSSE({ type: "cart_link", checkout_url: url }),
      onQuickReplies: (items) => writeSSE({ type: "quick_replies", items }),
      onDone: (fullResponse) => writeSSE({ type: "done", session_id: "test" }),
      onError: (error) => writeSSE({ type: "error", message: error }),
    };

    // テキストストリーミングをシミュレート
    callbacks.onTextDelta("お");
    callbacks.onTextDelta("すすめ");
    callbacks.onTextDelta("のお茶です。");
    callbacks.onProductCards([
      { name: "煎茶", price: "¥1,500", url: "/products/sencha", image: null, description: "静岡産" },
    ]);
    callbacks.onQuickReplies([{ label: "詳しく", text: "もっと教えて" }]);
    callbacks.onDone("おすすめのお茶です。");

    assertEqual(events.length, 6);

    const parsed = parseSSEEvents(events.join(""));
    assertEqual(parsed[0].type, "text_delta");
    assertEqual(parsed[0].content, "お");
    assertEqual(parsed[1].content, "すすめ");
    assertEqual(parsed[2].content, "のお茶です。");
    assertEqual(parsed[3].type, "product_card");
    assertEqual(parsed[4].type, "quick_replies");
    assertEqual(parsed[5].type, "done");
  });

  it("エラーコールバックが error イベントを生成する", () => {
    const events: string[] = [];
    function writeSSE(data: Record<string, unknown>) {
      events.push(`data: ${JSON.stringify(data)}\n\n`);
    }

    const callbacks: StreamCallbacks = {
      onTextDelta: () => {},
      onProductCards: () => {},
      onCartLink: () => {},
      onQuickReplies: () => {},
      onDone: () => {},
      onError: (error) => writeSSE({ type: "error", message: error }),
    };

    callbacks.onError("Internal server error");
    const parsed = parseSSEEvents(events.join(""));
    assertEqual(parsed.length, 1);
    assertEqual(parsed[0].type, "error");
    assertEqual(parsed[0].message, "Internal server error");
  });
});

// ---------------------------------------------------------------------------
// TransformStream SSE テスト
// ---------------------------------------------------------------------------

describe("TransformStream SSE output", () => {
  it("ReadableStream がチャンクを即座に出力する", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    // 非同期でイベントを書き込む
    const writePromise = (async () => {
      writer.write(encoder.encode(`data: ${JSON.stringify({ type: "text_delta", content: "テスト" })}\n\n`));
      writer.write(encoder.encode(`data: ${JSON.stringify({ type: "done", session_id: "s1" })}\n\n`));
      await writer.close();
    })();

    // ReadableStream から読み出す
    const reader = readable.getReader();
    const chunks: string[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(decoder.decode(value));
    }
    await writePromise;

    const allData = chunks.join("");
    const parsed = parseSSEEvents(allData);
    assertEqual(parsed.length, 2, "should have 2 events");
    assertEqual(parsed[0].type, "text_delta");
    assertEqual(parsed[1].type, "done");
  });
});

// ---------------------------------------------------------------------------
// 結果サマリー
// ---------------------------------------------------------------------------

setTimeout(() => {
  console.log("\n" + "=".repeat(60));
  console.log("Streaming SSE Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);

  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }

  process.exit(failedTests > 0 ? 1 : 0);
}, 1000);
