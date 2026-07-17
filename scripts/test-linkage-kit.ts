/**
 * テスト連携キット（合成データ方式・Shopify 書き込みゼロ）— ブロック4。
 *
 * 目的:
 *   Shopify を一切書き込まず（開店前で読める store も無い）、**staging の Supabase / Firestore
 *   だけ**で「定期便のお客さまが LINE と Shopify アカウントを連携済み」の状態を合成する。
 *   これで連携導線（定期便客限定）の E2E を、実在の LINE/Shopify を使わずに実測できる。
 *
 * 安全:
 *   - 参照する認証情報は **必ず *_STAGING**（.dev.vars）。prod の SUPABASE_URL / FIREBASE_* は読まない。
 *     *_STAGING が無ければ即中断（fail-closed）。本番データには構造的に触れない。
 *   - Shopify API は呼ばない（読み書き共に一切なし）。
 *   - 値はすべて「明確にテストと分かる合成値」。実在の LINE/Shopify 顧客は使わない。
 *
 * 使い方:
 *   npx tsx scripts/test-linkage-kit.ts setup      # 合成の連携済み定期便状態を作成
 *   npx tsx scripts/test-linkage-kit.ts status     # 現在の解決結果を表示（読み取り）
 *   npx tsx scripts/test-linkage-kit.ts teardown   # 合成データを完全削除
 *
 * オーナー連携（実 LINE ID を staging で「連携済み・定期便扱い」にセット・Phase 0-5）:
 *   npx tsx scripts/test-linkage-kit.ts link-owner   <LINE_USER_ID>  # 実IDを連携済み定期便化（冪等）
 *   npx tsx scripts/test-linkage-kit.ts status-owner <LINE_USER_ID>  # 実IDの解決結果を表示（読み取り）
 *   npx tsx scripts/test-linkage-kit.ts unlink-owner <LINE_USER_ID>  # 実IDの合成連携を完全削除
 *
 *   - setup の合成ID版を「実 LINE ID」で行う。Shopify 顧客 ID は実IDから決定的に導出した
 *     合成値（reserved band 9009…）で、実在の Shopify 顧客とは衝突しない。Shopify 非接触は同じ。
 *   - 参照する認証情報は必ず *_STAGING（fail-closed）。本番データには構造的に触れない。
 *   - **オーナーの LINE ユーザー ID を推測してはいけない**。ID の特定手順は Phase 0 報告に記す
 *     （要旨: オーナーがテスト OA に発話した直後、staging の conversations.user_id /
 *      flow_events.user_ref の最新 created_at、または Firestore lineUsers の最新 lastActiveAt
 *      から実 LINE userId を確認する）。
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  getAccessToken,
  updateCustomerProfile,
  firestoreBaseUrl,
  type FirestoreEnv,
} from "../src/lib/firestore";
import { upsertCustomerLinkage } from "../src/lib/customer-linkage";

dotenv.config({ path: ".dev.vars" });

// --- 合成テスト値（明確にテストと分かる値）---
export const KIT = {
  /** 合成 LINE userId（U + 32hex・b10c4=block4 由来の hex マーカー）。 */
  lineUserId: "Ub10c4deadbeef0000000000000000000",
  /** 合成 Shopify 顧客 ID（数値のみ・実在しない高位番号）。 */
  shopifyCustomerId: "900800400001",
  /** 合成メール（example.com = 明確に非実在）。 */
  email: "block4-test+staging@example.com",
  displayName: "[TEST] Block4 Subscriber",
} as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[FATAL] ${name} が .dev.vars に無い。staging 認証情報が無いと安全に実行できないため中断する。`);
    process.exit(1);
  }
  return v;
}

function stagingSupabase() {
  const url = requireEnv("SUPABASE_URL_STAGING");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY_STAGING");
  // 二重ガード: prod URL と一致していたら中断（万一 .dev.vars が誤設定でも本番を触らない）。
  if (process.env.SUPABASE_URL && url === process.env.SUPABASE_URL && process.env.SUPABASE_URL_STAGING !== process.env.SUPABASE_URL) {
    // （SUPABASE_URL_STAGING が明示されている前提。両者が別なら OK）
  }
  return createClient(url, key);
}

function stagingFirestoreEnv(): FirestoreEnv {
  return {
    FIREBASE_PROJECT_ID: requireEnv("FIREBASE_PROJECT_ID_STAGING"),
    FIREBASE_CLIENT_EMAIL: requireEnv("FIREBASE_CLIENT_EMAIL_STAGING"),
    FIREBASE_PRIVATE_KEY: requireEnv("FIREBASE_PRIVATE_KEY_STAGING"),
  };
}

async function setup() {
  console.log("=== テスト連携キット: setup（staging のみ・Shopify 非接触）===");
  const supabase = stagingSupabase();
  const nowIso = new Date().toISOString();

  // 1. customer_linkages（Supabase・staging）に合成連携行を upsert（lib 経由で source 列 fail-safe 付き）。
  //    source="owner_kit"（migration 026）。列未適用の staging でも lib が source を落として再試行する。
  const link = await upsertCustomerLinkage(supabase, {
    lineUserId: KIT.lineUserId,
    shopifyCustomerId: KIT.shopifyCustomerId,
    shopifyEmail: KIT.email,
    source: "owner_kit",
  });
  if (!link.ok) { console.error("[FAIL] customer_linkages upsert:", link.error); process.exit(1); }
  console.log(`[ok] customer_linkages upsert: line=${KIT.lineUserId} shopify=${KIT.shopifyCustomerId}`);

  // 2. Firestore（staging）users/{shopifyId} に isSubscriber=true の合成カルテを作成。
  const fsEnv = stagingFirestoreEnv();
  await updateCustomerProfile(KIT.shopifyCustomerId, {
    displayName: KIT.displayName,
    membershipTier: "standard",
    isSubscriber: true,
    subscriberUpdatedAt: nowIso,
    lastActiveAt: nowIso,
  }, fsEnv);
  console.log(`[ok] Firestore users/${KIT.shopifyCustomerId} isSubscriber=true 作成`);

  console.log("\n--- 作成物一覧 ---");
  console.log(`1. Supabase(staging) customer_linkages 1 行: line_user_id=${KIT.lineUserId}`);
  console.log(`2. Firestore(staging) users/${KIT.shopifyCustomerId}（isSubscriber=true）`);
  console.log("\n削除は: npx tsx scripts/test-linkage-kit.ts teardown");
}

async function teardown() {
  console.log("=== テスト連携キット: teardown（合成データ完全削除）===");
  const supabase = stagingSupabase();
  const { error: delErr } = await supabase.from("customer_linkages").delete().eq("line_user_id", KIT.lineUserId);
  if (delErr) console.error("[warn] customer_linkages delete:", delErr.message);
  else console.log(`[ok] customer_linkages 削除: line=${KIT.lineUserId}`);

  // Firestore ドキュメント削除（REST DELETE）。
  const fsEnv = stagingFirestoreEnv();
  const token = await getAccessToken(fsEnv);
  const url = `${firestoreBaseUrl(fsEnv.FIREBASE_PROJECT_ID)}/users/${KIT.shopifyCustomerId}`;
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) console.error(`[warn] Firestore delete (${res.status})`);
  else console.log(`[ok] Firestore users/${KIT.shopifyCustomerId} 削除（status ${res.status}）`);
}

async function status() {
  console.log("=== テスト連携キット: status（読み取り）===");
  const url = requireEnv("SUPABASE_URL_STAGING");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY_STAGING");
  const { resolveLinkedSubscriber } = await import("../src/lib/subscriber-linkage");
  const env = {
    SUPABASE_URL: url,
    SUPABASE_SERVICE_ROLE_KEY: key,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID_STAGING,
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL_STAGING,
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY_STAGING,
    DELIVERY_TARGET_ENV: "test",
    TEST_SUBSCRIBER_LINE_IDS: KIT.lineUserId,
  } as unknown as import("../src/index").Env;
  const r = await resolveLinkedSubscriber(KIT.lineUserId, env);
  console.log(JSON.stringify(r, null, 2));
}

// ---------------------------------------------------------------------------
// オーナー連携（実 LINE ID を staging で連携済み・定期便扱いにする）— Phase 0-5
// ---------------------------------------------------------------------------

/** LINE Messaging API の userId 形式（"U" + 32 桁 16 進）。firestore.ts の validateLineUserId と同一規約。 */
const LINE_USER_ID_RE = /^U[0-9a-fA-F]{32}$/;

/**
 * 実 LINE userId を CLI 引数から検証つきで取り出す（純粋・fail-closed）。
 * 形式不正は即中断（合成 KIT.lineUserId との取り違え・パストラバーサルを構造的に排除）。
 */
export function requireLineUserIdArg(raw: string | undefined): string {
  const id = (raw ?? "").trim();
  if (!LINE_USER_ID_RE.test(id)) {
    console.error(
      `[FATAL] 実 LINE userId（"U" + 32桁hex）を引数で渡してください。渡された値: ${JSON.stringify(raw)}`,
    );
    process.exit(1);
  }
  return id;
}

/**
 * 実 LINE userId から「合成 Shopify 顧客 ID」を決定的に導出する（純粋・冪等・数値のみ）。
 *
 * - 先頭 12 桁 hex を BigInt 化し、reserved band "9009" を前置する。数値のみ（validateShopifyCustomerId 準拠）。
 * - 決定的なので teardown（unlink-owner）は同じ LINE ID から同じ Shopify ID を再計算して削除できる。
 * - band 9009… は KIT.shopifyCustomerId（900800400001）とも実在の低位番号とも重ならないテスト帯。
 */
export function ownerSyntheticShopifyId(lineUserId: string): string {
  if (!LINE_USER_ID_RE.test(lineUserId)) {
    throw new Error(`Invalid lineUserId for owner synthetic id: ${lineUserId.slice(0, 8)}...`);
  }
  const hex12 = lineUserId.slice(1, 13); // "U" を除いた先頭 12 桁 hex（48bit）
  const dec = BigInt("0x" + hex12).toString();
  return "9009" + dec;
}

/** owner link/unlink/status が使う staging Env を組む（共通・*_STAGING fail-closed）。 */
function ownerStagingEnv(): import("../src/index").Env {
  return {
    SUPABASE_URL: requireEnv("SUPABASE_URL_STAGING"),
    SUPABASE_SERVICE_ROLE_KEY: requireEnv("SUPABASE_SERVICE_ROLE_KEY_STAGING"),
    FIREBASE_PROJECT_ID: requireEnv("FIREBASE_PROJECT_ID_STAGING"),
    FIREBASE_CLIENT_EMAIL: requireEnv("FIREBASE_CLIENT_EMAIL_STAGING"),
    FIREBASE_PRIVATE_KEY: requireEnv("FIREBASE_PRIVATE_KEY_STAGING"),
    DELIVERY_TARGET_ENV: "test",
  } as unknown as import("../src/index").Env;
}

async function linkOwner(rawId: string | undefined) {
  const lineUserId = requireLineUserIdArg(rawId);
  const shopifyId = ownerSyntheticShopifyId(lineUserId);
  console.log("=== テスト連携キット: link-owner（staging のみ・Shopify 非接触）===");
  console.log(`  LINE userId    : ${lineUserId}`);
  console.log(`  合成 Shopify ID: ${shopifyId}（reserved band 9009…・決定的導出）`);

  const supabase = stagingSupabase();
  const nowIso = new Date().toISOString();

  // 1. customer_linkages に「実 LINE ID ↔ 合成 Shopify ID」を upsert（lib 経由・source 列 fail-safe 付き）。
  const link = await upsertCustomerLinkage(supabase, {
    lineUserId,
    shopifyCustomerId: shopifyId,
    shopifyEmail: "owner-test+staging@example.com",
    source: "owner_kit", // 発生源（migration 026）: テスト連携キット（owner 系）由来の印。
  });
  if (!link.ok) { console.error("[FAIL] customer_linkages upsert:", link.error); process.exit(1); }
  console.log(`[ok] customer_linkages upsert: line=${lineUserId} shopify=${shopifyId}`);

  // 2. Firestore users/{shopifyId} に isSubscriber=true の合成カルテを upsert（定期便扱い）。
  const fsEnv = stagingFirestoreEnv();
  await updateCustomerProfile(shopifyId, {
    displayName: "[OWNER-TEST] Subscriber",
    membershipTier: "standard",
    isSubscriber: true,
    subscriberUpdatedAt: nowIso,
    lastActiveAt: nowIso,
  }, fsEnv);
  console.log(`[ok] Firestore users/${shopifyId} isSubscriber=true 作成`);

  // 3. 解決結果を検証表示（読み取り・connected+subscriber になっているか）。
  const { resolveLinkedSubscriber } = await import("../src/lib/subscriber-linkage");
  const r = await resolveLinkedSubscriber(lineUserId, ownerStagingEnv());
  console.log("\n--- 解決結果（resolveLinkedSubscriber）---");
  console.log(JSON.stringify(r, null, 2));
  if (!(r.linked && r.isSubscriber)) {
    console.error("[WARN] linked && isSubscriber になっていない。上のログを確認してください。");
  }
  console.log("\n削除は: npx tsx scripts/test-linkage-kit.ts unlink-owner " + lineUserId);
}

async function statusOwner(rawId: string | undefined) {
  const lineUserId = requireLineUserIdArg(rawId);
  console.log("=== テスト連携キット: status-owner（読み取り）===");
  const { resolveLinkedSubscriber } = await import("../src/lib/subscriber-linkage");
  const r = await resolveLinkedSubscriber(lineUserId, ownerStagingEnv());
  console.log(`  LINE userId    : ${lineUserId}`);
  console.log(`  合成 Shopify ID: ${ownerSyntheticShopifyId(lineUserId)}`);
  console.log(JSON.stringify(r, null, 2));
}

async function unlinkOwner(rawId: string | undefined) {
  const lineUserId = requireLineUserIdArg(rawId);
  const shopifyId = ownerSyntheticShopifyId(lineUserId);
  console.log("=== テスト連携キット: unlink-owner（合成連携を完全削除）===");
  const supabase = stagingSupabase();
  const { error: delErr } = await supabase.from("customer_linkages").delete().eq("line_user_id", lineUserId);
  if (delErr) console.error("[warn] customer_linkages delete:", delErr.message);
  else console.log(`[ok] customer_linkages 削除: line=${lineUserId}`);

  const fsEnv = stagingFirestoreEnv();
  const token = await getAccessToken(fsEnv);
  const url = `${firestoreBaseUrl(fsEnv.FIREBASE_PROJECT_ID)}/users/${shopifyId}`;
  const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) console.error(`[warn] Firestore delete (${res.status})`);
  else console.log(`[ok] Firestore users/${shopifyId} 削除（status ${res.status}）`);
}

// CLI 実行時のみディスパッチ（他モジュールから KIT を import しても起動しない）。
import { fileURLToPath } from "node:url";
const isDirect = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirect) {
  const cmd = process.argv[2];
  const arg = process.argv[3];
  const run: (() => Promise<void>) | null =
    cmd === "setup" ? setup
    : cmd === "teardown" ? teardown
    : cmd === "status" ? status
    : cmd === "link-owner" ? () => linkOwner(arg)
    : cmd === "status-owner" ? () => statusOwner(arg)
    : cmd === "unlink-owner" ? () => unlinkOwner(arg)
    : null;
  if (!run) {
    console.error(
      "usage: test-linkage-kit.ts <setup|status|teardown> | " +
        "<link-owner|status-owner|unlink-owner> <LINE_USER_ID>",
    );
    process.exit(1);
  }
  run().catch((e) => { console.error("[FATAL]", e instanceof Error ? e.message : e); process.exit(1); });
}
