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
  buildFlavorAnswer,
  buildStoryAnswer,
  buildRateThanksGood,
  teaFlowEvents,
  TEA_LIST_PAGE_SIZE,
  type TeaItem,
  mapProductPhotoSource,
  buildProductImageMap,
  fetchProductImages,
  _resetProductImageCache,
  pickTeaImage,
  type ProductPhotoSource,
} from "../../src/lib/tea-menu";
import { fetchProductMainImages } from "../../src/lib/shopify";
import type { Env } from "../../src/index";

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

it("カード: 淹れ方の目安/味・香り/別のお茶（楽しみ方なし=淹れ方+味・香り+別のお茶）", () => {
  const t = FIXTURE.find((x) => x.number === "10101")!;
  const m = buildTeaCard(t);
  const labels = m.quickReplies.map((q) => q.action.label);
  // 語り口（Phase 0 タスク5）: ラベルは「温度・抽出時間」から「淹れ方の目安」へ。
  assert(labels.some((l) => l.includes("淹れ方の目安")), "has 淹れ方の目安");
  assert(labels.some((l) => l.includes("味・香り")), "has 味・香り");
  assert(!labels.some((l) => l.includes("楽しみ方")), "no 楽しみ方 (0件)");
  assert(labels.some((l) => l.includes("別のお茶")), "has 別のお茶");
  // 「別のお茶を見る」は一覧 1 ページ目に戻る（種類選択には戻らない）
  const back = m.quickReplies.find((q) => q.action.label.includes("別のお茶"))!;
  assertEqual(back.action.text, "お茶を選ぶ｜1", "back to list page1");
});

it("淹れ方回答: How to Brew 本文を整形して直返し（創作なし）", () => {
  const t = FIXTURE.find((x) => x.number === "10101")!;
  const m = buildBrewAnswer(t);
  assert(m.text.includes("80℃ / 120ml / 60sec"), "brew text verbatim");
  assert(m.text.includes("10101｜"), "shows number (番号｜名前)");
  // 淹れ方回答の後は自分自身を除いた選択肢を再提示
  assert(!m.quickReplies.some((q) => q.action.label.includes("淹れ方")), "excludes 淹れ方 in followup");
});

it("淹れ方回答: 数値は変えず、目安として置く（正解の提示にしない）", () => {
  const t = FIXTURE.find((x) => x.number === "10101")!;
  const m = buildBrewAnswer(t);
  // データ不変: How to Brew 本文はそのまま
  assert(m.text.includes("80℃ / 120ml / 60sec"), "数値は不変");
  // 語り口: 目安として置き、好みで動かせることを添える
  assert(m.text.includes("淹れ方の目安です"), "目安として置く");
  assert(m.text.includes("お好みで"), "好みで調整できると添える");
  // break-proof: 断定・推薦の語を出さない（旧「おすすめの淹れ方はこちらです」なら失敗）
  for (const ng of ["おすすめの淹れ方", "正しい淹れ方", "正解", "すべき"]) {
    assert(!m.text.includes(ng), `禁止表現なし: ${ng}`);
  }
});

console.log("\n--- (b) 番号直指定 ---");

