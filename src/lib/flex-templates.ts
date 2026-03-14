/**
 * LINE Flex Message テンプレート。
 *
 * MS5 5.1: 商品カードテンプレート
 * MS5 5.2: 記事カードテンプレート
 * MS5 5.3: 注文確認カードテンプレート
 */

/** elxea ブランドカラー */
const COLORS = {
  cream: "#FFFEF2",
  charcoal: "#333333",
  muted: "#666666",
  border: "#E5E3D8",
  surface: "#F5F4EE",
} as const;

/** 商品カード Flex Message */
export function productCard(params: {
  name: string;
  description: string;
  price: string;
  imageUrl?: string;
  productUrl: string;
}): Record<string, unknown> {
  return {
    type: "bubble",
    size: "mega",
    ...(params.imageUrl
      ? {
          hero: {
            type: "image",
            url: params.imageUrl,
            size: "full",
            aspectRatio: "4:3",
            aspectMode: "cover",
          },
        }
      : {}),
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      backgroundColor: COLORS.cream,
      contents: [
        {
          type: "text",
          text: params.name,
          weight: "bold",
          size: "lg",
          color: COLORS.charcoal,
          wrap: true,
        },
        {
          type: "text",
          text: params.description,
          size: "sm",
          color: COLORS.muted,
          wrap: true,
          maxLines: 3,
        },
        {
          type: "text",
          text: params.price,
          size: "md",
          weight: "bold",
          color: COLORS.charcoal,
          margin: "md",
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      backgroundColor: COLORS.cream,
      contents: [
        {
          type: "button",
          action: {
            type: "uri",
            label: "詳細を見る",
            uri: params.productUrl,
          },
          style: "primary",
          color: COLORS.charcoal,
          height: "sm",
        },
      ],
    },
  };
}

/** 記事カード Flex Message */
export function articleCard(params: {
  title: string;
  description: string;
  imageUrl?: string;
  articleUrl: string;
}): Record<string, unknown> {
  return {
    type: "bubble",
    size: "mega",
    ...(params.imageUrl
      ? {
          hero: {
            type: "image",
            url: params.imageUrl,
            size: "full",
            aspectRatio: "16:9",
            aspectMode: "cover",
          },
        }
      : {}),
    body: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      backgroundColor: COLORS.cream,
      contents: [
        {
          type: "text",
          text: params.title,
          weight: "bold",
          size: "md",
          color: COLORS.charcoal,
          wrap: true,
        },
        {
          type: "text",
          text: params.description,
          size: "sm",
          color: COLORS.muted,
          wrap: true,
          maxLines: 2,
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      backgroundColor: COLORS.cream,
      contents: [
        {
          type: "button",
          action: {
            type: "uri",
            label: "記事を読む",
            uri: params.articleUrl,
          },
          style: "primary",
          color: COLORS.charcoal,
          height: "sm",
        },
      ],
    },
  };
}

/** 注文確認カード Flex Message（MS5 5.3） */
export function orderCard(params: {
  orderName: string;
  createdAt: string;
  totalPrice: string;
  financialStatus: string;
  fulfillmentStatus: string;
  items: Array<{ title: string; quantity: number }>;
  trackingNumber?: string;
  trackingUrl?: string;
}): Record<string, unknown> {
  // ステータスに応じたアイコン
  const fulfillmentIcon = params.fulfillmentStatus.includes("発送済")
    ? "📦"
    : params.fulfillmentStatus.includes("準備")
      ? "⏳"
      : "📋";

  const itemLines = params.items
    .slice(0, 5)
    .map(
      (item) =>
        ({
          type: "box",
          layout: "horizontal",
          contents: [
            {
              type: "text",
              text: item.title,
              size: "sm",
              color: COLORS.charcoal,
              flex: 4,
              wrap: true,
            },
            {
              type: "text",
              text: `x${item.quantity}`,
              size: "sm",
              color: COLORS.muted,
              flex: 1,
              align: "end",
            },
          ],
        }) as Record<string, unknown>,
    );

  const footerContents: Record<string, unknown>[] = [];

  if (params.trackingUrl) {
    footerContents.push({
      type: "button",
      action: {
        type: "uri",
        label: "配送状況を確認",
        uri: params.trackingUrl,
      },
      style: "primary",
      color: COLORS.charcoal,
      height: "sm",
    });
  }

  return {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "md",
      backgroundColor: COLORS.cream,
      contents: [
        {
          type: "text",
          text: `${fulfillmentIcon} 注文 ${params.orderName}`,
          weight: "bold",
          size: "lg",
          color: COLORS.charcoal,
        },
        {
          type: "separator",
          color: COLORS.border,
        },
        {
          type: "box",
          layout: "vertical",
          spacing: "sm",
          contents: [
            {
              type: "box",
              layout: "horizontal",
              contents: [
                {
                  type: "text",
                  text: "注文日",
                  size: "sm",
                  color: COLORS.muted,
                  flex: 2,
                },
                {
                  type: "text",
                  text: params.createdAt,
                  size: "sm",
                  color: COLORS.charcoal,
                  flex: 3,
                },
              ],
            },
            {
              type: "box",
              layout: "horizontal",
              contents: [
                {
                  type: "text",
                  text: "決済",
                  size: "sm",
                  color: COLORS.muted,
                  flex: 2,
                },
                {
                  type: "text",
                  text: params.financialStatus,
                  size: "sm",
                  color: COLORS.charcoal,
                  flex: 3,
                },
              ],
            },
            {
              type: "box",
              layout: "horizontal",
              contents: [
                {
                  type: "text",
                  text: "配送",
                  size: "sm",
                  color: COLORS.muted,
                  flex: 2,
                },
                {
                  type: "text",
                  text: params.fulfillmentStatus,
                  size: "sm",
                  color: COLORS.charcoal,
                  flex: 3,
                },
              ],
            },
            ...(params.trackingNumber
              ? [
                  {
                    type: "box",
                    layout: "horizontal",
                    contents: [
                      {
                        type: "text",
                        text: "追跡番号",
                        size: "sm",
                        color: COLORS.muted,
                        flex: 2,
                      },
                      {
                        type: "text",
                        text: params.trackingNumber,
                        size: "sm",
                        color: COLORS.charcoal,
                        flex: 3,
                      },
                    ],
                  },
                ]
              : []),
          ],
        },
        {
          type: "separator",
          color: COLORS.border,
        },
        {
          type: "text",
          text: "商品",
          size: "sm",
          weight: "bold",
          color: COLORS.charcoal,
        },
        {
          type: "box",
          layout: "vertical",
          spacing: "xs",
          contents: itemLines,
        },
        {
          type: "separator",
          color: COLORS.border,
        },
        {
          type: "box",
          layout: "horizontal",
          contents: [
            {
              type: "text",
              text: "合計",
              size: "md",
              weight: "bold",
              color: COLORS.charcoal,
              flex: 2,
            },
            {
              type: "text",
              text: params.totalPrice,
              size: "md",
              weight: "bold",
              color: COLORS.charcoal,
              flex: 3,
              align: "end",
            },
          ],
        },
      ],
    },
    ...(footerContents.length > 0
      ? {
          footer: {
            type: "box",
            layout: "vertical",
            spacing: "sm",
            backgroundColor: COLORS.cream,
            contents: footerContents,
          },
        }
      : {}),
  };
}

/** 複数商品を横スクロールで表示する Carousel */
export function productCarousel(
  products: Array<{
    name: string;
    description: string;
    price: string;
    imageUrl?: string;
    productUrl: string;
  }>,
): Record<string, unknown> {
  return {
    type: "carousel",
    contents: products.slice(0, 10).map((p) => productCard(p)),
  };
}
