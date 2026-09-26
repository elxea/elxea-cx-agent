/**
 * Unit Tests -- menu-actions（相談 / ④定期便 / elxea について の決定的応答）
 *
 * 純粋ロジック（Notion / LINE push / Firestore に触れない）を検証する:
 *   (a) トリガー文言がリッチメニュー（scripts/lib/rich-menu-definition.ts）の message text と一致
 *   (b) 相談: 初手 quick reply が 2-3 個・text は tea-menu / menu トリガーと非衝突（AI へ素通り）
 *   (c) ④定期便: subscriber / generic の出し分けメッセージ（両方リンクを含む）
 *   (d) elxea について: ブランド紹介（URL 実在 /ja）＋ 配信設定の受け皿
 *
 * 注意（2026-08-10）: 相談 と elxea について はリッチメニューの枠を持たない
 *   「発話専用トリガー」である（枠は 6 = roji アンケート導線に差し替え済み・commit e98843e）。
 *   固定応答自体は後方互換で存続するため、応答ビルダーのテストは維持する。
 *   (e) インターセプタ順序: onboarding / feedback の後（pending-state 保護）
 *
 * 使用方法: npx tsx tests/unit/menu-actions.test.ts
 */

import { buildRichMenuBody, storeUriFor } from "../../scripts/lib/rich-menu-definition";
import { readFileSync } from "node:fs";
import {
  CONSULTATION_TRIGGER,
  SUBSCRIPTION_TRIGGER,
  ABOUT_TRIGGER,
  buildConsultationPrompt,
  buildAboutMessage,
  buildSubscriptionMessage,
} from "../../src/lib/menu-actions";
import { parseTeaAction } from "../../src/lib/tea-menu";
import { MY_KARTE_TRIGGER } from "../../src/lib/my-karte";
import { READING_TRIGGER } from "../../src/lib/journal";
import { SURVEY_TRIGGER } from "../../src/lib/roji-survey-copy";

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

console.log("\n--- (a) トリガー文言はリッチメニューの message text と一致 ---");

it("トリガー定数がリッチメニュー定義の message text と一致（仮メニュー 3 枠・Amazon）", () => {
  // メニューの形の正本は scripts/lib/rich-menu-definition.ts（2026-09-26〜 仮メニュー 3 枠）。
  //   ① お茶の淹れ方（message）/ ② 好み診断（message）/ ③ Amazon ストア（uri → Worker の /go/store）。
  //   旧 6 枠の ③マイカルテ / ④定期便 / ⑤読みもの / ⑥roji アンケートは枠を外し、発話トリガーとしてのみ存続。
  //   相談 / elxea について も枠を持たない（2026-07 / 2026-08-09 commit e98843e に廃止済み）。
  //   ここを固定して「メニュー定義を戻すと旧導線に巻き戻る」回帰（Issue: richmenu6-trigger-gap）を再発させない。
  const body = buildRichMenuBody(storeUriFor("prod"));
  const texts = body.areas.flatMap((a) => (a.action.type === "message" ? [a.action.text] : []));
  // ①お茶の淹れ方 は tea-menu が処理（トリガー一致は tea-menu 側で担保）
  assertEqual(texts[0], "お茶の淹れ方を知りたい", "①tea text");
  // ②好み診断 は AI 会話へ（本モジュール非対象）
  assertEqual(texts[1], "好みに合うお茶を診断してほしいです", "②diagnosis text");
  assertEqual(texts.length, 2, "message の枠は ①② の 2 つだけ（③ は uri）");
  assertEqual(body.areas[2].action.type, "uri", "③ Amazon ストアは uri");
  for (const [trigger, label] of [
    [MY_KARTE_TRIGGER, "マイカルテ"],
    [SUBSCRIPTION_TRIGGER, "定期便"],
    [READING_TRIGGER, "読みもの"],
    [SURVEY_TRIGGER, "roji アンケート"],
    [CONSULTATION_TRIGGER, "相談"],
    [ABOUT_TRIGGER, "elxea について"],
  ] as const) {
    assert(!texts.includes(trigger), `${label} は枠を外した（メニューに無い）`);
  }
});

console.log("\n--- (b) 相談（発話専用）: 初手 quick reply ---");

it("相談の初手は 2-3 個の quick reply を提示", () => {
  const m = buildConsultationPrompt();
  assert(m.text.trim().length > 0, "has prompt text");
  assert(m.quickReplies.length >= 2 && m.quickReplies.length <= 3, "2-3 quick replies");
});

