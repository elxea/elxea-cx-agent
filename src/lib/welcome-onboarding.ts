/**
 * 入口質問型ウェルカム（ブロック2 — 3動線の入口整備）。
 *
 * 設計: 統合設計書「ブロック2: 入口質問型ウェルカム」
 *   https://app.notion.com/p/39f70c9d064c81b9bf20deaeb32b99e0
 *
 * 役割: 友だち追加直後に「どこで elxea を知ったか」を 1 回だけ質問し、回答で 3 動線へ分岐する。
 *   - マルシェ・イベント → 袋の 5 桁番号の案内（既存 tea-menu がそのまま受ける）
 *   - オンライン / その他 → 従来の 3 択 + 好み診断ボタン
 *
 * 本モジュールは純粋（副作用なし）にビルダー・分類器を提供し、記録・送信は routes/line.ts が行う。
 * テスト可能性: 分岐 3 種・素通り（null）を tests/unit/welcome-onboarding.test.ts で機械検証する。
 *
 * 文言の正本トーン: src/lib/brand-copy.ts。押し売りしない・1 メッセージ 100 文字目安・
 *   絵文字はボタンのアイコン的利用のみ（本文絵文字禁止）。
 */

import type { QuickReplyItem } from "./line";
import { WELCOME_INTRO } from "./brand-copy";
import { DIAGNOSIS_TRIGGER } from "./preference-diagnosis";
import { TEA_LIST_ENTRY_TRIGGER } from "./tea-menu";

// ---------------------------------------------------------------------------
// オンボーディング Quick Reply のトリガーテキスト（従来 3 択・正本）
// ---------------------------------------------------------------------------

/** 「お茶を探す」動線。 */
export const ONBOARDING_EXPLORE_TEXT = "onboarding:explore_tea";
/** 「elxea について知る」動線。 */
export const ONBOARDING_ABOUT_TEXT = "onboarding:about_elxea";
/** 「使い方を教えて」動線。 */
export const ONBOARDING_HOWTO_TEXT = "onboarding:how_to_use";

// ---------------------------------------------------------------------------
// 入口質問（流入元）のトリガーテキスト
// ---------------------------------------------------------------------------

/** 🌿 マルシェ・イベントで。 */
export const WELCOME_SOURCE_MARCHE_TEXT = "onboarding:source_marche";
/** 🛒 オンラインで。 */
export const WELCOME_SOURCE_ONLINE_TEXT = "onboarding:source_online";
/** その他。 */
export const WELCOME_SOURCE_OTHER_TEXT = "onboarding:source_other";

/** flow_events(welcome.source) / Firestore(onboarding.source) に記録する列挙値（自由文禁止）。 */
export type WelcomeSource = "marche" | "online" | "other";

/** トリガーテキスト → 記録用 slug（純粋・完全一致のみ・想定外は null）。 */
export function parseWelcomeSourceAnswer(userMessage: string): WelcomeSource | null {
  switch (userMessage) {
    case WELCOME_SOURCE_MARCHE_TEXT:
      return "marche";
    case WELCOME_SOURCE_ONLINE_TEXT:
      return "online";
    case WELCOME_SOURCE_OTHER_TEXT:
      return "other";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// メッセージビルダー（純粋）
// ---------------------------------------------------------------------------

/** ビルダーの戻り値（送信は呼び出し側）。 */
export interface WelcomeMessage {
  text: string;
  quickReplies: QuickReplyItem[];
}

function messageAction(label: string, text: string): QuickReplyItem {
  return { type: "action", action: { type: "message", label, text } };
}

/**
 * 友だち追加ウェルカム（入口質問型）。
 * WELCOME_INTRO と配信頻度の 1 行は維持し、末尾を流入元の質問に差し替える。
 */
export function buildEntryWelcome(): WelcomeMessage {
  const text =
    `${WELCOME_INTRO}\n\n` +
    "お便りをお送りするのは月に1〜2回、季節の節目だけです。\n\n" +
    "はじめに、どこで elxea を知っていただけましたか？";

  const quickReplies: QuickReplyItem[] = [
    messageAction("🌿 マルシェ・イベントで", WELCOME_SOURCE_MARCHE_TEXT),
    messageAction("🛒 オンラインで", WELCOME_SOURCE_ONLINE_TEXT),
    messageAction("その他", WELCOME_SOURCE_OTHER_TEXT),
  ];

  return { text, quickReplies };
}

/** マルシェ・イベント回答の分岐応答（袋の 5 桁番号を案内）。 */
function buildMarcheResponse(): WelcomeMessage {
  const text =
    "ありがとうございます。お手元のお茶の袋に5桁の番号があります。" +
    "送っていただくと、そのお茶の淹れ方などをご案内します。";

  const quickReplies: QuickReplyItem[] = [
    messageAction("🍵 30秒の好み診断", DIAGNOSIS_TRIGGER),
    messageAction("🍃 お茶の一覧を見る", TEA_LIST_ENTRY_TRIGGER),
    messageAction("使い方を教えて", ONBOARDING_HOWTO_TEXT),
  ];

  return { text, quickReplies };
}

/** オンライン / その他回答の分岐応答（従来 3 択 + 好み診断ボタン）。 */
function buildExploreResponse(): WelcomeMessage {
  const text = "ありがとうございます。まずは、何から始めましょうか？";

  const quickReplies: QuickReplyItem[] = [
    messageAction("お茶を探す", ONBOARDING_EXPLORE_TEXT),
    messageAction("elxea について知る", ONBOARDING_ABOUT_TEXT),
    messageAction("使い方を教えて", ONBOARDING_HOWTO_TEXT),
    messageAction("🍵 30秒の好み診断", DIAGNOSIS_TRIGGER),
  ];

  return { text, quickReplies };
}

/** 流入元回答に応じた分岐応答を返す（純粋）。 */
export function buildSourceResponse(source: WelcomeSource): WelcomeMessage {
  return source === "marche" ? buildMarcheResponse() : buildExploreResponse();
}
