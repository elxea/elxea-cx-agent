/**
 * M6 Staging E2E — LINE↔Shopify 連携の「実機 LINE を要さない範囲」を staging で実測する。
 *
 * 対象（設計書 §9）:
 *   R-a  staging worker の Shopify 宛先が **開発ストア**であること（本番ストアでないこと）
 *   R-b  staging worker の Supabase が **staging ref** であること
 *   T-4  [SEC-A] 未連携ユーザーの注文照会は「連携が必要」応答で、他人の注文が漏れないこと
 *   T-3  連携済みユーザーの注文照会で開発ストアの注文（#1001 / #1002）が返ること
 *   T-6  注文番号指定の詳細照会が当該注文の詳細（品目・状況）を返すこと
 *   T-7  カート生成の checkoutUrl が開発ストアのドメインであること
 *   T-1  未連携ユーザーへの連携ボタン（LIFF URI）提示と flow_events.link.invite_shown 記録
 *
 * 対象外（実機 LINE が要る）: AC-2 の LIFF レッグ / AC-3 の `sub == Messaging userId` 実測。
 *
 * 安全:
 *   - 宛先は tests/lib/assert-not-prod のホワイトリスト経由でのみ解決する（本番 worker へ到達不能）。
 *   - Supabase は **必ず *_STAGING**（fail-closed）。prod ref には一切接続しない。
 *   - 使う LINE userId はすべて合成（U+32hex・実在しない）。replyToken も合成なので
 *     LINE 側の返信は必ず失敗し、実在の誰にも 1 通も届かない（実配信ゼロ）。
 *   - Shopify への書き込みは一切しない（注文照会・カート作成は read / 一時カートのみ）。
 *
 * 使い方:
 *   STAGING_BASE_URL=https://elxea-agent-staging.setaka-on.workers.dev \
 *     npx tsx tests/staging/m6-shopify-linkage-e2e.ts
 */

import dotenv from "dotenv";
import * as crypto from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertAllowedTestTarget,
  assertNoProdMarker,
  installTestFetchGuard,
  resolveStagingBaseUrl,
  PROD_SUPABASE_REF,
} from "../lib/assert-not-prod";
import { upsertCustomerLinkage } from "../../src/lib/customer-linkage";

dotenv.config({ path: ".dev.vars" });
installTestFetchGuard("m6-shopify-linkage-e2e");

const STAGING_URL = resolveStagingBaseUrl(undefined, "m6 STAGING_BASE_URL");

/** 開発ストア（テスト用・本番ストアではない）。 */
const DEV_STORE_DOMAIN = "elxea-test-ugen0voh.myshopify.com";
/** 開発ストアのテスト顧客 Shopify customer id（実測済み）。 */
const TEST_SHOPIFY_CUSTOMER_ID = "9432276402259";
/** staging Supabase ref（設計 §5）。 */
const STAGING_SUPABASE_REF = "espeokdhutgztksdrpzt";

/** 合成 Messaging userId（U + 32hex）。m6 由来と分かる hex マーカー付き。 */
const HEX32 = (tail: string) => {
  const head = "e6a11" /* e2e-a11 */ + "0".repeat(32 - 5 - tail.length) + tail;
  if (!/^[0-9a-f]{32}$/.test(head)) throw new Error(`bad synthetic hex: ${head}`);
  return `U${head}`;
};
/** 連携済みにする合成 userId（手順 2 で customer_linkages に投入する）。 */
const LINKED_ID = HEX32("0001");
/** 未連携の合成 userId（T-4 SEC-A 用。連携行を作らない）。 */
const UNLINKED_ID = HEX32("0002");
/** T-1 用の別の未連携合成 userId（invite_shown を汚さないよう分離）。 */
const INVITE_ID = HEX32("0003");

const LINKAGE_TRIGGER = "アカウントを連携する";

let failed = 0;
const results: string[] = [];
function check(name: string, pass: boolean, detail: string) {
  const line = `  [${pass ? "PASS" : "FAIL"}] ${name}: ${detail}`;
  console.log(line);
  results.push(line);
  if (!pass) failed++;
}

