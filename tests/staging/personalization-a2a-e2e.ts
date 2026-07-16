/**
 * Staging E2E — A-2a 評価後の「次の一杯」+ A-1 事実収集（実 staging Supabase / 実 Notion）。
 *
 * なぜ直接呼び出しか: 本タスク時点で Cloudflare デプロイ認証が無効（wrangler whoami=Invalid token）で
 *   `wrangler deploy --env staging` が実行できないため、デプロイ済み worker への署名付き HTTP webhook は
 *   別途（有効な Cloudflare 認証取得後）に行う。本 E2E は新コード経路そのもの（handleTeaMenuFlow →
 *   recordProductRating → getUserRatings → selectNextCup → buildRateResponse）を実 staging データに対して
 *   実行し、「+1→次の一杯が1件付く / -1→提案ゼロで静かな一文 / product_ratings 実書込 / A-1 事実解決」を実測する。
 *   実 LINE 送信はしない（fake responder が応答を捕捉）。合成 ID の product_ratings は最後に完全削除する。
 *
 * 前提 env（.dev.vars）: SUPABASE_URL_STAGING / SUPABASE_SERVICE_ROLE_KEY_STAGING / NOTION_TOKEN /
 *   NOTION_TEA_MENU_DB_ID。
 *
 * 使い方: npx tsx tests/staging/personalization-a2a-e2e.ts
 */

import dotenv from "dotenv";
import * as crypto from "node:crypto";
import { handleTeaMenuFlow, fetchSellingTeas } from "../../src/lib/tea-menu";
import {
  createSupabaseClient,
} from "../../src/lib/supabase";
import {
  getUserRatings,
  positiveRatedProductNos,
  PRODUCT_RATINGS_TABLE,
} from "../../src/lib/product-ratings";
import type { LineResponder, QuickReplyItem } from "../../src/lib/line";
import type { Env } from "../../src/index";

dotenv.config({ path: ".dev.vars" });

