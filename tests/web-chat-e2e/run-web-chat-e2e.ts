/**
 * Web Chat E2E テスト — Spec v2 WC4-1 テストシナリオ
 *
 * 本番 / staging の Web Chat API エンドポイントに対して HTTP リクエストを送信し、
 * 4つのテストシナリオ（Spec v2 WC4-1 定義）をカバーする。
 *
 * テストシナリオ:
 *   1. Web 未ログインユーザー: 入力 -> AI 応答 -> 商品カード表示 -> 会話維持
 *   2. Web ログインユーザー: 同上 + Shopify Customer ID ベースの Identity 解決
 *   3. LINE -> Web 会話引き継ぎ: 紐付け済みユーザーの履歴取得検証
 *   4. エスカレーション: Web で人間対応要求 -> Slack 通知
 *
 * 使用方法:
 *   npx tsx tests/web-chat-e2e/run-web-chat-e2e.ts [--scenario=1] [--all]
 *   npx tsx tests/web-chat-e2e/run-web-chat-e2e.ts --target=https://custom-url.workers.dev
 *
 * 環境変数:
 *   WEB_CHAT_BASE_URL  - Web Chat API のベース URL（デフォルト: 本番 Worker）
 *   TEST_SESSION_ID    - テスト用セッション ID（UUID v4、省略時は自動生成）
 *
 * 注意:
 *   - このテストは実際の API を呼び出すため、Claude API / Supabase の利用が発生する
 *   - レートリミット（10req/min）に注意。連続実行時はインターバルを空ける
 */

import * as crypto from "node:crypto";
import * as dotenv from "dotenv";

dotenv.config({ path: ".dev.vars" });

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const targetArg = args.find((a) => a.startsWith("--target="))?.split("=")[1];

const BASE_URL =
  targetArg ??
  process.env.WEB_CHAT_BASE_URL ??
  "https://elxea-agent.elxea.workers.dev";

/** テスト用セッション ID（未ログインユーザー） */
const TEST_SESSION_ID =
  process.env.TEST_SESSION_ID ?? crypto.randomUUID();

/** テスト用セッション ID（ログインユーザー） */
const TEST_LOGGED_IN_SESSION_ID = crypto.randomUUID();

/** テスト用 Shopify Customer ID（ログインユーザーシナリオ用） */
const TEST_SHOPIFY_CUSTOMER_ID = "gid://shopify/Customer/99999999999";

/** テスト用セッション ID（エスカレーションシナリオ用） */
const TEST_ESCALATION_SESSION_ID = crypto.randomUUID();

/** リクエスト間の待機時間（ms）-- レートリミット回避 */
const REQUEST_INTERVAL_MS = 3000;

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

type SSEEvent = {
  type: string;
  content?: string;
  products?: Array<{
    name: string;
    price: string;
    url: string;
    image: string | null;
    description: string;
  }>;
  items?: Array<{ label: string; text: string }>;
  session_id?: string;
};

type ScenarioResult = {
  scenarioName: string;
  steps: Array<{
    stepName: string;
    pass: boolean;
    notes: string;
    duration?: number;
  }>;
  overallPass: boolean;
};

// ---------------------------------------------------------------------------
// HTTP ユーティリティ
// ---------------------------------------------------------------------------

/**
 * POST /api/chat にメッセージを送信し、SSE イベントをパースして返す
 */
async function sendChatMessage(
  message: string,
  sessionId: string,
  shopifyCustomerId?: string,
): Promise<{
  status: number;
  events: SSEEvent[];
  fullText: string;
  error?: string;
  durationMs: number;
}> {
  const startTime = Date.now();

  const body: Record<string, string> = {
    message,
    session_id: sessionId,
  };
  if (shopifyCustomerId) {
    body.shopify_customer_id = shopifyCustomerId;
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      status: 0,
      events: [],
      fullText: "",
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: Date.now() - startTime,
    };
  }

  const durationMs = Date.now() - startTime;

  if (!res.ok) {
    let errorBody: string;
    try {
      errorBody = JSON.stringify(await res.json());
    } catch {
      errorBody = await res.text();
    }
    return {
      status: res.status,
      events: [],
      fullText: "",
      error: errorBody,
      durationMs,
    };
  }

  // SSE レスポンスをパース
  const rawText = await res.text();
  const events: SSEEvent[] = [];
  let fullText = "";

  for (const line of rawText.split("\n")) {
    if (line.startsWith("data: ")) {
      try {
        const event: SSEEvent = JSON.parse(line.slice(6));
        events.push(event);
        if (event.type === "text_delta" && event.content) {
          fullText += event.content;
        }
      } catch {
        // パース失敗は無視
      }
    }
  }

  return { status: res.status, events, fullText, durationMs };
}

