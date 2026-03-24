/**
 * Shopify Admin API クライアント（MS6 6.2-6.4）。
 *
 * 注文照会・顧客情報の取得を提供。
 * Admin API Access Token が必要（Shopify Admin > Settings > Apps で Custom App を作成）。
 */

import type { Env } from "../index";
import { createSupabaseClient } from "./supabase";

const SHOPIFY_API_VERSION = "2025-01";

/** Shopify Admin GraphQL API を呼び出す */
async function shopifyAdminQuery(
  query: string,
  variables: Record<string, unknown>,
  env: Env,
): Promise<Record<string, unknown>> {
  if (!env.SHOPIFY_ADMIN_ACCESS_TOKEN || !env.SHOPIFY_STORE_DOMAIN) {
    throw new Error("Shopify Admin API credentials not configured");
  }

  const res = await fetch(
    `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Shopify Admin API error: ${res.status} ${error}`);
  }

  const json = (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    throw new Error(
      `Shopify GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`,
    );
  }

  return json.data ?? {};
}

// -------------------------------------------------------------------
// 顧客注文照会（lookup_my_orders）
// -------------------------------------------------------------------

type OrderSummary = {
  name: string;
  status: string;
  fulfillmentStatus: string;
  createdAt: string;
  totalPrice: string;
  tracking?: { number: string; url: string };
};

/**
 * ユーザーの紐付け済み Shopify アカウントから注文履歴を取得。
 */
export async function lookupMyOrders(
  userId: string,
  channel: "line" | "web",
  env: Env,
): Promise<string> {
  const supabase = createSupabaseClient(env);

  // customer_linkages から Shopify customer ID を取得
  // LINE チャネルの場合は line_user_id で検索、Web の場合は将来対応
  const linkageQuery = channel === "line"
    ? supabase.from("customer_linkages").select("shopify_customer_id, shopify_email").eq("line_user_id", userId).single()
    : supabase.from("customer_linkages").select("shopify_customer_id, shopify_email").eq("shopify_customer_id", userId).single();
  const { data: linkage, error: linkError } = await linkageQuery;

  if (linkError || !linkage?.shopify_customer_id) {
    return "このLINEアカウントにはShopifyアカウントが紐付けられていません。注文状況の確認には注文番号をお教えください。";
  }

  const query = `
    query getCustomerOrders($customerId: ID!) {
      customer(id: $customerId) {
        displayName
        email
        orders(first: 5, sortKey: CREATED_AT, reverse: true) {
          edges {
            node {
              name
              displayFinancialStatus
              displayFulfillmentStatus
              createdAt
              totalPriceSet {
                shopMoney { amount currencyCode }
              }
              fulfillments(first: 1) {
                trackingInfo(first: 1) {
                  number
                  url
                }
                status
              }
            }
          }
        }
      }
    }
  `;

  try {
    const data = await shopifyAdminQuery(
      query,
      { customerId: `gid://shopify/Customer/${linkage.shopify_customer_id}` },
      env,
    );

    const customer = data.customer as {
      displayName: string;
      email: string;
      orders: {
        edges: Array<{
          node: {
            name: string;
            displayFinancialStatus: string;
            displayFulfillmentStatus: string;
            createdAt: string;
            totalPriceSet: {
              shopMoney: { amount: string; currencyCode: string };
            };
            fulfillments: Array<{
              trackingInfo: Array<{ number: string; url: string }>;
              status: string;
            }>;
          };
        }>;
      };
    } | null;

    if (!customer) {
      return "Shopify上で顧客情報が見つかりませんでした。";
    }

    const orders: OrderSummary[] = customer.orders.edges.map((edge) => {
      const o = edge.node;
      const tracking = o.fulfillments?.[0]?.trackingInfo?.[0];
      return {
        name: o.name,
        status: formatFinancialStatus(o.displayFinancialStatus),
        fulfillmentStatus: formatFulfillmentStatus(
          o.displayFulfillmentStatus,
        ),
        createdAt: new Date(o.createdAt).toLocaleDateString("ja-JP"),
        totalPrice: `¥${Number(o.totalPriceSet.shopMoney.amount).toLocaleString()}`,
        tracking: tracking?.number
          ? { number: tracking.number, url: tracking.url }
          : undefined,
      };
    });

    if (orders.length === 0) {
      return `${customer.displayName}さんの注文履歴はまだありません。`;
    }

    const orderList = orders
      .map((o) => {
        let line = `- ${o.name}: ${o.totalPrice}（${o.createdAt}）\n  決済: ${o.status} / 配送: ${o.fulfillmentStatus}`;
        if (o.tracking) {
          line += `\n  追跡番号: ${o.tracking.number}`;
        }
        return line;
      })
      .join("\n");

    return `${customer.displayName}さんの最近の注文:\n${orderList}`;
  } catch (error) {
    console.error("lookupMyOrders error:", error);
    return "注文情報の取得に失敗しました。しばらくしてから再度お試しください。";
  }
}

