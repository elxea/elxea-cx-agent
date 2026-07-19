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

// ---------------------------------------------------------------------------
// Phase-3 Flex Message テンプレート
// ---------------------------------------------------------------------------

/**
 * 商品紹介カード（マッチ度付き）。
 *
 * 診断済みユーザー向けに、パーソナライズされたマッチ度と
 * 味わい説明を含む商品紹介 Flex Message。
 * 未診断ユーザーの場合は matchScore / matchReason を省略して使用する。
 */
export function productIntroCard(params: {
  name: string;
  origin?: string;
  variety?: string;
  description: string;
  price: string;
  imageUrl?: string;
  productUrl: string;
  /** マッチ度（0-100）。診断済みユーザーのみ表示 */
  matchScore?: number;
  /** マッチ理由（1行）。診断済みユーザーのみ表示 */
  matchReason?: string;
}): Record<string, unknown> {
  const bodyContents: Record<string, unknown>[] = [
    {
      type: "text",
      text: params.name,
      weight: "bold",
      size: "lg",
      color: COLORS.charcoal,
      wrap: true,
    },
  ];

  // 産地・品種（あれば表示）
  if (params.origin || params.variety) {
    const metaText = [params.origin, params.variety]
      .filter(Boolean)
      .join(" / ");
    bodyContents.push({
      type: "text",
      text: metaText,
      size: "xs",
      color: COLORS.muted,
      margin: "sm",
    });
  }

  // 味わい説明
  bodyContents.push({
    type: "text",
    text: params.description,
    size: "sm",
    color: COLORS.muted,
    wrap: true,
    maxLines: 3,
    margin: "md",
  });

  // 価格
  bodyContents.push({
    type: "text",
    text: params.price,
    size: "md",
    weight: "bold",
    color: COLORS.charcoal,
    margin: "md",
  });

  // マッチ度（診断済みユーザーのみ）
  if (params.matchScore !== undefined && params.matchReason) {
    bodyContents.push(
      {
        type: "separator",
        color: COLORS.border,
        margin: "md",
      } as Record<string, unknown>,
      {
        type: "box",
        layout: "horizontal",
        spacing: "sm",
        margin: "md",
        contents: [
          {
            type: "text",
            text: `${params.matchScore}% マッチ`,
            size: "sm",
            weight: "bold",
            color: COLORS.charcoal,
            flex: 0,
          },
          {
            type: "text",
            text: params.matchReason,
            size: "xs",
            color: COLORS.muted,
            flex: 1,
            wrap: true,
          },
        ],
      } as Record<string, unknown>,
    );
  }

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
      contents: bodyContents,
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
            label: "詳しく見る",
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

/**
 * レコメンドカルーセル（マッチ理由付き）。
 *
 * 「あなたにおすすめの N 種」として横スワイプで表示する。
 * 各カードにマッチ理由を1行添え、パーソナライズされた印象を与える。
 */
export function recommendCarousel(
  products: Array<{
    name: string;
    description: string;
    price: string;
    imageUrl?: string;
    productUrl: string;
    /** マッチ理由（1行。例: 「あなたが好む香ばしさとコクのバランス」） */
    matchReason: string;
  }>,
): Record<string, unknown> {
  const bubbles = products.slice(0, 10).map((p) => {
    const bodyContents: Record<string, unknown>[] = [
      {
        type: "text",
        text: p.name,
        weight: "bold",
        size: "md",
        color: COLORS.charcoal,
        wrap: true,
      },
      {
        type: "text",
        text: p.matchReason,
        size: "xs",
        color: COLORS.muted,
        wrap: true,
        margin: "sm",
        style: "italic",
      },
      {
        type: "text",
        text: p.description,
        size: "sm",
        color: COLORS.muted,
        wrap: true,
        maxLines: 2,
        margin: "md",
      },
      {
        type: "text",
        text: p.price,
        size: "md",
        weight: "bold",
        color: COLORS.charcoal,
        margin: "md",
      },
    ];

    return {
      type: "bubble",
      size: "kilo",
      ...(p.imageUrl
        ? {
            hero: {
              type: "image",
              url: p.imageUrl,
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
        contents: bodyContents,
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
              label: "詳しく見る",
              uri: p.productUrl,
            },
            style: "primary",
            color: COLORS.charcoal,
            height: "sm",
          },
        ],
      },
    } as Record<string, unknown>;
  });

  return {
    type: "carousel",
    contents: bubbles,
  };
}

