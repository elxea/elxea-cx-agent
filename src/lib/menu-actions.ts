/**
 * リッチメニュー（5 枠版・オーナー確定 2026-07-13）の決定的（deterministic・LLM 不使用）応答。
 *
 * 対象枠:
 *   ③ 相談        … "相談したいことがあります"    → 初手 quick reply を提示（以降は既存 AI 会話）
 *   ④ 定期便      … "定期便について知りたい"      → Shopify 連携 × isSubscriber で出し分け
 *   ⑤ elxea について… "elxeaについて教えて"        → ブランド紹介 1 通（+ 配信設定の受け皿）
 *
 * 設計方針:
 *   - ①（お茶の淹れ方）と ②（好み診断）は本モジュールの対象外。
 *     ① は tea-menu.ts が処理し、② は既存 AI 会話フローへ素通りさせる。
 *   - トリガーは「完全一致」に限定。自由発話・無関係発話は false を返して素通りさせ、
 *     既存の AI 自由対話・診断・注文照会・feedback を一切壊さない。
 *   - ④ の出し分けは deterministic（LLM を挟まない）。customer_linkages と Firestore の
 *     isSubscriber だけで分岐し、取得不能時は安全側（案内）にフォールバックする。
 */

import type { Env } from "../index";
import { type QuickReplyItem, type LineResponder } from "./line";
import { ABOUT_BLURB, WELCOME_DELIVERY_FREQUENCY } from "./brand-copy";
import {
  resolveLinkedSubscriber,
  emitLinkageButton,
  isMarcheSourceUser,
} from "./subscriber-linkage";

// ---------------------------------------------------------------------------
// トリガー（リッチメニュー message text と完全一致）
// ---------------------------------------------------------------------------

/** ③ 相談 */
export const CONSULTATION_TRIGGER = "相談したいことがあります";
/** ④ 定期便 */
export const SUBSCRIPTION_TRIGGER = "定期便について知りたい";
/**
 * elxea について（**発話専用トリガー**・リッチメニューの枠は持たない）。
 *
 * 2026-08-09 commit e98843e でリッチメニュー枠 6 は roji アンケート導線
 * （roji-survey-copy.ts SURVEY_TRIGGER / roji = 層2 のキュレーション体験サービス）に
 * 差し替えられ、本文言を送る枠は無くなった。ただし自由発話でこの文言が来たときの
 * 固定応答は後方互換で存続させる（利用者が過去のメニュー履歴から再送するため）。
 */
export const ABOUT_TRIGGER = "elxeaについて教えて";

// ---------------------------------------------------------------------------
// リンク（web-app の実在ルート — sitemap SoT / defaultLocale=ja で確認済み）
// ---------------------------------------------------------------------------

/** 正規サイト（ドメイン + ロケール）。 */
const SITE_URL = "https://elxea.com/ja";
/** 定期便案内ページ（app/[locale]/subscription 実在）。 */
const SUBSCRIPTION_URL = "https://elxea.com/ja/subscription";

// ---------------------------------------------------------------------------
// 純粋ビルダー（テスト可能・I/O なし）
// ---------------------------------------------------------------------------

function qr(label: string, text: string): QuickReplyItem {
  return { type: "action", action: { type: "message", label, text } };
}

/**
 * ③ 相談の初手メッセージ。
 * 2-3 個の quick reply で入口を分かりやすくする。各 quick reply の text は自然発話で、
 * タップ後は本モジュールを素通りして既存の AI 会話フローに乗る（意図的にトリガー非一致）。
 */
/** ③相談 初手の 3 択が送るテキスト（consult.entry の value 判定 SoT）。 */
export const CONSULT_ENTRY_TEXTS = {
  order: "注文状況と定期便について確認したいです",
  tea: "お茶選びを相談したいです",
  other: "その他の相談があります",
} as const;

export function buildConsultationPrompt(): { text: string; quickReplies: QuickReplyItem[] } {
  return {
    text:
      "ご相談ありがとうございます。\n" +
      "どのようなことをお手伝いしましょうか。\n" +
      "下からお選びいただくか、そのままメッセージでお聞かせください。",
    quickReplies: [
      qr("ご注文・定期便の確認", CONSULT_ENTRY_TEXTS.order),
      qr("お茶選びの相談", CONSULT_ENTRY_TEXTS.tea),
      qr("その他の相談", CONSULT_ENTRY_TEXTS.other),
    ],
  };
}

/**
 * ③相談 初手の 3 択タップ（consult.entry）の value スラッグを返す（純粋・P0-1）。
 * これらの発話は AI 会話へ素通りするため、記録は handleMessage で fire-and-forget に行う。
 */
export function consultEntryValue(
  userMessage: string,
): "order" | "tea" | "other" | null {
  const t = userMessage.trim();
  if (t === CONSULT_ENTRY_TEXTS.order) return "order";
  if (t === CONSULT_ENTRY_TEXTS.tea) return "tea";
  if (t === CONSULT_ENTRY_TEXTS.other) return "other";
  return null;
}

