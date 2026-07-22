/**
 * 実機テスト（オーナーがスマホで 1 回通す）の検証側 — 読み取りのみ・本番非接触。
 *
 * 位置づけ:
 *   オーナーは LINE アプリでの操作だけを行う。DB / ログの確認は本スクリプトが後から行う。
 *   手順書: ~/.claude/jobs/882ed6d7/tmp/realdevice-test-guide.md
 *
 * 何を判定するか（親 Issue の残 3 項目）:
 *   T-1b  … トークに「便益 1 行 + 連携ボタン」が出た      → flow_events.link.invite_shown
 *   AC-2  … 連携が customer_linkages に 1 行記録された     → source='liff' / U+32hex / 重複なし
 *   AC-3  … 連携された line_user_id が、その人が Bot に発話したときの Messaging userId と一致
 *           （= deploy-runbook G2 ゲート・LIFF の sub == Messaging userId の実測）
 *           根拠: link.invite_shown.user_ref は **Messaging webhook が運んだ userId**（LINE 由来）、
 *                 customer_linkages.line_user_id は **LIFF id_token の sub**（LINE Login 由来）。
 *                 この 2 つが一致することが「同一プロバイダで sub が Messaging userId になっている」
 *                 ことの直接証拠になる。さらに実際の注文照会応答で本人の注文が返ることを裏取りする。
 *
 * 安全:
 *   - 接続先は staging Supabase（ref 固定・fail-closed）のみ。書き込みなし。
 *   - installTestFetchGuard により本番 worker / 本番 Supabase への outbound は throw する。
 *   - Shopify / LINE / 本番 OA には一切接続しない。
 *
 * 使い方:
 *   npx tsx tests/staging/realdevice-verify.ts --baseline   # 実機テスト前のスナップショット
 *   npx tsx tests/staging/realdevice-verify.ts              # 実機テスト後の判定
 *   npx tsx tests/staging/realdevice-verify.ts --since 2026-07-22T03:00:00Z  # 判定窓を絞る
 */

import dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  assertAllowedTestTarget,
  assertNoProdMarker,
  installTestFetchGuard,
  ProdContactError,
  PROD_SUPABASE_REF,
} from "../lib/assert-not-prod";

dotenv.config({ path: ".dev.vars" });
installTestFetchGuard("realdevice-verify");

/** staging Supabase ref（設計 §5・prod は別 ref）。 */
const STAGING_SUPABASE_REF = "espeokdhutgztksdrpzt";
/** 開発ストア elxea-test2 のテスト顧客 id（実機で連携する相手）。 */
const TEST_SHOPIFY_CUSTOMER_ID = "24858806714740";
/** m6 e2e の合成 Messaging userId 前缀（実機行と区別する）。 */
const SYNTHETIC_PREFIX = "Ue6a11";
/** Messaging userId の形式（web-auth.ts:154 と同一）。 */
const MESSAGING_USER_ID_RE = /^U[0-9a-f]{32}$/;
/** 開発ストアに実在する注文番号（本人の注文が返ったことの判定語）。 */
const EXPECTED_ORDER_NUMBERS = ["1001", "1002", "1003", "1004"];

