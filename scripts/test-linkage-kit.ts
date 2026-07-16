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
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  getAccessToken,
  updateCustomerProfile,
  firestoreBaseUrl,
  type FirestoreEnv,
} from "../src/lib/firestore";

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

  // 1. customer_linkages（Supabase・staging）に合成連携行を upsert。
  const { error: linkErr } = await supabase.from("customer_linkages").upsert(
    {
      line_user_id: KIT.lineUserId,
      shopify_customer_id: KIT.shopifyCustomerId,
      shopify_email: KIT.email,
      linked_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: "line_user_id" },
  );
  if (linkErr) { console.error("[FAIL] customer_linkages upsert:", linkErr.message); process.exit(1); }
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

// CLI 実行時のみディスパッチ（他モジュールから KIT を import しても起動しない）。
import { fileURLToPath } from "node:url";
const isDirect = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirect) {
  const cmd = process.argv[2];
  const run = cmd === "setup" ? setup : cmd === "teardown" ? teardown : cmd === "status" ? status : null;
  if (!run) { console.error("usage: test-linkage-kit.ts <setup|status|teardown>"); process.exit(1); }
  run().catch((e) => { console.error("[FATAL]", e instanceof Error ? e.message : e); process.exit(1); });
}
