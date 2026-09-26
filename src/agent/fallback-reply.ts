/**
 * AI の返事が作れなかったときに返す文 (既存の fallback 文。文言は変えない)。
 *
 * もとは src/agent/core.ts の 2 か所 (runAgent の最終テキストが空のとき / runAgentStreaming の全文が空のとき)
 * に同じ文字列で書かれていたもの。送る関所 (src/lib/closed-link-gate.ts) で閉じたリンクを消した結果
 * 本文が空になったときも、無言にせずこの文に置き換えるため、1 か所に寄せた (D2b QA F1・Boss 確定)。
 *
 * 依存を持たない (lib からも agent からも import できるように)。
 */
export const AGENT_FALLBACK_REPLY = "申し訳ありません、お返事の生成に失敗しました。";