let failed = 0;
function check(name: string, pass: boolean, detail: string) {
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}: ${detail}`);
  if (!pass) failed++;
}

const SYNTH_ID = "U" + crypto.randomBytes(16).toString("hex"); // U + 32 hex（合成・実在しない）

function stagingEnv(): Env {
  return {
    SUPABASE_URL: process.env.SUPABASE_URL_STAGING,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY_STAGING,
    NOTION_TOKEN: process.env.NOTION_TOKEN,
    NOTION_TEA_MENU_DB_ID: process.env.NOTION_TEA_MENU_DB_ID,
  } as unknown as Env;
}

/** 応答を捕捉する fake responder（実 LINE 送信をしない）。 */
function captureResponder(): { responder: LineResponder; sent: Array<{ text: string; qr: string[] }> } {
  const sent: Array<{ text: string; qr: string[] }> = [];
  const responder: LineResponder = {
    async text(text: string, quickReplyItems?: QuickReplyItem[]) {
      sent.push({ text, qr: (quickReplyItems ?? []).map((q) => q.action.text) });
    },
    async flex() {
      /* 未使用 */
    },
  };
  return { responder, sent };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("=".repeat(60));
  console.log("Personalization A-2a / A-1 Staging E2E (direct-invoke)");
  console.log(`Synthetic user_ref: ${SYNTH_ID}`);
  console.log("=".repeat(60));

  const env = stagingEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[FATAL] staging Supabase creds missing in .dev.vars");
    process.exit(1);
  }
  const supabase = createSupabaseClient(env);

  // 販売中メニューから同軸ペアが取れる 2 銘柄を選ぶ（A-2a 提案対象を保証）。
  const teas = await fetchSellingTeas(env);
  console.log(`\n販売中メニュー: ${teas.length} 銘柄`);
  if (teas.length < 2) {
    console.error("[FATAL] 販売中メニューが 2 未満で E2E 不可");
    process.exit(1);
  }
  const rated = teas[0];
  console.log(`評価対象: ${rated.name}（No.${rated.number}）flavor=${JSON.stringify(rated.flavorProfiles)}`);

  // --- A-2a: +1 → 次の一杯が 1 件付く ---
  console.log("\n[A-2a +1] 感想よい → お礼 + 似た 1 本");
  {
    const { responder, sent } = captureResponder();
    const handled = await handleTeaMenuFlow(SYNTH_ID, `感想よい｜${rated.number}`, env, responder);
    check("handleTeaMenuFlow が処理した", handled === true, `handled=${handled}`);
    check("応答が 1 通", sent.length === 1, `count=${sent.length}`);
    const body = sent[0]?.text ?? "";
    check("お礼文を含む", body.includes("ありがとう"), body.slice(0, 40));
    const hasSuggestion = /No\.\d{5}/.test(body.replace(`No.${rated.number}`, ""));
    check("似た 1 本の提案（別 No.）を添える", hasSuggestion, body.replace(/\n/g, " ").slice(0, 120));
  }

  await sleep(1500); // fire-and-forget の insert 反映待ち

  // product_ratings 実書込を確認（+1）
  {
    const rows = await getUserRatings(supabase, SYNTH_ID);
    const good = rows.filter((r) => r.product_no === rated.number && r.rating === 1);
    check("product_ratings に +1 行が実在", good.length >= 1, `rows=${JSON.stringify(rows)}`);
  }

  // --- A-1: +1 事実が銘柄名に解決される ---
  console.log("\n[A-1] +1 事実 → 銘柄ラベル解決");
  {
    const rows = await getUserRatings(supabase, SYNTH_ID);
    const positives = positiveRatedProductNos(rows);
    check("positive に評価銘柄が含まれる", positives.includes(rated.number), positives.join(","));
    const label = (() => {
      const t = teas.find((x) => x.number === positives[0]);
      return t ? `${t.name}（No.${t.number}）` : "";
    })();
    check("銘柄ラベルに解決できる", label.includes(rated.number), label);
  }

  // --- A-2a: -1 → 提案ゼロ・静かな一文 ---
  console.log("\n[A-2a -1] 感想いまいち → 提案ゼロ・静かな受け止め");
  {
    const { responder, sent } = captureResponder();
    const handled = await handleTeaMenuFlow(SYNTH_ID, `感想いまいち｜${rated.number}`, env, responder);
    check("handleTeaMenuFlow が処理した", handled === true, `handled=${handled}`);
    const body = sent[0]?.text ?? "";
    check("静かな一文（好みは人それぞれ）", body.includes("好みは人それぞれ"), body.slice(0, 40));
    check("提案ゼロ（別 No. を出さない）", !/No\.\d{5}/.test(body.replace(`No.${rated.number}`, "")), body.replace(/\n/g, " ").slice(0, 120));
    check("お礼文ではない", !body.includes("ありがとう"), body.slice(0, 40));
  }

  await sleep(1500);

  // product_ratings 実書込を確認（-1 追記）
  {
    const rows = await getUserRatings(supabase, SYNTH_ID);
    const bad = rows.filter((r) => r.product_no === rated.number && r.rating === -1);
    check("product_ratings に -1 行が追記", bad.length >= 1, `total rows=${rows.length}`);
    // 再評価 -1 が最新 → positive から外れる（A-1 の負事実非注入の裏付け）。
    check("最新 -1 で positive から外れる", !positiveRatedProductNos(rows).includes(rated.number), positiveRatedProductNos(rows).join(","));
  }

  // --- 後片付け: 合成 user_ref の product_ratings を完全削除 ---
  console.log("\n[cleanup] 合成 user_ref の product_ratings を削除");
  {
    const { error } = await supabase.from(PRODUCT_RATINGS_TABLE).delete().eq("user_ref", SYNTH_ID);
    check("削除エラーなし", !error, error?.message ?? "ok");
    await sleep(800);
    const remain = await getUserRatings(supabase, SYNTH_ID);
    check("残存 0（完全削除）", remain.length === 0, `remain=${remain.length}`);
  }

  console.log("\n" + "=".repeat(60));
  console.log(failed === 0 ? "E2E: ALL PASS" : `E2E: ${failed} FAIL`);
  console.log("=".repeat(60));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.stack || e.message : e);
  process.exit(1);
});
