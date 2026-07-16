/**
 * アカウント連携導線（定期便客限定）＋ 定期便判定（ブロック4・staging 先行）。
 *
 * 設計 SoT: 統合設計書 §A-2 / §A-3（④定期便・候補2/3 は P2 = Shopify 開店時）
 *   https://app.notion.com/p/39c70c9d064c8129b802e99161b628a0
 *
 * 位置づけ（事実）:
 *   - Shopify は「開店前」。staging に Shopify Admin/Storefront 認証情報・ストアドメインは無い
 *     （staging secret は SHOPIFY_WEBHOOK_SECRET のみ）。よって「連携時に Shopify を読む」は
 *     staging では成立しない。→ 定期便判定は、注文 webhook が Firestore に非正規化する
 *     `users/{shopifyCustomerId}.isSubscriber` フラグ（subscription.ts の detectSubscriptionFromOrder
 *     が真のとき shopify-order-webhook.ts が立てる）を一次情報として読む（読み取りのみ・Shopify 非接触）。
 *   - Shopify 書き込みは一切しない。連携行（customer_linkages）の作成は Supabase 側の話であり、
 *     本モジュールは「読み取り＋出し分け文言」だけを担う（連携行の合成はテスト連携キットが担う）。
 *
 * 定期便判定の方式（根拠つき）:
 *   1. customer_linkages（Supabase）で lineUserId → shopify_customer_id を解決（未連携なら unlinked）。
 *   2. 定期便かどうかは以下の優先で判定する（いずれも Shopify を読まない）:
 *      (a) staging 限定のテスト用オーバーライド（TEST_SUBSCRIBER_LINE_IDS の allowlist）。
 *          Shopify を読めない staging で「この合成 ID は定期便扱い」を作るための仕組み。
 *          **本番条件（DELIVERY_TARGET_ENV !== "test"）では常に無効**（isStagingSubscriberOverrideEnv）。
 *      (b) Firestore `users/{shopifyId}.isSubscriber === true`（注文 webhook 由来の非正規化フラグ）。
 *   - 将来 Shopify 開店後は、authoritative source を Shopify Admin の customer.subscriptionContracts（読み取り）
 *     に切り替え可能だが、開店前は上記フラグが唯一の観測点（本番有効化の残作業は報告に明記）。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../index";
import { type LineResponder } from "./line";
import { createSupabaseClient } from "./supabase";
import { resolveCallerShopifyCustomerId } from "./shopify";
import {
  getCustomerProfile,
  getFirestoreEnv,
  type CustomerProfile,
  type FirestoreEnv,
} from "./firestore";
import {
  LINKAGE_INVITE_BODY,
  SUBSCRIBER_LINKED_BODY,
  NON_SUBSCRIBER_DECLINE_BODY,
  SITE_URL_JA,
} from "./brand-copy";

// ---------------------------------------------------------------------------
// トリガー / リンク
// ---------------------------------------------------------------------------

/** アカウント連携導線のトリガー（完全一致）。 */
export const LINKAGE_TRIGGER = "アカウントを連携する";

/** 定期便案内ページ（menu-actions.ts と同一・app/[locale]/subscription 実在）。 */
const SUBSCRIPTION_URL = "https://elxea.com/ja/subscription";

// ---------------------------------------------------------------------------
// テスト用オーバーライド（staging 限定・本番コードパス非影響）
// ---------------------------------------------------------------------------

/** テスト用「定期便扱い」allowlist の環境変数名（カンマ区切りの LINE userId）。 */
export const TEST_SUBSCRIBER_ENV_KEY = "TEST_SUBSCRIBER_LINE_IDS";

/**
 * テスト用オーバーライドが有効な環境か（＝ staging）を判定する。
 *
 * wrangler.toml で staging は DELIVERY_TARGET_ENV="test" に固定・本番は "prod"。
 * よって "test" のときだけオーバーライドを有効にすれば、**本番では allowlist が設定されても常に無効**。
 * これが「本番コードパスに影響しない」ことの機械的な担保（unit テストで固定）。
 */
export function isStagingSubscriberOverrideEnv(env: {
  DELIVERY_TARGET_ENV?: string;
}): boolean {
  return env.DELIVERY_TARGET_ENV === "test";
}

/** allowlist 文字列を LINE userId 配列に正規化する（純粋・空要素除去・トリム）。 */
export function parseTestSubscriberAllowlist(
  raw: string | undefined | null,
): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * この lineUserId が「テスト用の定期便扱い」か（純粋）。
 * staging（DELIVERY_TARGET_ENV="test"）かつ allowlist に含まれるときだけ true。
 * 本番条件では allowlist の中身に関わらず必ず false。
 */
export function isTestSubscriberOverride(
  lineUserId: string,
  env: { DELIVERY_TARGET_ENV?: string; TEST_SUBSCRIBER_LINE_IDS?: string },
): boolean {
  if (!isStagingSubscriberOverrideEnv(env)) return false;
  const allow = parseTestSubscriberAllowlist(env.TEST_SUBSCRIBER_LINE_IDS);
  return allow.includes(lineUserId);
}

// ---------------------------------------------------------------------------
// 連携＋定期便の解決（読み取りのみ・Shopify 非接触）
// ---------------------------------------------------------------------------

/** 定期便判定の観測点（どこで真になったか）。 */
export type SubscriberSource = "override" | "firestore" | "none" | "error";

/** 連携＋定期便の解決結果。 */
export type LinkageResolution = {
  /** customer_linkages に紐付けがあるか。 */
  linked: boolean;
  /** 紐付け済みなら Shopify 顧客 ID（数値文字列）／未連携は null。 */
  shopifyCustomerId: string | null;
  /** 定期便のご契約が確認できたか。 */
  isSubscriber: boolean;
  /** 定期便判定の観測点。 */
  source: SubscriberSource;
};