// ---------------------------------------------------------------------------
// staging Supabase（fail-closed）
// ---------------------------------------------------------------------------
function stagingSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL_STAGING;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY_STAGING;
  if (!url || !key) {
    throw new Error("SUPABASE_URL_STAGING / SUPABASE_SERVICE_ROLE_KEY_STAGING が .dev.vars に無い（fail-closed）。");
  }
  // 三重ガード: 本番 ref を含む URL には決して接続しない。
  assertNoProdMarker(url, "SUPABASE_URL_STAGING");
  if (!url.includes(STAGING_SUPABASE_REF)) {
    throw new Error(`SUPABASE_URL_STAGING が staging ref (${STAGING_SUPABASE_REF}) を指していない。中断。`);
  }
  return createClient(url, key);
}

// ---------------------------------------------------------------------------
// LINE webhook 送信（署名付き）
// ---------------------------------------------------------------------------
function pickWebhookSecret(): { label: string; secret: string } {
  // staging worker の LINE_CHANNEL_SECRET は「テスト OA の secret」が入っている（実測: 署名プローブ）。
  const s = process.env.LINE_CHANNEL_SECRET_TEST;
  if (!s) throw new Error("LINE_CHANNEL_SECRET_TEST が .dev.vars に無い（署名できないため中断）。");
  return { label: "LINE_CHANNEL_SECRET_TEST", secret: s };
}

async function sendLineText(userId: string, text: string): Promise<number> {
  const { secret } = pickWebhookSecret();
  const body = JSON.stringify({
    destination: "U" + "0".repeat(32),
    events: [
      {
        type: "message",
        mode: "active",
        timestamp: Date.now(),
        // processEvents は deliveryContext.isRedelivery と webhookEventId を必須で読む
        // （line.ts:226,235）。欠けると TypeError で 1 件も処理されない（実測 2026-07-22）。
        webhookEventId: `m6-${crypto.randomUUID()}`,
        deliveryContext: { isRedelivery: false },
        source: { type: "user", userId },
        // 合成 replyToken: LINE 側の返信は必ず失敗する（実在の誰にも届かない）。
        replyToken: "0".repeat(32),
        message: { type: "text", id: `m6-${Date.now()}`, text },
      },
    ],
  });
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64");
  const target = assertAllowedTestTarget(`${STAGING_URL}/webhook/line`, "m6 webhook POST");
  const res = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-line-signature": sig },
    body,
  });
  return res.status;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** staging の conversations から、指定 userId の assistant 応答が現れるまで待つ。 */
async function waitAssistantReply(
  supabase: SupabaseClient,
  userId: string,
  sinceIso: string,
  timeoutMs = 75_000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await supabase
      .from("conversations")
      .select("content, created_at")
      .eq("user_id", userId)
      .eq("role", "assistant")
      .gt("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data && data.length > 0) return data[0].content as string;
    await sleep(3000);
  }
  return null;
}

