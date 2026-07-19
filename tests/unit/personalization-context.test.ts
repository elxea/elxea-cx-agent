/**
 * Unit Tests — A-1 文脈接続（personalization-context 断片ビルダー）
 *
 * 検証範囲（設計 v2・A-1）:
 *   - 事実ゼロ → 空文字（何も注入しない）
 *   - persona / 入口 / +1 銘柄 / tasteProfile を注入し、それぞれのラベルが出る
 *   - 境界 4 ルールが必ず全て含まれる
 *   - 入口の未知値は注入しない（marche/online/other のみ）
 *   - ビルダーは渡された事実のみ扱う（-1 等の負の事実は呼び出し側が渡さない＝出ない）
 *
 * 使用: npx tsx tests/unit/personalization-context.test.ts
 */

import {
  buildPersonalizationContext,
  hasAnyFact,
  BOUNDARY_RULES,
  type PersonalizationFacts,
} from "../../src/lib/personalization-context";
import type { TasteProfile } from "../../src/lib/firestore";

let total = 0;
let passed = 0;
const failures: string[] = [];
function it(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  [FAIL] ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

const emptyFacts: PersonalizationFacts = {
  persona: null,
  entrySource: null,
  ratedGoodLabels: [],
  tasteProfile: null,
};

const taste: TasteProfile = {
  preferredCategories: ["green", "oolong"],
  flavorPreferences: ["floral"],
  scenePref: "evening",
};

it("事実ゼロ → 空文字（注入なし）", () => {
  assert(hasAnyFact(emptyFacts) === false, "hasAnyFact=false");
  assert(buildPersonalizationContext(emptyFacts) === "", "空文字");
});

it("persona を注入するとラベルと境界ルールが出る", () => {
  const out = buildPersonalizationContext({ ...emptyFacts, persona: "explorer" });
  assert(out.includes("探求"), "persona ラベル");
  for (const rule of BOUNDARY_RULES) assert(out.includes(rule), `境界ルール: ${rule.slice(0, 6)}`);
});

it("入口 marche/online/other を注入する", () => {
  assert(buildPersonalizationContext({ ...emptyFacts, entrySource: "marche" }).includes("マルシェ"), "marche");
  assert(buildPersonalizationContext({ ...emptyFacts, entrySource: "online" }).includes("オンライン"), "online");
  assert(buildPersonalizationContext({ ...emptyFacts, entrySource: "other" }).includes("その他"), "other");
});

it("+1 銘柄ラベルを注入する", () => {
  const out = buildPersonalizationContext({
    ...emptyFacts,
    ratedGoodLabels: ["11301｜やぶきた", "20101｜べにふうき"],
  });
  assert(out.includes("11301｜やぶきた"), "銘柄1");
  assert(out.includes("20101｜べにふうき"), "銘柄2");
  assert(out.includes("おいしかった"), "positive ラベル");
});

it("tasteProfile を注入する", () => {
  const out = buildPersonalizationContext({ ...emptyFacts, tasteProfile: taste });
  assert(out.includes("green") && out.includes("oolong"), "カテゴリ");
  assert(out.includes("floral"), "フレーバー");
  assert(out.includes("evening"), "シーン");
});

it("境界 4 ルールが常に全て含まれる（事実 1 つでも）", () => {
  const out = buildPersonalizationContext({ ...emptyFacts, ratedGoodLabels: ["11301｜x"] });
  assert(BOUNDARY_RULES.length === 4, "4 ルール");
  for (const rule of BOUNDARY_RULES) assert(out.includes(rule), "含む");
  // ルール1 が「マイナス評価・休眠・離脱に言及しない」制約を明文化していること。
  assert(out.includes("マイナス評価") && out.includes("言葉にしない"), "負の事実の非言及ルール");
  assert(out.includes("覚えています"), "メタ発言禁止ルール");
});

it("hasAnyFact は空 tasteProfile を事実として数えない", () => {
  const emptyTaste: TasteProfile = { preferredCategories: [], flavorPreferences: [], scenePref: null };
  assert(hasAnyFact({ ...emptyFacts, tasteProfile: emptyTaste }) === false, "空 taste は非事実");
});

console.log("\n============================================================");
console.log("personalization-context Test Results");
console.log("============================================================");
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${total - passed}`);
if (failures.length > 0) process.exit(1);
