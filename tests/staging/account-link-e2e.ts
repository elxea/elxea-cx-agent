/**
 * Staging E2E -- LINE↔Web の同一人物解決（名寄せ）を staging 実環境で完走させる。
 *
 * 何を証明するか:
 *   「Web で本人確定した Shopify 顧客」と「LINE の Messaging userId」が、
 *   staging の実 Worker + 実 Supabase を通って **1 つの連携行に解決される**こと。
 *   これは機能定義 v1.5 第3節 3-4「LINEでもWebでも同じ相手として続く」の土台にあたる。
 *
 * 外部送信ゼロ（安全上の設計・ここは緩めない）:
 *   handleAccountLinkEvent は完了メッセージを LINE に返す実装だが、本 E2E では
 *   **responder をスタブに差し替える**ため LINE 送信 API を一切叩かない。
 *   carryover（Firestore 統合）も同様にスタブ化する（本 E2E の検証対象外）。
 *   使う ID は非実在の合成値のみ（U+32hex / 桁数の大きい合成 Shopify 顧客 ID）。
 *
 * 検証（E1〜E5）:
 *   E1. 実 staging Worker の POST /api/identity/account-link-nonce が
 *       X-API-Key 認証を通り、nonce と access.line.me への redirect_url を返す（Web 側 3〜4 手目）。
 *   E2. その nonce が staging Supabase の account_link_nonces に未消費で実在する。
 *   E3. accountLink イベント（result=ok）を処理すると nonce が消費され、
 *       customer_linkages に source='account_link' の連携行が書かれる（= 名寄せ成立）。
 *   E4. 同じ nonce を再投入しても連携行は増えない（single-use / webhook 再送耐性）。
 *   E5. result=failed のイベントでは連携行を一切書かない（LINE 側の所有者検証失敗）。
 *
 * 後始末: 作った合成行（nonce / linkage）を必ず削除する（失敗時も finally で実行）。
 *
 * 使い方: npx tsx tests/staging/account-link-e2e.ts
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  handleAccountLinkEvent,
  ACCOUNT_LINK_NONCES_TABLE,
  ACCOUNT_LINK_SOURCE,
} from "../../src/lib/account-link";
import type { Env } from "../../src/index";
import type { LineResponder } from "../../src/lib/line";

dotenv.config({ path: ".dev.vars" });

/**
 * ⚠ staging を **ハードピン**する。
 * `.dev.vars` の CX_AGENT_BASE_URL は **本番**（elxea-agent.setaka-on.workers.dev）を指すため、
 * それを既定に使うと本番 Worker を叩いてしまう。本 E2E は staging 専用なので参照しない。
 * 上書きしたいときだけ ACCOUNT_LINK_E2E_URL を明示する。
 */
const STAGING_URL =
  process.env.ACCOUNT_LINK_E2E_URL ??
  "https://elxea-agent-staging.setaka-on.workers.dev";

/** 合成 LINE userId（U + 32hex・非実在）。実在ユーザーに触れない。 */
const SYNTH_LINE_ID = "Uacc0817ac0817ac0817ac0817ac08170";
/** 合成 Shopify 顧客 ID（数値文字列・実在しない桁）。 */
const SYNTH_CUSTOMER_ID = "9999000817001";