/** ⑤ elxea についての紹介（3-4 文・和の静けさ）＋ 配信設定の受け皿を末尾に一言。 */
export function buildAboutMessage(): string {
  return (
    `${ABOUT_BLURB}\n\n` +
    `くわしくはこちらをご覧ください。\n${SITE_URL}\n\n` +
    "このトークは、elxea のサポートを担当する AI がお答えしています。お茶えらびのご相談など、気軽に話しかけてくださいね。\n\n" +
    WELCOME_DELIVERY_FREQUENCY
  );
}

/**
 * ④ 定期便メッセージ。
 * @param kind "subscriber" = 連携済み & 定期便あり / "generic" = それ以外（未連携含む）
 */
export function buildSubscriptionMessage(kind: "subscriber" | "generic"): string {
  if (kind === "subscriber") {
    // TODO（Shopify 開店後）: Firestore/Shopify から現在のプラン名・次回お届け日・
    //   お届け間隔を取得し、この 1 通に差し込んで詳細化する。現段階は導線のみ。
    return (
      "いつも elxea の定期便をご利用いただき、ありがとうございます。\n\n" +
      "お届け中のプラン内容やお届け日のご確認・ご変更は、こちらのページからお手続きいただけます。\n" +
      `${SUBSCRIPTION_URL}\n\n` +
      "ご不明な点があれば、このままメッセージでお気軽にお尋ねください。"
    );
  }
  return (
    "elxea の定期便は、季節のお茶を旬に合わせて定期的にお届けする仕組みです。\n\n" +
    "選ぶ手間なく、その時季にいちばんおいしいお茶を、暮らしのそばに置いていただけます。\n\n" +
    `プランの詳細はこちらからご覧いただけます。\n${SUBSCRIPTION_URL}\n\n` +
    "気になることがあれば、このままメッセージでお尋ねくださいね。"
  );
}

// ---------------------------------------------------------------------------
// オーケストレーション（インターセプタ本体）
// ---------------------------------------------------------------------------

/**
 * リッチメニュー ③④⑤ の決定的応答インターセプタ。
 *
 * @returns 処理したら true（＝ここで応答完結）。対象トリガーでなければ false
 *          （＝呼び出し側は既存の AI 会話フローへ素通りさせる）。
 */
export async function handleMenuActionFlow(
  lineUserId: string,
  userMessage: string,
  env: Env,
  responder: LineResponder,
): Promise<boolean> {
  const t = userMessage.trim();

  // ③ 相談 — 初手 quick reply（以降は AI 会話）
  if (t === CONSULTATION_TRIGGER) {
    const m = buildConsultationPrompt();
    await responder.text(m.text, m.quickReplies);
    return true;
  }

  // elxea について（発話専用・メニュー枠なし）— ブランド紹介 1 通
  if (t === ABOUT_TRIGGER) {
    await responder.text(buildAboutMessage());
    return true;
  }

  // ④ 定期便 — 連携状態 × isSubscriber で出し分け（読み取りのみ・LLM 不使用）。
  //   - 連携済み定期便       → subscriber 応答（従来どおり）
  //   - 連携済み非定期便       → generic 紹介（従来どおり・すでに連携済みなので連携ボタンは出さない）
  //   - 未連携                → generic 紹介 + 便益 1 行 + 連携ボタン（LIFF 設定時）/ generic のみ（未設定・fail-safe）
  if (t === SUBSCRIPTION_TRIGGER) {
    const resolution = await resolveLinkedSubscriber(lineUserId, env);
    if (resolution.isSubscriber) {
      await responder.text(buildSubscriptionMessage("subscriber"));
    } else if (resolution.linked) {
      // 連携済み非定期便: 従来どおり generic 紹介のみ（連携済みなので連携導線は不要）。
      await responder.text(buildSubscriptionMessage("generic"));
    } else {
      // 未連携: 従来の generic 紹介（テキスト・URL は LINE が自動リンク）を送り、
      //   LIFF 設定時のみ続けて便益 + 連携ボタン（Flex）を出す（surface=menu4・invite_shown 記録）。
      //   LIFF 未設定（prod・fail-safe）は generic 紹介のみ（従来動作・ボタンなし）。
      //   generic 紹介の送信失敗が「連携ボタン提示（ファネルの本命）」を巻き込まないよう best-effort で保護する
      //   （invite_shown は emitLinkageButton が送信前に記録するため、ボタン提示は send 成否に依存しない）。
      try {
        await responder.text(buildSubscriptionMessage("generic"));
      } catch (err) {
        console.warn(
          "[menu] ④ generic intro send failed (continuing to linkage button):",
          err instanceof Error ? err.message : err,
        );
      }
      // マルシェ流入のお客さまには連携ボタンを出さない（空振り連携の抑止・CX S1/S2）。
      //   マルシェ客は generic 紹介のみで着地（連携の袋小路に誘導しない）。設計要件をコードのゲートに格上げ。
      if (!(await isMarcheSourceUser(lineUserId, env))) {
        await emitLinkageButton(lineUserId, env, responder, "menu4");
      }
    }
    return true;
  }

  return false;
}