/**
 * フィードバック UI テンプレート。
 *
 * 「今月のお茶はいかがでしたか？」の質問に対して
 * 4段階評価ボタンを表示する Flex Message。
 * タップ後は postback で feedback action として処理される。
 *
 * デザイン原則: 白ベース、淡いアクセント色、余白重視。
 */
export function feedbackCard(params: {
  /** 評価対象の商品名（例: 「今月のほうじ茶 クラシック」） */
  productName?: string;
  /** コールバックデータのプレフィックス（postback 用） */
  callbackPrefix?: string;
}): Record<string, unknown> {
  const prefix = params.callbackPrefix ?? "feedback";
  const title = params.productName
    ? `${params.productName}はいかがでしたか？`
    : "今月のお茶はいかがでしたか？";

  /**
   * 4段階評価ボタン。
   * postback data 形式: {prefix}:{rating}
   * テキスト送信は行わない（displayText のみ表示）。
   */
  const ratingButtons: Record<string, unknown>[] = [
    {
      type: "button",
      action: {
        type: "postback",
        label: "大好き",
        data: `${prefix}:love`,
        displayText: "大好き！",
      },
      style: "primary",
      color: COLORS.charcoal,
      height: "sm",
    },
    {
      type: "button",
      action: {
        type: "postback",
        label: "好き",
        data: `${prefix}:like`,
        displayText: "好きです",
      },
      style: "secondary",
      height: "sm",
    },
    {
      type: "button",
      action: {
        type: "postback",
        label: "普通",
        data: `${prefix}:neutral`,
        displayText: "普通かな",
      },
      style: "secondary",
      height: "sm",
    },
    {
      type: "button",
      action: {
        type: "postback",
        label: "苦手",
        data: `${prefix}:dislike`,
        displayText: "ちょっと苦手でした",
      },
      style: "secondary",
      height: "sm",
    },
  ];

  return {
    type: "bubble",
    size: "mega",
    body: {
      type: "box",
      layout: "vertical",
      spacing: "lg",
      backgroundColor: COLORS.cream,
      paddingAll: "xl",
      contents: [
        {
          type: "text",
          text: title,
          weight: "bold",
          size: "lg",
          color: COLORS.charcoal,
          wrap: true,
          align: "center",
        },
        {
          type: "text",
          text: "あなたの声を、次回のおすすめに反映します。",
          size: "xs",
          color: COLORS.muted,
          align: "center",
          margin: "md",
        },
        {
          type: "separator",
          color: COLORS.border,
          margin: "lg",
        },
      ],
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      backgroundColor: COLORS.cream,
      paddingAll: "lg",
      contents: [
        ...ratingButtons,
        {
          type: "text",
          text: "コメントがあればメッセージで教えてください",
          size: "xxs",
          color: COLORS.muted,
          align: "center",
          margin: "md",
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// UX③ お茶レコメンドカード + 画像 URL 正規化（写真つきカード / 写真なし graceful）
// ---------------------------------------------------------------------------

/**
 * お茶画像 URL を「直 r2.dev」優先に正規化する（UX③・純粋）。
 *
 * Product Catalogue（商品カタログ）の画像 URL は 2 形態が混在する:
 *   - wsrv.nl ラップ: `https://wsrv.nl/?url=<r2.dev を urlencode>&w=2000&…`
 *   - 直 r2.dev:      `https://pub-xxxx.r2.dev/cdn/…jpg`
 * LINE Flex の hero は公開到達な HTTPS 画像を要求する。安定性のため wsrv.nl ラップは
 * `?url=` を decode して直 r2.dev を採用し、素の直 URL はそのまま使う。
 *
 * @returns 正規化済み HTTPS URL。空 / http 化不能 / 非 URL は null（＝hero を出さず graceful）。
 */
export function preferDirectR2(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url = raw.trim();
  if (!url) return null;
  // wsrv.nl ラップなら ?url=<encoded> を剥がして直リンクを優先する。
  if (/(^|\/\/|\.)wsrv\.nl\//i.test(url)) {
    const m = url.match(/[?&]url=([^&]+)/);
    if (m) {
      try {
        const decoded = decodeURIComponent(m[1]).trim();
        if (decoded) url = decoded;
      } catch {
        /* 壊れた encoding は元 URL のまま扱う（fail-safe） */
      }
    }
  }
  if (url.startsWith("http://")) url = "https://" + url.slice("http://".length);
  return url.startsWith("https://") ? url : null;
}

/**
 * お茶レコメンドカード（UX③・写真つき or 写真なし graceful）。
 *
 * 構成: hero（画像あり時のみ）+ `名前（No.XXXXX）`（呼び出し側で formatTeaLabel 済）+ 抜粋 + 「見る」ボタン。
 * `imageUrl` 省略時は hero を出さず、崩れないテキスト調カードになる（現況の主経路）。
 * `matchReason` 指定時のみ本文末尾に理由 1 行を添える（診断/次の一杯の一貫性）。
 */
export function teaRecommendCard(params: {
  /** 表示名（既に `名前（No.XXXXX）` に整形済み）。 */
  name: string;
  /** 短い説明（味わい抜粋）。 */
  description: string;
  /** 正規化済み HTTPS 画像 URL（preferDirectR2 の戻り）。省略で hero なし。 */
  imageUrl?: string;
  /** 「見る」ボタンの遷移先（web）。 */
  productUrl: string;
  /** マッチ理由 1 行（任意）。 */
  matchReason?: string;
}): Record<string, unknown> {
  const bodyContents: Record<string, unknown>[] = [
    {
      type: "text",
      text: params.name,
      weight: "bold",
      size: "lg",
      color: COLORS.charcoal,
      wrap: true,
    },
  ];
  if (params.description.trim()) {
    bodyContents.push({
      type: "text",
      text: params.description.trim(),
      size: "sm",
      color: COLORS.muted,
      wrap: true,
      maxLines: 3,
      margin: "md",
    });
  }
  if (params.matchReason && params.matchReason.trim()) {
    bodyContents.push({
      type: "text",
      text: params.matchReason.trim(),
      size: "xs",
      color: COLORS.muted,
      wrap: true,
      margin: "md",
      style: "italic",
    });
  }
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
      contents: bodyContents,
    },
    footer: {
      type: "box",
      layout: "vertical",
      spacing: "sm",
      backgroundColor: COLORS.cream,
      contents: [
        {
          type: "button",
          action: { type: "uri", label: "見る", uri: params.productUrl },
          style: "primary",
          color: COLORS.charcoal,
          height: "sm",
        },
      ],
    },
  };
}

/**
 * お茶レコメンドカルーセル（UX③・最大 10・診断結果は最大 3 件で呼ぶ）。
 * 各 bubble は teaRecommendCard と同一構成（写真あり/なし graceful を各カードで踏襲）。
 * carousel は全 bubble が同一 size である必要があり、teaRecommendCard は常に "mega" のため整合する。
 */
export function teaRecommendCarousel(
  items: Array<{
    name: string;
    description: string;
    imageUrl?: string;
    productUrl: string;
    matchReason?: string;
  }>,
): Record<string, unknown> {
  return {
    type: "carousel",
    contents: items.slice(0, 10).map((t) => teaRecommendCard(t)),
  };
}
