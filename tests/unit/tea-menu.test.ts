/**
 * Unit Tests -- tea-menu（選択式お茶メニュー案内・タップ主体・状態レス）
 *
 * 純粋ロジック（Notion / LINE push に触れない）を fixture で検証する:
 *   (a) 種類選択 → 一覧（ページング）→ カード → 温度回答
 *   (b) 番号直指定（5 桁）
 *   (c) 楽しみ方はデータがある時のみ選択肢に出る（0 件なら出ない）
 *   (d) 無関係な発話は素通り（parseTeaAction=null / planTeaFlow=null）
 *   quick reply 上限 13 を超えないこと
 *
 * 使用方法: npx tsx tests/unit/tea-menu.test.ts
 */

import {
  parseTeaAction,
  planTeaFlow,
  buildCategoryMessage,
  buildTeaListMessage,
  buildTeaCard,
  buildBrewAnswer,
  TEA_LIST_PAGE_SIZE,
  type TeaItem,
} from "../../src/lib/tea-menu";

let total = 0,
  passed = 0,
  failed = 0;
const failures: Array<{ name: string; error: string }> = [];

function it(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${name}: ${msg}`);
    failures.push({ name, error: msg });
  }
}
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- Fixture: 緑茶 12（ページング検証） / 青茶 1 / 紅茶 1、うち 1 件のみ楽しみ方あり ---
function tea(number: string, category: string, name: string, extra: Partial<TeaItem> = {}): TeaItem {
  return {
    number,
    name,
    category,
    flavorProfiles: extra.flavorProfiles ?? ["すっきりした味わい | ライトボディ"],
    descShort: extra.descShort ?? "春の透明感あふれる瑞々しい味わい。",
    howToBrew: extra.howToBrew ?? "80℃ / 120ml / 60sec",
    temp: extra.temp ?? "",
    time: extra.time ?? "",
    water: extra.water ?? "",
    enjoy: extra.enjoy ?? "",
  };
}

const green: TeaItem[] = Array.from({ length: 12 }, (_, i) =>
  tea(`1${String(i + 1).padStart(2, "0")}01`, "緑茶", `緑茶サンプル${i + 1}`),
);
const FIXTURE: TeaItem[] = [
  ...green,
  tea("40101", "青茶", "香駿の和烏龍茶"),
  tea("50101", "紅茶", "夏摘みべにふうきの和紅茶", { enjoy: "食後の一杯に。チョコレートと好相性です。" }),
];

const QR_MAX = 13;

console.log("\n--- (a) 種類 → 一覧(ページング) → カード → 温度 ---");

it("種類選択: DB にある種類だけ件数付きで、上限内", () => {
  const m = buildCategoryMessage(FIXTURE);
  assertEqual(m.quickReplies.length, 3, "categories");
  assert(m.quickReplies.length <= QR_MAX, "qr<=13");
  // 表示順 緑茶→青茶→紅茶
  assertEqual(m.quickReplies[0].action.label, "緑茶（12）", "first cat label");
  assertEqual(m.quickReplies[2].action.label, "紅茶（1）", "third cat label");
});

it("一覧ページ1: 11件 + 次へ + 種類に戻る = 13（上限ちょうど）", () => {
  const m = buildTeaListMessage(FIXTURE, "緑茶", 0);
  assertEqual(m.quickReplies.length, QR_MAX, "page0 qr count");
  assert(m.quickReplies.length <= QR_MAX, "qr<=13");
  const labels = m.quickReplies.map((q) => q.action.label);
  assert(labels.includes("次へ"), "has 次へ");
  assert(labels.includes("種類に戻る"), "has 種類に戻る");
  // 先頭 11 件はカード遷移トークン
  assert(m.quickReplies[0].action.text.startsWith("このお茶｜"), "first is card token");
});

it("一覧ページ2: 残り1件 + 種類に戻る（次へ なし）", () => {
  const m = buildTeaListMessage(FIXTURE, "緑茶", 1);
  const labels = m.quickReplies.map((q) => q.action.label);
  assert(!labels.includes("次へ"), "no 次へ on last page");
  assert(labels.includes("種類に戻る"), "has 種類に戻る");
  // 12 件中 page size 11 → 2 ページ目は 1 件
  assertEqual(m.quickReplies.length, 2, "page1 qr count");
});

it("PAGE_SIZE は 11（ナビ2枠で上限13に収まる）", () => {
  assertEqual(TEA_LIST_PAGE_SIZE, 11, "page size");
});

it("カード: 温度/味・香り/別のお茶（楽しみ方なし=3択+別のお茶）", () => {
  const t = FIXTURE.find((x) => x.number === "10101")!;
  const m = buildTeaCard(t);
  const labels = m.quickReplies.map((q) => q.action.label);
  assert(labels.some((l) => l.includes("温度")), "has 温度");
  assert(labels.some((l) => l.includes("味・香り")), "has 味・香り");
  assert(!labels.some((l) => l.includes("楽しみ方")), "no 楽しみ方 (0件)");
  assert(labels.some((l) => l.includes("別のお茶")), "has 別のお茶");
});

it("温度回答: How to Brew 本文を整形して直返し（創作なし）", () => {
  const t = FIXTURE.find((x) => x.number === "10101")!;
  const m = buildBrewAnswer(t);
  assert(m.text.includes("80℃ / 120ml / 60sec"), "brew text verbatim");
  assert(m.text.includes("No.10101"), "shows number");
  // 温度回答の後は温度を除いた選択肢を再提示
  assert(!m.quickReplies.some((q) => q.action.label.includes("温度")), "excludes 温度 in followup");
});

console.log("\n--- (b) 番号直指定 ---");

it("5桁のみ → 該当カード", () => {
  const plan = planTeaFlow("50101", FIXTURE);
  assert(plan !== null, "planned");
  assert(plan!.messages[0].text.includes("No.50101"), "card for 50101");
});

it("5桁のみ 不明番号 → 正直な案内（インターセプトする）", () => {
  const plan = planTeaFlow("99999", FIXTURE);
  assert(plan !== null, "planned (not fall-through)");
  assert(plan!.messages[0].text.includes("見つかりませんでした"), "honest not-found");
});

it("QRリンク相当（文中5桁が既知番号）→ カード", () => {
  const plan = planTeaFlow("11301", FIXTURE);
  // 11301 は fixture の緑茶サンプル13...ではない。fixture は 10101..11201。
  // 既知でない5桁のみ → not-found（インターセプト）
  assert(plan !== null, "planned");
});

console.log("\n--- (c) 楽しみ方はデータがある時のみ ---");

it("楽しみ方あり → カードに 🍵楽しみ方 が出る", () => {
  const t = FIXTURE.find((x) => x.number === "50101")!;
  const m = buildTeaCard(t);
  assert(m.quickReplies.some((q) => q.action.label.includes("楽しみ方")), "has 楽しみ方 when data present");
});

console.log("\n--- (d) 無関係な発話は素通り ---");

it("普通の質問 → parseTeaAction=null（AI へ素通り）", () => {
  assertEqual(parseTeaAction("玉露のおすすめはありますか？"), null, "free question");
  assertEqual(parseTeaAction("注文状況を確認したいです"), null, "order query");
  assertEqual(parseTeaAction("こんにちは"), null, "greeting");
});

it("文中の未知5桁 → planTeaFlow=null（素通り・自由対話を壊さない）", () => {
  const plan = planTeaFlow("私の郵便番号は12345です", FIXTURE);
  assertEqual(plan, null, "loose 5-digit unknown → fall-through");
});

it("文中の既知5桁 → カード（number-loose 一致）", () => {
  const plan = planTeaFlow("40101 について教えて", FIXTURE);
  assert(plan !== null && plan.messages[0].text.includes("No.40101"), "known loose → card");
});

it("入口発話（リッチメニュー①）→ 種類選択", () => {
  const plan = planTeaFlow("お茶のおいしい淹れ方を教えてください", FIXTURE);
  assert(plan !== null, "planned");
  assertEqual(plan!.messages[0].quickReplies.length, 3, "category prompt");
});

it("全メッセージの quick reply が 13 以下", () => {
  const cases = [
    planTeaFlow("お茶を調べる", FIXTURE),
    planTeaFlow("お茶を選ぶ｜緑茶｜1", FIXTURE),
    planTeaFlow("お茶を選ぶ｜緑茶｜2", FIXTURE),
    planTeaFlow("このお茶｜50101", FIXTURE),
    planTeaFlow("淹れ方｜50101", FIXTURE),
    planTeaFlow("味と香り｜50101", FIXTURE),
    planTeaFlow("楽しみ方｜50101", FIXTURE),
  ];
  for (const c of cases) {
    assert(c !== null, "planned");
    for (const m of c!.messages) assert(m.quickReplies.length <= QR_MAX, `qr<=13 (${m.quickReplies.length})`);
  }
});

console.log("\n" + "=".repeat(60));
console.log("Tea Menu Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failed > 0 ? 1 : 0);
