/**
 * Unit Tests — brand-guard（ランタイム出力 egress の brand-fact ガード / ID-6701）
 *
 * AI が実行時に生成した応答に混じる非正本ブランド文言を、送信直前に正本語へ是正する。
 * 検証: (1) 検出 (2) 置換（正本語一致） (3) 正当表現の非検出（誤検知しない）。
 *
 * 使用: npx tsx tests/unit/brand-guard.test.ts
 */

import {
  guardBrandFacts,
  applyBrandGuard,
} from "../../src/lib/brand-guard";
import { BRAND_NAME_READING, COMPANY_NAME } from "../../src/lib/brand-copy";

let total = 0;
let passed = 0;
const queue: Array<{ name: string; fn: () => void }> = [];
function it(name: string, fn: () => void) {
  queue.push({ name, fn });
}
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

// --- (1)(2) 検出 + 置換 -----------------------------------------------------

it("読み仮名「エルシア」を正本読み仮名（エルクシア）へ置換する", () => {
  const r = guardBrandFacts("こんにちは、エルシアです。");
  assert(r.changed, "changed");
  assert(r.text.includes(BRAND_NAME_READING), "エルクシア に是正");
  assert(!r.text.includes("エルシア"), "エルシア が残らない");
  assert(r.violations.some((v) => v.ruleId === "reading"), "reading 違反を検出");
});

it("法人格「合同会社elxea」を正本法人名（株式会社elxea）へ置換する", () => {
  const r = guardBrandFacts("運営会社は合同会社elxeaです。");
  assert(r.text.includes(COMPANY_NAME), "株式会社elxea に是正");
  assert(!r.text.includes("合同会社"), "合同会社 が残らない");
  assert(r.violations.some((v) => v.ruleId === "company"), "company 違反を検出");
});

it("法人格「合同会社エルクシア」（読み仮名版）も置換する", () => {
  const r = guardBrandFacts("合同会社エルクシアが運営しています。");
  assert(r.text.includes(COMPANY_NAME), "株式会社elxea に是正");
  assert(!r.text.includes("合同会社"), "合同会社 が残らない");
});

it("ブランド自己紹介句「鹿児島を中心」を「日本各地」へ置換する", () => {
  const r = guardBrandFacts("elxea では、鹿児島を中心に各地のお茶を扱っています。");
  assert(r.text.includes("日本各地"), "日本各地 に是正");
  assert(!r.text.includes("鹿児島を中心"), "鹿児島を中心 が残らない");
  assert(r.violations.some((v) => v.ruleId === "origin"), "origin 違反を検出");
});

it("複数の非正本文言を 1 回で全て是正する", () => {
  const r = guardBrandFacts("エルシアは合同会社elxeaで、鹿児島を中心にお届けします。");
  assert(!r.text.includes("エルシア"), "エルシア 除去");
  assert(!r.text.includes("合同会社"), "合同会社 除去");
  assert(!r.text.includes("鹿児島を中心"), "鹿児島を中心 除去");
  assert(r.violations.length >= 3, "3 件以上の違反を検出");
});

it("同一語の複数出現を全て置換する", () => {
  const r = guardBrandFacts("エルシア、そしてまたエルシア。");
  assert(!r.text.includes("エルシア"), "全出現を除去");
  const readingHits = r.violations.filter((v) => v.ruleId === "reading").length;
  assert(readingHits === 2, "2 件検出");
});

// --- (3) 正当表現の非検出（誤検知しない） -----------------------------------

it("商品産地の事実「鹿児島産の茶葉」は是正しない（誤検知しない）", () => {
  const src = "こちらは鹿児島産の茶葉を使った深蒸し煎茶です。";
  const r = guardBrandFacts(src);
  assert(!r.changed, "変化なし");
  assert(r.text === src, "原文のまま");
  assert(r.violations.length === 0, "違反なし");
});

it("産地名の言及「知覧の煎茶」「鹿児島も含めて」は是正しない", () => {
  const src = "鹿児島も含めて様々な産地のお茶があります。知覧の煎茶もおすすめです。";
  const r = guardBrandFacts(src);
  assert(!r.changed, "変化なし");
  assert(r.violations.length === 0, "違反なし");
});

it("否定文脈「スキンケア用品は扱っていません」は是正しない（誤検知しない）", () => {
  const src = "スキンケア用品は扱っていません。お茶専門のお店です。";
  const r = guardBrandFacts(src);
  assert(!r.changed, "変化なし");
  assert(r.violations.length === 0, "違反なし（スキンケアはランタイム置換対象外）");
});

it("記事本文の散文「静かな豊かさ」は是正しない（編集的散文を壊さない）", () => {
  const src = "季節の巡りが、日常の中に静かな豊かさをもたらします。";
  const r = guardBrandFacts(src);
  assert(!r.changed, "変化なし");
  assert(r.violations.length === 0, "違反なし（静かな豊かさはランタイム置換対象外）");
});

it("正本文言「日本各地の小規模茶農家」「株式会社elxea」は是正しない", () => {
  const src =
    "elxea（エルクシア）は日本各地の小規模茶農家さんから厳選します。運営会社は株式会社elxeaです。";
  const r = guardBrandFacts(src);
  assert(!r.changed, "変化なし");
  assert(r.violations.length === 0, "違反なし");
});

// --- applyBrandGuard（ラッパ）----------------------------------------------

it("applyBrandGuard は是正後テキストを返す（無応答にしない）", () => {
  const out = applyBrandGuard("エルシアのお店です。", { channel: "line", userId: "u1" });
  assert(out.includes(BRAND_NAME_READING), "是正後テキスト");
  assert(out.length > 0, "空応答にしない");
});

it("applyBrandGuard は正当文をそのまま返す", () => {
  const src = "鹿児島産の茶葉です。";
  const out = applyBrandGuard(src, { channel: "web" });
  assert(out === src, "原文のまま");
});

it("空文字は安全に扱う", () => {
  const r = guardBrandFacts("");
  assert(r.text === "", "空文字");
  assert(!r.changed, "変化なし");
  assert(r.violations.length === 0, "違反なし");
});

for (const t of queue) {
  total++;
  try {
    t.fn();
    passed++;
    console.log(`  [PASS] ${t.name}`);
  } catch (err) {
    console.log(`  [FAIL] ${t.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log("\n============================================================");
console.log("brand-guard Test Results");
console.log("============================================================");
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${total - passed}`);
if (passed < total) process.exit(1);