// -------------------------------------------------------------------
// 注文詳細照会（get_order_detail）
// -------------------------------------------------------------------

/** 注文詳細の構造化データ（Flex Message 生成用） */
export type OrderDetailData = {
  orderName: string;
  createdAt: string;
  totalPrice: string;
  financialStatus: string;
  fulfillmentStatus: string;
  items: Array<{ title: string; quantity: number }>;
  trackingNumber?: string;
  trackingUrl?: string;
};

/** getOrderDetail の結果（テキスト + 構造化データ） */
export type OrderDetailResult = {
  text: string;
  data?: OrderDetailData;
};

/**
 * 注文番号から特定の注文の詳細を取得。
 * テキスト（Claude ツール結果用）と構造化データ（Flex Message 用）を返す。
 */
export async function getOrderDetail(
  orderNumber: string,
  env: Env,
): Promise<OrderDetailResult> {
  const query = `
    query getOrder($query: String!) {
      orders(first: 1, query: $query) {
        edges {
          node {
            name
            displayFinancialStatus
            displayFulfillmentStatus
            createdAt
            totalPriceSet {
              shopMoney { amount currencyCode }
            }
            lineItems(first: 10) {
              edges {
                node {
                  title
                  quantity
                  variant {
                    title
                    price
                  }
                }
              }
            }
            fulfillments(first: 3) {
              trackingInfo(first: 1) {
                number
                url
              }
              status
              createdAt
            }
            shippingAddress {
              province
              city
            }
          }
        }
      }
    }
  `;

  try {
    // 注文番号のフォーマット統一（#なしの数字のみに）
    const cleanNumber = orderNumber.replace(/^#/, "");
    const data = await shopifyAdminQuery(
      query,
      { query: `name:#${cleanNumber}` },
      env,
    );

    const orders = data.orders as {
      edges: Array<{
        node: {
          name: string;
          displayFinancialStatus: string;
          displayFulfillmentStatus: string;
          createdAt: string;
          totalPriceSet: {
            shopMoney: { amount: string; currencyCode: string };
          };
          lineItems: {
            edges: Array<{
              node: {
                title: string;
                quantity: number;
                variant: { title: string; price: string } | null;
              };
            }>;
          };
          fulfillments: Array<{
            trackingInfo: Array<{ number: string; url: string }>;
            status: string;
            createdAt: string;
          }>;
          shippingAddress: { province: string; city: string } | null;
        };
      }>;
    };

    if (!orders?.edges?.length) {
      return { text: `注文番号 #${cleanNumber} は見つかりませんでした。番号をもう一度ご確認ください。` };
    }

    const o = orders.edges[0].node;
    const financialStatus = formatFinancialStatus(o.displayFinancialStatus);
    const fulfillmentStatus = formatFulfillmentStatus(o.displayFulfillmentStatus);
    const createdAt = new Date(o.createdAt).toLocaleDateString("ja-JP");
    const totalPrice = `¥${Number(o.totalPriceSet.shopMoney.amount).toLocaleString()}`;

    const structuredItems = o.lineItems.edges.map((e) => ({
      title: e.node.title + (e.node.variant?.title && e.node.variant.title !== "Default Title" ? ` (${e.node.variant.title})` : ""),
      quantity: e.node.quantity,
    }));

    const itemsText = structuredItems
      .map((item) => `  - ${item.title} x${item.quantity}`)
      .join("\n");

    let text = `注文 ${o.name}\n`;
    text += `注文日: ${createdAt}\n`;
    text += `合計: ${totalPrice}\n`;
    text += `決済状況: ${financialStatus}\n`;
    text += `配送状況: ${fulfillmentStatus}\n`;
    text += `商品:\n${itemsText}`;

    let trackingNumber: string | undefined;
    let trackingUrl: string | undefined;

    if (o.fulfillments?.length) {
      const f = o.fulfillments[0];
      const tracking = f.trackingInfo?.[0];
      if (tracking?.number) {
        trackingNumber = tracking.number;
        trackingUrl = tracking.url || undefined;
        text += `\n追跡番号: ${trackingNumber}`;
        if (trackingUrl) {
          text += ` (${trackingUrl})`;
        }
      }
    }

    return {
      text,
      data: {
        orderName: o.name,
        createdAt,
        totalPrice,
        financialStatus,
        fulfillmentStatus,
        items: structuredItems,
        trackingNumber,
        trackingUrl,
      },
    };
  } catch (error) {
    console.error("getOrderDetail error:", error);
    return { text: "注文情報の取得に失敗しました。しばらくしてから再度お試しください。" };
  }
}

// -------------------------------------------------------------------
// カートリンク生成（Storefront API）
// -------------------------------------------------------------------

/** Shopify Storefront GraphQL API を呼び出す */
async function shopifyStorefrontQuery(
  query: string,
  variables: Record<string, unknown>,
  env: Env,
): Promise<Record<string, unknown>> {
  if (!env.SHOPIFY_STOREFRONT_ACCESS_TOKEN || !env.SHOPIFY_STORE_DOMAIN) {
    throw new Error("Shopify Storefront API credentials not configured");
  }

  const res = await fetch(
    `https://${env.SHOPIFY_STORE_DOMAIN}/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Storefront-Access-Token": env.SHOPIFY_STOREFRONT_ACCESS_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Shopify Storefront API error: ${res.status} ${error}`);
  }

  const json = (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string }>;
  };

  if (json.errors?.length) {
    throw new Error(
      `Shopify Storefront GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`,
    );
  }

  return json.data ?? {};
}

