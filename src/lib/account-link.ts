/**
 * LINE Account Link（LINE 純正のアカウント連携）— linkToken 発行 / nonce 発行・消費 / 連携成立。
 *
 * 一次情報（出典）:
 *   - https://developers.line.biz/ja/docs/messaging-api/linking-accounts/
 *   - https://raw.githubusercontent.com/line/line-openapi/main/messaging-api.yml （issueLinkToken）
 *   - https://raw.githubusercontent.com/line/line-openapi/main/webhook.yml       （AccountLinkEvent）
 *
 * なぜこの方式か（LIFF 連携との違い・プロバイダ統一が不要になる理由）:
 *   LIFF 連携は「LIFF が属する LINE Login チャネル」と「Bot の Messaging チャネル」が
 *   **同一プロバイダ**にある前提で成立する（同一プロバイダのときだけ id_token の sub が
 *   Messaging userId と一致する）。本番 OA と連携用 LIFF は別プロバイダのため本番化できなかった。
 *   Account Link は LINE Login チャネルを使わない。Bot（Messaging チャネル）が linkToken を
 *   発行し、LINE が所有者検証を済ませたうえで **同じ Messaging チャネルの webhook** に
 *   accountLink イベントを返す。得られる `source.userId` は Messaging userId そのもの
 *   （LINE の API 定義で往復が明記されている）。よってプロバイダ構成に依存しない。
 *
 * 連携の流れ（本モジュールが担う箇所を [*] で示す）:
 *   1. [*] Bot が POST /v2/bot/user/{userId}/linkToken → linkToken（10 分・1 回限り）
 *   2. [*] 自社の連携入口 URL に linkToken を付けてトークに送る（ボタンの遷移先）
 *   3.     web-app: ユーザーがログイン → サーバが Shopify 顧客 ID を確定
 *   4. [*] 自社サーバが nonce を発行・保存 → access.line.me/dialog/bot/accountLink へリダイレクト
 *   5.     LINE が所有者検証 → Messaging チャネルの webhook に accountLink イベント
 *   6. [*] nonce を消費して Shopify 顧客 ID を引き当て、customer_linkages に連携行を書く
 *
 * セキュリティ方針（この 3 点が連携の安全性の本体）:
 *   - nonce は **CSPRNG 192bit（要件 128bit 以上）を base64url 化**した 32 文字。
 *     LINE 仕様の「予測が難しく一度しか使用できない文字列・10〜255 文字」を満たす。
 *   - nonce は **single-use**。消費は単一 UPDATE（consumed_at IS NULL かつ未期限のときだけ成立）
 *     + RETURNING で行うため、同時到達しても 1 回しか成功しない（アプリ側のロック不要）。
 *   - `link.result !== "ok"` のときは **連携行を一切書かない**（LINE 側の所有者検証が失敗している）。
 *
 * 秘密の取り扱い: linkToken / nonce の**値をログに出さない**（漏れると連携を横取りできる）。
 *   ログには「成否」と「理由コード」だけを出す。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../index";
import type { LineResponder } from "./line";
import { createSupabaseClient } from "./supabase";
import { upsertCustomerLinkage } from "./customer-linkage";
import { logFlowEvent } from "./flow-events";
import { getFirestoreEnv, mergeLineUserIntoShopify } from "./firestore";
import { ACCOUNT_LINK_COMPLETED_BODY } from "./brand-copy";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** nonce 一時保存テーブル（migration 028）。 */
export const ACCOUNT_LINK_NONCES_TABLE = "account_link_nonces";

/** customer_linkages.source（migration 026）に入れる発生源。Account Link 由来の連携。 */
export const ACCOUNT_LINK_SOURCE = "account_link";

/** LINE の連携ダイアログ（ユーザーをここへリダイレクトすると所有者検証が走る）。 */
export const ACCOUNT_LINK_DIALOG_URL =
  "https://access.line.me/dialog/bot/accountLink";

/**
 * nonce の乱数バイト数。24 byte = 192bit（LINE 推奨の 128bit 以上を満たす）。
 * base64url 化して 32 文字（LINE 仕様の 10〜255 文字に収まる）。
 */
export const NONCE_BYTES = 24;

/**
 * nonce の有効期間（分）。既定 5 分。
 * linkToken 自体が 10 分・1 回限りで失効するため、これより長くしても意味がない
 * （通常フローでは発行から数秒で消費される）。短いほど盗まれた nonce の窓が狭い。
 */
