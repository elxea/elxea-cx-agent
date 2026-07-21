/**
 * Staging E2E -- ブロック4 連携導線（定期便客限定）+ テスト連携キット。
 *
 * 前提: 先に `npx tsx scripts/test-linkage-kit.ts setup` を実行して合成の連携済み定期便状態を作る。
 *
 * 検証（実 staging の Supabase / Firestore / Worker を叩く）:
 *   E1. 直接解決 E2E: resolveLinkedSubscriber を **staging の実 Supabase+Firestore** に対して実行し、
 *       合成 ID が linked=true / isSubscriber=true と解決され、連携済み（定期便客）応答が返ること。
 *       → 「連携導線 → 定期便判定 → 連携完了 → 連携済みとしての応答」を実データで実測。
 *   E2. 未連携 ID は linked=false → 連携案内、が返ること（分岐の実データ確認）。
 *   E3. 署名付き webhook E2E: 合成 ID が LINKAGE_TRIGGER を送る LINE webhook を **署名して** staging
 *       worker に POST し、HTTP 200 を得る（transport 経路の疎通）。合成 replyToken への返信は
 *       LINE 側で失敗し、実在の誰にも届かない（外部送信ゼロ）。
 *
 * 使い方: npx tsx tests/staging/block4-linkage-e2e.ts
 */

import dotenv from "dotenv";
import * as crypto from "node:crypto";
import { KIT } from "../../scripts/test-linkage-kit";
import {
  resolveLinkedSubscriber,
  selectLinkageMessage,
  buildSubscriberLinkedMessage,
  buildLinkageInviteMessage,
  LINKAGE_TRIGGER,
} from "../../src/lib/subscriber-linkage";
import type { Env } from "../../src/index";
import {
  assertAllowedTestTarget,
  assertNotProdEnv,
  installTestFetchGuard,
  resolveStagingBaseUrl,
} from "../lib/assert-not-prod";

dotenv.config({ path: ".dev.vars" });

// 宛先ガードを最初に敷く（.dev.vars 読み込み後・あらゆる fetch より前）。
installTestFetchGuard("block4-linkage-e2e");

// 宛先は staging 専用 env (STAGING_BASE_URL) からのみ解決する。
// `.dev.vars` の CX_AGENT_BASE_URL は **本番 Worker** を指すため参照しない（本番 POST の根因）。
const STAGING_URL = resolveStagingBaseUrl(undefined, "block4-linkage-e2e STAGING_BASE_URL");
const UNLINKED_ID = "Ub10c4feedface0000000000000000000"; // 連携行を作っていない合成 ID

let failed = 0;
function check(name: string, pass: boolean, detail: string) {
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}: ${detail}`);
  if (!pass) failed++;
}

function stagingEnv(lineIdOverride?: string): Env {
  const env = {
    SUPABASE_URL: process.env.SUPABASE_URL_STAGING,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY_STAGING,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID_STAGING,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL_STAGING,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY_STAGING,
    DELIVERY_TARGET_ENV: "test",
    TEST_SUBSCRIBER_LINE_IDS: lineIdOverride ?? KIT.lineUserId,
  };
  // 本番 ref / 本番 OA / 実送信フラグの混入を fail-closed で拒否する。
  assertNotProdEnv(env as unknown as Record<string, unknown>);
  return env as unknown as Env;
}

function signLineBody(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("base64");
}

async function main() {
  console.log("=".repeat(60));
  console.log("Block4 Linkage Staging E2E");
  console.log(`Target: ${STAGING_URL}`);
  console.log("=".repeat(60));

  // E1: 直接解決（連携済み定期便）
  console.log("\n[E1] 直接解決: 合成連携済み定期便 ID");
  const r1 = await resolveLinkedSubscriber(KIT.lineUserId, stagingEnv());
  check("linked=true", r1.linked === true, `linked=${r1.linked}`);
  check("isSubscriber=true", r1.isSubscriber === true, `isSubscriber=${r1.isSubscriber} source=${r1.source}`);
  check("shopifyCustomerId 一致", r1.shopifyCustomerId === KIT.shopifyCustomerId, `${r1.shopifyCustomerId}`);
  const msg1 = selectLinkageMessage(r1);
  check("連携済み(定期便客)応答が返る", msg1 === buildSubscriberLinkedMessage(), `msg length=${msg1.length}`);

  // E2: 未連携 → 案内
  console.log("\n[E2] 直接解決: 未連携 ID");
  const r2 = await resolveLinkedSubscriber(UNLINKED_ID, stagingEnv(UNLINKED_ID));
  check("linked=false", r2.linked === false, `linked=${r2.linked}`);
  const msg2 = selectLinkageMessage(r2);
  check("連携案内が返る", msg2 === buildLinkageInviteMessage(), `msg length=${msg2.length}`);

  // E3: 署名付き webhook（transport 疎通）
  console.log("\n[E3] 署名付き LINE webhook を staging worker へ POST");
  const webhookBody = JSON.stringify({
    destination: "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    events: [{
      type: "message",
      mode: "active",
      timestamp: Date.now(),
      source: { type: "user", userId: KIT.lineUserId },
      replyToken: "00000000000000000000000000000000", // 合成: 実返信は LINE 側で失敗（誰にも届かない）
      message: { type: "text", id: "e2e-block4", text: LINKAGE_TRIGGER },
    }],
  });
  const secretCandidates = [
    ["LINE_CHANNEL_SECRET", process.env.LINE_CHANNEL_SECRET],
    ["LINE_CHANNEL_SECRET_TEST", process.env.LINE_CHANNEL_SECRET_TEST],
  ].filter(([, v]) => !!v) as Array<[string, string]>;

  let got200 = false;
  let lastStatus = 0;
  for (const [label, secret] of secretCandidates) {
    const sig = signLineBody(webhookBody, secret);
    const target = assertAllowedTestTarget(
      `${STAGING_URL}/webhook/line`,
      "block4-linkage-e2e webhook POST",
    );
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-line-signature": sig },
      body: webhookBody,
    }).catch(() => null);
    lastStatus = res?.status ?? 0;
    console.log(`    sign with ${label} → HTTP ${lastStatus}`);
    if (res?.status === 200) { got200 = true; break; }
  }
  // transport 疎通は「いずれかの secret で 200」で PASS。合成 replyToken への返信失敗は想定内。
  check("署名付き webhook が 200（transport 疎通）", got200, `last status=${lastStatus}`);

  console.log("\n" + "=".repeat(60));
  console.log(failed === 0 ? "E2E: ALL PASS" : `E2E: ${failed} FAIL`);
  console.log("後片付け: E1-E3 は追加の永続データを作らない（LINKAGE_TRIGGER は会話保存前に return）。");
  console.log("テスト連携キット本体（合成連携行/カルテ）は **残す**（最終ゲートで Setaka が確認）。");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error("[FATAL]", e instanceof Error ? e.message : e); process.exit(1); });
