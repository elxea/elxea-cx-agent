/**
 * Shopify 注文 webhook の検証・冪等・処理オーケストレーション（受け口を作って待つ）。
 *
 * 目的（T1 先回り配線）:
 *   Shopify 本番稼働時に「注文が入ったら即通電」するよう、受信経路を今つないでおく。
 *   - HMAC 署名検証（X-Shopify-Hmac-Sha256）を必須化（無認証受信は禁止・fail-closed）。
 *   - 冪等性は注文 ID をキーに processed_events テーブルでアトミック claim（二重処理防止）。
 *   - 受信 → 顧客特定 → runPurchasePreferencePipeline 通電（死蔵配線）＋ lastPurchaseAt 更新
 *     ＋ 定期便フラグ（isSubscriber）更新。
 *
 * 安全設計:
 *   - 署名検証は定数時間比較・fail-closed（secret 未設定 / header 欠落 / 不一致は必ず拒否）。
 *   - claim は「先に予約 → 後で処理」。同一注文の複数 topic（create/paid/updated）や再送でも
 *     ペルソナ加算（+3）が多重に効かない（注文 ID 単位で 1 回だけ処理）。
 *   - 実送信は一切しない。外部への push はパイプライン内の Firestore/Shopify 書き込みのみ。
 *
 * このモジュール自体はネットワーク I/O を直接持たない純粋寄りの構造にし、実 I/O は deps 注入で
 * 差し替え可能にする（ユニットテストは fake を注入して純粋に検証する）。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../index";
import {
  createSupabaseDeliveryLedgerStore,
  extractDeliveryRecords,
  type DeliveryRecord,
  type DeliveryWriteResult,
} from "./delivery-ledger";
import { getFirestoreEnv, updateCustomerProfile } from "./firestore";
import { runPurchasePreferencePipeline } from "./preference-pipeline";
import { fetchProductTagsByIds } from "./shopify";
import { detectSubscriptionFromOrder } from "./subscription";

// -------------------------------------------------------------------
// 型
// -------------------------------------------------------------------

/** Shopify 注文 webhook payload の、本モジュールが使う最小形。 */
export type ShopifyOrderPayload = {
  id?: number | string;
  created_at?: string;
  tags?: string | string[] | null;
  customer?: { id?: number | string | null } | null;
  line_items?: Array<{
    /** 明細 ID。配送台帳の二重計上を防ぐ鍵の一部（038）。 */
    id?: number | string | null;
    product_id?: number | string | null;
    /** 以下は配送台帳（何が・どの銘柄が届いたか）のために読む。 */
    variant_id?: number | string | null;
    title?: string | null;
    variant_title?: string | null;
    name?: string | null;
    sku?: string | null;
    quantity?: number | null;
    selling_plan_allocation?: unknown;
    selling_plan_id?: string | number | null;
  }> | null;
  /** 発送の記録。あれば配送台帳の「届いた日」をこちらから取る（注文日より確か）。 */
  fulfillments?: Array<{
    created_at?: string | null;
    status?: string | null;
  }> | null;
};

/** 注文冪等 claim のポート（DB 実装を差し替え可能にしてテストを純粋に保つ）。 */
export interface WebhookIdempotencyStore {
  /**
   * eventKey をアトミックに予約する。
   * INSERT ... ON CONFLICT DO NOTHING 相当。今回挿入できたら claimed:true、
   * 既存（＝二重）なら claimed:false。DB エラーは throw（fail-closed 判断は呼び出し側）。
   */
  claim(eventKey: string): Promise<{ claimed: boolean }>;
}

/** handleShopifyOrder の依存（実 I/O は factory、テストは fake を注入）。 */
export type ShopifyOrderDeps = {
  /** 商品 ID → タグ の解決。 */
  fetchProductTags: (
    productIds: string[],
    env: Env,
  ) => Promise<Map<string, string[]>>;
  /** 購入ペルソナパイプライン（死蔵配線の通電先）。 */
  runPurchasePipeline: (
    shopifyCustomerId: string,
    lineItems: Array<{ productTags: string[] }>,
    env: Env,
  ) => Promise<void>;
  /**
   * 配送台帳へ「誰に・いつ・何が届いたか」を書く（migration 038 / 機能定義 第5節 タスク9）。
   * **この記録は過去に遡って作れない**ため、属性更新やペルソナ加算より先に実行する。
   */
  recordDeliveries: (rows: DeliveryRecord[]) => Promise<DeliveryWriteResult>;
  /** CustomerProfile の部分更新（lastPurchaseAt / isSubscriber）。 */
  updateProfile: (
    shopifyCustomerId: string,
    updates: {
      lastPurchaseAt?: string | null;
      isSubscriber?: boolean;
      subscriberUpdatedAt?: string | null;
    },
    env: Env,
  ) => Promise<void>;
};