export const NONCE_TTL_MINUTES = 5;

/** nonce の形式（base64url・LINE 仕様の長さ範囲）。 */
const NONCE_RE = /^[A-Za-z0-9_-]{10,255}$/;

/**
 * linkToken の形式ゲート（防御的なだけで、認証ではない）。
 * 実測の linkToken は 32 文字の英数字だが、LINE は文字数を仕様として固定していないため
 * 幅を持たせる。URL に載せる前のゴミ混入・過大長を弾く目的。
 */
const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{8,512}$/;

// ---------------------------------------------------------------------------
// nonce 生成 / 形式検証（純粋・テスト可能）
// ---------------------------------------------------------------------------

/** バイト列を base64url（パディング無し・URL 安全）へ変換する。 */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * nonce を生成する（CSPRNG・192bit・base64url 32 文字）。
 *
 * LINE 仕様（アカウント連携）:
 *   「予測が難しく一度しか使用できない文字列」／長さ 10〜255 文字／
 *   セキュアな乱数で 128bit(16byte) 以上・Base64 推奨。
 * ここでは 24byte(192bit) を base64url 化する（URL クエリに載るためパディング・記号を避ける）。
 * `crypto.getRandomValues` は Workers / Node いずれも CSPRNG。Math.random は使わない。
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

/** nonce の形式が LINE 仕様（base64url・10〜255 文字）に適合するか（純粋）。 */
export function isValidNonceFormat(value: unknown): value is string {
  return typeof value === "string" && NONCE_RE.test(value);
}

/** linkToken の形式ゲート（純粋・防御的。認証ではない）。 */
export function isValidLinkTokenFormat(value: unknown): value is string {
  return typeof value === "string" && LINK_TOKEN_RE.test(value);
}

// ---------------------------------------------------------------------------
// URL 組み立て（純粋）
// ---------------------------------------------------------------------------

/** linkToken 発行エンドポイント（Messaging API）。 */
export function buildLinkTokenEndpoint(lineUserId: string): string {
  return `https://api.line.me/v2/bot/user/${encodeURIComponent(lineUserId)}/linkToken`;
}

/**
 * 自社の連携入口 URL に linkToken を付ける（トークのボタンの遷移先）。
 * 既存クエリは保持し、linkToken だけを上書きする。
 *
 * `openExternalBrowser=1` を必ず付ける（LINE 固有クエリ）:
 *   このボタンはトーク内（LINE の内蔵ブラウザ = LIFF ではない web-app の入口 URL）で開かれる。
 *   内蔵ブラウザだと Cookie/セッションが本人の既定ブラウザと分離し、ログイン状態や
 *   linkToken cookie(TTL 600s) の受け渡しが不安定になる。`openExternalBrowser=1` を付けると
 *   LINE が **端末の外部ブラウザ**で開き直すため、web-app 側のログイン→顧客 ID 確定が安定する。
 *   これは Account Link の web-app 入口（`/{locale}/link` 系）専用の対処であり、
 *   LIFF フォールバック URL には付けない（openExternalBrowser は LIFF に無効なため）。
 */
export function buildAccountLinkEntryUrl(
  entryUrl: string,
  linkToken: string,
): string {
  const url = new URL(entryUrl);
  url.searchParams.set("linkToken", linkToken);
  url.searchParams.set("openExternalBrowser", "1");
  return url.toString();
}

/**
 * LINE の連携ダイアログ URL（ログイン後、ここへ 302 でリダイレクトする）。
 * linkToken と nonce の 2 つだけを載せる（自社ユーザー ID 等は載せない）。
 */
export function buildAccountLinkRedirectUrl(
  linkToken: string,
  nonce: string,
): string {
  const url = new URL(ACCOUNT_LINK_DIALOG_URL);
  url.searchParams.set("linkToken", linkToken);
  url.searchParams.set("nonce", nonce);
  return url.toString();
}

// ---------------------------------------------------------------------------
// linkToken 発行（Messaging API・never throw）
// ---------------------------------------------------------------------------

/** linkToken 発行結果。失敗理由は値を含まない短い理由コード。 */
export type LinkTokenResult =
  | { ok: true; linkToken: string }
  | { ok: false; reason: string };

/** テスト用の依存注入（既定は実 fetch）。 */
export type LinkTokenDeps = {
  fetchImpl?: typeof fetch;
};

