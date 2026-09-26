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
import { ABOUT_BLURB, SUPPORT_EMAIL, WELCOME_DELIVERY_FREQUENCY } from "./brand-copy";
import { byStore, EC_SITE_OPEN } from "./storefront";
import {
  resolveLinkedSubscriber,
  emitLinkageButton,
  isMarcheSourceUser,
  type LinkageSiteDeps,
} from "./subscriber-linkage";
import { isSalesSurfaceEnabled } from "./sales-surface";

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

/**
 * ⑤ elxea についての紹介（3-4 文・和の静けさ）＋ 配信設定の受け皿を末尾に一言。
 *
 * C-12（文言 v2）: 公式サイトが閉じている間は「くわしくはこちら」の 1 行ぶんを組み立てない
 * （ブランド紹介の行き先は Amazon ストアではないため、案内だけ外す。前後の文はそのまま）。
 * @param siteOpen 公式 EC が開店しているか（既定 EC_SITE_OPEN。テストは両方を渡して固定する）
 */
export function buildAboutMessage(siteOpen: boolean = EC_SITE_OPEN): string {
  return (
    `${ABOUT_BLURB}\n\n` +
    byStore(`くわしくはこちらをご覧ください。\n${SITE_URL}\n\n`, "", siteOpen) +
    "このトークは、elxea のサポートを担当する AI がお答えしています。お茶えらびのご相談など、気軽に話しかけてくださいね。\n\n" +
    WELCOME_DELIVERY_FREQUENCY
  );
}

/**
 * C-9（文言 v2）: 定期便を利用中の方への閉店中の返事。定期便ページが閉じているので、
 * 開いている窓口（問い合わせメール）へ向ける。
 */
export const SUBSCRIPTION_SUBSCRIBER_REPLY_CLOSED =
  "いつも elxea の定期便をご利用いただき、ありがとうございます。\n\n" +
  `お届け内容やお届け日のご確認・ご変更は、お手数ですが ${SUPPORT_EMAIL} までご連絡ください。\n\n` +
  "ご不明な点があれば、このままメッセージでお気軽にお尋ねください。";

/**
 * C-10（文言 v2）: 定期便の紹介（売り込み面 ON の未利用の方）の閉店中の返事。
 * 申し込めないものの魅力を語らず、開始時期の約束もしない。Amazon は定期便の代わりにならないので案内しない。
 */
export const SUBSCRIPTION_GENERIC_REPLY_CLOSED =
  "elxea の定期便は、いまお届けをはじめる準備を進めています。\n\n" +
  "気になることがあれば、このままメッセージでお尋ねくださいね。";

/**
 * C-11（文言 v2）: 定期便の既定の返事（売り込み面 OFF）の閉店中の文。C-10 と 1 文目をそろえている。
 */
export const SUBSCRIPTION_INQUIRY_REPLY_CLOSED =
  "elxea の定期便は、いまお届けをはじめる準備を進めています。\n\n" +
  "お茶のことでしたら、このままメッセージでお尋ねくださいね。";

/**
 * ④ 定期便メッセージ。
 * @param kind "subscriber" = 連携済み & 定期便あり / "generic" = それ以外（未連携含む）
 * @param siteOpen 公式 EC が開店しているか（既定 EC_SITE_OPEN）。閉店中は C-9 / C-10 を返す。
 */