/** create_cart_link の結果 */
export type CartLinkResult = {
  text: string;
  checkoutUrl?: string;
};

/**
 * Shopify Storefront API でカートを作成し、チェックアウト URL を返す。
 *
 * Storefront API の cartCreate mutation を使用。
 * 生成される URL は https://{store}.myshopify.com/cart/c/{cart_token} 形式。
 *
 * @param items 商品バリアント ID と数量のリスト
 * @param env Workers 環境変数
 */
export async function createCartLink(
  items: Array<{ variantId: string; quantity: number }>,
  env: Env,
): Promise<CartLinkResult> {
  const mutation = `
    mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart {
          id
          checkoutUrl
          lines(first: 10) {
            edges {
              node {
                merchandise {
                  ... on ProductVariant {
                    title
                    product {
                      title
                    }
                    price {
                      amount
                      currencyCode
                    }
                  }
                }
                quantity
              }
            }
          }
          cost {
            totalAmount {
              amount
              currencyCode
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    // Variant ID を Shopify GID 形式に正規化
    const lines = items.map((item) => {
      const merchandiseId = item.variantId.startsWith("gid://")
        ? item.variantId
        : `gid://shopify/ProductVariant/${item.variantId}`;
      return {
        merchandiseId,
        quantity: item.quantity,
      };
    });

    const data = await shopifyStorefrontQuery(
      mutation,
      { input: { lines } },
      env,
    );

    const cartCreate = data.cartCreate as {
      cart?: {
        id: string;
        checkoutUrl: string;
        lines: {
          edges: Array<{
            node: {
              merchandise: {
                title: string;
                product: { title: string };
                price: { amount: string; currencyCode: string };
              };
              quantity: number;
            };
          }>;
        };
        cost: {
          totalAmount: { amount: string; currencyCode: string };
        };
      };
      userErrors?: Array<{ field: string[]; message: string }>;
    };

    if (cartCreate?.userErrors?.length) {
      const errorMsg = cartCreate.userErrors
        .map((e) => e.message)
        .join(", ");
      console.error("Cart creation user errors:", errorMsg);
      return { text: `カートの作成に失敗しました: ${errorMsg}` };
    }

    if (!cartCreate?.cart?.checkoutUrl) {
      return { text: "カートの作成に失敗しました。しばらくしてから再度お試しください。" };
    }

    const cart = cartCreate.cart;
    const cartItems = cart.lines.edges.map((e) => {
      const m = e.node.merchandise;
      return `${m.product.title}${m.title !== "Default Title" ? ` (${m.title})` : ""} x${e.node.quantity} - ¥${Number(m.price.amount).toLocaleString()}`;
    });

    const totalAmount = `¥${Number(cart.cost.totalAmount.amount).toLocaleString()}`;

    let text = "カートを作成しました。\n\n";
    text += cartItems.join("\n");
    text += `\n\n合計: ${totalAmount}`;
    text += `\n\n購入はこちらから: ${cart.checkoutUrl}`;

    return { text, checkoutUrl: cart.checkoutUrl };
  } catch (error) {
    console.error("createCartLink error:", error);
    return { text: "カートの作成に失敗しました。しばらくしてから再度お試しください。" };
  }
}

// -------------------------------------------------------------------
// ステータスの日本語変換
// -------------------------------------------------------------------

function formatFinancialStatus(status: string): string {
  const map: Record<string, string> = {
    PENDING: "未決済",
    AUTHORIZED: "承認済み",
    PARTIALLY_PAID: "一部入金",
    PAID: "支払い済み",
    PARTIALLY_REFUNDED: "一部返金",
    REFUNDED: "返金済み",
    VOIDED: "無効",
  };
  return map[status] ?? status;
}

function formatFulfillmentStatus(status: string): string {
  const map: Record<string, string> = {
    UNFULFILLED: "未発送",
    PARTIALLY_FULFILLED: "一部発送済み",
    FULFILLED: "発送済み",
    RESTOCKED: "返品済み",
    PENDING_FULFILLMENT: "発送準備中",
    OPEN: "処理中",
    IN_PROGRESS: "処理中",
    ON_HOLD: "保留中",
    SCHEDULED: "発送予定",
  };
  return map[status] ?? status;
}