/**
 * この LINE ユーザー向けの linkToken を発行する（10 分・1 回限り）。
 *
 * POST https://api.line.me/v2/bot/user/{userId}/linkToken → { "linkToken": "..." }
 * Bot の channel access token（Messaging）で認証する。**コンソール設定は不要**
 * （Account Link に設定欄は存在せず、別プロバイダ構成でも障害にならない）。
 *
 * never throw: 失敗は ok:false を返す（呼び出し側は従来導線へ fail-safe する）。
 * ログに linkToken の値は出さない。
 */
export async function issueLinkToken(
  lineUserId: string,
  env: Pick<Env, "LINE_CHANNEL_ACCESS_TOKEN">,
  deps?: LinkTokenDeps,
): Promise<LinkTokenResult> {
  const doFetch = deps?.fetchImpl ?? fetch;
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { ok: false, reason: "missing_channel_access_token" };
  if (!lineUserId) return { ok: false, reason: "missing_user_id" };

  try {
    const res = await doFetch(buildLinkTokenEndpoint(lineUserId), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      // 本文は理由の手がかりになるが linkToken を含まない（失敗応答のため）。長さだけ抑える。
      const detail = await res.text().catch(() => "");
      console.warn(
        `[account-link] linkToken issue failed: status=${res.status} detail=${detail.slice(0, 200)}`,
      );
      return { ok: false, reason: `http_${res.status}` };
    }

    const data = (await res.json().catch(() => null)) as {
      linkToken?: unknown;
    } | null;
    const linkToken = data?.linkToken;
    if (!isValidLinkTokenFormat(linkToken)) {
      return { ok: false, reason: "unexpected_response" };
    }
    return { ok: true, linkToken };
  } catch (err) {
    console.warn(
      "[account-link] linkToken issue threw (non-fatal):",
      err instanceof Error ? err.message : err,
    );
    return { ok: false, reason: "network_error" };
  }
}

// ---------------------------------------------------------------------------
// nonce の発行 / 消費（single-use・TTL）
// ---------------------------------------------------------------------------

/** nonce 発行結果。 */
export type NonceIssueResult =
  | { ok: true; nonce: string; expiresAt: string }
  | { ok: false; reason: string };

/** nonce 発行のオプション（テストで固定するため）。 */
export type NonceIssueOptions = {
  /** 有効期間（分）。既定 NONCE_TTL_MINUTES。 */
  ttlMinutes?: number;
  /** 現在時刻（epoch ms）。既定 Date.now()。 */
  nowMs?: number;
  /** 明示 nonce（テスト専用。本番は必ず未指定 = CSPRNG 生成）。 */
  nonce?: string;
};

/**
 * nonce を発行して保存する（自社側で本人確定した Shopify 顧客 ID を短時間だけ預かる）。
 *
 * 呼び出し元は「サーバ認証済みの Shopify 顧客 ID」だけを渡すこと。
 * ブラウザ自己申告の customer_id をここに渡すと、他人の顧客 ID で連携できてしまう。
 *
 * never throw。ログに nonce の値は出さない。
 */
export async function issueAccountLinkNonce(
  supabase: SupabaseClient,
  shopifyCustomerId: string,
  opts?: NonceIssueOptions,
): Promise<NonceIssueResult> {
  if (!shopifyCustomerId) return { ok: false, reason: "missing_customer_id" };

  const nonce = opts?.nonce ?? generateNonce();
  if (!isValidNonceFormat(nonce)) return { ok: false, reason: "invalid_nonce" };

  const nowMs = opts?.nowMs ?? Date.now();
  const ttlMinutes = opts?.ttlMinutes ?? NONCE_TTL_MINUTES;
  const expiresAt = new Date(nowMs + ttlMinutes * 60 * 1000).toISOString();

  try {
    const { error } = await supabase.from(ACCOUNT_LINK_NONCES_TABLE).insert({
      nonce,
      shopify_customer_id: shopifyCustomerId,
      expires_at: expiresAt,
    });
    if (error) {
      console.error("[account-link] nonce insert failed:", error.message);
      return { ok: false, reason: "persist_failed" };
    }
    return { ok: true, nonce, expiresAt };
  } catch (err) {
    console.error(
      "[account-link] nonce insert threw:",
      err instanceof Error ? err.message : err,
    );
    return { ok: false, reason: "persist_failed" };
  }
}

