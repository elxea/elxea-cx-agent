/**
 * Unit Tests — 入口質問型ウェルカム（ブロック2 — 3動線の入口整備）
 *
 * 純粋なビルダー・分類器のみを検証する（Supabase / Firestore / LINE には触れない）。
 * 検証範囲:
 *   - 分岐 3 種（marche / online / other）の分類と応答
 *   - 素通り挙動（自由発話・5桁番号・メニュー操作・空文字 → null）
 *   - 記録の契約（welcome.source の value=marche/online/other が flow_events で落ちない）
 *   - 入口質問ウェルカムの構造（WELCOME_INTRO 維持・3 択・本文絵文字なし）
 *
 * 使用: npx tsx tests/unit/welcome-onboarding.test.ts
 */

import {
  parseWelcomeSourceAnswer,
  buildEntryWelcome,
  buildSourceResponse,
  WELCOME_SOURCE_MARCHE_TEXT,
  WELCOME_SOURCE_ONLINE_TEXT,
  WELCOME_SOURCE_OTHER_TEXT,
  ONBOARDING_EXPLORE_TEXT,
  ONBOARDING_ABOUT_TEXT,
  ONBOARDING_HOWTO_TEXT,
  type WelcomeSource,
} from "../../src/lib/welcome-onboarding";
import { WELCOME_INTRO } from "../../src/lib/brand-copy";
import { DIAGNOSIS_TRIGGER } from "../../src/lib/preference-diagnosis";
import { TEA_LIST_ENTRY_TRIGGER } from "../../src/lib/tea-menu";
import { buildFlowEventRow } from "../../src/lib/flow-events";
import type { QuickReplyItem } from "../../src/lib/line";

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
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${name}: ${msg}`);
    failures.push(`${name}: ${msg}`);
  }
}
function assertEqual<T>(a: T, e: T, label = "") {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertTrue(v: boolean, label = "") {
  if (!v) throw new Error(`${label}: expected true`);
}

/** quick reply の message action テキスト一覧を取り出す。 */
function actionTexts(items: QuickReplyItem[]): string[] {
  return items.map((i) => (i.action.type === "message" ? i.action.text : ""));
}
function actionLabels(items: QuickReplyItem[]): string[] {
  return items.map((i) => i.action.label ?? "");
}
/** 本文絵文字の簡易検出（絵文字はボタンのアイコン的利用のみ許可）。 */
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u;

// --- 分類器（3 分岐 + 素通り） ---------------------------------------------

it("parseWelcomeSourceAnswer: マルシェトークン → marche", () => {
  assertEqual(parseWelcomeSourceAnswer(WELCOME_SOURCE_MARCHE_TEXT), "marche");
});
it("parseWelcomeSourceAnswer: オンライントークン → online", () => {
  assertEqual(parseWelcomeSourceAnswer(WELCOME_SOURCE_ONLINE_TEXT), "online");
});
it("parseWelcomeSourceAnswer: その他トークン → other", () => {
  assertEqual(parseWelcomeSourceAnswer(WELCOME_SOURCE_OTHER_TEXT), "other");
});

it("parseWelcomeSourceAnswer: 素通り — 自由発話・5桁番号・メニュー操作・空文字は null", () => {
  const passthrough = [
    "こんにちは",
    "おすすめのお茶を教えて",
    "12345", // 5 桁番号（tea-menu が受ける）
    TEA_LIST_ENTRY_TRIGGER, // メニュー操作
    DIAGNOSIS_TRIGGER, // 診断トリガー
    ONBOARDING_EXPLORE_TEXT, // 従来 3 択
    "",
    "  ",
    "onboarding:source_", // 前方一致の偽トークン
  ];
  for (const msg of passthrough) {
    assertEqual(parseWelcomeSourceAnswer(msg), null, `passthrough(${JSON.stringify(msg)})`);
  }
});

// --- 入口質問ウェルカム ------------------------------------------------------

it("buildEntryWelcome: WELCOME_INTRO を維持し流入元の質問で終える", () => {
  const { text, quickReplies } = buildEntryWelcome();
  assertTrue(text.startsWith(WELCOME_INTRO), "WELCOME_INTRO 先頭維持");
  assertTrue(text.includes("お便りをお送りするのは月に1〜2回"), "配信頻度 1 行維持");
  assertTrue(text.includes("どこで elxea を知っていただけましたか"), "流入元の質問");
  assertTrue(!EMOJI_RE.test(text), "本文に絵文字なし");
  assertEqual(quickReplies.length, 3, "3 択");
});

it("buildEntryWelcome: 3 択が流入元トークンを送る", () => {
  const { quickReplies } = buildEntryWelcome();
  const texts = actionTexts(quickReplies);
  assertTrue(texts.includes(WELCOME_SOURCE_MARCHE_TEXT), "marche トークン");
  assertTrue(texts.includes(WELCOME_SOURCE_ONLINE_TEXT), "online トークン");
  assertTrue(texts.includes(WELCOME_SOURCE_OTHER_TEXT), "other トークン");
});

// --- 分岐応答 ---------------------------------------------------------------

it("buildSourceResponse(marche): 5桁番号を案内し診断/一覧/使い方を提示", () => {
  const { text, quickReplies } = buildSourceResponse("marche");
  assertTrue(text.includes("5桁の番号"), "5桁番号の案内");
  assertTrue(!EMOJI_RE.test(text), "本文に絵文字なし");
  const texts = actionTexts(quickReplies);
  assertTrue(texts.includes(DIAGNOSIS_TRIGGER), "診断トリガー");
  assertTrue(texts.includes(TEA_LIST_ENTRY_TRIGGER), "お茶一覧トリガー（tea-menu 入口）");
  assertTrue(texts.includes(ONBOARDING_HOWTO_TEXT), "使い方トークン");
});

it("buildSourceResponse(online): 好み診断が主線（quickReply 先頭 = 診断・設計 A-3）", () => {
  const { text, quickReplies } = buildSourceResponse("online");
  assertTrue(!EMOJI_RE.test(text), "本文に絵文字なし");
  const texts = actionTexts(quickReplies);
  // 主線 = 好み診断が先頭（従来は 4 択末尾に希釈されていたドリフトの是正）。
  assertEqual(texts[0], DIAGNOSIS_TRIGGER, "先頭が好み診断トリガー");
  // ほかの入り口は副次として残す（選択肢は削らない）。
  assertTrue(texts.includes(ONBOARDING_EXPLORE_TEXT), "お茶を探す残置");
  assertTrue(texts.includes(ONBOARDING_ABOUT_TEXT), "elxea について知る残置");
  assertTrue(texts.includes(ONBOARDING_HOWTO_TEXT), "使い方を教えて残置");
  assertEqual(quickReplies.length, 4, "診断 + 3 択 = 4");
});

it("buildSourceResponse(other): 従来どおり診断は末尾（online とは非同一・主線化しない）", () => {
  const other = buildSourceResponse("other");
  const online = buildSourceResponse("online");
  const otherTexts = actionTexts(other.quickReplies);
  // 「その他」は設計 A-3 が主線を規定しない入口 → 従来の並び（診断は末尾）を維持。
  assertEqual(otherTexts[0], ONBOARDING_EXPLORE_TEXT, "その他は先頭がお茶を探す");
  assertEqual(otherTexts[otherTexts.length - 1], DIAGNOSIS_TRIGGER, "その他は診断が末尾");
  // online（診断主線）とは非同一 = ドリフト是正がオンライン分岐に閉じている証跡。
  assertTrue(online.text !== other.text, "online と other の本文は非同一");
  assertTrue(
    actionTexts(online.quickReplies)[0] !== otherTexts[0],
    "先頭 CTA が online と other で異なる",
  );
});

it("quick reply ラベル長は LINE 上限 20 文字以内", () => {
  const all = [
    ...actionLabels(buildEntryWelcome().quickReplies),
    ...actionLabels(buildSourceResponse("marche").quickReplies),
    ...actionLabels(buildSourceResponse("online").quickReplies),
  ];
  for (const label of all) {
    assertTrue([...label].length <= 20, `label 長 (${label})`);
  }
});

// --- 記録契約（flow_events welcome.source） ---------------------------------

it("welcome.source: value=marche/online/other は PII ガードで落ちない", () => {
  const sources: WelcomeSource[] = ["marche", "online", "other"];
  for (const value of sources) {
    const row = buildFlowEventRow({ eventName: "welcome.source", userRef: "U123", value });
    assertEqual(row.event_name, "welcome.source", "event_name");
    assertEqual(row.value, value, `value 保持 (${value})`);
    assertEqual(row.channel, "line", "channel 既定");
  }
});

it("記録契約: 各トークンをパースした source は flow_events の slug として有効", () => {
  const tokens = [WELCOME_SOURCE_MARCHE_TEXT, WELCOME_SOURCE_ONLINE_TEXT, WELCOME_SOURCE_OTHER_TEXT];
  for (const tok of tokens) {
    const source = parseWelcomeSourceAnswer(tok);
    assertTrue(source !== null, `parse(${tok})`);
    const row = buildFlowEventRow({ eventName: "welcome.source", userRef: "U1", value: source ?? undefined });
    assertEqual(row.value, source, `round-trip value (${tok})`);
  }
});

console.log(`\nwelcome-onboarding.test: ${passed}/${total} passed`);
if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
