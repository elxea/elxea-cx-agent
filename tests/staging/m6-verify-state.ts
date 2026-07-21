/**
 * M6 状態確認 — 投入した合成連携行と、本番非接触ガードの negative control を確認する。
 *
 * - staging Supabase の customer_linkages / conversations / flow_events を読むだけ（書き込みなし）。
 * - 本番宛先がガードで確実に throw することを negative control で実証する（T-11 の根拠）。
 */
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import {
  assertAllowedTestTarget,
  assertNoProdMarker,
  installTestFetchGuard,
  ProdContactError,
  PROD_SUPABASE_REF,
} from "../lib/assert-not-prod";

dotenv.config({ path: ".dev.vars" });
installTestFetchGuard("m6-verify-state");

const STAGING_REF = "espeokdhutgztksdrpzt";
const LINKED_ID = "Ue6a11000000000000000000000000001";
const UNLINKED_ID = "Ue6a11000000000000000000000000002";
const INVITE_ID = "Ue6a11000000000000000000000000003";

async function main() {
  const url = process.env.SUPABASE_URL_STAGING!;
  assertNoProdMarker(url, "SUPABASE_URL_STAGING");
  if (!url.includes(STAGING_REF)) throw new Error("staging ref でない。中断。");
  const supabase = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY_STAGING!);

  console.log(`Supabase ref: ${STAGING_REF} (prod ref ${PROD_SUPABASE_REF} には未接続)`);

  const { data: link } = await supabase
    .from("customer_linkages")
    .select("line_user_id, shopify_customer_id, shopify_email, source, linked_at")
    .in("line_user_id", [LINKED_ID, UNLINKED_ID, INVITE_ID]);
  console.log("\n[customer_linkages] 合成行:");
  console.log(JSON.stringify(link, null, 2));

  const { data: evts } = await supabase
    .from("flow_events")
    .select("event_name, user_ref, metadata, created_at")
    .eq("event_name", "link.invite_shown")
    .in("user_ref", [INVITE_ID])
    .order("created_at", { ascending: false })
    .limit(3);
  console.log("\n[flow_events] link.invite_shown:");
  console.log(JSON.stringify(evts, null, 2));

  const { count } = await supabase
    .from("conversations")
    .select("*", { count: "exact", head: true })
    .in("user_id", [LINKED_ID, UNLINKED_ID, INVITE_ID]);
  console.log(`\n[conversations] 合成 ID の行数: ${count}`);

  // --- negative control: 本番宛先は fail-closed で throw する ---
  console.log("\n[negative control] ガードが本番宛先を拒否するか");
  const prodTargets = [
    "https://elxea-agent.setaka-on.workers.dev/webhook/line",
    `https://${PROD_SUPABASE_REF}.supabase.co/rest/v1/customer_linkages`,
  ];
  for (const t of prodTargets) {
    try {
      assertAllowedTestTarget(t, "negative control");
      console.log(`  [FAIL] 拒否されなかった: ${t}`);
      process.exit(1);
    } catch (e) {
      const ok = e instanceof ProdContactError;
      console.log(`  [${ok ? "PASS" : "FAIL"}] ${t} → ${e instanceof Error ? e.message.slice(0, 120) : e}`);
      if (!ok) process.exit(1);
    }
  }
  // fetch レイヤでも塞がれること（送信前に throw する）。
  try {
    await fetch("https://elxea-agent.setaka-on.workers.dev/");
    console.log("  [FAIL] fetch ガードが本番 worker を通した");
    process.exit(1);
  } catch (e) {
    console.log(`  [PASS] fetch ガード: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
  }
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