export function buildSubscriptionMessage(
  kind: "subscriber" | "generic",
  siteOpen: boolean = EC_SITE_OPEN,
): string {
  if (!siteOpen) {
    return kind === "subscriber" ? SUBSCRIPTION_SUBSCRIBER_REPLY_CLOSED : SUBSCRIPTION_GENERIC_REPLY_CLOSED;
  }
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

/**
 * ④ 定期便（売り込み面 OFF・既定時）の中立応答。
 *
 * roji「物販の匂いを出さない」に従い、**未利用の方への定期便の常設案内**（便益の訴求・
 * 連携ボタンのファネル）は出さない。お客様が自分から尋ねたときの受け皿として、
 * 事実の案内先（EC サイト）だけを 1 通返す。便益・評価・煽りの言葉は置かない。
 * 機能定義 v1.5 3-5・Phase 0 タスク4。
 */
/** ④ 定期便で返す応答の種類。 */
export type SubscriptionResponseKind =
  /** 利用中の方へのお手続き案内（購入後サポート・常時有効）。 */
  | "subscriber"
  /** 中立の案内先 1 通（売り込み面 OFF・既定）。 */
  | "inquiry"
  /** 従来の紹介 1 通のみ（売り込み面 ON・連携済み非定期便）。 */
  | "generic"
  /** 従来の紹介 + 連携ボタンのファネル（売り込み面 ON・未連携）。 */
  | "generic_with_linkage";

/**
 * ④ 定期便の応答種別を決める（純粋・I/O なし）。
 *
 * 売り込み面 OFF（既定）では、利用中の方以外に**定期便の常設案内を出さない**。
 * 便益の訴求・連携ボタンのファネルは売り込み面 ON のときだけ復活する。
 */
export function decideSubscriptionResponse(opts: {
  salesEnabled: boolean;
  linked: boolean;
  isSubscriber: boolean;
  /** 公式 EC が開店しているか（既定 EC_SITE_OPEN）。 */
  siteOpen?: boolean;
}): SubscriptionResponseKind {
  if (opts.isSubscriber) return "subscriber";
  if (!opts.salesEnabled) return "inquiry";
  // 閉店中は連携ボタンのファネル（generic_with_linkage）に進ませない（実装設計 rev2 第4章）。
  //   連携先の購入アカウントが開店前には無いため、未連携でも紹介 1 通（C-10）で着地させる。
  if (!(opts.siteOpen ?? EC_SITE_OPEN)) return "generic";
  return opts.linked ? "generic" : "generic_with_linkage";
}

/**
 * ④ 定期便（売り込み面 OFF・既定）の中立応答。
 * @param siteOpen 公式 EC が開店しているか（既定 EC_SITE_OPEN）。閉店中は C-11 を返す。
 */
export function buildSubscriptionInquiryReply(siteOpen: boolean = EC_SITE_OPEN): string {
  if (!siteOpen) return SUBSCRIPTION_INQUIRY_REPLY_CLOSED;
  return (
    "定期便の内容とお申し込みは、elxea のサイトでご覧いただけます。\n" +
    `${SUBSCRIPTION_URL}\n\n` +
    "お茶のことでしたら、このままメッセージでお尋ねくださいね。"
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
  deps?: LinkageSiteDeps,
): Promise<boolean> {
  const t = userMessage.trim();
  // 公式 EC の開店状態（既定 EC_SITE_OPEN）。テストは deps で開店時 / 閉店中の両方を固定する。
  const siteOpen = deps?.siteOpen ?? EC_SITE_OPEN;

  // ③ 相談 — 初手 quick reply（以降は AI 会話）
  if (t === CONSULTATION_TRIGGER) {
    const m = buildConsultationPrompt();
    await responder.text(m.text, m.quickReplies);
    return true;
  }

  // elxea について（発話専用・メニュー枠なし）— ブランド紹介 1 通
  if (t === ABOUT_TRIGGER) {
    await responder.text(buildAboutMessage(siteOpen));
    return true;
  }

  // ④ 定期便 — 連携状態 × isSubscriber で出し分け（読み取りのみ・LLM 不使用）。
  //   - 連携済み定期便       → subscriber 応答（従来どおり）
  //   - 連携済み非定期便       → generic 紹介（従来どおり・すでに連携済みなので連携ボタンは出さない）
  //   - 未連携                → generic 紹介 + 便益 1 行 + 連携ボタン（LIFF 設定時）/ generic のみ（未設定・fail-safe）
  if (t === SUBSCRIPTION_TRIGGER) {
    const resolution = await (deps?.resolveLinkage ?? resolveLinkedSubscriber)(lineUserId, env);
    // 閉店中は generic_with_linkage（連携ボタンのファネル）にならない（decideSubscriptionResponse）。
    const kind = decideSubscriptionResponse({
      salesEnabled: isSalesSurfaceEnabled(env),
      linked: resolution.linked,
      isSubscriber: resolution.isSubscriber,
      siteOpen,
    });
    if (kind === "subscriber") {
      // 利用中の方への手続き案内は「購入後のサポート」であり売り込みではないため、フラグに関わらず維持する。
      await responder.text(buildSubscriptionMessage("subscriber", siteOpen));
    } else if (kind === "inquiry") {
      // 売り込み面 OFF（既定）: 未利用の方への定期便の常設案内（便益 + 連携ボタンのファネル）を出さない。
      //   受け皿は EC サイト側に寄せ、ここでは中立な案内先 1 通で着地させる。
      await responder.text(buildSubscriptionInquiryReply(siteOpen));
    } else if (kind === "generic") {
      // 連携済み非定期便: 従来どおり generic 紹介のみ（連携済みなので連携導線は不要）。
      //   閉店中は未連携もここに来る（C-10 の 1 通・連携ボタンなし）。
      await responder.text(buildSubscriptionMessage("generic", siteOpen));
    } else {
      // 未連携: 従来の generic 紹介（テキスト・URL は LINE が自動リンク）を送り、
      //   LIFF 設定時のみ続けて便益 + 連携ボタン（Flex）を出す（surface=menu4・invite_shown 記録）。
      //   LIFF 未設定（prod・fail-safe）は generic 紹介のみ（従来動作・ボタンなし）。
      //   generic 紹介の送信失敗が「連携ボタン提示（ファネルの本命）」を巻き込まないよう best-effort で保護する
      //   （invite_shown は emitLinkageButton が送信前に記録するため、ボタン提示は send 成否に依存しない）。
      try {
        await responder.text(buildSubscriptionMessage("generic", siteOpen));
      } catch (err) {
        console.warn(
          "[menu] ④ generic intro send failed (continuing to linkage button):",
          err instanceof Error ? err.message : err,
        );
      }
      // マルシェ流入のお客さまには連携ボタンを出さない（空振り連携の抑止・CX S1/S2）。
      //   マルシェ客は generic 紹介のみで着地（連携の袋小路に誘導しない）。設計要件をコードのゲートに格上げ。
      if (!(await (deps?.isMarcheSource ?? isMarcheSourceUser)(lineUserId, env))) {
        await emitLinkageButton(lineUserId, env, responder, "menu4");
      }
    }
    return true;
  }

  return false;
}
