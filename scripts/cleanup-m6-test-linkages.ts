/**
 * M6 e2e の合成連携行クリーンアップ（**実機テストの前に必ず実行する**）。
 *
 * なぜ必要か（事実）:
 *   m6-shopify-linkage-e2e.ts は staging の `customer_linkages` に合成行
 *   （`Ue6a11...0001` → 開発ストア elxea-test2 のテスト顧客 `24858806714740` / `source=test`）を作る。
 *   この行を残したまま実機で **同じテスト顧客**を LIFF 連携すると、同一 `shopify_customer_id` の
 *   行が 2 本できる。すると web チャネルの解決
 *   （`src/lib/shopify.ts:35-39` の `.eq("shopify_customer_id", userId).single()`）が
 *   multiple-rows エラー → `null` → **未連携扱い**に壊れ、マイページ側の注文照会が静かに死ぬ。
 *   （LINE チャネルは `line_user_id` 一意なので壊れない。壊れるのは web レッグ。）
 *
 * 何を消すか:
 *   `customer_linkages` のうち **合成 userId 前缀 `Ue6a11` で始まる行だけ**（既定）。
 *   `--source-test-only`（既定 true）で `source='test'` も条件に加える。
 *   実顧客の連携行・会話履歴・flow_events には一切触れない。
 *
 * 安全:
 *   - 接続先は `SUPABASE_URL_STAGING` のみ（staging ref 一致を強制・fail-closed）。
 *   - 既定は **dry-run**（消さずに一覧表示）。実削除は `--apply` を明示したときだけ。
 *   - 本番 Supabase / 本番 worker / Shopify には一切接続しない。
 *
 * 使い方:
 *   npx tsx scripts/cleanup-m6-test-linkages.ts              # dry-run（既定・何も消さない）
 *   npx tsx scripts/cleanup-m6-test-linkages.ts --apply      # 実削除
 *   npx tsx scripts/cleanup-m6-test-linkages.ts --apply --any-source   # source 条件を外す
 */

import dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertNoProdMarker, installTestFetchGuard } from "../tests/lib/assert-not-prod";

dotenv.config({ path: ".dev.vars" });
installTestFetchGuard("cleanup-m6-test-linkages");

/** staging Supabase ref（設計 §5）。 */
const STAGING_SUPABASE_REF = "espeokdhutgztksdrpzt";
/** m6 e2e が使う合成 Messaging userId の前缀（`U` + `e6a11` マーカー）。 */
const SYNTHETIC_PREFIX = "Ue6a11";
/**
 * 開発ストアのテスト顧客（重複検知の表示用）。
 * 2026-07-22: 新開発ストア `elxea-test2` のテスト顧客に張替（旧 `9432276402259` は
 * 旧ストア `elxea-test-ugen0voh` の id で、もう参照先が無い）。
 */
const TEST_SHOPIFY_CUSTOMER_ID = "24858806714740";
/** 旧開発ストアのテスト顧客 id（残骸検知の表示用・削除条件には使わない）。 */
const LEGACY_SHOPIFY_CUSTOMER_ID = "9432276402259";

const apply = process.argv.includes("--apply");
const anySource = process.argv.includes("--any-source");

function stagingSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL_STAGING;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY_STAGING;
  if (!url || !key) {
    throw new Error("SUPABASE_URL_STAGING / SUPABASE_SERVICE_ROLE_KEY_STAGING が .dev.vars に無い（fail-closed）。");
  }
  assertNoProdMarker(url, "SUPABASE_URL_STAGING");
  if (!url.includes(STAGING_SUPABASE_REF)) {
    throw new Error(`SUPABASE_URL_STAGING が staging ref (${STAGING_SUPABASE_REF}) を指していない。中断。`);
  }
  return createClient(url, key);
}

async function main() {
  const supabase = stagingSupabase();
  console.log("=".repeat(70));
  console.log("M6 合成連携行クリーンアップ");
  console.log(`mode          : ${apply ? "APPLY（実削除）" : "DRY-RUN（何も消さない）"}`);
  console.log(`target        : staging Supabase (${STAGING_SUPABASE_REF}) / customer_linkages`);
  console.log(`match         : line_user_id LIKE '${SYNTHETIC_PREFIX}%'${anySource ? "" : " AND source='test'"}`);
  console.log("=".repeat(70));

  // 1. 削除候補の列挙
  let q = supabase
    .from("customer_linkages")
    .select("line_user_id, shopify_customer_id, source, linked_at")
    .like("line_user_id", `${SYNTHETIC_PREFIX}%`);
  if (!anySource) q = q.eq("source", "test");
  const { data: targets, error: selErr } = await q;
  if (selErr) throw new Error(`列挙に失敗: ${selErr.message}`);

  console.log(`\n[候補] ${targets?.length ?? 0} 行`);
  for (const r of targets ?? []) {
    console.log(`  - ${r.line_user_id} → ${r.shopify_customer_id} (source=${r.source ?? "null"}, linked_at=${r.linked_at})`);
  }

  // 2. 同一 shopify_customer_id の重複（web レッグ破壊の実体）を可視化
  const { data: dup } = await supabase
    .from("customer_linkages")
    .select("line_user_id, shopify_customer_id, source")
    .eq("shopify_customer_id", TEST_SHOPIFY_CUSTOMER_ID);
  console.log(
    `\n[重複チェック] shopify_customer_id=${TEST_SHOPIFY_CUSTOMER_ID} を指す行: ${dup?.length ?? 0} 本` +
      `${(dup?.length ?? 0) > 1 ? "  ← 2 本以上あると web チャネルの .single() が壊れる" : ""}`,
  );
  for (const r of dup ?? []) {
    console.log(`  - ${r.line_user_id} (source=${r.source ?? "null"})`);
  }

  // 2b. 旧開発ストアの customer id を指す残骸（張替漏れ）を可視化する。
  const { data: legacy } = await supabase
    .from("customer_linkages")
    .select("line_user_id, shopify_customer_id, source")
    .eq("shopify_customer_id", LEGACY_SHOPIFY_CUSTOMER_ID);
  console.log(
    `\n[旧ストア残骸] shopify_customer_id=${LEGACY_SHOPIFY_CUSTOMER_ID}（旧 elxea-test-ugen0voh）を指す行: ` +
      `${legacy?.length ?? 0} 本${(legacy?.length ?? 0) > 0 ? "  ← 新ストアに張り替えるか削除する" : ""}`,
  );
  for (const r of legacy ?? []) {
    console.log(`  - ${r.line_user_id} (source=${r.source ?? "null"})`);
  }

  // 3. 削除（--apply のときだけ）
  if (!apply) {
    console.log("\nDRY-RUN のため何も削除していない。実削除は --apply を付けて再実行する。");
    return;
  }
  if ((targets?.length ?? 0) === 0) {
    console.log("\n削除対象なし。終了。");
    return;
  }

  let d = supabase.from("customer_linkages").delete().like("line_user_id", `${SYNTHETIC_PREFIX}%`);
  if (!anySource) d = d.eq("source", "test");
  const { error: delErr } = await d;
  if (delErr) throw new Error(`削除に失敗: ${delErr.message}`);

  // 4. 事後確認
  let vq = supabase
    .from("customer_linkages")
    .select("line_user_id")
    .like("line_user_id", `${SYNTHETIC_PREFIX}%`);
  if (!anySource) vq = vq.eq("source", "test");
  const { data: after } = await vq;
  console.log(`\n[削除完了] 残存 ${after?.length ?? 0} 行（0 が正常）`);
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
