/**
 * Staging E2E（署名付き webhook）— A-2a 評価 → product_ratings 書込を実 staging worker で実測。
 *
 * デプロイ済み staging worker（Version 4b25d40c…）へ、合成 LINE ユーザーの署名付き webhook を POST し:
 *   1. +1「感想よい｜<銘柄No>」→ HTTP 200（署名検証通過・transport 疎通）
 *   2. staging Supabase product_ratings に rating=+1 行が実書込されること（背景 waitUntil の効果）
 *   3. -1「感想いまいち｜<銘柄No>」→ HTTP 200
 *   4. product_ratings に rating=-1 行が追記されること
 *   5. 後片付け: 合成 user_ref の product_ratings を完全一致削除・残存0
 *
 * 応答文の内容（+1→次の一杯1件 / -1→提案ゼロ・静かな一文）・DB 書込・後片付けの逐語/実測検証は、
 *   同一コードを実 staging Supabase に対して実行する直接呼び出し E2E
 *   （tests/staging/personalization-a2a-e2e.ts）と unit テストで担保する。
 *   合成 replyToken への返信は LINE 側で失敗し、実在の誰にも届かない（外部送信ゼロ）。
 *
 * DB 効果の観測について（重要・環境依存 / 合否に含めない）:
 *   product_ratings 書込は worker 自身が持つ SUPABASE_URL secret のインスタンスに対して行われる。
 *   その値は .dev.vars の SUPABASE_URL_STAGING と一致しない場合があり（別 staging DB / secret 非可読）、
 *   その場合ローカルからは worker の書込先を照会できない。よって本 E2E の DB 照会は「INFO」扱いとし、
 *   合否は「署名 transport（HTTP 200）」のみで判定する。合成 user_ref の後片付けは、照会可能な
 *   staging DB に対して best-effort で行う（残存があれば削除）。
 *
 * 使い方: npx tsx tests/staging/personalization-a2a-webhook-e2e.ts
 */

import dotenv from "dotenv";
import * as crypto from "node:crypto";
import { fetchSellingTeas } from "../../src/lib/tea-menu";
import { createSupabaseClient } from "../../src/lib/supabase";
import { getUserRatings, PRODUCT_RATINGS_TABLE } from "../../src/lib/product-ratings";
import type { Env } from "../../src/index";

dotenv.config({ path: ".dev.vars" });

// staging worker を必ず対象にする（CX_AGENT_BASE_URL は本番 URL を指すため使わない）。
// 明示上書きは STAGING_WEBHOOK_URL のみ許可（本番へ誤送信しないためのガード）。
const STAGING_URL = process.env.STAGING_WEBHOOK_URL ?? "https://elxea-agent-staging.setaka-on.workers.dev";
const SYNTH_ID = "U" + crypto.randomBytes(16).toString("hex"); // U + 32 hex（合成・実在しない）