let failed = 0;
function check(name: string, pass: boolean, detail: string) {
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}: ${detail}`);
  if (!pass) failed++;
}

/** LINE 送信をしないスタブ responder（送信 API を叩かないことが要件）。 */
function stubResponder(): LineResponder & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    text: async (body: string) => {
      sent.push(body);
    },
  } as unknown as LineResponder & { sent: string[] };
}

async function main() {
  console.log("=".repeat(60));
  console.log("Account Link (LINE↔Web 同一人物解決) Staging E2E");
  console.log(`Target: ${STAGING_URL}`);
  console.log("外部送信: なし（responder スタブ・合成 ID のみ）");
  console.log("=".repeat(60));

  const supabaseUrl = process.env.SUPABASE_URL_STAGING;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY_STAGING;
  const syncSecret = process.env.SYNC_API_SECRET;

  if (!supabaseUrl || !supabaseKey) {
    console.error("SUPABASE_URL_STAGING / SUPABASE_SERVICE_ROLE_KEY_STAGING が必要です");
    process.exit(1);
  }
  if (!syncSecret) {
    console.error("SYNC_API_SECRET が必要です（nonce 発行の server-to-server 認証）");
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);
  // Env は handleAccountLinkEvent の carryover をスタブ化するため最小限で足りる。
  const env = { SUPABASE_URL: supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: supabaseKey } as unknown as Env;

  let issuedNonce: string | null = null;

  try {
    // --- E1. staging Worker の nonce 発行エンドポイント（Web 側 3〜4 手目）-------------
    console.log("\n--- E1. POST /api/identity/account-link-nonce（実 staging Worker）---");
    const res = await fetch(`${STAGING_URL}/api/identity/account-link-nonce`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": syncSecret },
      body: JSON.stringify({
        shopify_customer_id: SYNTH_CUSTOMER_ID,
        // linkToken は LINE が発行するものだが、E2E では形式ゲートを通る合成値で
        // 「redirect_url の組み立てまで到達するか」だけを見る（LINE には投げない）。
        link_token: "e2e0000000000000000000000000acc1",
      }),
    });
    check("HTTP 200 が返る", res.status === 200, `status=${res.status}`);

    const data = (await res.json().catch(() => null)) as {
      success?: boolean;
      nonce?: string;
      expires_at?: string;
      redirect_url?: string;
    } | null;

    check("success=true", data?.success === true, String(data?.success));
    check(
      "nonce が返る（値は出さない）",
      typeof data?.nonce === "string" && data.nonce.length >= 10,
      `length=${data?.nonce?.length ?? 0}`,
    );
    check(
      "redirect_url が LINE の連携ダイアログを指す",
      typeof data?.redirect_url === "string" &&
        data.redirect_url.startsWith("https://access.line.me/dialog/bot/accountLink"),
      data?.redirect_url?.split("?")[0] ?? "none",
    );

    if (typeof data?.nonce !== "string") {
      console.error("\nnonce が取れないため以降を中止します");
      return;
    }
    issuedNonce = data.nonce;

    // --- E2. staging Supabase に未消費の nonce が実在する ------------------------------
    console.log("\n--- E2. account_link_nonces に未消費で保存されている ---");
    const { data: nonceRows } = await supabase
      .from(ACCOUNT_LINK_NONCES_TABLE)
      .select("shopify_customer_id, consumed_at, expires_at")
      .eq("nonce", issuedNonce)
      .limit(1);
    const nonceRow = (nonceRows ?? [])[0] as
      | { shopify_customer_id?: string; consumed_at?: string | null; expires_at?: string }
      | undefined;

    check("nonce 行が staging DB に実在する", !!nonceRow, nonceRow ? "found" : "not found");
    check(
      "預けた Shopify 顧客 ID が一致する",
      nonceRow?.shopify_customer_id === SYNTH_CUSTOMER_ID,
      String(nonceRow?.shopify_customer_id),
    );
    check("未消費である", !nonceRow?.consumed_at, `consumed_at=${nonceRow?.consumed_at ?? "null"}`);
    check(
      "TTL が未来にある",
      !!nonceRow?.expires_at && new Date(nonceRow.expires_at).getTime() > Date.now(),
      String(nonceRow?.expires_at),
    );

    // 事前に残骸があれば消す（前回失敗時の後始末）。
    await supabase.from("customer_linkages").delete().eq("line_user_id", SYNTH_LINE_ID);

    // --- E3. accountLink イベント → 名寄せ成立 -----------------------------------------
    console.log("\n--- E3. accountLink(result=ok) を処理して連携行が書かれる ---");
    const responder = stubResponder();
    const outcome = await handleAccountLinkEvent(
      SYNTH_LINE_ID,
      { result: "ok", nonce: issuedNonce },
      env,
      responder,
      { supabase, carryover: async () => {} }, // Firestore 統合はスタブ（本 E2E の対象外）
    );
    check("outcome=linked", outcome === "linked", String(outcome));
    check(
      "LINE 送信 API を叩いていない（スタブが受けただけ）",
      responder.sent.length === 1,
      `stub received=${responder.sent.length} / 実送信=0`,
    );

    const { data: linkRows } = await supabase
      .from("customer_linkages")
      .select("line_user_id, shopify_customer_id, source")
      .eq("line_user_id", SYNTH_LINE_ID);
    const linkRow = (linkRows ?? [])[0] as
      | { shopify_customer_id?: string; source?: string }
      | undefined;

    check("連携行が 1 件できた", (linkRows ?? []).length === 1, `rows=${(linkRows ?? []).length}`);
    check(
      "LINE userId と Shopify 顧客 ID が同一人物として結ばれた",
      linkRow?.shopify_customer_id === SYNTH_CUSTOMER_ID,
      `${SYNTH_LINE_ID.slice(0, 10)}… ⇔ ${linkRow?.shopify_customer_id}`,
    );
    check("source=account_link", linkRow?.source === ACCOUNT_LINK_SOURCE, String(linkRow?.source));

    // --- E4. 同じ nonce の再投入（webhook 再送）--------------------------------------
    console.log("\n--- E4. 同じ nonce を再投入しても増えない（single-use）---");
    const replay = await handleAccountLinkEvent(
      SYNTH_LINE_ID,
      { result: "ok", nonce: issuedNonce },
      env,
      stubResponder(),
      { supabase, carryover: async () => {} },
    );
    check(
      "2 回目は連携行を作らない",
      replay === "skipped_nonce_unusable",
      String(replay),
    );
    const { data: afterReplay } = await supabase
      .from("customer_linkages")
      .select("line_user_id")
      .eq("line_user_id", SYNTH_LINE_ID);
    check("連携行は 1 件のまま", (afterReplay ?? []).length === 1, `rows=${(afterReplay ?? []).length}`);

    // --- E5. result=failed は書かない ---------------------------------------------------
    console.log("\n--- E5. result=failed では連携行を作らない ---");
    const failedOutcome = await handleAccountLinkEvent(
      "Ufailfailfailfailfailfailfail0000",
      { result: "failed", nonce: issuedNonce },
      env,
      stubResponder(),
      { supabase, carryover: async () => {} },
    );
    check("outcome=skipped_result_failed", failedOutcome === "skipped_result_failed", String(failedOutcome));
    const { data: failRows } = await supabase
      .from("customer_linkages")
      .select("line_user_id")
      .eq("line_user_id", "Ufailfailfailfailfailfailfail0000");
    check("連携行は作られていない", (failRows ?? []).length === 0, `rows=${(failRows ?? []).length}`);
  } finally {
    // --- 後始末: 合成行を必ず消す ------------------------------------------------------
    console.log("\n--- cleanup（合成データの削除）---");
    await supabase.from("customer_linkages").delete().eq("line_user_id", SYNTH_LINE_ID);
    await supabase
      .from("customer_linkages")
      .delete()
      .eq("line_user_id", "Ufailfailfailfailfailfailfail0000");
    if (issuedNonce) {
      await supabase.from(ACCOUNT_LINK_NONCES_TABLE).delete().eq("nonce", issuedNonce);
    }
    console.log("  cleanup done");
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Account Link Staging E2E: ${failed === 0 ? "ALL PASS" : `${failed} FAILED`}`);
  console.log("=".repeat(60));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E threw:", err);
  process.exit(1);
});
