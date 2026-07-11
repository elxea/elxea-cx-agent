import type { Context } from "hono";
import type { Env } from "../index";
import { createSupabaseClient } from "../lib/supabase";
import {
  verifyShopifyWebhookSignature,
  orderIdempotencyKey,
  handleShopifyOrder,
  createSupabaseIdempotencyStore,
  createShopifyOrderDeps,
  type ShopifyOrderPayload,
} from "../lib/shopify-order-webhook";

/**
 * Shopify 注文 webhook ハンドラ（受け口を作って待つ・稼働で即通電）。
 *
 * 1. HMAC 署名検証（fail-closed / secret 未設定・不一致は 401）
 * 2. 注文 ID で冪等 claim（二重処理防止 / 再送・複数 topic を跨いで一意）
 * 3. 即時 200 を返しつつ waitUntil() で処理（顧客特定 → ペルソナ通電＋lastPurchaseAt＋定期便）
 *
 * ⚠ 実送信は一切しない。副作用は Firestore / Shopify metafield（パイプライン内・既存ガード）のみ。
 */
export async function shopifyOrderWebhook(c: Context<{ Bindings: Env }>) {
  // 生ボディ（署名検証は raw で行う。JSON.parse 後だと署名がずれる）
  const rawBody = await c.req.text();
  const hmac = c.req.header("X-Shopify-Hmac-Sha256");

  // 1. 署名検証（fail-closed）
  const valid = await verifyShopifyWebhookSignature(
    rawBody,
    hmac,
    c.env.SHOPIFY_WEBHOOK_SECRET,
  );
  if (!valid) {
    return c.json({ error: "Invalid signature" }, 401);
  }

  // 2. パース
  let order: ShopifyOrderPayload;
  try {
    order = JSON.parse(rawBody) as ShopifyOrderPayload;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const eventKey = orderIdempotencyKey(order);
  if (!eventKey) {
    // 注文 ID 欠落 = 処理不能だが、Shopify に再送させても直らないため 200 で受理して破棄。
    return c.json({ status: "ignored", reason: "missing order id" });
  }

  // 3. 冪等 claim（アトミック）。claim 失敗（DB エラー）は 500 で Shopify に再送させる。
  const supabase = createSupabaseClient(c.env);
  const store = createSupabaseIdempotencyStore(supabase);
  let claimed: boolean;
  try {
    ({ claimed } = await store.claim(eventKey));
  } catch (err) {
    console.error("[shopify-webhook] idempotency claim error:", err);
    return c.json({ error: "claim failed" }, 500);
  }
  if (!claimed) {
    // 既処理（再送・別 topic 重複）→ 何もせず 200。
    return c.json({ status: "duplicate" });
  }

  // 4. バックグラウンド処理（即時 200 を返す）
  const deps = createShopifyOrderDeps();
  c.executionCtx.waitUntil(
    handleShopifyOrder(order, c.env, deps).then((result) => {
      console.log("[shopify-webhook] order processed:", JSON.stringify(result));
    }),
  );

  return c.json({ status: "ok" });
}