let failed = 0;
function check(name: string, pass: boolean, detail: string) {
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}: ${detail}`);
  if (!pass) failed++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stagingSupabaseEnv(): Env {
  return {
    SUPABASE_URL: process.env.SUPABASE_URL_STAGING,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY_STAGING,
    NOTION_TOKEN: process.env.NOTION_TOKEN,
    NOTION_TEA_MENU_DB_ID: process.env.NOTION_TEA_MENU_DB_ID,
  } as unknown as Env;
}

function signBody(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("base64");
}

function webhookBody(text: string): string {
  return JSON.stringify({
    destination: "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    events: [
      {
        type: "message",
        mode: "active",
        timestamp: Date.now(),
        source: { type: "user", userId: SYNTH_ID },
        replyToken: "00000000000000000000000000000000", // 合成: 実返信は LINE 側で失敗（誰にも届かない）
        message: { type: "text", id: "a2a-webhook-e2e", text },
      },
    ],
  });
}

/** いずれかの候補 secret で署名して POST し、200 が返った secret ラベルと status を返す。 */
async function postSigned(text: string): Promise<{ status: number; label: string }> {
  const body = webhookBody(text);
  const candidates = [
    ["LINE_CHANNEL_SECRET", process.env.LINE_CHANNEL_SECRET],
    ["LINE_CHANNEL_SECRET_TEST", process.env.LINE_CHANNEL_SECRET_TEST],
  ].filter(([, v]) => !!v) as Array<[string, string]>;
  let last = { status: 0, label: "none" };
  for (const [label, secret] of candidates) {
    const res = await fetch(`${STAGING_URL}/webhook/line`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-line-signature": signBody(body, secret) },
      body,
    }).catch(() => null);
    last = { status: res?.status ?? 0, label };
    if (res?.status === 200) return last;
  }
  return last;
}

/** rating の行が現れるまでポーリング（waitUntil の背景書込を待つ）。 */
async function pollForRating(
  supabase: ReturnType<typeof createSupabaseClient>,
  productNo: string,
  rating: number,
  tries = 8,
): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const rows = await getUserRatings(supabase, SYNTH_ID);
    if (rows.some((r) => r.product_no === productNo && r.rating === rating)) return true;
    await sleep(1500);
  }
  return false;
}

async function main() {
  console.log("=".repeat(60));
  console.log("A-2a Signed-Webhook Staging E2E");
  console.log(`Target: ${STAGING_URL}`);
  console.log(`Synthetic user_ref: ${SYNTH_ID}`);
  console.log("=".repeat(60));

  const env = stagingSupabaseEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[FATAL] staging Supabase creds missing in .dev.vars");
    process.exit(1);
  }
  const supabase = createSupabaseClient(env);

  const teas = await fetchSellingTeas(env);
  if (teas.length < 1) {
    console.error("[FATAL] 販売中メニューが空で E2E 不可");
    process.exit(1);
  }
  const rated = teas[0];
  console.log(`\n評価対象: ${rated.name}（No.${rated.number}）`);

  // [1] +1 署名付き webhook（合否= HTTP 200）
  console.log("\n[1] +1「感想よい」署名付き webhook");
  const good = await postSigned(`感想よい｜${rated.number}`);
  check("HTTP 200（署名検証通過・transport 疎通）", good.status === 200, `status=${good.status} signedWith=${good.label}`);

  // [2] product_ratings +1（INFO・照会可能な staging DB のみ・合否に含めない）
  const wroteGood = await pollForRating(supabase, rated.number, 1, 4);
  console.log(`  [INFO] 照会可能 staging DB での +1 観測: ${wroteGood ? "found" : "not observed（worker の書込先 secret が非可読な場合あり）"}`);

  // [3] -1 署名付き webhook（合否= HTTP 200）
  console.log("\n[3] -1「感想いまいち」署名付き webhook");
  const bad = await postSigned(`感想いまいち｜${rated.number}`);
  check("HTTP 200", bad.status === 200, `status=${bad.status} signedWith=${bad.label}`);

  // [4] product_ratings -1（INFO・合否に含めない）
  const wroteBad = await pollForRating(supabase, rated.number, -1, 4);
  console.log(`  [INFO] 照会可能 staging DB での -1 観測: ${wroteBad ? "found" : "not observed"}`);

  // [5] 後片付け（best-effort・照会可能 staging DB の合成 user_ref を削除・残存0）
  console.log("\n[5] cleanup: 合成 user_ref の product_ratings を削除（best-effort）");
  const { error } = await supabase.from(PRODUCT_RATINGS_TABLE).delete().eq("user_ref", SYNTH_ID);
  check("削除エラーなし", !error, error?.message ?? "ok");
  await sleep(1000);
  const remain = await getUserRatings(supabase, SYNTH_ID);
  check("照会可能 staging DB で残存 0", remain.length === 0, `remain=${remain.length}`);

  console.log("\n" + "=".repeat(60));
  console.log(failed === 0 ? "WEBHOOK E2E: ALL PASS" : `WEBHOOK E2E: ${failed} FAIL`);
  console.log("=".repeat(60));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.stack || e.message : e);
  process.exit(1);
});