/** nonce 消費の失敗理由（値は含まない）。 */
export type NonceConsumeReason =
  | "invalid_format"
  | "unknown"
  | "already_used"
  | "expired"
  | "error";

/** nonce 消費結果。 */
export type NonceConsumeResult =
  | { ok: true; shopifyCustomerId: string }
  | { ok: false; reason: NonceConsumeReason };

/**
 * nonce を **一度だけ** 消費して、預けた Shopify 顧客 ID を返す。
 *
 * single-use の担保（アプリ側ロック不要）:
 *   `UPDATE account_link_nonces SET consumed_at = now()
 *      WHERE nonce = ? AND consumed_at IS NULL AND expires_at > now() RETURNING shopify_customer_id`
 *   という **単一の UPDATE 文**として発行される（PostgREST の update + filter + select）。
 *   行ロックは Postgres が取るため、同一 nonce が同時に 2 回届いても 1 回しか行を返さない
 *   （2 回目は 0 行 = already_used）。webhook 再送（deliveryContext.isRedelivery /
 *   processed_events）の冪等性と合わせて二重連携を構造的に防ぐ。
 *
 * 0 行だったときだけ、理由の切り分け（unknown / already_used / expired）のために 1 回読む。
 * この読み取りは観測目的のみで、連携の成否には影響しない。
 *
 * never throw。ログに nonce の値は出さない。
 */
export async function consumeAccountLinkNonce(
  supabase: SupabaseClient,
  nonce: string,
  opts?: { nowMs?: number },
): Promise<NonceConsumeResult> {
  if (!isValidNonceFormat(nonce)) return { ok: false, reason: "invalid_format" };

  const nowIso = new Date(opts?.nowMs ?? Date.now()).toISOString();

  try {
    const { data, error } = await supabase
      .from(ACCOUNT_LINK_NONCES_TABLE)
      .update({ consumed_at: nowIso })
      .eq("nonce", nonce)
      .is("consumed_at", null)
      .gt("expires_at", nowIso)
      .select("shopify_customer_id");

    if (error) {
      console.error("[account-link] nonce consume failed:", error.message);
      return { ok: false, reason: "error" };
    }

    const row = (data ?? [])[0] as { shopify_customer_id?: unknown } | undefined;
    if (row && typeof row.shopify_customer_id === "string" && row.shopify_customer_id) {
      return { ok: true, shopifyCustomerId: row.shopify_customer_id };
    }

    // 0 行 = 未知 / 消費済み / 期限切れ。理由だけを観測する（連携判断には影響しない）。
    const { data: probe } = await supabase
      .from(ACCOUNT_LINK_NONCES_TABLE)
      .select("consumed_at, expires_at")
      .eq("nonce", nonce)
      .limit(1);

    const found = (probe ?? [])[0] as
      | { consumed_at?: unknown; expires_at?: unknown }
      | undefined;
    if (!found) return { ok: false, reason: "unknown" };
    if (found.consumed_at) return { ok: false, reason: "already_used" };
    return { ok: false, reason: "expired" };
  } catch (err) {
    console.error(
      "[account-link] nonce consume threw:",
      err instanceof Error ? err.message : err,
    );
    return { ok: false, reason: "error" };
  }
}

// ---------------------------------------------------------------------------
// accountLink イベントの処理（連携成立）
// ---------------------------------------------------------------------------

/** accountLink イベントの link ペイロード（webhook.yml の AccountLinkEvent）。 */
export type AccountLinkPayload = {
  result: "ok" | "failed";
  nonce: string;
};

/** 連携処理の結果（ログ・テスト用の理由コード）。 */
export type AccountLinkOutcome =
  | "linked"
  | "skipped_result_failed"
  | "skipped_invalid_nonce"
  | "skipped_nonce_unusable"
  | "failed_persist";

/** handleAccountLinkEvent のテスト用依存注入（本番は未指定）。 */
export type AccountLinkHandlerDeps = {
  supabase?: SupabaseClient;
  consumeNonce?: typeof consumeAccountLinkNonce;
  upsertLinkage?: typeof upsertCustomerLinkage;
  logEvent?: typeof logFlowEvent;
  /** 好み引き継ぎ（Firestore・never throw）。既定は runCarryoverMerge。 */
  carryover?: (
    env: Env,
    lineUserId: string,
    shopifyCustomerId: string,
  ) => Promise<void>;
};

