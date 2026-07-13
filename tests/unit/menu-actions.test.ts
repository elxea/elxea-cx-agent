/**
 * Unit Tests -- menu-actions（リッチメニュー ③相談 / ④定期便 / ⑤elxeaについて の決定的応答）
 *
 * 純粋ロジック（Notion / LINE push / Firestore に触れない）を検証する:
 *   (a) トリガー文言がリッチメニュー（setup-rich-menu.ts）の message text と一致
 *   (b) ③相談: 初手 quick reply が 2-3 個・text は tea-menu / menu トリガーと非衝突（AI へ素通り）
 *   (c) ④定期便: subscriber / generic の出し分けメッセージ（両方リンクを含む）
 *   (d) ⑤elxea: ブランド紹介（URL 実在 /ja）＋ 配信設定の受け皿
 *   (e) インターセプタ順序: onboarding / feedback の後（pending-state 保護）
 *
 * 使用方法: npx tsx tests/unit/menu-actions.test.ts
 */

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

it("トリガー定数が setup-rich-menu.ts の各枠 message text と一致", () => {
  const src = readFileSync(new URL("../../scripts/setup-rich-menu.ts", import.meta.url), "utf8");
  assert(src.includes(`text: "${CONSULTATION_TRIGGER}"`), "③相談 text matches");
  assert(src.includes(`text: "${SUBSCRIPTION_TRIGGER}"`), "④定期便 text matches");
  assert(src.includes(`text: "${ABOUT_TRIGGER}"`), "⑤elxea text matches");
  // ①お茶の淹れ方 は tea-menu が処理（トリガー一致は tea-menu 側で担保）
  assert(src.includes(`text: "お茶の淹れ方を知りたい"`), "①tea text present");
  // ②好み診断 は AI 会話へ（本モジュール非対象）
  assert(src.includes(`text: "好みに合うお茶を診断してほしいです"`), "②diagnosis text present");
});

console.log("\n--- (b) ③相談: 初手 quick reply ---");

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

it("subscriber: 御礼 + プラン確認リンク（/ja/subscription）を含む", () => {
  const s = buildSubscriptionMessage("subscriber");
  assert(s.includes("https://elxea.com/ja/subscription"), "has subscription link");
  assert(s.includes("ありがとう"), "thanks existing subscriber");
});

it("generic: 押し売りしない紹介 + リンクを含む", () => {
  const g = buildSubscriptionMessage("generic");
  assert(g.includes("https://elxea.com/ja/subscription"), "has subscription link");
  assert(g.includes("定期便"), "introduces subscription");
});

it("subscriber と generic は別文面", () => {
  assert(
    buildSubscriptionMessage("subscriber") !== buildSubscriptionMessage("generic"),
    "two distinct variants",
  );
});

console.log("\n--- (d) ⑤elxea について ---");

it("ブランド紹介 + 実在 URL(/ja) + AI 開示 + 配信頻度（opt-out 約束は書かない）", () => {
  const a = buildAboutMessage();
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

console.log("\n" + "=".repeat(60));
console.log("Menu Actions Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failed > 0 ? 1 : 0);
