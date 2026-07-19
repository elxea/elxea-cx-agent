/**
 * 入口質問型ウェルカム（ブロック2 — 3動線の入口整備）。
 *
 * 設計: 統合設計書「ブロック2: 入口質問型ウェルカム」
 *   https://app.notion.com/p/39f70c9d064c81b9bf20deaeb32b99e0
 *
 * 役割: 友だち追加直後に「どこで elxea を知ったか」を 1 回だけ質問し、回答で 3 動線へ分岐する。
 *   - マルシェ・イベント → 袋の 5 桁番号の案内（既存 tea-menu がそのまま受ける）
 *   - オンライン → 好み診断を主線に（設計 A-3・診断を quickReply 先頭 + 語調で先に薦める）
 *   - その他 → 従来の 3 択 + 好み診断ボタン
 *
 * 本モジュールは純粋（副作用なし）にビルダー・分類器を提供し、記録・送信は routes/line.ts が行う。
 * テスト可能性: 分岐 3 種・素通り（null）を tests/unit/welcome-onboarding.test.ts で機械検証する。
 *
 * 文言の正本トーン: src/lib/brand-copy.ts。押し売りしない・1 メッセージ 100 文字目安・
 *   絵文字はボタンのアイコン的利用のみ（本文絵文字禁止）。
 */

import type { QuickReplyItem } from "./line";
import { WELCOME_INTRO, WELCOME_DELIVERY_FREQUENCY } from "./brand-copy";
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
    `${WELCOME_DELIVERY_FREQUENCY}\n\n` +
    "はじめに、どこで elxea を知っていただけましたか？";

  const quickReplies: QuickReplyItem[] = [
    messageAction("🌿 マルシェ・イベントで", WELCOME_SOURCE_MARCHE_TEXT),
    messageAction("🛒 オンラインで", WELCOME_SOURCE_ONLINE_TEXT),
    messageAction("その他", WELCOME_SOURCE_OTHER_TEXT),
  ];

  return { text, quickReplies };
}

/**
 * マルシェ・イベント回答の分岐応答（袋の 5 桁番号を案内）。
 *
 * 設計 A-3 / D7「マルシェ出身 = 手元のお茶起点」の主線。spec drift #1（マルシェ = 最大の入口）を
 *   踏まえ、番号を送る動作（このトークに送る）とその見返り（淹れ方の案内）を明示して、初動の
 *   「番号未送信」離脱を減らす。トーン: 押し売りしない・静か（"よろしければ" で余白を残す）・本文絵文字禁止。
 *   ここで番号を送らず静かになった方には、後日 marche-activation.ts が短期の 1 通で静かに思い出してもらう。
 */
function buildMarcheResponse(): WelcomeMessage {
  const text =
    "ありがとうございます。お手元のお茶の袋に、5桁の番号が書かれています。" +
    "その番号をこのトークに送っていただくと、そのお茶の淹れ方をご案内します。" +
    "よろしければ、番号を送ってみてくださいね。";

  const quickReplies: QuickReplyItem[] = [
    messageAction("🍵 30秒の好み診断", DIAGNOSIS_TRIGGER),
    messageAction("🍃 お茶の一覧を見る", TEA_LIST_ENTRY_TRIGGER),
    messageAction("使い方を教えて", ONBOARDING_HOWTO_TEXT),
  ];

  return { text, quickReplies };
}

/**
 * オンライン回答の分岐応答（設計案 v2 A-3「オンライン出身 = 好み診断が主線」）。
 *
 * 設計意図（personalization-spec §6 優先4 / Table A #15 / 監査 #8）: オンライン入口は
 *   個別最適ゾーンへの最短路が「好み診断」（カルテ蓄積の起点）。従来は診断が 4 択の末尾に
 *   置かれ主線が希釈していた（buildExploreResponse を online/other で共用）。ここでは診断を
 *   主 CTA として (1) quickReply の先頭に置き + (2) 本文の語調で先に薦める。ほかの入り口
 *   （お茶を探す / について / 使い方）は副次として残し、選択肢自体は削らない。
 *
 * トーン: brand-copy 準拠（押し売りしない・本文絵文字禁止・1メッセージ100文字目安）。
 *   絵文字はボタンのアイコン的利用のみ（🍵）。
 */
function buildOnlineResponse(): WelcomeMessage {
  const text =
    "ありがとうございます。まずは30秒の好み診断で、あなたに合う一杯を見つけてみませんか。" +
    "もちろん、ほかのメニューからゆっくり選んでいただいても大丈夫です。";

  const quickReplies: QuickReplyItem[] = [
    messageAction("🍵 30秒の好み診断", DIAGNOSIS_TRIGGER),
    messageAction("お茶を探す", ONBOARDING_EXPLORE_TEXT),
    messageAction("elxea について知る", ONBOARDING_ABOUT_TEXT),
    messageAction("使い方を教えて", ONBOARDING_HOWTO_TEXT),
  ];

  return { text, quickReplies };
}

/**
 * その他回答の分岐応答（従来 3 択 + 好み診断ボタン）。
 *
 * 「その他」は設計 A-3 が主線を規定しない入口のため、従来の汎用 3 択（探す/について/使い方）
 *   + 末尾の好み診断ボタンの並びを維持する（online のような診断主線化はしない）。
 */
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
  switch (source) {
    case "marche":
      return buildMarcheResponse();
    case "online":
      // 設計 A-3: オンライン出身は好み診断を主線に（診断先頭 + 語調で先に薦める）。
      return buildOnlineResponse();
    default:
      // "その他"（設計 A-3 が主線を規定しない入口）は従来の汎用応答へ。
      return buildExploreResponse();
  }
}