const baseline = process.argv.includes("--baseline");
const sinceArg = (() => {
  const i = process.argv.indexOf("--since");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

type Verdict = "PASS" | "FAIL" | "WARN";
const results: Array<{ verdict: Verdict; name: string; detail: string }> = [];
function record(verdict: Verdict, name: string, detail: string): Verdict {
  results.push({ verdict, name, detail });
  console.log(`  [${verdict}] ${name}${detail ? ` — ${detail}` : ""}`);
  return verdict;
}
function check(name: string, pass: boolean, detail: string): Verdict {
  return record(pass ? "PASS" : "FAIL", name, detail);
}

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

type LinkageRow = {
  line_user_id: string;
  shopify_customer_id: string;
  shopify_email: string | null;
  source: string | null;
  linked_at: string;
};

type FlowEventRow = {
  event_name: string;
  user_ref: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

async function main() {
  const supabase = stagingSupabase();
  console.log("=".repeat(72));
  console.log(`実機テスト検証 — mode=${baseline ? "BASELINE（事前スナップショット）" : "VERIFY（判定）"}`);
  console.log(`target : staging Supabase (${STAGING_SUPABASE_REF}) / 読み取りのみ`);
  if (sinceArg) console.log(`since  : ${sinceArg}`);
  console.log("=".repeat(72));

  // ---------------------------------------------------------------------
  // 1. customer_linkages（全行を見る。実機行は合成前缀を持たない行）
  // ---------------------------------------------------------------------
  const { data: allLinks, error: linkErr } = await supabase
    .from("customer_linkages")
    .select("line_user_id, shopify_customer_id, shopify_email, source, linked_at")
    .order("linked_at", { ascending: false })
    .limit(50);
  if (linkErr) throw new Error(`customer_linkages 読み取り失敗: ${linkErr.message}`);
  const links = (allLinks ?? []) as LinkageRow[];

  console.log("\n[1] customer_linkages（全行）");
  if (links.length === 0) console.log("  (0 行)");
  for (const r of links) {
    const tag = r.line_user_id.startsWith(SYNTHETIC_PREFIX) ? " <合成>" : "";
    console.log(
      `  - ${r.line_user_id} -> ${r.shopify_customer_id} (source=${r.source ?? "null"}, ${r.linked_at})${tag}`,
    );
  }

  const liffRows = links.filter(
    (r) => r.source === "liff" && !r.line_user_id.startsWith(SYNTHETIC_PREFIX),
  );
  const realLink = liffRows[0] ?? null;

  // ---------------------------------------------------------------------
  // 2. flow_events（link.invite_shown / link.completed）
  // ---------------------------------------------------------------------
  let feQuery = supabase
    .from("flow_events")
    .select("event_name, user_ref, metadata, created_at")
    .in("event_name", ["link.invite_shown", "link.completed"])
    .order("created_at", { ascending: false })
    .limit(50);
  if (sinceArg) feQuery = feQuery.gte("created_at", sinceArg);
  const { data: feData, error: feErr } = await feQuery;
  if (feErr) throw new Error(`flow_events 読み取り失敗: ${feErr.message}`);
  const events = ((feData ?? []) as FlowEventRow[]).filter(
    (e) => !e.user_ref.startsWith(SYNTHETIC_PREFIX),
  );

  console.log("\n[2] flow_events（link.* / 合成 ID を除く）");
  if (events.length === 0) console.log("  (0 件)");
  for (const e of events) {
    console.log(`  - ${e.created_at} ${e.event_name} user_ref=${e.user_ref} metadata=${JSON.stringify(e.metadata)}`);
  }

  const inviteShown = events.filter((e) => e.event_name === "link.invite_shown");
  const linkCompleted = events.filter((e) => e.event_name === "link.completed");

  if (baseline) {
    console.log("\n[BASELINE] 上記が実機テスト**前**の状態。実機後にこのコマンドを --baseline なしで再実行する。");
    console.log(`  実機後の判定窓に使える --since: ${new Date().toISOString()}`);
    return;
  }

  // ---------------------------------------------------------------------
  // 3. 判定
  // ---------------------------------------------------------------------
  console.log("\n[3] 判定");

  // T-1b: 連携ボタンを出した事実
  const t1b = check(
    "T-1b 便益 1 行 + 連携ボタンをトークに出した（link.invite_shown）",
    inviteShown.length > 0,
    inviteShown.length > 0
      ? `surface=${JSON.stringify(inviteShown[0].metadata)} at ${inviteShown[0].created_at}`
      : "link.invite_shown が 0 件（トリガー語が届いていない / LIFF_LINKAGE_URL 未設定 / webhook 不達）",
  );

  // AC-2: customer_linkages に source=liff の実機行が 1 行
  const ac2a = check(
    "AC-2a customer_linkages に source='liff' の実機行がある",
    realLink !== null,
    realLink
      ? `${realLink.line_user_id} -> ${realLink.shopify_customer_id} at ${realLink.linked_at}`
      : "source='liff' の実機行が無い（LIFF ページで連携完了に到達していない）",
  );

  if (realLink) {
    check(
      "AC-2b line_user_id が Messaging userId 形式（U + 32hex）",
      MESSAGING_USER_ID_RE.test(realLink.line_user_id),
      realLink.line_user_id,
    );
    check(
      "AC-2c 連携先がテスト顧客（開発ストア elxea-test2）",
      realLink.shopify_customer_id === TEST_SHOPIFY_CUSTOMER_ID,
      `${realLink.shopify_customer_id}（期待 ${TEST_SHOPIFY_CUSTOMER_ID}）`,
    );
    const sameCustomer = links.filter(
      (r) => r.shopify_customer_id === realLink.shopify_customer_id,
    );
    check(
      "AC-2d 同一 shopify_customer_id の行が 1 本だけ（.single() を壊さない）",
      sameCustomer.length === 1,
      `${sameCustomer.length} 本: ${sameCustomer.map((r) => `${r.line_user_id}(${r.source})`).join(", ")}`,
    );
    check(
      "AC-2e flow_events に link.completed(source=liff) がある",
      linkCompleted.some((e) => e.user_ref === realLink.line_user_id),
      linkCompleted.length > 0 ? JSON.stringify(linkCompleted[0]) : "0 件",
    );
  }

  // AC-3（G2 の核心）: Messaging userId == LIFF id_token の sub
  if (realLink && inviteShown.length > 0) {
    const matching = inviteShown.find((e) => e.user_ref === realLink.line_user_id);
    check(
      "AC-3-core LIFF の sub が Messaging userId と一致（invite_shown.user_ref == customer_linkages.line_user_id）",
      Boolean(matching),
      matching
        ? `一致: ${realLink.line_user_id}`
        : `不一致: messaging=${inviteShown.map((e) => e.user_ref).join(",")} / liff_sub=${realLink.line_user_id}` +
          " → LIFF の LINE Login チャネルとテスト OA の Messaging チャネルが別プロバイダの疑い（S2 不成立）",
    );
  } else if (!baseline) {
    record("FAIL", "AC-3-core LIFF の sub が Messaging userId と一致", "前提（invite_shown / liff 行）が揃っていない");
  }

  // AC-3 裏取り: 本人の注文が返ったか
  if (realLink) {
    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .select("role, content, created_at")
      .eq("user_id", realLink.line_user_id)
      .gte("created_at", realLink.linked_at)
      .order("created_at", { ascending: true })
      .limit(40);
    if (convErr) throw new Error(`conversations 読み取り失敗: ${convErr.message}`);
    const assistantRows = (conv ?? []).filter((r) => (r as { role: string }).role === "assistant");
    const hit = assistantRows.find((r) =>
      EXPECTED_ORDER_NUMBERS.some((n) => new RegExp(`#?\\b${n}\\b`).test(String((r as { content: string }).content))),
    );
    check(
      "AC-3 連携後に注文照会で本人の注文が返った（#1001-#1004 のいずれかを含む応答）",
      Boolean(hit),
      hit
        ? JSON.stringify(String((hit as { content: string }).content).slice(0, 300))
        : `連携後の assistant 応答 ${assistantRows.length} 件に注文番号なし` +
          (assistantRows.length > 0
            ? `（最後の応答: ${JSON.stringify(String((assistantRows[assistantRows.length - 1] as { content: string }).content).slice(0, 200))}）`
            : ""),
    );
  }

  // ---------------------------------------------------------------------
  // 4. negative control（本番宛先がガードで拒否されること）
  // ---------------------------------------------------------------------
  console.log("\n[4] negative control — 本番宛先は fail-closed");
  for (const t of [
    "https://elxea-agent.setaka-on.workers.dev/webhook/line",
    `https://${PROD_SUPABASE_REF}.supabase.co/rest/v1/customer_linkages`,
  ]) {
    try {
      assertAllowedTestTarget(t, "negative control");
      record("FAIL", "prod guard", `拒否されなかった: ${t}`);
    } catch (e) {
      record(e instanceof ProdContactError ? "PASS" : "FAIL", "prod guard", `${t} を拒否`);
    }
  }

  // ---------------------------------------------------------------------
  // 5. サマリ
  // ---------------------------------------------------------------------
  const fails = results.filter((r) => r.verdict === "FAIL");
  console.log("\n" + "=".repeat(72));
  console.log(
    `結果: PASS=${results.filter((r) => r.verdict === "PASS").length} / FAIL=${fails.length} / WARN=${results.filter((r) => r.verdict === "WARN").length}`,
  );
  if (fails.length > 0) {
    console.log("FAIL 一覧:");
    for (const f of fails) console.log(`  - ${f.name}: ${f.detail}`);
  }
  console.log("=".repeat(72));
  void t1b;
  void ac2a;
  process.exit(fails.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