/** handleShopifyOrder の結果（テスト・ログ用）。 */
export type ShopifyOrderResult = {
  status:
    | "processed"
    | "skipped_no_customer"
    | "skipped_firebase_unset"
    | "error";
  shopifyCustomerId?: string;
  isSubscriber?: boolean;
  pipelineInvoked?: boolean;
  lastPurchaseAtUpdated?: boolean;
  /** 配送台帳に書いた行数（新規＋更新）。0 は「書く中身が無かった」。 */
  deliveriesRecorded?: number;
  /** 配送台帳への書き込みに失敗したときだけ入る（他の経路は続行する）。 */
  deliveryLedgerError?: string;
  reason?: string;
};

// -------------------------------------------------------------------
// 署名検証（HMAC-SHA256・base64・定数時間・fail-closed）
// -------------------------------------------------------------------

/**
 * Shopify webhook の HMAC 署名を検証する。
 *
 * Shopify は raw リクエストボディを webhook secret で HMAC-SHA256 し、base64 を
 * X-Shopify-Hmac-Sha256 ヘッダで送る。ここではそれを再計算して定数時間比較する。
 *
 * fail-closed: secret 未設定・署名欠落・不一致・長さ不一致はすべて false（受信拒否）。
 *
 * @param rawBody 受信した生ボディ（パース前の文字列そのまま）
 * @param hmacHeader X-Shopify-Hmac-Sha256 ヘッダ値（base64）
 * @param secret SHOPIFY_WEBHOOK_SECRET
 */
export async function verifyShopifyWebhookSignature(
  rawBody: string,
  hmacHeader: string | null | undefined,
  secret: string | null | undefined,
): Promise<boolean> {
  // fail-closed: secret / 署名が無ければ検証不能 = 拒否
  if (!secret || !hmacHeader) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));

  // 定数時間比較（タイミング攻撃防止）。長さ不一致は即 false。
  if (computed.length !== hmacHeader.length) return false;
  let result = 0;
  for (let i = 0; i < computed.length; i++) {
    result |= computed.charCodeAt(i) ^ hmacHeader.charCodeAt(i);
  }
  return result === 0;
}

// -------------------------------------------------------------------
// payload 解析（純粋）
// -------------------------------------------------------------------

/** 注文の冪等キー。注文 ID 単位で 1 回だけ処理する（topic/再送を跨いで一意）。 */
export function orderIdempotencyKey(order: ShopifyOrderPayload): string | null {
  if (order.id == null) return null;
  const id = String(order.id).trim();
  if (id.length === 0) return null;
  return `shopify:order:${id}`;
}

