/**
 * 実機テスト用「連携リセット」— 指定 LINE userId の customer_linkages 行を staging から消す。
 *
 * なぜ必要か（実測・2026-07-22）:
 *   実機テストは「未連携の人が連携ボタンを見て、連携し、注文が返る」ことを確認する。
 *   ところが staging の customer_linkages にはオーナー本人の LINE userId が
 *   **過去テストの残骸として既に登録済み**だった（開発ストアに存在しない
 *   shopify_customer_id を指す・source=null）。この行が残っていると:
 *     - subscriber-linkage.resolveLinkedSubscriber が linked=true を返すため
 *       **連携ボタン（Flex）が出ない**（T-1b が成立しない）
 *     - 注文照会は存在しない顧客を引くため「顧客情報が見つかりません」に倒れる
 *   よって実機テストの前に、対象者の連携行を必ず消す（＝未連携状態に戻す）。
 *   再テストのたびに使える冪等なリセット手段でもある。
 *
 * 安全:
 *   - 接続先は SUPABASE_URL_STAGING（ref 固定）のみ。fail-closed。
 *   - 既定は dry-run。実削除は --apply を明示したときだけ。
 *   - 削除対象は「--line-user-id で明示した 1 件」のみ。前方一致・一括削除はしない。
 *   - 本番 Supabase / 本番 worker / Shopify には一切接続しない。
 *
 * 使い方:
 *   npx tsx scripts/reset-realdevice-linkage.ts --line-user-id U....            # dry-run
 *   npx tsx scripts/reset-realdevice-linkage.ts --line-user-id U.... --apply    # 実削除
 */

import dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertNoProdMarker, installTestFetchGuard } from "../tests/lib/assert-not-prod";

dotenv.config({ path: ".dev.vars" });
installTestFetchGuard("reset-realdevice-linkage");

/** staging Supabase ref（設計 §5）。 */
const STAGING_SUPABASE_REF = "espeokdhutgztksdrpzt";
/** Messaging userId の形式（web-auth.ts:154 と同一）。 */
const MESSAGING_USER_ID_RE = /^U[0-9a-f]{32}$/;

const apply = process.argv.includes("--apply");
const lineUserId = (() => {
  const i = process.argv.indexOf("--line-user-id");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

function stagingSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL_STAGING;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY_STAGING;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL_STAGING / SUPABASE_SERVICE_ROLE_KEY_STAGING が .dev.vars に無い（fail-closed）。",
    );
  }
  assertNoProdMarker(url, "SUPABASE_URL_STAGING");
  if (!url.includes(STAGING_SUPABASE_REF)) {
    throw new Error(`SUPABASE_URL_STAGING が staging ref (${STAGING_SUPABASE_REF}) を指していない。中断。`);
  }
  return createClient(url, key);
}

async function main() {
  if (!lineUserId) {
    throw new Error("--line-user-id <U+32hex> は必須（一括削除はしない）。");
  }
  if (!MESSAGING_USER_ID_RE.test(lineUserId)) {
    throw new Error(`--line-user-id が Messaging userId 形式（U + 32hex）でない: ${lineUserId}`);
  }

  const supabase = stagingSupabase();
  console.log("=".repeat(70));
  console.log("実機テスト用 連携リセット");
  console.log(`mode          : ${apply ? "APPLY（実削除）" : "DRY-RUN（何も消さない）"}`);
  console.log(`target        : staging Supabase (${STAGING_SUPABASE_REF}) / customer_linkages`);
  console.log(`line_user_id  : ${lineUserId}`);
  console.log("=".repeat(70));

  const { data: rows, error: selErr } = await supabase
    .from("customer_linkages")
    .select("line_user_id, shopify_customer_id, shopify_email, source, linked_at")
    .eq("line_user_id", lineUserId);
  if (selErr) throw new Error(`読み取り失敗: ${selErr.message}`);

  if (!rows || rows.length === 0) {
    console.log("\n[候補] 0 行 — 既に未連携。実機テストをそのまま開始してよい。");
    return;
  }
  console.log(`\n[候補] ${rows.length} 行`);
  for (const r of rows) {
    console.log(
      `  - ${r.line_user_id} -> ${r.shopify_customer_id} (source=${r.source ?? "null"}, linked_at=${r.linked_at})`,
    );
  }

  if (!apply) {
    console.log("\nDRY-RUN のため何も削除していない。実削除は --apply を付けて再実行する。");
    return;
  }

  const { error: delErr } = await supabase
    .from("customer_linkages")
    .delete()
    .eq("line_user_id", lineUserId);
  if (delErr) throw new Error(`削除失敗: ${delErr.message}`);

  const { data: after, error: afterErr } = await supabase
    .from("customer_linkages")
    .select("line_user_id")
    .eq("line_user_id", lineUserId);
  if (afterErr) throw new Error(`削除後確認に失敗: ${afterErr.message}`);
  console.log(`\n[削除完了] 残存 ${after?.length ?? 0} 行（0 が正常 = 未連携に戻った）`);
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