/** flow_events を 1 件待つ。 */
async function waitFlowEvent(
  supabase: SupabaseClient,
  userRef: string,
  eventName: string,
  sinceIso: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await supabase
      .from("flow_events")
      .select("event_name, user_ref, metadata, created_at")
      .eq("user_ref", userRef)
      .eq("event_name", eventName)
      .gt("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(1);
    if (data && data.length > 0) return data[0] as Record<string, unknown>;
    await sleep(3000);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------
async function main() {
  console.log("=".repeat(70));
  console.log("M6 Shopify Linkage Staging E2E");
  console.log(`Target worker : ${STAGING_URL}`);
  console.log(`Dev store     : ${DEV_STORE_DOMAIN}`);
  console.log(`Synthetic ids : linked=${LINKED_ID} unlinked=${UNLINKED_ID} invite=${INVITE_ID}`);
  console.log("=".repeat(70));

  const supabase = stagingSupabase();

  // -------------------------------------------------------------------------
  // 手順 2: 合成の連携行を投入（AC-2 の LIFF レッグを迂回して下流を検証する）
  // -------------------------------------------------------------------------
  console.log("\n[SETUP] customer_linkages に合成の連携行を upsert（staging のみ）");
  const up = await upsertCustomerLinkage(supabase, {
    lineUserId: LINKED_ID,
    shopifyCustomerId: TEST_SHOPIFY_CUSTOMER_ID,
    shopifyEmail: "setaka-on+shopifytest@elxea.com",
    source: "test",
  });
  check("合成連携行 upsert", up.ok, up.ok ? `${LINKED_ID} → ${TEST_SHOPIFY_CUSTOMER_ID}` : String(up.error));
  if (!up.ok) process.exit(1);

  // 未連携 ID に行が無いことを明示確認（SEC-A の前提）。
  const { data: unlinkedRows } = await supabase
    .from("customer_linkages")
    .select("line_user_id")
    .eq("line_user_id", UNLINKED_ID);
  check("未連携 ID に連携行が無い", (unlinkedRows?.length ?? 0) === 0, `rows=${unlinkedRows?.length ?? 0}`);

  // -------------------------------------------------------------------------
  // T-4 [SEC-A] 未連携ユーザーの注文照会
  // -------------------------------------------------------------------------
  console.log("\n[T-4 / SEC-A] 未連携 ID で「注文状況」");
  const t4Since = new Date(Date.now() - 5000).toISOString();
  const t4Status = await sendLineText(UNLINKED_ID, "注文状況を教えてください");
  console.log(`  webhook HTTP ${t4Status}`);
  const t4Reply = await waitAssistantReply(supabase, UNLINKED_ID, t4Since);
  // 漏洩判定: 開発ストアの注文番号・商品名・顧客名が 1 つでも出たら FAIL（本質はここ）。
  const t4Leak =
    !!t4Reply && /(#?\b100[12]\b|Snowboard|Ski Wax|setaka-on\+shopifytest)/i.test(t4Reply);
  // 案内判定: 連携（紐付け）を求める / 注文番号を求める 方向に誘導していること。
  const t4Guides = !!t4Reply && /(連携|紐付|ログイン|注文番号)/.test(t4Reply);
  check(
    "未連携は連携要求で返り、他人の注文が漏れない",
    !!t4Reply && !t4Leak && t4Guides,
    t4Reply ? JSON.stringify(t4Reply.slice(0, 260)) : "応答なし(timeout)",
  );

  // -------------------------------------------------------------------------
  // T-3 連携済みユーザーの注文照会（下流 + R-a の実測）
  // -------------------------------------------------------------------------
  console.log("\n[T-3] 連携済み ID で「注文状況」");
  const t3Since = new Date(Date.now() - 5000).toISOString();
  const t3Status = await sendLineText(LINKED_ID, "注文状況を教えてください");
  console.log(`  webhook HTTP ${t3Status}`);
  const t3Reply = await waitAssistantReply(supabase, LINKED_ID, t3Since);
  const has1001 = !!t3Reply && /#?1001/.test(t3Reply);
  const has1002 = !!t3Reply && /#?1002/.test(t3Reply);
  check(
    "開発ストアの注文が返る（#1001 / #1002）",
    has1001 && has1002,
    t3Reply ? JSON.stringify(t3Reply.slice(0, 400)) : "応答なし(timeout)",
  );

  // -------------------------------------------------------------------------
  // T-6 注文番号指定の詳細照会
  // -------------------------------------------------------------------------
  console.log("\n[T-6] 連携済み ID で「注文番号 #1001 の詳細」");
  const t6Since = new Date(Date.now() - 5000).toISOString();
  const t6Status = await sendLineText(LINKED_ID, "注文番号 #1001 の詳細を教えてください。品目と配送状況をお願いします。");
  console.log(`  webhook HTTP ${t6Status}`);
  const t6Reply = await waitAssistantReply(supabase, LINKED_ID, t6Since);
  check(
    "当該注文の詳細（品目・状況）が返る",
    !!t6Reply && /1001/.test(t6Reply) && /(Snowboard|スノーボード|品目|商品)/i.test(t6Reply),
    t6Reply ? JSON.stringify(t6Reply.slice(0, 400)) : "応答なし(timeout)",
  );

  // -------------------------------------------------------------------------
  // T-7 カート生成（Storefront API・PII 非依存）
  //   ※ 開発ストアの実 variant id は手元に無いため、CART_VARIANT_ID で明示指定できる。
  //     未指定時は合成 id を渡し、「Storefront が開発ストアで応答するか」までを測る。
  // -------------------------------------------------------------------------
  const cartVariantId = process.env.CART_VARIANT_ID ?? "40000000000001";
  console.log(`\n[T-7] 連携済み ID でカート生成（variant_id=${cartVariantId}）`);
  const t7Since = new Date(Date.now() - 5000).toISOString();
  const t7Status = await sendLineText(
    LINKED_ID,
    `この商品を買いたいです。create_cart_link ツールで variant_id="${cartVariantId}"、数量1のカートリンクを作ってください。`,
  );
  console.log(`  webhook HTTP ${t7Status}`);
  const t7Reply = await waitAssistantReply(supabase, LINKED_ID, t7Since);
  const t7Url = t7Reply?.match(/https?:\/\/[^\s)"'）】]+/g)?.find((u) => /\/cart\/|checkout/.test(u));
  const t7Host = t7Url ? new URL(t7Url).hostname : null;
  check(
    "checkoutUrl が開発ストアのドメイン",
    !!t7Host && t7Host === DEV_STORE_DOMAIN,
    t7Host ? `host=${t7Host} url=${t7Url}` : `checkoutUrl なし: ${JSON.stringify((t7Reply ?? "").slice(0, 260))}`,
  );

  // -------------------------------------------------------------------------
  // T-1 未連携ユーザーへの連携ボタン + flow_events.link.invite_shown
  // -------------------------------------------------------------------------
  console.log(`\n[T-1] 未連携 ID で完全一致トリガ「${LINKAGE_TRIGGER}」`);
  const t1Since = new Date(Date.now() - 5000).toISOString();
  const t1Status = await sendLineText(INVITE_ID, LINKAGE_TRIGGER);
  console.log(`  webhook HTTP ${t1Status}`);
  const t1Event = await waitFlowEvent(supabase, INVITE_ID, "link.invite_shown", t1Since);
  check(
    "flow_events に link.invite_shown が記録される",
    !!t1Event,
    t1Event ? JSON.stringify(t1Event) : "記録なし(timeout)",
  );

  // -------------------------------------------------------------------------
  // R-b: staging worker が staging Supabase を使っていることの実測
  //   合成連携行は **staging Supabase にしか無い**。worker がそれを解決できた
  //   （= T-3 で本人の注文が返った）事実が、worker→staging Supabase の配線の証拠。
  //   さらに worker が書いた行（conversations / flow_events）が staging に現れることでも裏取りする。
  // -------------------------------------------------------------------------
  console.log("\n[R-b] worker の書き込みが staging Supabase に現れるか");
  const { data: rbRows } = await supabase
    .from("conversations")
    .select("user_id, channel, role, created_at")
    .in("user_id", [LINKED_ID, UNLINKED_ID])
    .order("created_at", { ascending: false })
    .limit(10);
  check(
    "worker の会話行が staging Supabase に存在",
    (rbRows?.length ?? 0) > 0,
    `rows=${rbRows?.length ?? 0} (ref=${STAGING_SUPABASE_REF}, prod ref ${PROD_SUPABASE_REF} には未接続)`,
  );

  console.log("\n" + "=".repeat(70));
  console.log(failed === 0 ? "M6 E2E: ALL PASS" : `M6 E2E: ${failed} FAIL`);
  console.log("後片付け: 合成連携行は残す（後続検証で使う）。");
  console.log(`  line_user_id=${LINKED_ID} shopify_customer_id=${TEST_SHOPIFY_CUSTOMER_ID} source=test`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