/** 注文から顧客 ID（数値文字列）を取り出す。guest checkout 等で無ければ null。 */
export function extractCustomerId(order: ShopifyOrderPayload): string | null {
  const raw = order.customer?.id;
  if (raw == null) return null;
  const id = String(raw).replace(/^gid:\/\/shopify\/Customer\//, "").trim();
  return /^\d+$/.test(id) ? id : null;
}

/** 注文の line_items から数値 product_id 群を取り出す（重複排除）。 */
export function extractProductIds(order: ShopifyOrderPayload): string[] {
  const items = order.line_items ?? [];
  const ids = items
    .map((i) => (i.product_id == null ? "" : String(i.product_id).trim()))
    .filter((id) => id.length > 0);
  return Array.from(new Set(ids));
}

// -------------------------------------------------------------------
// オーケストレーション（deps 注入・テスト可能）
// -------------------------------------------------------------------

/**
 * 注文 1 件を処理する（冪等 claim 済みの前提で呼ばれる）。
 *
 * 手順:
 *   1. 顧客 ID を特定。無ければ何もしない（guest checkout）。
 *   2. lastPurchaseAt を無条件更新（デノーマライズ; タグの有無に依らず購入事実を反映）。
 *      定期便判定が真なら isSubscriber も更新。
 *   3. line_items の商品タグを解決し、runPurchasePreferencePipeline に通電（ペルソナ加算 +3）。
 *      タグが無くてもパイプラインは内部で安全にスキップする（別軸加算のため会話スコアは不変）。
 *
 * 例外は握って ShopifyOrderResult に畳む（webhook を落とさない）。
 */
export async function handleShopifyOrder(
  order: ShopifyOrderPayload,
  env: Env,
  deps: ShopifyOrderDeps,
): Promise<ShopifyOrderResult> {
  try {
    const shopifyCustomerId = extractCustomerId(order);
    if (!shopifyCustomerId) {
      // 誰に届いたか分からない記録は作らない（guest checkout）。
      return { status: "skipped_no_customer" };
    }

    // 商品タグ（配送台帳の分類とペルソナ加算の両方で使う）。
    // 台帳は最優先なので、タグが引けなくても**書く**（分類は 'unknown' のまま残す）。
    const productIds = extractProductIds(order);
    let tagMap = new Map<string, string[]>();
    let tagFetchError: string | undefined;
    try {
      tagMap = await deps.fetchProductTags(productIds, env);
    } catch (err) {
      tagFetchError = err instanceof Error ? err.message : String(err);
    }

    // ── 1. 配送台帳（何より先に書く。遡って作れない記録だから）─────────────
    let deliveriesRecorded = 0;
    let deliveryLedgerError: string | undefined;
    try {
      const rows = extractDeliveryRecords(order, { productTags: tagMap });
      const written = await deps.recordDeliveries(rows);
      deliveriesRecorded = written.inserted + written.updated;
    } catch (err) {
      // 台帳が書けなくても他の経路は止めない（ここで throw すると属性更新まで巻き添えになる）。
      deliveryLedgerError = err instanceof Error ? err.message : String(err);
    }

    if (tagFetchError) {
      // タグが引けない = ペルソナ加算の材料が無い。台帳を書いたうえで異常として返す。
      return {
        status: "error",
        shopifyCustomerId,
        deliveriesRecorded,
        deliveryLedgerError,
        reason: `product tags fetch failed: ${tagFetchError}`,
      };
    }

    // Firebase 未設定なら属性更新経路は成立しない（fail-safe スキップ）。台帳は上で書き済み。
    try {
      getFirestoreEnv(env);
    } catch {
      return { status: "skipped_firebase_unset", deliveriesRecorded, deliveryLedgerError };
    }

    const isSubscriber = detectSubscriptionFromOrder(order);
    const purchasedAt = order.created_at ?? new Date().toISOString();

    // lastPurchaseAt を無条件更新（＋ 定期便なら isSubscriber も）。
    const nowIso = new Date().toISOString();
    await deps.updateProfile(
      shopifyCustomerId,
      isSubscriber
        ? {
            lastPurchaseAt: purchasedAt,
            isSubscriber: true,
            subscriberUpdatedAt: nowIso,
          }
        : { lastPurchaseAt: purchasedAt },
      env,
    );

    // 解決済みのタグでペルソナパイプラインに通電。
    const lineItems = productIds.map((pid) => ({
      productTags: tagMap.get(pid) ?? [],
    }));

    await deps.runPurchasePipeline(shopifyCustomerId, lineItems, env);

    return {
      status: "processed",
      shopifyCustomerId,
      isSubscriber,
      pipelineInvoked: true,
      lastPurchaseAtUpdated: true,
      deliveriesRecorded,
      deliveryLedgerError,
    };
  } catch (err) {
    return {
      status: "error",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

// -------------------------------------------------------------------
// 実 I/O アダプタ（runtime のみ）
// -------------------------------------------------------------------

/** processed_events を使う冪等ストア（既存 LINE webhook と同じテーブルを共用）。 */
export function createSupabaseIdempotencyStore(
  supabase: SupabaseClient,
): WebhookIdempotencyStore {
  return {
    async claim(eventKey: string): Promise<{ claimed: boolean }> {
      const { data, error } = await supabase
        .from("processed_events")
        .upsert(
          { webhook_event_id: eventKey },
          { onConflict: "webhook_event_id", ignoreDuplicates: true },
        )
        .select("webhook_event_id");
      if (error) {
        // fail-closed: claim できたか不明なら「未 claim」に倒し、呼び出し側で送信中止扱い。
        throw new Error(`idempotency claim failed: ${error.message}`);
      }
      return { claimed: (data?.length ?? 0) > 0 };
    },
  };
}

/**
 * 実 I/O 版の deps を構築する（本番経路）。
 *
 * @param supabase 配送台帳（Supabase RPC `record_tea_deliveries`）への接続。
 */
export function createShopifyOrderDeps(supabase: SupabaseClient): ShopifyOrderDeps {
  const ledger = createSupabaseDeliveryLedgerStore(supabase as unknown as {
    rpc(fn: string, args: Record<string, unknown>): Promise<{
      data: unknown;
      error: { message: string } | null;
    }>;
  });
  return {
    fetchProductTags: (productIds, env) => fetchProductTagsByIds(productIds, env),
    recordDeliveries: (rows) => ledger.record(rows),
    runPurchasePipeline: (customerId, lineItems, env) =>
      runPurchasePreferencePipeline(customerId, lineItems, env),
    updateProfile: async (customerId, updates, env) => {
      const fsEnv = getFirestoreEnv(env);
      await updateCustomerProfile(customerId, updates, fsEnv);
    },
  };
}