it("相談の quick reply text は tea-menu / menu トリガーと衝突しない（タップ後 AI へ素通り）", () => {
  const m = buildConsultationPrompt();
  for (const q of m.quickReplies) {
    // tea-menu にインターセプトされない（parseTeaAction=null）
    assertEqual(parseTeaAction(q.action.text), null, `not tea: ${q.action.text}`);
    // menu-actions の 3 トリガーとも一致しない
    assert(
      q.action.text !== CONSULTATION_TRIGGER &&
        q.action.text !== SUBSCRIPTION_TRIGGER &&
        q.action.text !== ABOUT_TRIGGER,
      `not a menu trigger: ${q.action.text}`,
    );
  }
});

console.log("\n--- (c) ④定期便: subscriber / generic 出し分け ---");

// 開店時（siteOpen=true）は master の文・リンクのまま。閉店中（既定）は文言 v2 C-9 / C-10 / C-12
//   （完全一致は tests/hermetic/closed-site-copy-d2a.test.ts）。
it("subscriber（開店時）: 御礼 + プラン確認リンク（/ja/subscription）を含む", () => {
  const s = buildSubscriptionMessage("subscriber", true);
  assert(s.includes("https://elxea.com/ja/subscription"), "has subscription link");
  assert(s.includes("ありがとう"), "thanks existing subscriber");
});

it("generic（開店時）: 押し売りしない紹介 + リンクを含む", () => {
  const g = buildSubscriptionMessage("generic", true);
  assert(g.includes("https://elxea.com/ja/subscription"), "has subscription link");
  assert(g.includes("定期便"), "introduces subscription");
});

it("subscriber と generic は別文面", () => {
  assert(
    buildSubscriptionMessage("subscriber") !== buildSubscriptionMessage("generic"),
    "two distinct variants",
  );
});

console.log("\n--- (d) elxea について（発話専用） ---");

it("ブランド紹介 + 実在 URL(/ja) + AI 開示 + 配信頻度（opt-out 約束は書かない・開店時）", () => {
  const a = buildAboutMessage(true);
  assert(a.includes("elxea"), "mentions brand");
  assert(a.includes("https://elxea.com/ja"), "has site URL");
  assert(a.includes("AI"), "AI 開示1文（P0-5）");
  assert(a.includes("月に1〜2回"), "配信頻度の期待値");
  // opt-out 廃止（2026-07-13）: 存在しない「配信停止できます」約束を書かないことを固定。
  assert(!a.includes("停止"), "配信停止の約束を含めない");
});

console.log("\n--- (e) インターセプタ順序（pending-state 保護） ---");

it("handleMenuActionFlow は onboarding / feedback の後に配線される", () => {
  const src = readFileSync(new URL("../../src/routes/line.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function handleTextMessage"));
  const iOnboarding = fn.indexOf("handleOnboardingMessage(lineUserId");
  const iFeedback = fn.indexOf("handleFeedbackMessage(lineUserId");
  const iMenu = fn.indexOf("handleMenuActionFlow(lineUserId");
  assert(iMenu > -1, "menu-action interceptor present");
  assert(iOnboarding > -1 && iOnboarding < iMenu, "onboarding precedes menu-action");
  assert(iFeedback > -1 && iFeedback < iMenu, "feedback precedes menu-action");
});

console.log("\n--- (f) ④定期便: 未連携分岐に便益+連携ボタンを追加（ブロック4） ---");

it("④分岐は resolveLinkedSubscriber で 3 態（subscriber / 連携済み非定期便 / 未連携）を出し分ける", () => {
  const src = readFileSync(new URL("../../src/lib/menu-actions.ts", import.meta.url), "utf8");
  // 旧 resolveSubscriptionKind（2 態）は撤去され、resolveLinkedSubscriber へ移行している。
  assert(!src.includes("resolveSubscriptionKind"), "old 2-way resolver removed");
  assert(src.includes("resolveLinkedSubscriber"), "uses linked-subscriber resolver");
  const branch = src.slice(src.indexOf("if (t === SUBSCRIPTION_TRIGGER)"));
  assert(branch.includes("resolution.isSubscriber"), "subscriber branch");
  assert(branch.includes("resolution.linked"), "linked (non-subscriber) branch");
});

it("未連携分岐は generic 紹介テキストの後に emitLinkageButton(surface=menu4) を出す", () => {
  const src = readFileSync(new URL("../../src/lib/menu-actions.ts", import.meta.url), "utf8");
  const branch = src.slice(src.indexOf("if (t === SUBSCRIPTION_TRIGGER)"));
  const iText = branch.indexOf('buildSubscriptionMessage("generic", siteOpen)');
  const iButton = branch.indexOf("emitLinkageButton(");
  assert(iText > -1, "generic intro sent");
  assert(iButton > -1, "linkage button emitted");
  assert(iText < iButton, "generic text precedes button (URL auto-links in text)");
  assert(branch.includes('"menu4"'), "surface=menu4 tag");
});

console.log("\n" + "=".repeat(60));
console.log("Menu Actions Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failed > 0 ? 1 : 0);
