/**
 * E2E テスト実行スクリプト — elxea-agent
 *
 * staging Worker のエンドポイントに対して LINE Webhook を模擬送信し、
 * エージェントの応答ロジックを検証する。
 *
 * 使用方法:
 *   npx tsx tests/e2e/run-e2e.ts [--scenario=1] [--all]
 *
 * 前提条件:
 *   - .dev.vars または環境変数に LINE_CHANNEL_SECRET 等が設定済み
 *   - Supabase が起動しており、ナレッジが同期済みであること
 */

import * as crypto from "node:crypto";
import * as dotenv from "dotenv";
import {
  assertAllowedTestTarget,
  installTestFetchGuard,
  resolveStagingBaseUrl,
} from "../lib/assert-not-prod";

dotenv.config({ path: ".dev.vars" });

// 宛先ガードを最初に敷く（あらゆる fetch より前）。
installTestFetchGuard("e2e run-e2e");

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

// 宛先は staging 専用 env（STAGING_BASE_URL / CI 互換の STAGING_WORKER_URL）からのみ解決し、
// 共有ガードのホワイトリスト（staging Worker と localhost のみ）を必ず通す。
// `.dev.vars` の CX_AGENT_BASE_URL は本番 Worker を指すため参照しない。
const STAGING_WORKER_URL = resolveStagingBaseUrl(undefined, "run-e2e STAGING_BASE_URL");

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? "";

/** テスト用のダミー LINE ユーザー ID */
const TEST_LINE_USER_ID = process.env.TEST_LINE_USER_ID ?? "Utest_e2e_user_001";

// ---------------------------------------------------------------------------
// Webhook 署名生成（本番と同じロジック）
// ---------------------------------------------------------------------------

function computeLineSignature(body: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64");
}

// ---------------------------------------------------------------------------
// Webhook ペイロード生成
// ---------------------------------------------------------------------------

type WebhookMessage = {
  type: "message";
  message: { type: "text"; id: string; text: string };
  source: { type: "user"; userId: string };
  replyToken: string;
  webhookEventId: string;
  deliveryContext: { isRedelivery: boolean };
  timestamp: number;
};

type FollowEvent = {
  type: "follow";
  source: { type: "user"; userId: string };
  replyToken: string;
  webhookEventId: string;
  deliveryContext: { isRedelivery: boolean };
  timestamp: number;
};

let eventCounter = 0;

function buildMessageEvent(
  text: string,
  userId = TEST_LINE_USER_ID,
): WebhookMessage {
  eventCounter++;
  return {
    type: "message",
    message: {
      type: "text",
      id: `msg_${Date.now()}_${eventCounter}`,
      text,
    },
    source: { type: "user", userId },
    replyToken: `reply_${Date.now()}_${eventCounter}`,
    webhookEventId: `evt_${Date.now()}_${eventCounter}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now(),
  };
}

function buildFollowEvent(userId = TEST_LINE_USER_ID): FollowEvent {
  eventCounter++;
  return {
    type: "follow",
    source: { type: "user", userId },
    replyToken: `reply_${Date.now()}_${eventCounter}`,
    webhookEventId: `evt_${Date.now()}_${eventCounter}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Webhook 送信
// ---------------------------------------------------------------------------

async function sendWebhook(
  events: (WebhookMessage | FollowEvent)[],
  targetUrl = STAGING_WORKER_URL,
): Promise<{ status: number; body: unknown }> {
  const payload = {
    destination: "Ctest",
    events,
  };
  const bodyStr = JSON.stringify(payload);
  const signature = computeLineSignature(bodyStr, LINE_CHANNEL_SECRET);

  // 送信直前に宛先を再検査する（targetUrl は引数で上書きできるため、ここが最終の砦）。
  const endpoint = assertAllowedTestTarget(`${targetUrl}/webhook/line`, "run-e2e sendWebhook");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-line-signature": signature,
    },
    body: bodyStr,
  });

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }

  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// テストシナリオ定義
// ---------------------------------------------------------------------------

type ScenarioResult = {
  scenarioName: string;
  steps: Array<{
    input: string;
    status: number;
    pass: boolean;
    notes: string;
  }>;
  overallPass: boolean;
};

