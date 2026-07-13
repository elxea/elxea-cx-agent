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
import { createSupabaseClient } from "./supabase";
import { resolveCallerShopifyCustomerId } from "./shopify";
import { getCustomerProfile, getFirestoreEnv } from "./firestore";

// ---------------------------------------------------------------------------
// トリガー（リッチメニュー message text と完全一致）
// ---------------------------------------------------------------------------

/** ③ 相談 */
export const CONSULTATION_TRIGGER = "相談したいことがあります";
/** ④ 定期便 */
export const SUBSCRIPTION_TRIGGER = "定期便について知りたい";
/** ⑤ elxea について */
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
    "elxea（エルシア）は、「日常に、静かな豊かさを」をテーマにしたお茶のブランドです。\n\n" +
    "鹿児島を中心に各地の生産者と直接つながり、茶畑で丁寧に育てられたお茶を、つくり手の物語とともにお届けしています。" +
    "お茶だけでなく、茶葉を活かしたスキンケアも手がけています。\n\n" +
    `くわしくはこちらをご覧ください。\n${SITE_URL}\n\n` +
    "このトークは、elxea のサポートを担当する AI がお答えしています。お茶えらびのご相談など、気軽に話しかけてくださいね。\n\n" +
    "お便りをお送りするのは月に1〜2回、季節の節目だけです。"
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
// ④ 出し分け判定（deterministic・LLM 不使用）
// ---------------------------------------------------------------------------

/**
 * 定期便の出し分け種別を解決する。
 *   1. customer_linkages に Shopify 顧客 ID が無い（未連携）→ "generic"
 *   2. 連携済みで Firestore の isSubscriber === true → "subscriber"
 *   3. それ以外 / 取得失敗 → "generic"（安全側: 案内を出す）
 */
export async function resolveSubscriptionKind(
  lineUserId: string,
  env: Env,
): Promise<"subscriber" | "generic"> {
  try {
    const supabase = createSupabaseClient(env);
    const shopifyId = await resolveCallerShopifyCustomerId(lineUserId, "line", supabase);
    if (!shopifyId) return "generic"; // 未連携

    const profile = await getCustomerProfile(shopifyId, getFirestoreEnv(env));
    return profile?.isSubscriber === true ? "subscriber" : "generic";
  } catch (err) {
    console.warn(
      "[menu] subscription kind resolve failed, fallback to generic:",
      err instanceof Error ? err.message : err,
    );
    return "generic";
  }
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

  // ⑤ elxea について — ブランド紹介 1 通
  if (t === ABOUT_TRIGGER) {
    await responder.text(buildAboutMessage());
    return true;
  }

  // ④ 定期便 — Shopify 連携 × isSubscriber で出し分け
  if (t === SUBSCRIPTION_TRIGGER) {
    const kind = await resolveSubscriptionKind(lineUserId, env);
    await responder.text(buildSubscriptionMessage(kind));
    return true;
  }

  return false;
}