/** resolveLinkedSubscriber のテスト用依存注入（本番は未指定で実クライアントを使う）。 */
export type LinkageDeps = {
  supabase?: SupabaseClient;
  /** lineUserId → shopify_customer_id 解決（customer_linkages）。 */
  resolveCustomerId?: (
    userId: string,
    channel: "line" | "web",
    supabase: SupabaseClient,
  ) => Promise<string | null>;
  /** Firestore の CustomerProfile 取得（isSubscriber 参照用）。 */
  getProfile?: (
    shopifyCustomerId: string,
    fsEnv: FirestoreEnv,
  ) => Promise<CustomerProfile | null>;
};

/**
 * lineUserId から「連携済みか」「定期便か」を解決する（読み取りのみ・Shopify に一切触れない）。
 *
 * 判定順:
 *   1. customer_linkages で shopify_customer_id を解決。無ければ unlinked（linked=false）。
 *   2. テスト用オーバーライド（staging 限定）が真 → isSubscriber=true / source="override"。
 *   3. Firestore users/{shopifyId}.isSubscriber === true → true / source="firestore"。
 *   4. いずれも無ければ false / source="none"。
 *
 * どの段でも例外は握って安全側（未連携／非定期便）に倒す（会話を止めない）。
 */
export async function resolveLinkedSubscriber(
  lineUserId: string,
  env: Env,
  deps?: LinkageDeps,
): Promise<LinkageResolution> {
  const supabase = deps?.supabase ?? createSupabaseClient(env);
  const resolveCustomerId =
    deps?.resolveCustomerId ?? resolveCallerShopifyCustomerId;
  const getProfile = deps?.getProfile ?? getCustomerProfile;

  try {
    const shopifyCustomerId = await resolveCustomerId(
      lineUserId,
      "line",
      supabase,
    );
    if (!shopifyCustomerId) {
      return {
        linked: false,
        shopifyCustomerId: null,
        isSubscriber: false,
        source: "none",
      };
    }

    // (a) staging 限定オーバーライド（Shopify を読まずに「定期便扱い」を作る）。
    if (isTestSubscriberOverride(lineUserId, env)) {
      return {
        linked: true,
        shopifyCustomerId,
        isSubscriber: true,
        source: "override",
      };
    }

    // (b) Firestore の非正規化フラグ（注文 webhook 由来）。
    let fsEnv: FirestoreEnv;
    try {
      fsEnv = getFirestoreEnv(env);
    } catch {
      // Firestore 未設定: 定期便は判定不能 → 非定期便（安全側）。連携自体は成立している。
      return {
        linked: true,
        shopifyCustomerId,
        isSubscriber: false,
        source: "none",
      };
    }

    const profile = await getProfile(shopifyCustomerId, fsEnv);
    const isSubscriber = profile?.isSubscriber === true;
    return {
      linked: true,
      shopifyCustomerId,
      isSubscriber,
      source: isSubscriber ? "firestore" : "none",
    };
  } catch (err) {
    console.warn(
      "[subscriber-linkage] resolve failed, treating as unlinked:",
      err instanceof Error ? err.message : err,
    );
    return {
      linked: false,
      shopifyCustomerId: null,
      isSubscriber: false,
      source: "error",
    };
  }
}

// ---------------------------------------------------------------------------
// 出し分け文言（純粋・テスト可能・絵文字禁止・押し売りなし）
// ---------------------------------------------------------------------------

/** 未連携のお客さまへの案内（マイページからの連携を促す）。 */
export function buildLinkageInviteMessage(): string {
  return `${LINKAGE_INVITE_BODY}\n${SITE_URL_JA}`;
}

/** 連携済み＋定期便のお客さまへの応答（定期便客としての受け止め）。 */
export function buildSubscriberLinkedMessage(): string {
  return SUBSCRIBER_LINKED_BODY;
}

/** 連携済みだが定期便でないお客さまへの、丁寧なお断り。 */
export function buildNonSubscriberDeclineMessage(): string {
  return `${NON_SUBSCRIBER_DECLINE_BODY}\n${SUBSCRIPTION_URL}`;
}

/**
 * 解決結果から返すべき文言を選ぶ（純粋・分岐の SoT）。
 *   - 未連携 → 連携案内
 *   - 連携済み＋定期便 → 定期便客としての応答
 *   - 連携済み＋非定期便 → 丁寧なお断り
 */
export function selectLinkageMessage(resolution: LinkageResolution): string {
  if (!resolution.linked) return buildLinkageInviteMessage();
  if (resolution.isSubscriber) return buildSubscriberLinkedMessage();
  return buildNonSubscriberDeclineMessage();
}

// ---------------------------------------------------------------------------
// オーケストレーション（インターセプタ）
// ---------------------------------------------------------------------------

/**
 * アカウント連携導線（定期便客限定）の決定的応答インターセプタ。
 *
 * トリガー「アカウントを連携する」の完全一致のみ反応する。無関係発話は false を返して素通りさせ、
 * 既存の AI 会話・診断・注文照会・feedback を一切壊さない（menu-actions.ts と同じ後置・非侵襲設計）。
 *
 * @returns 処理したら true（ここで応答完結）。トリガー非一致なら false。
 */
export async function handleLinkageFlow(
  lineUserId: string,
  userMessage: string,
  env: Env,
  responder: LineResponder,
): Promise<boolean> {
  if (userMessage.trim() !== LINKAGE_TRIGGER) return false;

  const resolution = await resolveLinkedSubscriber(lineUserId, env);
  await responder.text(selectLinkageMessage(resolution));
  return true;
}