/**
 * シナリオ 1: 商品相談 → 提案 → カートリンク
 * Webhook を送信し、200 OK が返ることを確認する。
 * 実際の応答内容は LINE に送信されるため、staging 上の LINE アプリで目視確認が必要。
 */
async function runScenario1(): Promise<ScenarioResult> {
  console.log("\n--- シナリオ 1: 商品相談 → 提案 → カートリンク ---");
  const steps = [];

  const inputs = [
    "おすすめのお茶を教えてください",
    "この商品のURLを教えてください",
    "他のおすすめも見たい",
  ];

  for (const input of inputs) {
    const result = await sendWebhook([buildMessageEvent(input)]);
    const pass = result.status === 200;
    console.log(`  [${pass ? "PASS" : "FAIL"}] "${input}" → HTTP ${result.status}`);
    steps.push({ input, status: result.status, pass, notes: JSON.stringify(result.body) });
    // LINE は非同期処理のため少し待機
    await new Promise((r) => setTimeout(r, 2000));
  }

  const overallPass = steps.every((s) => s.pass);
  return { scenarioName: "シナリオ 1: 商品相談 → 提案 → カートリンク", steps, overallPass };
}

/**
 * シナリオ 2: FAQ 質問 → 回答
 */
async function runScenario2(): Promise<ScenarioResult> {
  console.log("\n--- シナリオ 2: FAQ 質問 → 回答 ---");
  const steps = [];

  const inputs = [
    "送料はいくらですか？",
    "返品できますか？",
    "支払い方法は何が使えますか？",
    "在庫はありますか？",
  ];

  for (const input of inputs) {
    const result = await sendWebhook([buildMessageEvent(input)]);
    const pass = result.status === 200;
    console.log(`  [${pass ? "PASS" : "FAIL"}] "${input}" → HTTP ${result.status}`);
    steps.push({ input, status: result.status, pass, notes: JSON.stringify(result.body) });
    await new Promise((r) => setTimeout(r, 2000));
  }

  const overallPass = steps.every((s) => s.pass);
  return { scenarioName: "シナリオ 2: FAQ 質問 → 回答", steps, overallPass };
}

/**
 * シナリオ 3: 注文状況確認（紐付けなしパターン）
 */
async function runScenario3(): Promise<ScenarioResult> {
  console.log("\n--- シナリオ 3: 注文状況確認 ---");
  const steps = [];

  // 紐付けなしユーザーでのテスト
  const unrelinkedUserId = "Utest_unlinked_user_001";
  const inputs = [
    { text: "注文状況を教えてください", userId: unrelinkedUserId },
    { text: "#9999 の詳細を確認したい", userId: unrelinkedUserId },
  ];

  for (const input of inputs) {
    const result = await sendWebhook(
      [buildMessageEvent(input.text, input.userId)],
    );
    const pass = result.status === 200;
    console.log(`  [${pass ? "PASS" : "FAIL"}] "${input.text}" (user: ${input.userId.slice(0, 15)}...) → HTTP ${result.status}`);
    steps.push({ input: input.text, status: result.status, pass, notes: JSON.stringify(result.body) });
    await new Promise((r) => setTimeout(r, 2000));
  }

  const overallPass = steps.every((s) => s.pass);
  return { scenarioName: "シナリオ 3: 注文状況確認", steps, overallPass };
}

/**
 * シナリオ 4: エスカレーション発動
 */
async function runScenario4(): Promise<ScenarioResult> {
  console.log("\n--- シナリオ 4: エスカレーション発動 ---");
  const steps = [];

  const escalationInputs = [
    "商品が届かないのですが",
    "スタッフに繋いでください",
    "アレルギー反応が出ました",
  ];

  for (const input of escalationInputs) {
    const result = await sendWebhook([buildMessageEvent(input)]);
    const pass = result.status === 200;
    console.log(`  [${pass ? "PASS" : "FAIL"}] "${input}" → HTTP ${result.status}`);
    steps.push({ input, status: result.status, pass, notes: JSON.stringify(result.body) });
    await new Promise((r) => setTimeout(r, 3000)); // エスカレーションは Slack 通知があるため少し長く待機
  }

  const overallPass = steps.every((s) => s.pass);
  return { scenarioName: "シナリオ 4: エスカレーション発動", steps, overallPass };
}

