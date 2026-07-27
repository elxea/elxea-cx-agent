/**
 * Staging Webhook 署名コントラクトテスト — elxea-cx-agent
 *
 * 「デプロイ済み staging Worker が LINE Webhook の署名検証を正しく行うか」だけを検証する。
 * deploy-staging の *後* に走らせ、いま出したビルドの fail-closed を確認するのが目的。
 *
 * ── なぜ「シナリオ E2E」ではなくこれを CI ゲートにするのか ────────────────────
 * tests/e2e/run-e2e.ts（`pnpm test:e2e`）は会話イベントを 15 本 staging に撃ち込む。
 * 署名が通ると staging Worker は実際にイベントを処理し、Anthropic API 呼び出し・
 * Supabase 書き込み・api.line.me への reply/push 呼び出しまで走る（reply token が
 * 偽物なので配信自体は 400 で落ちるが、外向き送信リクエストは発生する）。
 * それを master マージのたびに自動で撃つのは避けたい。加えて run-e2e.ts は
 * HTTP 200 しか判定できず（応答本文は「LINE アプリで目視確認」と自ら書いている）、
 * 自動ゲートとしての判定力がほぼ無い。
 *   → 会話シナリオの検証は hermetic-e2e（tests/hermetic/**・ネットワーク不使用・
 *     応答本文まで自動判定）が担う。run-e2e.ts は人が staging を触るときの手動ツールとして残す。
 *
 * ── 本テストが安全な理由（実送信ゼロの構造的保証）──────────────────────
 * 送るのは常に `events: []`（空配列）。src/routes/line.ts の processEvents は
 * `for (const event of webhookBody.events)` でループするだけなので、空配列では
 * ループ本体が一度も実行されない。よって LINE 送信・LLM 呼び出し・イベント永続化は
 * 構造的にゼロ。署名検証パスだけを通す。
 *
 * 使用方法:
 *   STAGING_WORKER_URL=https://elxea-agent-staging.setaka-on.workers.dev \
 *   LINE_CHANNEL_SECRET=<staging(テストOA)のチャネルシークレット> \
 *   npx tsx tests/staging/webhook-contract.test.ts
 */

import * as crypto from "node:crypto";
import { assertNoProdMarker } from "../lib/assert-not-prod";

const STAGING_URL = process.env.STAGING_WORKER_URL ?? "";
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET ?? "";

/** 本テストが送る唯一のペイロード。events は必ず空配列（イベント処理を起こさない）。 */
const BODY = JSON.stringify({ destination: "Ctest", events: [] });

function sign(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("base64");
}

async function postWebhook(
  signature: string | null,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature !== null) headers["x-line-signature"] = signature;

  const res = await fetch(`${STAGING_URL}/webhook/line`, {
    method: "POST",
    headers,
    body: BODY,
  });
  return { status: res.status, text: await res.text() };
}

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(
      `FAIL: ${name} -- ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

/**
 * 正しい署名は受理される。
 * これが 403 になる場合、CI の LINE_CHANNEL_SECRET と staging Worker の
 * LINE_CHANNEL_SECRET が食い違っている（＝シークレットのローテーション漏れ）。
 */
async function testValidSignatureAccepted(): Promise<void> {
  const { status, text } = await postWebhook(sign(BODY, CHANNEL_SECRET));
  if (status !== 200) {
    throw new Error(
      `正しい署名が拒否された: HTTP ${status} ${text}. ` +
        `CI の LINE_CHANNEL_SECRET が staging Worker の LINE_CHANNEL_SECRET と一致していない可能性が高い。`,
    );
  }
}

/** 誤った署名は 403 で拒否される（fail-closed の本体）。 */
async function testInvalidSignatureRejected(): Promise<void> {
  const forged = sign(BODY, `${CHANNEL_SECRET}-forged`);
  const { status } = await postWebhook(forged);
  if (status !== 403) {
    throw new Error(
      `誤った署名が 403 で拒否されなかった: HTTP ${status}. Webhook が偽装リクエストを受理している。`,
    );
  }
}

/** 署名ヘッダ欠落も 403 で拒否される（未署名リクエストの素通り防止）。 */
async function testMissingSignatureRejected(): Promise<void> {
  const { status } = await postWebhook(null);
  if (status !== 403) {
    throw new Error(
      `署名ヘッダ無しが 403 で拒否されなかった: HTTP ${status}. 未署名リクエストが素通りしている。`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("=".repeat(60));
  console.log("elxea-cx-agent Staging Webhook 署名コントラクトテスト");
  console.log(`Target: ${STAGING_URL}`);
  console.log(`Date:   ${new Date().toISOString()}`);
  console.log("=".repeat(60));
  console.log("");

  // 前提チェックは fail-closed（未設定を「スキップして緑」にしない）。
  if (!STAGING_URL) {
    console.error("FAIL: STAGING_WORKER_URL が未設定。");
    process.exit(1);
  }
  if (!CHANNEL_SECRET) {
    console.error(
      "FAIL: LINE_CHANNEL_SECRET が未設定。テスト OA のチャネルシークレットを渡すこと。",
    );
    process.exit(1);
  }
  // 本番 Worker へは絶対に向けない（URL 誤爆の最終防波堤）。
  assertNoProdMarker(STAGING_URL, "STAGING_WORKER_URL");

  await runTest("正しい署名の webhook は 200 で受理される", testValidSignatureAccepted);
  await runTest("誤った署名の webhook は 403 で拒否される", testInvalidSignatureRejected);
  await runTest("署名ヘッダ無しの webhook は 403 で拒否される", testMissingSignatureRejected);

  console.log("");
  console.log("=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) process.exit(1);
})();