it("5桁のみ → 該当カード", () => {
  const plan = planTeaFlow("50101", FIXTURE);
  assert(plan !== null, "planned");
  assert(plan!.messages[0].text.includes("50101｜"), "card for 50101");
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
it("感想よい → お礼 / 感想いまいち → 静かな受け止め（A-2a・純粋 planner は提案なし）", () => {
  // 純粋 planner は Supabase 読取なし＝ +1 はお礼のみ / -1 は静かな一文（提案ゼロ）。
  //   「次の一杯」の実提案は handleTeaMenuFlow が評価済み除外集合を引いてから付ける。
  const teas = [tea("40101", "青茶", "香駿の和烏龍茶")];
  const good = planTeaFlow("感想よい｜40101", teas);
  const bad = planTeaFlow("感想いまいち｜40101", teas);
  assert(!!good && good.messages[0].text.includes("ありがとう"), "thanks (good)");
  // -1 直後は「引く」: お礼ではなく静かな受け止め（提案・演出をしない）。
  assert(!!bad && bad.messages[0].text.includes("好みは人それぞれ"), "quiet decline (bad)");
  assert(!!bad && !bad.messages[0].text.includes("ありがとう"), "bad is not a thanks");
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
  assert(plan !== null && plan.messages[0].text.includes("40101｜"), "known loose → card");
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
  assert(step2 !== null && step2.messages[0].text.includes("10101｜"), "step2 card");
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

console.log("\n--- (ブロック3-A 1a) 診断出所スレッディング（source=diagnosis 継承） ---");

it("診断カードトークン このお茶｜40101｜診断 → card アクション origin=diagnosis", () => {
  const a = parseTeaAction("このお茶｜40101｜診断");
  assertEqual(a?.kind, "card", "card");
  assertEqual((a as { origin?: string }).origin, "diagnosis", "origin=diagnosis");
});

it("teaFlowEvents: 診断経由カード → tea.card_view(value=diagnosis)（Spec enum 一致）", () => {
  const evs = teaFlowEvents("このお茶｜40101｜診断", FIXTURE, "U1");
  assertEqual(evs[0].eventName, "tea.card_view", "card_view");
  assertEqual(evs[0].value, "diagnosis", "value=diagnosis");
  assertEqual(evs[0].productNo, "40101", "product_no");
  // 通常経路（マーカーなし）は従来どおり list
  assertEqual(teaFlowEvents("このお茶｜40101", FIXTURE, "U1")[0].value, "list", "no-marker=list");
});

it("診断カード → 感想ボタンが origin を継承（感想｜40101｜診断）", () => {
  const plan = planTeaFlow("このお茶｜40101｜診断", FIXTURE);
  assert(!!plan, "plan");
  const rate = plan!.messages[0].quickReplies.find((q) => q.action.label.includes("感想"))!;
  assertEqual(rate.action.text, "感想｜40101｜診断", "rate token carries diagnosis marker");
  // 「別のお茶を見る」= 一覧は出所をリセット（マーカーを付けない）
  const back = plan!.messages[0].quickReplies.find((q) => q.action.label.includes("別のお茶"))!;
  assertEqual(back.action.text, "お茶を選ぶ｜1", "back to list has no marker");
});

it("診断出所の感想プロンプト → rate-good/bad が origin を継承", () => {
  const a = parseTeaAction("感想｜40101｜診断");
  assertEqual(a?.kind, "rate", "rate");
  assertEqual((a as { origin?: string }).origin, "diagnosis", "rate origin");
  const plan = planTeaFlow("感想｜40101｜診断", FIXTURE);
  const texts = plan!.messages[0].quickReplies.map((q) => q.action.text);
  assert(texts.includes("感想よい｜40101｜診断"), "good carries marker");
  assert(texts.includes("感想いまいち｜40101｜診断"), "bad carries marker");
});

it("rate-good の origin: 診断経由=diagnosis / 通常=undefined（source 決定の入力）", () => {
  assertEqual((parseTeaAction("感想よい｜40101｜診断") as { origin?: string }).origin, "diagnosis", "diag");
  assertEqual((parseTeaAction("感想よい｜40101") as { origin?: string }).origin, undefined, "normal");
});

console.log("\n--- (ブロック3-A 2) 終端後の1手（網羅的メニュー再掲をやめる） ---");

it("温度回答: 次の1手は 味・香り + お茶の一覧 の2個だけ（全再掲しない）", () => {
  const t = FIXTURE.find((x) => x.number === "10101")!;
  const m = buildBrewAnswer(t);
  const labels = m.quickReplies.map((q) => q.action.label);
  assertEqual(m.quickReplies.length, 2, "1手=2個");
  assert(labels.some((l) => l.includes("味・香り")), "sibling=味・香り");
  assert(labels.some((l) => l.includes("お茶の一覧")), "has お茶の一覧");
  assert(!labels.some((l) => l.includes("淹れ方")), "no 自分自身（淹れ方）");
  assert(!labels.some((l) => l.includes("感想")), "no 感想 in terminal");
  const back = m.quickReplies.find((q) => q.action.label.includes("お茶の一覧"))!;
  assertEqual(back.action.text, "お茶を選ぶ｜1", "一覧へ");
});

it("味・香り回答: 次の1手は 淹れ方の目安 + お茶の一覧", () => {
  const t = FIXTURE.find((x) => x.number === "10101")!;
  const m = buildFlavorAnswer(t);
  const labels = m.quickReplies.map((q) => q.action.label);
  assert(labels.some((l) => l.includes("淹れ方の目安")), "sibling=淹れ方の目安");
  assert(labels.some((l) => l.includes("お茶の一覧")), "has 一覧");
  assert(m.quickReplies.length <= 2, "1〜2個");
});

it("物語回答: 兄弟（味・香り）にデータがあれば 兄弟 + 一覧、無ければ 一覧のみ", () => {
  const withFlavor = tea("40101", "青茶", "香駿の和烏龍茶", { story: "祖父の代から…", descShort: "華やかな香り" });
  const mWith = buildStoryAnswer(withFlavor);
  assert(mWith.quickReplies.some((q) => q.action.label.includes("味・香り")), "sibling present");
  // 兄弟データ皆無（flavor 情報なし）→ お茶の一覧のみ
  const noFlavor = tea("40102", "青茶", "無情報茶", { story: "物語", flavorProfiles: [], descShort: "" });
  const mNo = buildStoryAnswer(noFlavor);
  assertEqual(mNo.quickReplies.length, 1, "sibling データ無→一覧のみ");
  assertEqual(mNo.quickReplies[0].action.label.includes("お茶の一覧"), true, "一覧");
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

console.log("\n--- (UX①) お茶ラベルの番号｜名前統一（名前のみ表示の是正） ---");

it("淹れ方一覧: 各お茶ボタンの label が `番号｜名前`（① 是正・名前のみを撲滅）", () => {
  const m = buildEntryMessage(FIXTURE, 0);
  const teaLabels = m.quickReplies
    .filter((q) => q.action.text.startsWith("このお茶｜"))
    .map((q) => q.action.label);
  assert(teaLabels.length > 0, "お茶ボタンがある");
  for (const label of teaLabels) {
    assert(/^\d{5}｜/.test(label), `番号｜名前統一 (${label})`);
    assert(label.length <= 20, `≤20 (${label})`);
  }
});

it("次の一杯ボタン: buildRateThanksGood の提案 label が `番号｜名前`（①）", () => {
  const rated = FIXTURE.find((x) => x.number === "10101")!;
  const suggestion = FIXTURE.find((x) => x.number === "40101")!;
  const m = buildRateThanksGood(rated, suggestion);
  const btn = m.quickReplies.find((q) => q.action.text === "このお茶｜40101");
  assert(!!btn, "提案ボタンがある");
  assert(btn!.action.label.startsWith("40101｜"), `番号｜名前 (${btn!.action.label})`);
  assert(btn!.action.label.length <= 20, "≤20");
  // 本文にも `番号｜名前` の提案文が入る（従来どおり）。
  assert(m.text.includes("40101｜"), "提案文にも番号｜名前");
});

// ---------------------------------------------------------------------------
// お茶写真の読み先（2026-09-30 Asset hub 段1: 配信済みの写真だけを出す）
//   Shopify の商品のメイン写真 → 無ければ Image Main_LINE Gift。Image Main_Shopify は読まない。
// ---------------------------------------------------------------------------

console.log("\n--- お茶写真の読み先（配信済みの写真だけ: Shopify → LINE ギフト。Image Main_Shopify は読まない） ---");
const asyncTests: Array<{ name: string; fn: () => Promise<void> }> = [];
function itAsync(name: string, fn: () => Promise<void>) {
  asyncTests.push({ name, fn });
}

/** Product Catalogue の単品 1 行（Notion API の形）。 */
function catalogueRow(o: {
  sku: string;
  single?: boolean;
  teaMenuId?: string;
  productId?: string | number | null;
  productIdType?: "rich_text" | "number";
  lineGift?: string | null;
  shopifyCol?: string | null;
}) {
  const pid =
    o.productIdType === "number"
      ? { type: "number", number: o.productId == null ? null : Number(o.productId) }
      : {
          type: "rich_text",
          rich_text: o.productId == null ? [] : [{ plain_text: String(o.productId) }],
        };
  return {
    id: `row-${o.sku}`,
    properties: {
      SKU: { type: "title", title: [{ plain_text: o.sku }] },
      Tags_Shopify: {
        type: "multi_select",
        multi_select: o.single === false ? [{ name: "Set" }] : [{ name: "Single Pack" }],
      },
      "Tea Menu": { type: "relation", relation: o.teaMenuId ? [{ id: o.teaMenuId }] : [] },
      "Product ID_Shopify": pid,
      "Image Main_LINE Gift": { type: "url", url: o.lineGift ?? null },
      "Image Main_Shopify": { type: "url", url: o.shopifyCol ?? null },
    },
  };
}

const R2_A = "https://pub-test.r2.dev/cdn/a.jpg";
const R2_B = "https://pub-test.r2.dev/cdn/b.jpg";
const R2_ENTERED = "https://pub-test.r2.dev/cdn/entered-not-delivered.jpg";
const SHOP_1 = "https://cdn.shopify.com/s/files/1/x/files/p1_1200x.jpg?v=1";
const SHOP_2 = "https://cdn.shopify.com/s/files/1/x/files/p2_1200x.jpg?v=1";

it("写真の材料: 単品行から Product ID_Shopify と LINE ギフトの写真と join キーを読む", () => {
  const s = mapProductPhotoSource(
    catalogueRow({
      sku: "TEA-STMS-10101-FL-01",
      teaMenuId: "tea-page-10101",
      productId: "7718802030750",
      lineGift: `https://wsrv.nl/?url=${encodeURIComponent(R2_A)}&w=2000`,
      shopifyCol: R2_ENTERED,
    }) as never,
  );
  assert(!!s, "単品行は材料になる");
  assert(s!.shopifyProductId === "7718802030750", `product id (${s!.shopifyProductId})`);
  assert(s!.lineGiftUrl === R2_A, `LINE ギフトは wsrv を剥がした直リンク (${s!.lineGiftUrl})`);
  assert(s!.keys.includes("tea-page-10101") && s!.keys.includes("10101"), "relation id と 5 桁番号");
  assert(!JSON.stringify(s).includes(R2_ENTERED), "Image Main_Shopify の値は材料に入らない");
});

it("写真の材料: 単品でない行は対象外 / Product ID が number 型・gid 形式でも読める / 不正は null", () => {
  assert(mapProductPhotoSource(catalogueRow({ sku: "TEA-STMS-10101-FL-01", single: false }) as never) === null, "単品でない");
  const n = mapProductPhotoSource(
    catalogueRow({ sku: "TEA-STMS-10201-FL-01", productId: 7756120424606, productIdType: "number" }) as never,
  );
  assert(n?.shopifyProductId === "7756120424606", `number 型 (${n?.shopifyProductId})`);
  const g = mapProductPhotoSource(
    catalogueRow({ sku: "TEA-STMS-10301-FL-01", productId: "gid://shopify/Product/7718815105182" }) as never,
  );
  assert(g?.shopifyProductId === "7718815105182", `gid 形式 (${g?.shopifyProductId})`);
  const bad = mapProductPhotoSource(catalogueRow({ sku: "TEA-STMS-10401-FL-01", productId: "abc" }) as never);
  assert(bad !== null && bad.shopifyProductId === null, "不正な ID は null（行は残す）");
  assert(mapProductPhotoSource(catalogueRow({ sku: "TEA-STMS-N01-01" }) as never) === null, "join キーが無い行は対象外");
});

it("読み先: Shopify の写真があればそれを使う（LINE ギフトより優先）", () => {
  const sources: ProductPhotoSource[] = [
    { keys: ["tea-a", "10101"], shopifyProductId: "1", lineGiftUrl: R2_A },
  ];
  const map = buildProductImageMap(sources, new Map([["1", SHOP_1]]));
  assert(map.get("tea-a") === SHOP_1 && map.get("10101") === SHOP_1, "Shopify の写真");
});

it("読み先: Shopify に写真が無いときだけ LINE ギフトの写真 / どちらも無ければ載せない", () => {
  const sources: ProductPhotoSource[] = [
    { keys: ["tea-a", "10101"], shopifyProductId: "1", lineGiftUrl: R2_A },
    { keys: ["tea-b", "10201"], shopifyProductId: "2", lineGiftUrl: null },
    { keys: ["tea-c", "10301"], shopifyProductId: null, lineGiftUrl: R2_B },
  ];
  const map = buildProductImageMap(sources, new Map());
  assert(map.get("tea-a") === R2_A, "Shopify 無し → LINE ギフト");
  assert(!map.has("tea-b") && !map.has("10201"), "どちらも無し → 載せない（写真なし）");
  assert(map.get("10301") === R2_B, "Product ID 無し → LINE ギフト");
});

it("読み先: 同じお茶の 2 行（FL / TB）は、どちらかの Shopify の写真が LINE ギフトより勝つ", () => {
  const sources: ProductPhotoSource[] = [
    { keys: ["tea-a", "10101"], shopifyProductId: null, lineGiftUrl: R2_A },
    { keys: ["tea-a", "10101"], shopifyProductId: "1", lineGiftUrl: null },
  ];
  const map = buildProductImageMap(sources, new Map([["1", SHOP_1]]));
  assert(map.get("tea-a") === SHOP_1, `2 行目の Shopify が勝つ (${map.get("tea-a")})`);
});

it("読み先: Image Main_Shopify（入れたが配信していない写真）はカードに出ない", () => {
  const row = catalogueRow({ sku: "TEA-STMS-50101-FL-01", teaMenuId: "tea-z", productId: "9", shopifyCol: R2_ENTERED });
  const s = mapProductPhotoSource(row as never)!;
  const map = buildProductImageMap([s], new Map());
  const tea = { id: "tea-z", number: "50101" } as TeaItem;
  assert(pickTeaImage(map, tea) === undefined, "Shopify の列だけに写真がある → 写真なし");
});

it("読み先（ソース固定）: tea-menu.ts は Image Main_Shopify 列を読まない", () => {
  const src = readFileSync(new URL("../../src/lib/tea-menu.ts", import.meta.url), "utf8");
  assert(!/pr\[\s*"Image Main_Shopify"\s*\]/.test(src), "pr[\"Image Main_Shopify\"] を読むコードが無い");
  assert(/pr\[\s*"Image Main_LINE Gift"\s*\]/.test(src), "LINE ギフトの列は読む");
});

const FAKE_ENV = {} as unknown as Env;

itAsync("Shopify の写真を読む: 読むだけ（query のみ）・gid を数値に戻す・写真でない先頭は載せない・100 件ごとに分ける", async () => {
  const queries: string[] = [];
  const idsSeen: string[][] = [];
  const ids = Array.from({ length: 150 }, (_, i) => String(1000 + i));
  const map = await fetchProductMainImages([...ids, "gid://shopify/Product/1000", "x"], FAKE_ENV, {
    adminQuery: async (q, v) => {
      queries.push(q);
      const gids = v.ids as string[];
      idsSeen.push(gids);
      return {
        nodes: gids.map((gid) =>
          gid.endsWith("/1000")
            ? { id: gid, featuredMedia: { image: { url: SHOP_1 } } }
            : gid.endsWith("/1001")
              ? { id: gid, featuredMedia: {} } // 動画など（MediaImage でない）
              : gid.endsWith("/1002")
                ? { id: gid, featuredMedia: null } // 写真なし
                : null, // 見つからない
        ),
      };
    },
  });
  assert(queries.every((q) => /^\s*query\b/.test(q) && !/mutation/i.test(q)), "query だけ");
  assert(idsSeen.length === 2 && idsSeen[0].length === 100 && idsSeen[1].length === 50, `分割 ${idsSeen.map((x) => x.length)}`);
  assert(map.size === 1 && map.get("1000") === SHOP_1, `写真は 1000 だけ (${[...map.keys()]})`);
});

itAsync("Shopify の写真を読む: ID が 0 件なら Shopify を呼ばない", async () => {
  let called = 0;
  const map = await fetchProductMainImages(["", "abc"], FAKE_ENV, {
    adminQuery: async () => {
      called++;
      return {};
    },
  });
  assert(called === 0 && map.size === 0, "呼ばない");
});

itAsync("fetchProductImages: Shopify → LINE ギフトの順で組み、成功時はキャッシュする", async () => {
  _resetProductImageCache();
  let shopCalls = 0;
  const deps = {
    loadSources: async () => [
      { keys: ["tea-a"], shopifyProductId: "1", lineGiftUrl: R2_A },
      { keys: ["tea-b"], shopifyProductId: "2", lineGiftUrl: R2_B },
    ],
    loadShopifyImages: async (ids: string[]) => {
      shopCalls++;
      assert(ids.join(",") === "1,2", `ID を渡す (${ids})`);
      return new Map([["1", SHOP_1]]);
    },
  };
  const m1 = await fetchProductImages(FAKE_ENV, false, deps);
  assert(m1.get("tea-a") === SHOP_1 && m1.get("tea-b") === R2_B, "組み方");
  await fetchProductImages(FAKE_ENV, false, deps);
  assert(shopCalls === 1, `2 回目はキャッシュ (${shopCalls})`);
  _resetProductImageCache();
});

itAsync("fetchProductImages: Shopify が失敗したら LINE ギフトだけで組み、キャッシュしない", async () => {
  _resetProductImageCache();
  let shopCalls = 0;
  const deps = {
    loadSources: async () => [
      { keys: ["tea-a"], shopifyProductId: "1", lineGiftUrl: R2_A },
      { keys: ["tea-b"], shopifyProductId: "2", lineGiftUrl: null },
    ],
    loadShopifyImages: async (): Promise<Map<string, string>> => {
      shopCalls++;
      if (shopCalls === 1) throw new Error("Shopify Admin API credentials not configured");
      return new Map([["2", SHOP_2]]);
    },
  };
  const m1 = await fetchProductImages(FAKE_ENV, false, deps);
  assert(m1.get("tea-a") === R2_A && !m1.has("tea-b"), "失敗時は LINE ギフトだけ");
  const m2 = await fetchProductImages(FAKE_ENV, false, deps);
  assert(shopCalls === 2, `失敗はキャッシュしない (${shopCalls})`);
  assert(m2.get("tea-b") === SHOP_2, "2 回目は Shopify の写真");
  _resetProductImageCache();
});

for (const t of asyncTests) {
  total++;
  try {
    await t.fn();
    passed++;
    console.log(`  [PASS] ${t.name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${t.name}: ${msg}`);
    failures.push({ name: t.name, error: msg });
  }
}

console.log("\n" + "=".repeat(60));
console.log("Tea Menu Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failed > 0 ? 1 : 0);
