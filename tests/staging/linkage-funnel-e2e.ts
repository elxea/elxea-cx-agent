/**
 * Staging E2E -- 連携導線の作り直し（トーク内入り口の便益+ボタン / source / link.* ファネル）。
 *
 * 観測方法（webhook の応答本文は LINE への reply/push で HTTP レスポンスに出ないため、副作用で観測する）:
 *   - 便益+ボタンを「出した」事実 = flow_events(link.invite_shown, metadata.surface) の行（送信前に記録される）。
 *   - 連携完了 = flow_events(link.completed) + customer_linkages 行。
 *   すべて staging の Supabase を service role で読む（実 LINE 送信はしない・合成 ID/replyToken のみ）。
 *
 * ケース:
 *   A. 未連携 ID + 完全一致トリガー(message)         → link.invite_shown surface=trigger
 *   B. 未連携 ID + ④定期便トリガー(message)          → link.invite_shown surface=menu4
 *   C. /api/identity/link-liff（合成・X-API-Key）    → customer_linkages 行 + link.completed（source は 026 適用後に 'liff'）
 *   D. 連携済み ID + 完全一致トリガー(message)        → link.invite_shown が出ない（ボタン非表示）
 *
 * 使い方: npx tsx tests/staging/linkage-funnel-e2e.ts
 * 後片付け: 実行末尾で合成データ（flow_events / customer_linkages）を完全一致で削除する。
 */

import dotenv from "dotenv";
import * as crypto from "node:crypto";
import {
  LINKAGE_TRIGGER,
} from "../../src/lib/subscriber-linkage";
import { SUBSCRIPTION_TRIGGER } from "../../src/lib/menu-actions";
import {
  assertAllowedTestTarget,
  installTestFetchGuard,
  resolveStagingBaseUrl,
} from "../lib/assert-not-prod";

dotenv.config({ path: ".dev.vars" });

// 宛先ガードを最初に敷く（あらゆる fetch より前）。
installTestFetchGuard("linkage-funnel-e2e");

// staging を明示（.dev.vars の CX_AGENT_BASE_URL は prod を指すため使わない）。
// 共有ガードのホワイトリスト（staging Worker / localhost のみ）を通した値だけを宛先にする。
const STAGING_URL = resolveStagingBaseUrl(undefined, "linkage-funnel-e2e STAGING_BASE_URL");

const SUPA_URL = process.env.SUPABASE_URL_STAGING!;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY_STAGING!;
const SYNC_SECRET = process.env.SYNC_API_SECRET!;
if (!SUPA_URL || !SUPA_KEY) {
  console.error("[FATAL] staging Supabase 認証情報が .dev.vars に無い。中断。");
  process.exit(1);
}
// prod Supabase 取り違え二重ガード。
if (process.env.SUPABASE_URL && SUPA_URL === process.env.SUPABASE_URL) {
  console.error("[FATAL] SUPABASE_URL_STAGING が prod と一致。中断。");
  process.exit(1);
}

// 合成 ID（U + 32hex ちょうど・b10c4f=block4-funnel マーカー・非実在）。
function synthId(tag: string): string {
  const base = "b10c4f";
  const id = "U" + base + "0".repeat(32 - base.length - tag.length) + tag;
  if (!/^U[0-9a-f]{32}$/.test(id)) {
    console.error(`[FATAL] 合成 ID 形式不正: ${id}`);
    process.exit(1);
  }
  return id;
}
const ID_TRIGGER = synthId("a1");
const ID_MENU4 = synthId("a2");
const ID_LIFF = synthId("a3");
const ID_LINKED = synthId("a4");
const SHOPIFY_LIFF = "900800400777";
const SHOPIFY_LINKED = "900800400778";
const ALL_IDS = [ID_TRIGGER, ID_MENU4, ID_LIFF, ID_LINKED];