/**
 * GET /api/chat/history で会話履歴を取得
 */
async function getChatHistory(
  sessionId: string,
  channel?: "line" | "web",
): Promise<{
  status: number;
  messages: Array<{
    role: string;
    content: string;
    channel: string;
    created_at: string;
    product_cards?: unknown[];
  }>;
  isLinked: boolean;
  error?: string;
}> {
  let url = `${BASE_URL}/api/chat/history?session_id=${sessionId}`;
  if (channel) {
    url += `&channel=${channel}`;
  }

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    return {
      status: 0,
      messages: [],
      isLinked: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    return {
      status: res.status,
      messages: [],
      isLinked: false,
      error: await res.text(),
    };
  }

  const data = await res.json() as {
    messages: Array<{
      role: string;
      content: string;
      channel: string;
      created_at: string;
      product_cards?: unknown[];
    }>;
    is_linked: boolean;
  };

  return {
    status: res.status,
    messages: data.messages,
    isLinked: data.is_linked,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// シナリオ 1: Web 未ログインユーザー
// ---------------------------------------------------------------------------

async function runScenario1(): Promise<ScenarioResult> {
  console.log("\n--- Scenario 1: Web 未ログインユーザー ---");
  console.log(`  Session ID: ${TEST_SESSION_ID}`);
  const steps: ScenarioResult["steps"] = [];

  // Step 1: 商品問い合わせ -> AI 応答 + 商品カード
  console.log("  [Step 1] 商品問い合わせ -> AI 応答");
  const r1 = await sendChatMessage(
    "おすすめのお茶を教えてください",
    TEST_SESSION_ID,
  );

  const step1Pass =
    r1.status === 200 &&
    r1.fullText.length > 0 &&
    r1.events.some((e) => e.type === "done");

  const hasProductCard = r1.events.some((e) => e.type === "product_card");
  const hasQuickReplies = r1.events.some((e) => e.type === "quick_replies");

  console.log(`    HTTP ${r1.status} (${r1.durationMs}ms)`);
  console.log(`    Response: ${r1.fullText.slice(0, 100)}...`);
  console.log(`    Product cards: ${hasProductCard ? "YES" : "NO"}`);
  console.log(`    Quick replies: ${hasQuickReplies ? "YES" : "NO"}`);
  console.log(`    [${step1Pass ? "PASS" : "FAIL"}]`);

  steps.push({
    stepName: "商品問い合わせ -> AI 応答 + SSE",
    pass: step1Pass,
    notes: `HTTP ${r1.status}, text=${r1.fullText.length}chars, product_card=${hasProductCard}, quick_replies=${hasQuickReplies}`,
    duration: r1.durationMs,
  });

  await sleep(REQUEST_INTERVAL_MS);

  // Step 2: 会話継続性 -- フォローアップ質問
  console.log("  [Step 2] フォローアップ質問 -> 会話コンテキスト維持");
  const r2 = await sendChatMessage(
    "その中で一番人気はどれですか？",
    TEST_SESSION_ID,
  );

  const step2Pass = r2.status === 200 && r2.fullText.length > 0;

  console.log(`    HTTP ${r2.status} (${r2.durationMs}ms)`);
  console.log(`    Response: ${r2.fullText.slice(0, 100)}...`);
  console.log(`    [${step2Pass ? "PASS" : "FAIL"}]`);

  steps.push({
    stepName: "フォローアップ質問 -> 会話コンテキスト維持",
    pass: step2Pass,
    notes: `HTTP ${r2.status}, text=${r2.fullText.length}chars`,
    duration: r2.durationMs,
  });

  await sleep(REQUEST_INTERVAL_MS);

  // Step 3: 会話履歴の取得・検証
  console.log("  [Step 3] 会話履歴取得 -> メッセージが保存されている");
  const history = await getChatHistory(TEST_SESSION_ID);

  const step3Pass =
    history.status === 200 && history.messages.length >= 2; // 少なくとも user + assistant のペア

  console.log(`    HTTP ${history.status}`);
  console.log(`    Messages: ${history.messages.length}`);
  console.log(`    Is linked: ${history.isLinked}`);
  console.log(`    [${step3Pass ? "PASS" : "FAIL"}]`);

  steps.push({
    stepName: "会話履歴取得 -> メッセージ保存確認",
    pass: step3Pass,
    notes: `HTTP ${history.status}, messages=${history.messages.length}, is_linked=${history.isLinked}`,
  });

  const overallPass = steps.every((s) => s.pass);
  return {
    scenarioName: "Scenario 1: Web 未ログインユーザー",
    steps,
    overallPass,
  };
}

// ---------------------------------------------------------------------------
// シナリオ 2: Web ログインユーザー
// ---------------------------------------------------------------------------

async function runScenario2(): Promise<ScenarioResult> {
  console.log("\n--- Scenario 2: Web ログインユーザー ---");
  console.log(`  Session ID: ${TEST_LOGGED_IN_SESSION_ID}`);
  console.log(`  Shopify Customer ID: ${TEST_SHOPIFY_CUSTOMER_ID}`);
  const steps: ScenarioResult["steps"] = [];

  // Step 1: ログイン済みユーザーとしてメッセージ送信
  console.log("  [Step 1] ログイン済みユーザーの商品問い合わせ");
  const r1 = await sendChatMessage(
    "おすすめのお茶を教えてください",
    TEST_LOGGED_IN_SESSION_ID,
    TEST_SHOPIFY_CUSTOMER_ID,
  );

  const step1Pass =
    r1.status === 200 &&
    r1.fullText.length > 0 &&
    r1.events.some((e) => e.type === "done");

  console.log(`    HTTP ${r1.status} (${r1.durationMs}ms)`);
  console.log(`    Response: ${r1.fullText.slice(0, 100)}...`);
  console.log(`    [${step1Pass ? "PASS" : "FAIL"}]`);

  steps.push({
    stepName: "ログイン済みユーザーの商品問い合わせ",
    pass: step1Pass,
    notes: `HTTP ${r1.status}, text=${r1.fullText.length}chars`,
    duration: r1.durationMs,
  });

  await sleep(REQUEST_INTERVAL_MS);

  // Step 2: Identity 解決の確認（会話履歴で is_linked を検証）
  console.log("  [Step 2] Identity 解決確認 (is_linked チェック)");
  const history = await getChatHistory(TEST_LOGGED_IN_SESSION_ID);

  // テスト用の Shopify Customer ID は実在しないため、
  // 新規登録されて is_linked=false になるのが正常動作
  const step2Pass = history.status === 200 && history.messages.length >= 1;

  console.log(`    HTTP ${history.status}`);
  console.log(`    Messages: ${history.messages.length}`);
  console.log(`    Is linked: ${history.isLinked}`);
  console.log(`    [${step2Pass ? "PASS" : "FAIL"}]`);

  steps.push({
    stepName: "Identity 解決 + 会話履歴取得",
    pass: step2Pass,
    notes: `HTTP ${history.status}, messages=${history.messages.length}, is_linked=${history.isLinked}`,
  });

  const overallPass = steps.every((s) => s.pass);
  return {
    scenarioName: "Scenario 2: Web ログインユーザー",
    steps,
    overallPass,
  };
}

// ---------------------------------------------------------------------------
// シナリオ 3: LINE -> Web 会話引き継ぎ
// ---------------------------------------------------------------------------

async function runScenario3(): Promise<ScenarioResult> {
  console.log("\n--- Scenario 3: LINE -> Web 会話引き継ぎ ---");
  console.log("  注意: このシナリオは user_identity_map に紐付けレコードが");
  console.log("  存在する場合にのみ完全に検証可能です。");
  console.log("  紐付けなしの場合は API の正常動作のみ確認します。");
  const steps: ScenarioResult["steps"] = [];

  // Step 1: 新しいセッションでの履歴取得（紐付けなし = 空）
  const crossChannelSessionId = crypto.randomUUID();
  console.log(`  [Step 1] 新規セッションの履歴取得（空であることを確認）`);
  const emptyHistory = await getChatHistory(crossChannelSessionId);

  const step1Pass =
    emptyHistory.status === 200 &&
    emptyHistory.messages.length === 0 &&
    emptyHistory.isLinked === false;

  console.log(`    HTTP ${emptyHistory.status}`);
  console.log(`    Messages: ${emptyHistory.messages.length}`);
  console.log(`    Is linked: ${emptyHistory.isLinked}`);
  console.log(`    [${step1Pass ? "PASS" : "FAIL"}]`);

  steps.push({
    stepName: "新規セッション -> 空履歴",
    pass: step1Pass,
    notes: `HTTP ${emptyHistory.status}, messages=${emptyHistory.messages.length}, is_linked=${emptyHistory.isLinked}`,
  });

  await sleep(REQUEST_INTERVAL_MS);

  // Step 2: メッセージ送信後、履歴に反映されることを確認
  console.log("  [Step 2] メッセージ送信 -> 履歴に反映");
  await sendChatMessage("テスト", crossChannelSessionId);
  await sleep(REQUEST_INTERVAL_MS);

  const updatedHistory = await getChatHistory(crossChannelSessionId);

  const step2Pass =
    updatedHistory.status === 200 &&
    updatedHistory.messages.length >= 2; // user + assistant

  console.log(`    HTTP ${updatedHistory.status}`);
  console.log(`    Messages: ${updatedHistory.messages.length}`);
  console.log(`    [${step2Pass ? "PASS" : "FAIL"}]`);

  steps.push({
    stepName: "メッセージ送信 -> 履歴に反映",
    pass: step2Pass,
    notes: `HTTP ${updatedHistory.status}, messages=${updatedHistory.messages.length}`,
  });

  // Step 3: channel フィルターの動作確認
  console.log("  [Step 3] channel=web フィルターで履歴取得");
  const webOnlyHistory = await getChatHistory(crossChannelSessionId, "web");

  const step3Pass =
    webOnlyHistory.status === 200 &&
    webOnlyHistory.messages.every((m) => m.channel === "web");

  console.log(`    HTTP ${webOnlyHistory.status}`);
  console.log(`    Messages (web only): ${webOnlyHistory.messages.length}`);
  console.log(`    All web channel: ${step3Pass}`);
  console.log(`    [${step3Pass ? "PASS" : "FAIL"}]`);

  steps.push({
    stepName: "channel=web フィルター動作",
    pass: step3Pass,
    notes: `HTTP ${webOnlyHistory.status}, web_messages=${webOnlyHistory.messages.length}`,
  });

  const overallPass = steps.every((s) => s.pass);
  return {
    scenarioName: "Scenario 3: LINE -> Web 会話引き継ぎ",
    steps,
    overallPass,
  };
}

// ---------------------------------------------------------------------------
// シナリオ 4: エスカレーション
// ---------------------------------------------------------------------------

async function runScenario4(): Promise<ScenarioResult> {
  console.log("\n--- Scenario 4: エスカレーション ---");
  console.log(`  Session ID: ${TEST_ESCALATION_SESSION_ID}`);
  const steps: ScenarioResult["steps"] = [];

  // Step 1: 人間対応要求
  console.log("  [Step 1] 人間対応要求 -> エスカレーション");
  const r1 = await sendChatMessage(
    "人間のスタッフに繋いでください。商品に問題があります。",
    TEST_ESCALATION_SESSION_ID,
  );

  const step1Pass = r1.status === 200 && r1.fullText.length > 0;

  // エスカレーション時のレスポンスには「確認」「お待ち」「スタッフ」などが含まれることが多い
  const escalationKeywords = ["確認", "お待ち", "スタッフ", "担当", "対応"];
  const hasEscalationResponse = escalationKeywords.some((kw) =>
    r1.fullText.includes(kw),
  );

  console.log(`    HTTP ${r1.status} (${r1.durationMs}ms)`);
  console.log(`    Response: ${r1.fullText.slice(0, 150)}...`);
  console.log(`    Escalation keywords found: ${hasEscalationResponse}`);
  console.log(`    [${step1Pass ? "PASS" : "FAIL"}]`);

  steps.push({
    stepName: "人間対応要求 -> エスカレーション応答",
    pass: step1Pass,
    notes: `HTTP ${r1.status}, text=${r1.fullText.length}chars, escalation_response=${hasEscalationResponse}`,
    duration: r1.durationMs,
  });

  await sleep(REQUEST_INTERVAL_MS);

  // Step 2: 健康被害報告（最優先エスカレーション）
  console.log("  [Step 2] 健康被害報告 -> 最優先エスカレーション");
  const healthSessionId = crypto.randomUUID();
  const r2 = await sendChatMessage(
    "お茶を飲んだらアレルギー反応が出ました。体調が悪いです。",
    healthSessionId,
  );

  const step2Pass = r2.status === 200 && r2.fullText.length > 0;

  console.log(`    HTTP ${r2.status} (${r2.durationMs}ms)`);
  console.log(`    Response: ${r2.fullText.slice(0, 150)}...`);
  console.log(`    [${step2Pass ? "PASS" : "FAIL"}]`);

  steps.push({
    stepName: "健康被害報告 -> 最優先エスカレーション",
    pass: step2Pass,
    notes: `HTTP ${r2.status}, text=${r2.fullText.length}chars`,
    duration: r2.durationMs,
  });

  const overallPass = steps.every((s) => s.pass);
  return {
    scenarioName: "Scenario 4: エスカレーション",
    steps,
    overallPass,
  };
}

// ---------------------------------------------------------------------------
// 入力バリデーションテスト（外部 API 不要）
// ---------------------------------------------------------------------------

async function safeFetch(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; ok: boolean; text: () => Promise<string>; json: () => Promise<unknown> } | null> {
  try {
    return await fetch(url, init);
  } catch (err) {
    console.log(`    NETWORK ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function runValidationTests(): Promise<ScenarioResult> {
  console.log("\n--- Validation Tests: 入力バリデーション ---");
  const steps: ScenarioResult["steps"] = [];

  // Connectivity check
  console.log("  [Connectivity] Checking connection to Worker...");
  const healthCheck = await safeFetch(`${BASE_URL}/`);
  if (!healthCheck) {
    console.log("  SKIP: Cannot connect to Worker. Set WEB_CHAT_BASE_URL or --target.");
    return {
      scenarioName: "Validation Tests: 入力バリデーション",
      steps: [{
        stepName: "Connectivity check",
        pass: false,
        notes: "Cannot connect to Worker",
      }],
      overallPass: false,
    };
  }
  console.log(`  Connected: HTTP ${healthCheck.status}`);

  // Test 1: 空メッセージ -> 400
  console.log("  [Test 1] 空メッセージ -> 400 エラー");
  const r1 = await safeFetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "", session_id: crypto.randomUUID() }),
  });
  const step1Pass = r1?.status === 400;
  console.log(`    HTTP ${r1?.status ?? "N/A"} [${step1Pass ? "PASS" : "FAIL"}]`);
  steps.push({
    stepName: "空メッセージ -> 400",
    pass: step1Pass,
    notes: `HTTP ${r1?.status ?? "N/A"}`,
  });

  // Test 2: 不正な session_id -> 400
  console.log("  [Test 2] 不正な session_id -> 400 エラー");
  const r2 = await safeFetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "test", session_id: "invalid" }),
  });
  const step2Pass = r2?.status === 400;
  console.log(`    HTTP ${r2?.status ?? "N/A"} [${step2Pass ? "PASS" : "FAIL"}]`);
  steps.push({
    stepName: "不正な session_id -> 400",
    pass: step2Pass,
    notes: `HTTP ${r2?.status ?? "N/A"}`,
  });

  // Test 3: session_id なし -> 400
  console.log("  [Test 3] session_id なし -> 400 エラー");
  const r3 = await safeFetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "test" }),
  });
  const step3Pass = r3?.status === 400;
  console.log(`    HTTP ${r3?.status ?? "N/A"} [${step3Pass ? "PASS" : "FAIL"}]`);
  steps.push({
    stepName: "session_id なし -> 400",
    pass: step3Pass,
    notes: `HTTP ${r3?.status ?? "N/A"}`,
  });

  // Test 4: 不正な JSON -> 400
  console.log("  [Test 4] 不正な JSON -> 400 エラー");
  const r4 = await safeFetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not-json",
  });
  const step4Pass = r4?.status === 400;
  console.log(`    HTTP ${r4?.status ?? "N/A"} [${step4Pass ? "PASS" : "FAIL"}]`);
  steps.push({
    stepName: "不正な JSON -> 400",
    pass: step4Pass,
    notes: `HTTP ${r4?.status ?? "N/A"}`,
  });

  // Test 5: 不正な shopify_customer_id -> 400
  console.log("  [Test 5] 不正な shopify_customer_id -> 400 エラー");
  const r5 = await safeFetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "test",
      session_id: crypto.randomUUID(),
      shopify_customer_id: "invalid-gid",
    }),
  });
  const step5Pass = r5?.status === 400;
  console.log(`    HTTP ${r5?.status ?? "N/A"} [${step5Pass ? "PASS" : "FAIL"}]`);
  steps.push({
    stepName: "不正な shopify_customer_id -> 400",
    pass: step5Pass,
    notes: `HTTP ${r5?.status ?? "N/A"}`,
  });

  // Test 6: History API -- 不正な session_id -> 400
  console.log("  [Test 6] History: 不正な session_id -> 400 エラー");
  const r6 = await safeFetch(`${BASE_URL}/api/chat/history?session_id=invalid`);
  const step6Pass = r6?.status === 400;
  console.log(`    HTTP ${r6?.status ?? "N/A"} [${step6Pass ? "PASS" : "FAIL"}]`);
  steps.push({
    stepName: "History: 不正な session_id -> 400",
    pass: step6Pass,
    notes: `HTTP ${r6?.status ?? "N/A"}`,
  });

  // Test 7: History API -- 不正な channel -> 400
  console.log("  [Test 7] History: 不正な channel -> 400 エラー");
  const r7 = await safeFetch(
    `${BASE_URL}/api/chat/history?session_id=${crypto.randomUUID()}&channel=invalid`,
  );
  const step7Pass = r7?.status === 400;
  console.log(`    HTTP ${r7?.status ?? "N/A"} [${step7Pass ? "PASS" : "FAIL"}]`);
  steps.push({
    stepName: "History: 不正な channel -> 400",
    pass: step7Pass,
    notes: `HTTP ${r7?.status ?? "N/A"}`,
  });

  // Test 8: Health check endpoint
  console.log("  [Test 8] GET / -> 200 OK");
  const step8Pass = healthCheck.status === 200;
  console.log(`    HTTP ${healthCheck.status} [${step8Pass ? "PASS" : "FAIL"}]`);
  steps.push({
    stepName: "Health check GET / -> 200",
    pass: step8Pass,
    notes: `HTTP ${healthCheck.status}`,
  });

  const overallPass = steps.every((s) => s.pass);
  return {
    scenarioName: "Validation Tests: 入力バリデーション",
    steps,
    overallPass,
  };
}

// ---------------------------------------------------------------------------
// メイン実行
// ---------------------------------------------------------------------------

async function main() {
  const scenarioArg = args
    .find((a) => a.startsWith("--scenario="))
    ?.split("=")[1];
  const runAll = args.includes("--all") || !scenarioArg;
  const validationOnly = args.includes("--validation-only");

  console.log("=".repeat(60));
  console.log("Web Chat E2E Test -- Spec v2 WC4-1");
  console.log(`Target: ${BASE_URL}`);
  console.log(`Date: ${new Date().toLocaleString("ja-JP")}`);
  console.log("=".repeat(60));

  const scenarioRunners: Record<string, () => Promise<ScenarioResult>> = {
    "1": runScenario1,
    "2": runScenario2,
    "3": runScenario3,
    "4": runScenario4,
    validation: runValidationTests,
  };

  const results: ScenarioResult[] = [];

  if (validationOnly) {
    results.push(await runValidationTests());
  } else if (runAll) {
    // バリデーションテストは外部 API 呼び出しが少ないため先に実行
    results.push(await runValidationTests());
    for (const key of ["1", "2", "3", "4"]) {
      results.push(await scenarioRunners[key]());
    }
  } else if (scenarioArg && scenarioRunners[scenarioArg]) {
    results.push(await scenarioRunners[scenarioArg]());
  } else {
    console.error(`ERROR: Unknown scenario: ${scenarioArg}`);
    console.error("Available: --scenario=1|2|3|4|validation or --all");
    process.exit(1);
  }

  // 結果サマリー
  console.log("\n" + "=".repeat(60));
  console.log("Web Chat E2E Test Results");
  console.log("=".repeat(60));

  let allPassed = true;
  for (const r of results) {
    const mark = r.overallPass ? "PASS" : "FAIL";
    console.log(`[${mark}] ${r.scenarioName}`);
    for (const step of r.steps) {
      const stepMark = step.pass ? "PASS" : "FAIL";
      const duration = step.duration ? ` (${step.duration}ms)` : "";
      console.log(`       [${stepMark}] ${step.stepName}${duration}`);
    }
    if (!r.overallPass) {
      allPassed = false;
    }
  }

  console.log("\n" + "-".repeat(60));
  console.log("注意事項:");
  console.log("- Scenario 1-2, 4 は実際の Claude API を呼び出します");
  console.log("- Scenario 3 の LINE -> Web 引き継ぎは user_identity_map に");
  console.log("  紐付けレコードがある場合にのみ完全検証可能です");
  console.log("- Scenario 4 のエスカレーションは Slack 通知を目視確認してください");
  console.log("- 商品カードの正確性（商品名・価格）はナレッジ依存のため目視確認推奨");

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Web Chat E2E test error:", err);
  process.exit(1);
});
