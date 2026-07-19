/**
 * 会話フィードバック（👍/👎）Quick Reply の生成と提示頻度（監査 #5「常時付与 → 静か原則に整合」）。
 *
 * トレース結果（撤去せず頻度を絞る理由）:
 *   「👍 よかった / 👎 改善希望」は AI 応答への品質フィードバックで、タップ時に
 *   routes/line.ts handleFeedbackMessage が Supabase `message_feedback` へ rating(+1/-1) を記録し、
 *   ネガ時は Slack 通知する（sendNegativeFeedbackAlert）。これは お茶の 感想
 *   （product_ratings → selectNextCup による次の一杯 = 個別最適の燃料）とは **別系統の独立シグナル**。
 *   よって撤去はしない（撤去すると品質シグナル/ネガ検知の入口が消える）。代わりに
 *   「毎ターン常時付与」だけをやめ、提示頻度を絞る（静けさを回復しつつ信号は保全）。
 *   感想→product_ratings→次の一杯 ループには一切触れない（別モジュール・別テーブル・別経路）。
 *
 * このモジュールは routes/line.ts から純粋ロジックだけを切り出したもの（重い依存を持たない）。
 * テストは本モジュールを直接 import して純粋関数を検証できる（routes/line.ts を読み込まない）。
 */

import type { QuickReplyItem } from "./line";

/** フィードバック Quick Reply のトリガーテキスト（handleFeedbackMessage が完全一致で解釈する正本）。 */
export const FEEDBACK_POSITIVE_TEXT = "feedback:positive";
export const FEEDBACK_NEGATIVE_TEXT = "feedback:negative";

/**
 * 提示頻度（N ターンに 1 回）。静か原則（毎ターンの評価ボタンを出さない）と、
 * 品質シグナル確保（定期的に affordance は残す）の折り合いを取る単一ノブ。
 * 運用データを見て調整可能（値だけ変えれば頻度が変わる）。tasting-note CTA のしきい値 5 と揃える。
 */
export const FEEDBACK_QUICK_REPLY_EVERY_N_TURNS = 5;

/**
 * 👍/👎 の 2 ボタンを生成する（タップ時の記録・Slack 通知は handleFeedbackMessage 側で不変）。
 * これらのボタンは「信号の入口」であり、内容（テキスト）は変えない。
 */
export function buildFeedbackQuickReplies(): QuickReplyItem[] {
  return [
    {
      type: "action",
      action: { type: "message", label: "👍 よかった", text: FEEDBACK_POSITIVE_TEXT },
    },
    {
      type: "action",
      action: { type: "message", label: "👎 改善希望", text: FEEDBACK_NEGATIVE_TEXT },
    },
  ];
}

/**
 * このターンで 👍/👎 を提示するか（純粋・監査 #5）。
 * 常時付与はやめ、初回応答で 1 度だけ affordance を見せ、以降は N ターンに 1 度だけにする（静か）。
 * タップ経路（handleFeedbackMessage）は常時有効なので「出した時だけ」記録できる
 *   ＝ 品質シグナルは保全され、毎ターンのノイズだけが減る。
 *
 * @param assistantTurnCount このターンを含むアシスタント応答の通算回数（1 始まり）。
 */
export function shouldAttachFeedbackQuickReplies(assistantTurnCount: number): boolean {
  if (assistantTurnCount <= 0) return false;
  if (assistantTurnCount === 1) return true; // 初回応答で一度だけ affordance を提示（学習のため）
  return assistantTurnCount % FEEDBACK_QUICK_REPLY_EVERY_N_TURNS === 0; // 以降は N ターンに 1 度
}

/**
 * エージェント応答の Quick Reply 列に、フィードバック 2 ボタンを（頻度条件を満たす時だけ）付ける（純粋）。
 * エージェント自身の Quick Reply は常に保持し、フィードバックは末尾に付与するか否かだけを判断する。
 * これにより「毎ターン常時付与」を「初回 + N ターンに 1 度」へ置き換える（信号は保全・静けさは回復）。
 */
export function buildResponseQuickReplies(
  agentQuickReplies: QuickReplyItem[],
  opts: { assistantTurnCount: number },
): QuickReplyItem[] {
  const quickReplies = [...agentQuickReplies];
  if (shouldAttachFeedbackQuickReplies(opts.assistantTurnCount)) {
    quickReplies.push(...buildFeedbackQuickReplies());
  }
  return quickReplies;
}
