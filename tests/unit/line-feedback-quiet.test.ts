/**
 * Unit Tests -- 会話フィードバック 👍/👎 の「常時付与 → 静か原則に整合」（監査 #5）
 *
 * トレース済みの事実: 👍/👎 は品質フィードバックで、タップ時に routes/line.ts handleFeedbackMessage が
 *   Supabase message_feedback へ rating(+1/-1) を記録し、ネガ時は Slack 通知する。これは お茶の 感想
 *   （product_ratings → selectNextCup）とは別系統の重要シグナル。よって撤去せず、常時付与だけをやめて
 *   提示頻度を絞る（信号は保全・静けさは回復）。本テストはその境界を固定する。
 *
 * 検証:
 *   (a) 提示頻度ゲート: 初回 + N ターンに 1 度だけ true、それ以外は false（常時付与ではない）
 *   (b) buildResponseQuickReplies: エージェント QR は常に保持し、フィードバックは頻度条件時のみ末尾付与
 *   (c) 信号保全: buildFeedbackQuickReplies の 2 ボタン（feedback:positive / negative）は不変
 *   (d) 配線 break-proof: routes/line.ts が buildResponseQuickReplies 経由で、旧「常時 append」を残さない
 *
 * 使用方法: npx tsx tests/unit/line-feedback-quiet.test.ts
 */

import { readFileSync } from "node:fs";
import {
  shouldAttachFeedbackQuickReplies,
  buildResponseQuickReplies,
  buildFeedbackQuickReplies,
  FEEDBACK_POSITIVE_TEXT,
  FEEDBACK_NEGATIVE_TEXT,
  FEEDBACK_QUICK_REPLY_EVERY_N_TURNS,
} from "../../src/lib/feedback-quick-reply";
import type { QuickReplyItem } from "../../src/lib/line";

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
function assertDeep<T>(actual: T, expected: T, label = "") {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const agentQR: QuickReplyItem[] = [
  { type: "action", action: { type: "message", label: "お茶を選ぶ", text: "お茶を選ぶ" } },
];
const texts = (qrs: QuickReplyItem[]) => qrs.map((q) => q.action.text);
const hasFeedback = (qrs: QuickReplyItem[]) =>
  texts(qrs).includes(FEEDBACK_POSITIVE_TEXT) || texts(qrs).includes(FEEDBACK_NEGATIVE_TEXT);

console.log("\n--- (a) 提示頻度ゲート（常時付与ではない） ---");

it("初回応答(turn=1)では提示する（affordance を一度は見せる）", () => {
  assert(shouldAttachFeedbackQuickReplies(1) === true, "turn1 true");
});

it("静かなターン(2,3,4)では提示しない（declutter・break-proof）", () => {
  for (const t of [2, 3, 4]) assert(shouldAttachFeedbackQuickReplies(t) === false, `turn${t} false`);
});

it("N ターン目(=5)で再提示、その倍数(=10)でも提示（信号を定期的に確保）", () => {
  assert(shouldAttachFeedbackQuickReplies(FEEDBACK_QUICK_REPLY_EVERY_N_TURNS) === true, "turnN true");
  assert(
    shouldAttachFeedbackQuickReplies(FEEDBACK_QUICK_REPLY_EVERY_N_TURNS * 2) === true,
    "turn2N true",
  );
});

it("turn<=0 は提示しない（安全側）", () => {
  assert(shouldAttachFeedbackQuickReplies(0) === false, "turn0 false");
  assert(shouldAttachFeedbackQuickReplies(-3) === false, "neg false");
});

console.log("\n--- (b) buildResponseQuickReplies ---");

it("静かなターンは feedback を付けず、エージェント QR は保持（常時付与でない）", () => {
  const qrs = buildResponseQuickReplies(agentQR, { assistantTurnCount: 3 });
  assert(!hasFeedback(qrs), "no feedback on quiet turn");
  assert(texts(qrs).includes("お茶を選ぶ"), "agent QR preserved");
  assert(qrs.length === 1, "only agent QR");
});

it("提示ターンは末尾に feedback 2 ボタンを付与（エージェント QR の後）", () => {
  const qrs = buildResponseQuickReplies(agentQR, { assistantTurnCount: 1 });
  assert(qrs.length === 3, "agent + 2 feedback");
  assert(qrs[0].action.text === "お茶を選ぶ", "agent QR first");
  assert(hasFeedback(qrs), "feedback appended");
});

it("エージェント QR 空でも提示ターンでは feedback を出せる（信号の入口を残す）", () => {
  const qrs = buildResponseQuickReplies([], { assistantTurnCount: 1 });
  assertDeep(texts(qrs), [FEEDBACK_POSITIVE_TEXT, FEEDBACK_NEGATIVE_TEXT], "feedback only");
});

console.log("\n--- (c) 信号保全: 2 ボタンのテキストは不変 ---");

it("buildFeedbackQuickReplies は feedback:positive / negative の 2 ボタン（記録・通知の入口）", () => {
  const fb = buildFeedbackQuickReplies();
  assert(fb.length === 2, "2 buttons");
  assert(fb[0].action.text === FEEDBACK_POSITIVE_TEXT, "positive text unchanged");
  assert(fb[1].action.text === FEEDBACK_NEGATIVE_TEXT, "negative text unchanged");
  assert(fb[0].action.label.includes("よかった"), "positive label");
  assert(fb[1].action.label.includes("改善希望"), "negative label");
});

console.log("\n--- (d) 配線 break-proof（routes/line.ts） ---");

it("handleTextMessage は buildResponseQuickReplies 経由・旧『常時 append』を残さない", () => {
  const src = readFileSync(new URL("../../src/routes/line.ts", import.meta.url), "utf8");
  assert(src.includes("buildResponseQuickReplies("), "wired via buildResponseQuickReplies");
  // 旧パターン [...agentQuickReplies, ...feedbackQuickReplies] が残っていない（常時付与の回帰を禁止）。
  assert(
    !/\[\s*\.\.\.agentQuickReplies\s*,\s*\.\.\.feedbackQuickReplies\s*\]/.test(src),
    "no unconditional [...agent, ...feedback] append",
  );
  // 感想→next-cup ループの入口（message_feedback 記録経路）は不変であること。
  assert(src.includes("message_feedback"), "message_feedback recording path intact");
});

console.log("\n" + "=".repeat(60));
console.log("Feedback Quiet (監査 #5) Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failed > 0 ? 1 : 0);
