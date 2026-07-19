/**
 * ハーメティック — 動線5: 会話フィードバック 👍/👎 の「常時付与 → 静か原則に整合」（監査 #5）。
 *
 * 👍/👎 は品質フィードバック（タップ時に routes/line.ts handleFeedbackMessage が Supabase
 *   message_feedback へ rating を記録し、ネガ時は Slack 通知する）で、お茶の 感想
 *   （product_ratings → selectNextCup）とは別系統の重要シグナル。撤去せず常時付与だけをやめて頻度を絞る。
 *
 * 本ファイルは出荷される純粋ロジック buildResponseQuickReplies の挙動を固定する（ネットワーク不使用＝
 * ハーメティック）。AI 自由対話の応答は LLM 経路（Anthropic）を要すためハーメティックに駆動しない
 * （workerd プールは host ファイルも読めないためソース grep もここでは行わない）。handleTextMessage が
 * buildResponseQuickReplies 経由で旧「常時 append」を残していないことの配線 break-proof は
 * tests/unit/line-feedback-quiet.test.ts（tsx で readFileSync 可能）が担保する。
 * 感想→next-cup ループの非回帰は flow1 が担保する。
 */

import { describe, expect, it } from "vitest";
import {
  shouldAttachFeedbackQuickReplies,
  buildResponseQuickReplies,
  buildFeedbackQuickReplies,
  FEEDBACK_POSITIVE_TEXT,
  FEEDBACK_NEGATIVE_TEXT,
  FEEDBACK_QUICK_REPLY_EVERY_N_TURNS,
} from "../../src/lib/feedback-quick-reply";
import type { QuickReplyItem } from "../../src/lib/line";

const agentQR: QuickReplyItem[] = [
  { type: "action", action: { type: "message", label: "お茶を選ぶ", text: "お茶を選ぶ" } },
];
const texts = (qrs: QuickReplyItem[]) => qrs.map((q) => q.action.text);

describe("hermetic — 動線5: 👍/👎 を静か原則に整合（信号は保全・監査 #5）", () => {
  it("常時付与ではない: 静かなターン(2,3,4)では 👍/👎 を付けない（declutter・break-proof）", () => {
    for (const t of [2, 3, 4]) {
      const qrs = buildResponseQuickReplies(agentQR, { assistantTurnCount: t });
      expect(texts(qrs), `turn${t} は positive を出さない`).not.toContain(FEEDBACK_POSITIVE_TEXT);
      expect(texts(qrs), `turn${t} は negative を出さない`).not.toContain(FEEDBACK_NEGATIVE_TEXT);
      // エージェント自身の Quick Reply は保持する（機能を削らない）。
      expect(texts(qrs)).toContain("お茶を選ぶ");
    }
  });

  it("信号は保全: 初回 + N ターンでは 👍/👎 を提示し、2 ボタンのテキストは不変", () => {
    expect(shouldAttachFeedbackQuickReplies(1)).toBe(true);
    expect(shouldAttachFeedbackQuickReplies(FEEDBACK_QUICK_REPLY_EVERY_N_TURNS)).toBe(true);
    const fb = buildFeedbackQuickReplies();
    expect(texts(fb)).toEqual([FEEDBACK_POSITIVE_TEXT, FEEDBACK_NEGATIVE_TEXT]);
    const onFirstTurn = buildResponseQuickReplies([], { assistantTurnCount: 1 });
    expect(texts(onFirstTurn)).toEqual([FEEDBACK_POSITIVE_TEXT, FEEDBACK_NEGATIVE_TEXT]);
  });
});