/**
 * 連携成立時の好み引き継ぎ（lineUsers→users カルテ統合）を安全に実行する（never throw）。
 *
 * identity/link-liff の同名処理と同じ意図・同じ非致命方針。Firestore 未設定・一時失敗は
 * 握り潰す（連携そのものは既に成立している）。data-only・冪等は merge 側が担保する。
 */
export async function runCarryoverMerge(
  env: Env,
  lineUserId: string,
  shopifyCustomerId: string,
): Promise<void> {
  try {
    const fsEnv = getFirestoreEnv(env);
    await mergeLineUserIntoShopify(lineUserId, shopifyCustomerId, fsEnv);
  } catch (err) {
    console.warn(
      "[account-link] karte carryover merge skipped/failed (non-fatal):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * accountLink イベントを処理して連携行を書く（webhook の背景処理から呼ばれる）。
 *
 * 判断の順序（安全側に倒す）:
 *   1. `link.result !== "ok"` → **何も書かない**（LINE 側の所有者検証が失敗している）。
 *   2. nonce の形式が不正 → 何も書かない（DB に触れない）。
 *   3. nonce を single-use で消費できない（未知 / 消費済み / 期限切れ）→ 何も書かない。
 *   4. ここまで通ったときだけ customer_linkages に upsert（source='account_link'）。
 *   5. 連携完了を flow_events(link.completed) に記録し、好みを引き継ぎ、完了をお伝えする。
 *
 * 完了メッセージには **いつでも連携を解除できる旨**を必ず含める
 * （LINE のアカウント連携の必須義務: 解除手段の提供と、連携時の解除可能である旨の通知）。
 *
 * never throw（呼び出し側の webhook ループを止めない）。
 */
export async function handleAccountLinkEvent(
  lineUserId: string,
  link: AccountLinkPayload | undefined,
  env: Env,
  responder: LineResponder,
  deps?: AccountLinkHandlerDeps,
): Promise<AccountLinkOutcome> {
  // 1. 失敗イベントでは連携行を書かない（result=failed / link 欠落）。
  if (!link || link.result !== "ok") {
    console.warn(
      `[account-link] accountLink event not ok (result=${link?.result ?? "missing"}) — 連携行は作らない`,
    );
    return "skipped_result_failed";
  }

  // 2. nonce の形式ゲート（DB に触れる前に弾く）。
  if (!isValidNonceFormat(link.nonce)) {
    console.warn("[account-link] accountLink event carried a malformed nonce — 連携行は作らない");
    return "skipped_invalid_nonce";
  }

  const supabase = deps?.supabase ?? createSupabaseClient(env);
  const consume = deps?.consumeNonce ?? consumeAccountLinkNonce;
  const upsert = deps?.upsertLinkage ?? upsertCustomerLinkage;
  const logEvent = deps?.logEvent ?? logFlowEvent;
  const carryover = deps?.carryover ?? runCarryoverMerge;

  // 3. single-use 消費（ここで初めて自社ユーザーが確定する）。
  const consumed = await consume(supabase, link.nonce);
  if (!consumed.ok) {
    console.warn(
      `[account-link] nonce not usable (reason=${consumed.reason}) — 連携行は作らない`,
    );
    return "skipped_nonce_unusable";
  }

  // 4. 連携行の upsert（冪等・onConflict=line_user_id）。source で発生源を残す。
  const result = await upsert(supabase, {
    lineUserId,
    shopifyCustomerId: consumed.shopifyCustomerId,
    source: ACCOUNT_LINK_SOURCE,
  });
  if (!result.ok) {
    console.error("[account-link] linkage upsert failed:", result.error);
    return "failed_persist";
  }

  // 5. 連携完了の記録（fire-and-forget・応答を止めない）。
  void logEvent(supabase, {
    eventName: "link.completed",
    userRef: lineUserId,
    metadata: { source: ACCOUNT_LINK_SOURCE },
  });

  // 完了をお伝えする（解除できる旨の通知を含む = LINE の必須義務）。
  //   送信失敗で連携を巻き戻さない（連携は既に成立している）。
  try {
    await responder.text(ACCOUNT_LINK_COMPLETED_BODY);
  } catch (err) {
    console.warn(
      "[account-link] completion message send failed (linkage already persisted):",
      err instanceof Error ? err.message : err,
    );
  }

  // 好みの引き継ぎ（never throw）。
  await carryover(env, lineUserId, result.shopifyCustomerId);

  console.log(`[account-link] linked messaging user ${lineUserId} via account link`);
  return "linked";
}
