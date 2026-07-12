/**
 * 選択式お茶メニュー案内の内部確認ハーネス（read-only・LINE push なし・デプロイ不要）。
 *
 * 実データ（Notion Tea Menu List / Status=販売中）を fetchSellingTeas で取得し、
 * planTeaFlow で (a)-(d) の各フローを deterministic に流して、送信されるはずの
 * テキストと quick reply を標準出力に表示する。LINE には一切送信しない。
 *
 * 実行:
 *   set -a; source .dev.vars; set +a
 *   npx tsx scripts/tea-menu-demo.ts
 */

import { fetchSellingTeas, planTeaFlow, type TeaItem } from "../src/lib/tea-menu";
import type { Env } from "../src/index";

function env(): Env {
  const e = process.env;
  if (!e.NOTION_TOKEN) throw new Error("NOTION_TOKEN 未設定（source .dev.vars してください）");
  return {
    NOTION_TOKEN: e.NOTION_TOKEN,
    NOTION_TEA_MENU_DB_ID: e.NOTION_TEA_MENU_DB_ID ?? "",
  } as unknown as Env;
}

function render(label: string, userMessage: string, teas: TeaItem[]) {
  console.log("\n" + "─".repeat(70));
  console.log(`▶ ${label}`);
  console.log(`  user: "${userMessage}"`);
  const plan = planTeaFlow(userMessage, teas);
  if (!plan) {
    console.log("  → 素通り（null）: 既存 AI 自由対話フローへ（インターセプトしない）");
    return;
  }
  for (const m of plan.messages) {
    console.log("  bot text:");
    for (const line of m.text.split("\n")) console.log(`    | ${line}`);
    console.log(`  quick replies (${m.quickReplies.length}件, 上限13):`);
    for (const q of m.quickReplies) {
      console.log(`    [${q.action.label}]  → "${q.action.text}"`);
    }
  }
}

async function main() {
  const teas = await fetchSellingTeas(env());
  console.log(`販売中のお茶: ${teas.length}件`);
  const byCat = new Map<string, number>();
  for (const t of teas) byCat.set(t.category, (byCat.get(t.category) ?? 0) + 1);
  console.log("種類別:", JSON.stringify(Object.fromEntries(byCat), null, 0));
  console.log("楽しみ方あり:", teas.filter((t) => t.enjoy.trim()).length, "件");

  // 実在番号を 1 件拾う
  const sample = teas.find((t) => t.number === "11301") ?? teas[0];

  console.log("\n\n==================== (a) 絞り込み → 一覧 → カード → 温度 ====================");
  render("a-1 入口（リッチメニュー①）→ 種類選択", "お茶のおいしい淹れ方を教えてください", teas);
  render("a-2 種類=緑茶 一覧ページ1", "お茶を選ぶ｜緑茶｜1", teas);
  render("a-3 種類=緑茶 一覧ページ2（ページング）", "お茶を選ぶ｜緑茶｜2", teas);
  render(`a-4 お茶カード（No.${sample.number}）`, `このお茶｜${sample.number}`, teas);
  render(`a-5 温度・抽出時間（No.${sample.number}）`, `淹れ方｜${sample.number}`, teas);
  render(`a-6 味・香り（No.${sample.number}）`, `味と香り｜${sample.number}`, teas);

  console.log("\n\n==================== (b) 番号直指定 ====================");
  render("b-1 5桁のみ（実在）", sample.number, teas);
  render("b-2 5桁のみ（不明番号）→ 正直な案内", "99999", teas);
  render("b-3 QRリンク相当（文中5桁が既知）", `${sample.number}`, teas);

  console.log("\n\n==================== (c) 楽しみ方（0件なので選択肢に出ない） ====================");
  render(`c-1 カードに楽しみ方が出ないこと（No.${sample.number}）`, `このお茶｜${sample.number}`, teas);
  render(`c-2 楽しみ方を直接叩いても正直に案内（No.${sample.number}）`, `楽しみ方｜${sample.number}`, teas);

  console.log("\n\n==================== (d) 既存の自由対話は素通り ====================");
  render("d-1 自由な淹れ方質問（別文言）", "玉露をおいしく淹れるコツは？", teas);
  render("d-2 注文照会", "最近の注文と定期便の状況を教えてください", teas);
  render("d-3 文中の未知5桁（郵便番号など）", "私の郵便番号は12345です", teas);
  render("d-4 挨拶", "こんにちは", teas);

  console.log("\n" + "─".repeat(70));
  console.log("完了（LINE への送信は行っていません）");
}

main().catch((e) => {
  console.error("ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
