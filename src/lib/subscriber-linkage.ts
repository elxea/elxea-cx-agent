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
  LINKAGE_BENEFIT_LINE,
  LINKAGE_BUTTON_LABEL,
  SITE_URL_JA,
  ACCOUNT_LINK_UNLINK_TRIGGER,
  ACCOUNT_LINK_UNLINKED_BODY,
  ACCOUNT_LINK_NOT_LINKED_BODY,
  ACCOUNT_LINK_UNLINK_FAILED_BODY,
} from "./brand-copy";
import { logFlowEvent } from "./flow-events";
import { issueLinkToken, buildAccountLinkEntryUrl } from "./account-link";
import { clearCustomerLinkage } from "./customer-linkage";

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

/**
 * 未連携のお客さまへの案内（マイページからの連携を促す・テキスト版）。
 * 着地先（体験重大3対応）: liffUrl があれば LIFF（マイページ相当）へ、無ければ従来の elxea.com/ja へ。
 *   prod（LIFF 未設定）では従来どおり SITE_URL_JA（fail-safe・文言不変）。
 */
export function buildLinkageInviteMessage(liffUrl?: string | null): string {
  const url = liffUrl && liffUrl.length > 0 ? liffUrl : SITE_URL_JA;
  return `${LINKAGE_INVITE_BODY}\n${url}`;
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
// トーク内入り口の「便益 + 連携ボタン」（LIFF 導線・staging 先行・ブロック4）
// ---------------------------------------------------------------------------

/** 連携ボタンを出した文脈（flow_events link.invite_shown の metadata.surface）。 */
export type LinkageSurface = "trigger" | "menu4";

/**
 * LIFF 連携 URL を env から解決する（純粋）。
 * 未設定・空白のみは null（＝ prod fail-safe: ボタンを出さず従来テキストに倒す）。
 */
export function resolveLiffLinkageUrl(env: { LIFF_LINKAGE_URL?: string }): string | null {
  const raw = env.LIFF_LINKAGE_URL?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/**
 * Account Link 方式の連携入口 URL（web-app の /{locale}/link）を env から解決する（純粋）。
 * 未設定・空白のみは null（＝ 従来の LIFF / テキスト導線に倒す）。
 */
export function resolveAccountLinkEntryUrl(env: {
  ACCOUNT_LINK_ENTRY_URL?: string;
}): string | null {
  const raw = env.ACCOUNT_LINK_ENTRY_URL?.trim();
  return raw && raw.length > 0 ? raw : null;
}

/** 連携 URL 解決のテスト用依存注入（本番は未指定で実 API を使う）。 */
export type LinkageUrlDeps = {
  issueLinkToken?: typeof issueLinkToken;
};

/**
 * **このお客さま専用**の連携 URL を解決する（Account Link 優先 / LIFF フォールバック）。
 *
 * なぜユーザーごとに URL を作るのか:
 *   Account Link は「Bot が発行した linkToken（10 分・1 回限り・そのユーザー専用）」を
 *   自社の連携入口に載せて初めて成立する。静的な 1 本の URL では成立しない。
 *   よってボタンを出すたびに linkToken を発行し、`?linkToken=...` を付けた URL を組む。
 *
 * fail-safe（既存挙動を壊さない）:
 *   - ACCOUNT_LINK_ENTRY_URL 未設定 → 従来どおり LIFF URL（未設定なら null）。
 *   - linkToken 発行に失敗 → LIFF URL（未設定なら null）へ黙って倒す。連携導線が
 *     LINE API の一時障害で完全に消えないようにする（ボタンが出ないより出るほうがよい）。
 */
export async function resolveLinkageUrlForUser(
  lineUserId: string,
  env: Env,
  deps?: LinkageUrlDeps,
): Promise<string | null> {
  const entryUrl = resolveAccountLinkEntryUrl(env);
  if (entryUrl) {
    const issue = deps?.issueLinkToken ?? issueLinkToken;
    const token = await issue(lineUserId, env);
    if (token.ok) return buildAccountLinkEntryUrl(entryUrl, token.linkToken);
    console.warn(
      `[subscriber-linkage] linkToken issue failed (reason=${token.reason}) — 従来導線へ fail-safe`,
    );
  }
  return resolveLiffLinkageUrl(env);
}

/**
 * 連携招待の Flex（便益 1 行 + LIFF を開く URI ボタン）を組む（純粋・テスト可能）。
 * leadText があれば便益行の前に添える（④定期便の generic 紹介を先頭に置く用途）。
 * 絵文字・感嘆符は使わない（体験原則）。altText は通知プレビュー用の素文。
 */
export function buildLinkageInviteFlex(
  liffUrl: string,
  opts?: { leadText?: string },
): { altText: string; contents: Record<string, unknown> } {
  const bodyContents: Array<Record<string, unknown>> = [];
  if (opts?.leadText) {
    bodyContents.push({
      type: "text",
      text: opts.leadText,
      wrap: true,
      size: "sm",
      color: "#555555",
    });
  }
  bodyContents.push({
    type: "text",
    text: LINKAGE_BENEFIT_LINE,
    wrap: true,
    size: "sm",
    color: "#333333",
  });

  const contents: Record<string, unknown> = {
    type: "bubble",
    body: { type: "box", layout: "vertical", spacing: "md", contents: bodyContents },
    footer: {
      type: "box",
      layout: "vertical",
      contents: [
        {
          type: "button",
          style: "primary",
          height: "sm",
          action: { type: "uri", label: LINKAGE_BUTTON_LABEL, uri: liffUrl },
        },
      ],
    },
  };
  return { altText: LINKAGE_BENEFIT_LINE, contents };
}

/**
 * LIFF 設定時のみ「便益 1 行 + 連携ボタン（LIFF を開く URI アクション）」の Flex を送り、
 * flow_events(link.invite_shown, metadata.surface) を fire-and-forget で記録する（入り口 1a/1b 共通の核）。
 *
 * @param leadText Flex の便益行の前に添える文（任意）。
 * @returns 出したら true（＝ボタンを提示）。LIFF 未設定（prod）なら false（何も送らない・呼び出し側が fail-safe を担う）。
 */
export async function emitLinkageButton(
  lineUserId: string,
  env: Env,
  responder: LineResponder,
  surface: LinkageSurface,
  leadText?: string,
  deps?: LinkageUrlDeps,
): Promise<boolean> {
  // ⚠ お客さまごとに URL を組む（Account Link の linkToken はユーザー専用・1 回限りのため）。
  //    ACCOUNT_LINK_ENTRY_URL 未設定なら従来どおり静的な LIFF URL に倒れる（無回帰）。
  const liffUrl = await resolveLinkageUrlForUser(lineUserId, env, deps);
  if (!liffUrl) return false;

  // 便益 + ボタンを出す事実を先に記録する（fire-and-forget・送信前）。
  //   既存の welcome.tap / welcome.source と同じ流儀: 「提示した」という導線事実は配信成否に依存させない
  //   （下流の send が失敗しても記録は残す）。ファネル計測の欠測を防ぐ。
  void logFlowEvent(createSupabaseClient(env), {
    eventName: "link.invite_shown",
    userRef: lineUserId,
    metadata: { surface },
  });
  const flex = buildLinkageInviteFlex(liffUrl, { leadText });
  await responder.flex(flex.altText, flex.contents);
  return true;
}

/**
 * トリガー経路（1a）の未連携ユーザーへ「連携招待」を送る。
 *   - LIFF 設定あり（staging）: 便益 + 連携ボタン（Flex）＋ invite_shown 記録。
 *   - LIFF 未設定（prod・fail-safe）: ボタンは出さず fallbackText（従来の案内テキスト）を送る。
 */
export async function sendLinkageInvite(
  lineUserId: string,
  env: Env,
  responder: LineResponder,
  fallbackText: string,
  deps?: LinkageUrlDeps,
): Promise<void> {
  const shown = await emitLinkageButton(
    lineUserId,
    env,
    responder,
    "trigger",
    undefined,
    deps,
  );
  if (!shown) await responder.text(fallbackText);
}

// ---------------------------------------------------------------------------
// 連携解除（LINE 必須義務: いつでも解除できること）
// ---------------------------------------------------------------------------

/** 連携解除のテスト用依存注入（本番は未指定）。 */
export type LinkageUnlinkDeps = {
  supabase?: SupabaseClient;
  clearLinkage?: typeof clearCustomerLinkage;
};

/**
 * 連携解除を実行して結果をお伝えする（完全一致トリガー「連携を解除する」）。
 *
 * 必須義務（出典: https://developers.line.biz/ja/docs/messaging-api/linking-accounts/）:
 *   「ユーザーがいつでもアカウントの連携を解除できるようにしておくこと」。
 *   そのため解除は 1 手（トークで一言送るだけ）で完了し、確認の往復や画面遷移を挟まない。
 *
 * 何を消すか: 連携列だけ（shopify_customer_id / shopify_email / source）。行は消さない
 *   （配信停止フラグ等が同居しているため。詳細は clearCustomerLinkage のコメント）。
 *
 * @returns 解除できたら true（元から未連携も true = 応答済み）。失敗しても応答はする。
 */
export async function handleLinkageUnlink(
  lineUserId: string,
  env: Env,
  responder: LineResponder,
  deps?: LinkageUnlinkDeps,
): Promise<boolean> {
  const supabase = deps?.supabase ?? createSupabaseClient(env);
  const clear = deps?.clearLinkage ?? clearCustomerLinkage;

  const result = await clear(supabase, lineUserId);

  if (!result.ok) {
    console.error("[subscriber-linkage] unlink failed:", result.error);
    // 断定しない（「解除しました」と言わない）。もう一度お願いする。
    await responder.text(ACCOUNT_LINK_UNLINK_FAILED_BODY);
    return false;
  }

  if (!result.cleared) {
    // 元から未連携。壊すものが無いので、そのままお伝えする（冪等）。
    await responder.text(ACCOUNT_LINK_NOT_LINKED_BODY);
    return true;
  }

  // 解除の事実を記録（fire-and-forget・連携ファネルの対）。
  void logFlowEvent(supabase, {
    eventName: "link.unlinked",
    userRef: lineUserId,
  });
  await responder.text(ACCOUNT_LINK_UNLINKED_BODY);
  return true;
}

// ---------------------------------------------------------------------------
// オーケストレーション（インターセプタ）
// ---------------------------------------------------------------------------

/**
 * アカウント連携導線（定期便客限定）の決定的応答インターセプタ。
 *
 * トリガー「アカウントを連携する」「連携を解除する」の完全一致のみ反応する。無関係発話は false を
 * 返して素通りさせ、既存の AI 会話・診断・注文照会・feedback を一切壊さない
 * （menu-actions.ts と同じ後置・非侵襲設計）。
 *
 * 出し分け:
 *   - 「連携を解除する」→ 連携解除（LINE 必須義務の解除導線）。連携の有無に関わらずここで完結。
 *   - 未連携 → 便益 + 連携ボタン（連携 URL 設定時）/ 従来の案内テキスト（未設定時・fail-safe）。surface=trigger。
 *   - 連携済み定期便 → 定期便客としての応答（従来どおり）。
 *   - 連携済み非定期便 → 丁寧なお断り（従来どおり）。
 *
 * @returns 処理したら true（ここで応答完結）。トリガー非一致なら false。
 */
export async function handleLinkageFlow(
  lineUserId: string,
  userMessage: string,
  env: Env,
  responder: LineResponder,
  deps?: LinkageUrlDeps & LinkageUnlinkDeps,
): Promise<boolean> {
  const trimmed = userMessage.trim();

  // 解除（必須義務）: 連携中かどうかに関わらず、この一言で完結させる。
  if (trimmed === ACCOUNT_LINK_UNLINK_TRIGGER) {
    await handleLinkageUnlink(lineUserId, env, responder, deps);
    return true;
  }

  if (trimmed !== LINKAGE_TRIGGER) return false;

  const resolution = await resolveLinkedSubscriber(lineUserId, env);
  if (!resolution.linked) {
    // 未連携: 便益 + ボタン（連携 URL 設定時）。fail-safe は従来の案内テキスト（着地先も env 連動）。
    await sendLinkageInvite(
      lineUserId,
      env,
      responder,
      buildLinkageInviteMessage(resolveLiffLinkageUrl(env)),
      deps,
    );
    return true;
  }
  // 連携済み（定期便客 / 非定期便）は従来どおりテキスト応答。
  await responder.text(selectLinkageMessage(resolution));
  return true;
}