let failed = 0;
function check(name: string, pass: boolean, detail = "") {
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}${detail ? ": " + detail : ""}`);
  if (!pass) failed++;
}

function sb(path: string, init?: RequestInit) {
  return fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

function signLineBody(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("base64");
}

async function postWebhook(userId: string, text: string): Promise<number> {
  const body = JSON.stringify({
    destination: "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    events: [{
      type: "message",
      mode: "active",
      timestamp: Date.now(),
      source: { type: "user", userId },
      replyToken: "00000000000000000000000000000000", // 合成: 実返信は LINE 側で失敗（誰にも届かない）
      message: { type: "text", id: `e2e-${Date.now()}`, text },
      webhookEventId: `wh-${crypto.randomUUID()}`,
      deliveryContext: { isRedelivery: false },
    }],
  });
  const secrets = [
    process.env.LINE_CHANNEL_SECRET_TEST,
    process.env.LINE_CHANNEL_SECRET,
  ].filter(Boolean) as string[];
  let last = 0;
  for (const secret of secrets) {
    const target = assertAllowedTestTarget(
      `${STAGING_URL}/webhook/line`,
      "linkage-funnel-e2e webhook POST",
    );
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-line-signature": signLineBody(body, secret) },
      body,
    }).catch(() => null);
    last = res?.status ?? 0;
    if (res?.status === 200) return 200;
  }
  return last;
}

/** flow_events を user_ref + event_name で数える（background 書き込みを待つためポーリング）。 */
async function countFlowEvents(userRef: string, eventName: string, surface?: string): Promise<number> {
  for (let i = 0; i < 10; i++) {
    const res = await sb(`flow_events?user_ref=eq.${userRef}&event_name=eq.${eventName}&select=event_name,metadata`);
    if (res.ok) {
      const rows = (await res.json()) as Array<{ metadata?: { surface?: string } }>;
      const filtered = surface ? rows.filter((r) => r.metadata?.surface === surface) : rows;
      if (filtered.length > 0) return filtered.length;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return 0;
}

async function upsertLinkage(lineUserId: string, shopifyId: string) {
  await sb(`customer_linkages?on_conflict=line_user_id`, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      line_user_id: lineUserId,
      shopify_customer_id: shopifyId,
      linked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
}

async function cleanup() {
  for (const id of ALL_IDS) {
    await sb(`flow_events?user_ref=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    await sb(`customer_linkages?line_user_id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
}

async function main() {
  console.log("=".repeat(64));
  console.log("Linkage Funnel Staging E2E");
  console.log(`Target: ${STAGING_URL}`);
  console.log("=".repeat(64));

  // 事前: 合成データを綺麗にする（前回の残骸があれば）。
  await cleanup();

  // health
  const h = await fetch(
    assertAllowedTestTarget(`${STAGING_URL}/`, "linkage-funnel-e2e health"),
  ).catch(() => null);
  check("staging worker health 200", h?.status === 200, `HTTP ${h?.status}`);

  // A. 未連携 + トリガー → invite_shown surface=trigger
  console.log("\n[A] 未連携 ID + 完全一致トリガー → 便益+ボタン（surface=trigger）");
  const sA = await postWebhook(ID_TRIGGER, LINKAGE_TRIGGER);
  check("webhook 200 (transport)", sA === 200, `HTTP ${sA}`);
  const cA = await countFlowEvents(ID_TRIGGER, "link.invite_shown", "trigger");
  check("link.invite_shown surface=trigger が記録される", cA >= 1, `count=${cA}`);

  // B. 未連携 + ④定期便 → invite_shown surface=menu4
  console.log("\n[B] 未連携 ID + ④定期便トリガー → generic紹介 + 便益+ボタン（surface=menu4）");
  const sB = await postWebhook(ID_MENU4, SUBSCRIPTION_TRIGGER);
  check("webhook 200 (transport)", sB === 200, `HTTP ${sB}`);
  const cB = await countFlowEvents(ID_MENU4, "link.invite_shown", "menu4");
  check("link.invite_shown surface=menu4 が記録される", cB >= 1, `count=${cB}`);

  // C. link-liff → customer_linkages 行 + link.completed
  console.log("\n[C] /api/identity/link-liff（合成・X-API-Key）→ 連携行 + link.completed");
  const liffBody = JSON.stringify({
    line_messaging_user_id: ID_LIFF,
    shopify_customer_id: SHOPIFY_LIFF,
    shopify_email: "block4-funnel+staging@example.com",
  });
  const liffRes = await fetch(
    assertAllowedTestTarget(`${STAGING_URL}/api/identity/link-liff`, "linkage-funnel-e2e link-liff"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": SYNC_SECRET },
      body: liffBody,
    },
  ).catch(() => null);
  check("link-liff 200", liffRes?.status === 200, `HTTP ${liffRes?.status}`);
  // 連携行 + source 列（migration 026 適用後は select=source が 200・値は 'liff'）。
  let linkRow: { shopify_customer_id?: string; source?: string | null } | null = null;
  for (let i = 0; i < 8; i++) {
    const r = await sb(`customer_linkages?line_user_id=eq.${ID_LIFF}&select=shopify_customer_id,source`);
    if (r.ok) {
      const rows = (await r.json()) as Array<{ shopify_customer_id?: string; source?: string | null }>;
      if (rows.length > 0) { linkRow = rows[0]; break; }
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  check("customer_linkages 行が作られる", !!linkRow, linkRow ? `shopify=${linkRow.shopify_customer_id}` : "no row");
  // 026 適用済み: select=source が 200 で返り、値が 'liff' であること。
  const srcProbe = await sb(`customer_linkages?line_user_id=eq.${ID_LIFF}&select=source`);
  check("source 列が select 可能（026 適用済み）", srcProbe.status === 200, `HTTP ${srcProbe.status}`);
  check("source='liff' が書かれている", linkRow?.source === "liff", `source=${JSON.stringify(linkRow?.source ?? null)}`);
  const cC = await countFlowEvents(ID_LIFF, "link.completed");
  check("link.completed が記録される", cC >= 1, `count=${cC}`);

  // D. 連携済み ID + トリガー → invite_shown が出ない
  console.log("\n[D] 連携済み ID + 完全一致トリガー → 便益+ボタンは出ない（invite_shown なし）");
  await upsertLinkage(ID_LINKED, SHOPIFY_LINKED);
  const sD = await postWebhook(ID_LINKED, LINKAGE_TRIGGER);
  check("webhook 200 (transport)", sD === 200, `HTTP ${sD}`);
  // 少し待ってから「無いこと」を確認（background 完了を待つ）。
  await new Promise((r) => setTimeout(r, 4000));
  const cD = await countFlowEvents(ID_LINKED, "link.invite_shown");
  check("連携済みには link.invite_shown が出ない", cD === 0, `count=${cD}`);

  // 後片付け
  console.log("\n[cleanup] 合成データ完全一致削除");
  await cleanup();
  // 削除確認
  let residual = 0;
  for (const id of ALL_IDS) {
    const fe = await sb(`flow_events?user_ref=eq.${id}&select=event_name`);
    const cl = await sb(`customer_linkages?line_user_id=eq.${id}&select=line_user_id`);
    residual += ((await fe.json()) as unknown[]).length + ((await cl.json()) as unknown[]).length;
  }
  check("合成データが完全削除された", residual === 0, `residual rows=${residual}`);

  console.log("\n" + "=".repeat(64));
  console.log(failed === 0 ? "FUNNEL E2E: ALL PASS" : `FUNNEL E2E: ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  try { await cleanup(); } catch { /* noop */ }
  process.exit(1);
});
