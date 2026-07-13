/**
 * Unit Tests -- tea-menu（選択式お茶メニュー案内・タップ主体・状態レス）
 *
 * タップ圧縮版（オーナー確定 2026-07-13「3 タップ以内」）の純粋ロジックを fixture で検証する:
 *   (a) 一覧（種類選択層なし・ページング）→ カード → 温度回答
 *   (b) 番号直指定（5 桁）
 *   (c) 楽しみ方はデータがある時のみ選択肢に出る（0 件なら出ない）
 *   (d) 無関係な発話は素通り（parseTeaAction=null / planTeaFlow=null）
 *   (e) 3 タップ以内で回答到達（メニュー → お茶 → 項目）
 *   quick reply 上限 13 を超えないこと
 *
 * 使用方法: npx tsx tests/unit/tea-menu.test.ts
 */

import { readFileSync } from "node:fs";
import {
  parseTeaAction,
  planTeaFlow,
  buildEntryMessage,
  buildTeaCard,
  buildBrewAnswer,
  buildStoryAnswer,
  teaFlowEvents,
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
    story: extra.story ?? "",
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

console.log("\n--- (a) 一覧(種類選択なし・ページング) → カード → 温度 ---");

it("一覧ページ1: 11件 + 次へ = 12（前へなし・上限内）", () => {
  const m = buildEntryMessage(FIXTURE, 0);
  assertEqual(m.quickReplies.length, 12, "page0 qr count");
  assert(m.quickReplies.length <= QR_MAX, "qr<=13");
  const labels = m.quickReplies.map((q) => q.action.label);
  assert(labels.includes("次へ"), "has 次へ");
  assert(!labels.includes("前へ"), "no 前へ on page0");
  assert(!labels.includes("種類に戻る"), "no category layer");
  // 先頭はカード遷移トークン（お茶を直接列挙・種類選択を挟まない）
  assert(m.quickReplies[0].action.text.startsWith("このお茶｜"), "first is card token");
  assert(m.text.includes("全14種"), "shows total count");
});

it("一覧ページ2: 前へ + 残り3件（次へ なし）", () => {
  const m = buildEntryMessage(FIXTURE, 1);
  const labels = m.quickReplies.map((q) => q.action.label);
  assert(labels.includes("前へ"), "has 前へ on last page");
  assert(!labels.includes("次へ"), "no 次へ on last page");
  // 14 件中 page size 11 → 2 ページ目は 3 件 + 前へ = 4
  assertEqual(m.quickReplies.length, 4, "page1 qr count");
});

it("PAGE_SIZE は 11（前へ/次へ 2枠で上限13に収まる）", () => {
  assertEqual(TEA_LIST_PAGE_SIZE, 11, "page size");
});

it("カード: 温度/味・香り/別のお茶（楽しみ方なし=温度+味・香り+別のお茶）", () => {
  const t = FIXTURE.find((x) => x.number === "10101")!;
  const m = buildTeaCard(t);
  const labels = m.quickReplies.map((q) => q.action.label);
  assert(labels.some((l) => l.includes("温度")), "has 温度");
  assert(labels.some((l) => l.includes("味・香り")), "has 味・香り");
  assert(!labels.some((l) => l.includes("楽しみ方")), "no 楽しみ方 (0件)");
  assert(labels.some((l) => l.includes("別のお茶")), "has 別のお茶");
  // 「別のお茶を見る」は一覧 1 ページ目に戻る（種類選択には戻らない）
  const back = m.quickReplies.find((q) => q.action.label.includes("別のお茶"))!;
  assertEqual(back.action.text, "お茶を選ぶ｜1", "back to list page1");
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

console.log("\n--- (c) 楽しみ方はデータがある時のみ ---");

it("楽しみ方あり → カードに 🍵楽しみ方 が出る", () => {
  const t = FIXTURE.find((x) => x.number === "50101")!;
  const m = buildTeaCard(t);
  assert(m.quickReplies.some((q) => q.action.label.includes("楽しみ方")), "has 楽しみ方 when data present");
});

console.log("\n--- (P0-9) つくり手の物語ボタン ---");

it("農家の物語あり → カードに つくり手の物語 ボタンが出る", () => {
  const t = tea("40101", "青茶", "香駿の和烏龍茶", { story: "祖父の代から続く茶畑で…" });
  const m = buildTeaCard(t);
  assert(m.quickReplies.some((q) => q.action.label.includes("つくり手の物語")), "story button present");
  assert(m.quickReplies.some((q) => q.action.text === "つくり手の物語｜40101"), "story token");
});
it("農家の物語なし → ボタンは出ない（楽しみ方と同方式）", () => {
  const t = tea("40101", "青茶", "香駿の和烏龍茶", { story: "" });
  const m = buildTeaCard(t);
  assert(!m.quickReplies.some((q) => q.action.label.includes("つくり手の物語")), "no story button when empty");
});
it("つくり手の物語｜40101 → 物語回答（本文を返す）", () => {
  const teas = [tea("40101", "青茶", "香駿の和烏龍茶", { story: "祖父の代から続く茶畑で丁寧に育てました。" })];
  const plan = planTeaFlow("つくり手の物語｜40101", teas);
  assert(!!plan, "plan exists");
  assert(plan!.messages[0].text.includes("祖父の代"), "story body returned");
});
it("buildStoryAnswer は物語なしで準備中フォールバック", () => {
  const t = tea("40101", "青茶", "香駿の和烏龍茶", { story: "" });
  const m = buildStoryAnswer(t);
  assert(m.text.includes("準備中"), "準備中 fallback");
});

console.log("\n--- (P0-3) 感想ひとこと（product_ratings 入口） ---");

it("カードに 💬この一杯の感想 ボタンが常設される", () => {
  const t = tea("40101", "青茶", "香駿の和烏龍茶");
  const m = buildTeaCard(t);
  assert(m.quickReplies.some((q) => q.action.label.includes("感想")), "rating button present");
  assert(m.quickReplies.some((q) => q.action.text === "感想｜40101"), "rate token");
});
it("感想｜40101 → 2択（おいしかった / 好みと少し違った）を提示", () => {
  const teas = [tea("40101", "青茶", "香駿の和烏龍茶")];
  const plan = planTeaFlow("感想｜40101", teas);
  assert(!!plan, "plan exists");
  const texts = plan!.messages[0].quickReplies.map((q) => q.action.text);
  assert(texts.includes("感想よい｜40101"), "good choice");
  assert(texts.includes("感想いまいち｜40101"), "bad choice");
});
it("感想よい / 感想いまいち → お礼メッセージ（記録は handler 側の副作用）", () => {
  const teas = [tea("40101", "青茶", "香駿の和烏龍茶")];
  const good = planTeaFlow("感想よい｜40101", teas);
  const bad = planTeaFlow("感想いまいち｜40101", teas);
  assert(!!good && good.messages[0].text.includes("ありがとう"), "thanks (good)");
  assert(!!bad && bad.messages[0].text.includes("ありがとう"), "thanks (bad)");
});
it("感想トークンの解析: rate / rate-good / rate-bad を正しく区別（衝突なし）", () => {
  assertEqual(parseTeaAction("感想｜40101")?.kind, "rate", "rate");
  assertEqual(parseTeaAction("感想よい｜40101")?.kind, "rate-good", "rate-good");
  assertEqual(parseTeaAction("感想いまいち｜40101")?.kind, "rate-bad", "rate-bad");
});

console.log("\n--- (P0-1) tea.* flow_events 導出 ---");

it("teaFlowEvents: entry → tea.list_view(page1)", () => {
  const evs = teaFlowEvents("お茶を選ぶ｜1", FIXTURE, "U1");
  assertEqual(evs[0].eventName, "tea.list_view", "list_view");
  assertEqual(evs[0].step, "page1", "page1");
});
it("teaFlowEvents: card → tea.card_view(list, 5桁)", () => {
  const evs = teaFlowEvents("このお茶｜40101", FIXTURE, "U1");
  assertEqual(evs[0].eventName, "tea.card_view", "card_view");
  assertEqual(evs[0].value, "list", "entry=list");
  assertEqual(evs[0].productNo, "40101", "product_no");
});
it("teaFlowEvents: story タップ → tea.item_view(story, 5桁)", () => {
  const evs = teaFlowEvents("つくり手の物語｜40101", FIXTURE, "U1");
  assertEqual(evs[0].eventName, "tea.item_view", "item_view");
  assertEqual(evs[0].value, "story", "story");
  assertEqual(evs[0].productNo, "40101", "product_no");
});
it("teaFlowEvents: 5桁のみ実在 → tea.card_view(number) / 不在 → tea.number_miss", () => {
  const hit = teaFlowEvents("40101", FIXTURE, "U1");
  assertEqual(hit[0].eventName, "tea.card_view", "card_view");
  assertEqual(hit[0].value, "number", "number");
  const miss = teaFlowEvents("99999", FIXTURE, "U1");
  assertEqual(miss[0].eventName, "tea.number_miss", "number_miss");
  assertEqual(miss[0].value, "99999", "入力番号");
});
it("teaFlowEvents: 無関係な発話は空（素通り）", () => {
  assertEqual(teaFlowEvents("こんにちは", FIXTURE, "U1").length, 0, "empty");
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

console.log("\n--- (e) 入口 → 一覧 → カード → 項目（3タップ以内で回答到達） ---");

it("入口発話（リッチメニュー①）→ 一覧（種類選択層なし）", () => {
  const plan = planTeaFlow("お茶の淹れ方を知りたい", FIXTURE);
  assert(plan !== null, "planned");
  // 一覧を直返し（種類 3 択ではなく、お茶のカードトークンが並ぶ）
  assert(
    plan!.messages[0].quickReplies[0].action.text.startsWith("このお茶｜"),
    "entry lists teas directly",
  );
});

it("旧①文言も後方互換で入口に入る", () => {
  const plan = planTeaFlow("お茶のおいしい淹れ方を教えてください", FIXTURE);
  assert(plan !== null, "legacy entry planned");
  assert(plan!.messages[0].quickReplies[0].action.text.startsWith("このお茶｜"), "legacy → list");
});

it("3タップ以内: メニュー[1] → お茶[2] → 温度[3] の各段が plan を返す", () => {
  // タップ1: メニュー → 一覧
  const step1 = planTeaFlow("お茶の淹れ方を知りたい", FIXTURE);
  assert(step1 !== null, "step1 entry");
  // タップ2: 一覧のお茶ボタン（このお茶｜10101）→ カード
  const step2 = planTeaFlow("このお茶｜10101", FIXTURE);
  assert(step2 !== null && step2.messages[0].text.includes("No.10101"), "step2 card");
  // タップ3: カードの温度ボタン（淹れ方｜10101）→ 回答
  const step3 = planTeaFlow("淹れ方｜10101", FIXTURE);
  assert(step3 !== null && step3.messages[0].text.includes("80℃"), "step3 answer");
});

it("ページング: お茶を選ぶ｜2 → 2ページ目", () => {
  const plan = planTeaFlow("お茶を選ぶ｜2", FIXTURE);
  assert(plan !== null, "planned");
  const labels = plan!.messages[0].quickReplies.map((q) => q.action.label);
  assert(labels.includes("前へ"), "page2 has 前へ");
});

it("全メッセージの quick reply が 13 以下", () => {
  const cases = [
    planTeaFlow("お茶を調べる", FIXTURE),
    planTeaFlow("お茶を選ぶ｜1", FIXTURE),
    planTeaFlow("お茶を選ぶ｜2", FIXTURE),
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

console.log("\n--- 回帰: feedback pending 中は tea-menu が横取りしない（インターセプタ順序） ---");

it("handleTextMessage は onboarding / feedback を tea-menu より先に呼ぶ", () => {
  // pending-state を持つ onboarding / feedback ハンドラが tea-menu より前に配線されて
  // いることをソース順序で固定する。改善希望タップ後のコメント（5桁や入口語を含みうる）が
  // tea-menu に横取りされて message_feedback 記録 / Slack 通知を失う回帰を防ぐ。
  const src = readFileSync(new URL("../../src/routes/line.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function handleTextMessage"));
  const iOnboarding = fn.indexOf("handleOnboardingMessage(lineUserId");
  const iFeedback = fn.indexOf("handleFeedbackMessage(lineUserId");
  const iTea = fn.indexOf("handleTeaMenuFlow(lineUserId");
  assert(iOnboarding > -1 && iFeedback > -1 && iTea > -1, "all three interceptors present");
  assert(iOnboarding < iTea, `onboarding(${iOnboarding}) must precede tea-menu(${iTea})`);
  assert(iFeedback < iTea, `feedback(${iFeedback}) must precede tea-menu(${iTea})`);
});

it("feedback pending コメントに5桁が混じっても tea トリガーと衝突しない（解析上の独立性）", () => {
  assertEqual(parseTeaAction("味が薄いと感じました"), null, "free comment → not tea");
  assert(parseTeaAction("11301") !== null, "bare 5-digit is a tea action (guarded by ordering)");
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