/**
 * シナリオ 5: ウェルカムフロー（友だち追加）
 */
async function runScenario5(): Promise<ScenarioResult> {
  console.log("\n--- シナリオ 5: ウェルカムフロー ---");
  const steps = [];

  const followUserId = "Utest_new_user_welcome";
  const result = await sendWebhook([buildFollowEvent(followUserId)]);
  const pass = result.status === 200;
  console.log(`  [${pass ? "PASS" : "FAIL"}] follow event (user: ${followUserId.slice(0, 15)}...) → HTTP ${result.status}`);
  steps.push({
    input: "[follow event]",
    status: result.status,
    pass,
    notes: JSON.stringify(result.body),
  });

  await new Promise((r) => setTimeout(r, 2000));

  const overallPass = steps.every((s) => s.pass);
  return { scenarioName: "シナリオ 5: ウェルカムフロー", steps, overallPass };
}

/**
 * シナリオ 6: ID 紐付けフロー（紐付けなしパターン）
 */
async function runScenario6(): Promise<ScenarioResult> {
  console.log("\n--- シナリオ 6: ID 紐付けフロー ---");
  const steps = [];

  const unrelinkedUserId = "Utest_unlinked_id_flow";
  const result = await sendWebhook([
    buildMessageEvent("注文確認したい", unrelinkedUserId),
  ]);
  const pass = result.status === 200;
  console.log(`  [${pass ? "PASS" : "FAIL"}] 紐付けなしユーザーの注文確認 → HTTP ${result.status}`);
  steps.push({
    input: "注文確認したい",
    status: result.status,
    pass,
    notes: JSON.stringify(result.body),
  });

  await new Promise((r) => setTimeout(r, 2000));

  const overallPass = steps.every((s) => s.pass);
  return { scenarioName: "シナリオ 6: ID 紐付けフロー", steps, overallPass };
}

// ---------------------------------------------------------------------------
// メイン実行
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const scenarioArg = args.find((a) => a.startsWith("--scenario="))?.split("=")[1];
  const runAll = args.includes("--all") || !scenarioArg;

  console.log("=".repeat(60));
  console.log("elxea-agent E2E テスト");
  console.log(`対象: ${STAGING_WORKER_URL}`);
  console.log(`日時: ${new Date().toLocaleString("ja-JP")}`);
  console.log("=".repeat(60));

  if (!LINE_CHANNEL_SECRET) {
    console.error("ERROR: LINE_CHANNEL_SECRET が設定されていません。.dev.vars を確認してください。");
    process.exit(1);
  }

  const scenarioRunners: Record<string, () => Promise<ScenarioResult>> = {
    "1": runScenario1,
    "2": runScenario2,
    "3": runScenario3,
    "4": runScenario4,
    "5": runScenario5,
    "6": runScenario6,
  };

  const results: ScenarioResult[] = [];

  if (runAll) {
    for (const runner of Object.values(scenarioRunners)) {
      results.push(await runner());
    }
  } else if (scenarioArg && scenarioRunners[scenarioArg]) {
    results.push(await scenarioRunners[scenarioArg]());
  } else {
    console.error(`ERROR: 不明なシナリオ番号: ${scenarioArg}`);
    console.error("使用可能: --scenario=1〜6 または --all");
    process.exit(1);
  }

  // 結果サマリー
  console.log("\n" + "=".repeat(60));
  console.log("テスト結果サマリー");
  console.log("=".repeat(60));

  let allPassed = true;
  for (const r of results) {
    const mark = r.overallPass ? "PASS" : "FAIL";
    console.log(`[${mark}] ${r.scenarioName}`);
    if (!r.overallPass) {
      allPassed = false;
      for (const step of r.steps.filter((s) => !s.pass)) {
        console.log(`       FAIL: "${step.input}" → HTTP ${step.status}`);
      }
    }
  }

  console.log("\n注意: Webhook は 200 OK を返すのみです。");
  console.log("実際の応答内容（Flex Message・Quick Reply・エスカレーション）は");
  console.log("staging 環境の LINE アプリで目視確認してください。");
  console.log("確認チェックリストは tests/e2e/scenarios.md を参照。");

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E テスト実行エラー:", err);
  process.exit(1);
});
