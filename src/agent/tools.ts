import type Anthropic from "@anthropic-ai/sdk";

/**
 * エージェントが使用できるツール定義。
 *
 * - escalate_to_human: オペレーターへのエスカレーション
 * - lookup_my_orders: 顧客の注文履歴照会（LINE↔Shopify紐付け）
 * - get_order_detail: 注文番号による注文詳細照会
 */

/** エスカレーションツール（MS2 2.4） */
const ESCALATION_TOOL: Anthropic.Tool = {
  name: "escalate_to_human",
  description:
    "人間のオペレーターにエスカレーションします。以下の場合に使用: (1)ナレッジに該当情報がない (2)クレーム・返品・返金 (3)顧客が人間対応を要求 (4)健康被害・安全性の訴え (5)個人情報の詳細確認が必要 (6)注文トラブル (7)回答に自信がない場合",
  input_schema: {
    type: "object" as const,
    properties: {
      reason: {
        type: "string",
        description:
          "エスカレーションの理由。オペレーターが状況を把握できるよう具体的に記述。",
      },
      category: {
        type: "string",
        enum: [
          "knowledge_gap",
          "complaint",
          "human_request",
          "health_safety",
          "personal_info",
          "order_trouble",
          "uncertain",
        ],
        description:
          "エスカレーション分類: knowledge_gap=ナレッジ不足, complaint=クレーム・返品, human_request=人間対応要求, health_safety=健康・安全, personal_info=個人情報確認, order_trouble=注文トラブル, uncertain=自信がない",
      },
      summary: {
        type: "string",
        description:
          "これまでの会話の要約。顧客の要望・対応済み内容・未解決事項を含める。",
      },
    },
    required: ["reason", "category", "summary"],
  },
};

/** 注文履歴照会ツール（MS6 6.2） */
const LOOKUP_ORDERS_TOOL: Anthropic.Tool = {
  name: "lookup_my_orders",
  description:
    "このお客様のLINEアカウントに紐付いた注文履歴を取得します。「注文状況は？」「配送どうなってる？」などの問い合わせに使用。入力不要。",
  input_schema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
};

/** 注文詳細照会ツール（MS6 6.3） */
const ORDER_DETAIL_TOOL: Anthropic.Tool = {
  name: "get_order_detail",
  description:
    "お客様ご自身の注文番号を指定して、その注文（本人の注文のみ）の詳細情報（商品一覧、配送状況、追跡番号）を取得します。アカウント連携済みの本人の注文だけが対象で、他人の注文や未連携ユーザーの照会はできません（その場合は連携をご案内します）。",
  input_schema: {
    type: "object" as const,
    properties: {
      order_number: {
        type: "string",
        description: "お客様ご自身の注文番号（例: '1234' または '#1234'）",
      },
    },
    required: ["order_number"],
  },
};

/** 商品カード送信ツール（MS5 5.1/5.4） */
const RECOMMEND_PRODUCT_TOOL: Anthropic.Tool = {
  name: "recommend_product",
  description:
    "商品を視覚的なカードで提案します。商品名、説明、価格、商品URLを指定すると、LINEでリッチな商品カードが表示されます。複数商品を一度に提案する場合は products 配列に複数指定してください（最大3件）。",
  input_schema: {
    type: "object" as const,
    properties: {
      products: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "商品名",
            },
            description: {
              type: "string",
              description: "商品の特徴を1-2文で",
            },
            price: {
              type: "string",
              description: "価格（例: '¥1,980'）",
            },
            product_url: {
              type: "string",
              description:
                "商品ページURL（elxea.com のURL。不明な場合は https://elxea.com/ja/products を使用）",
            },
          },
          required: ["name", "description", "price", "product_url"],
        },
        description: "提案する商品のリスト（1-3件）",
      },
    },
    required: ["products"],
  },
};

/** カートリンク生成ツール */
const CREATE_CART_LINK_TOOL: Anthropic.Tool = {
  name: "create_cart_link",
  description:
    "お客様が購入したい商品のカートリンク（チェックアウトURL）を生成します。「この商品を買いたい」「カートに入れたい」「購入したい」という意思表示があった場合に使用。商品のバリアントIDと数量を指定してください。バリアントIDはナレッジベースの商品情報から取得してください。",
  input_schema: {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            variant_id: {
              type: "string",
              description:
                "Shopify の商品バリアント ID（数値文字列 or GID 形式 'gid://shopify/ProductVariant/xxx'）",
            },
            quantity: {
              type: "number",
              description: "数量（デフォルト: 1）",
              minimum: 1,
              maximum: 10,
            },
          },
          required: ["variant_id"],
        },
        description: "カートに追加する商品リスト（1-5件）",
      },
    },
    required: ["items"],
  },
};

/** 配信 opt-out ツール（UX レビュー指摘 #3・migration 020 の入口） */
const SET_BROADCAST_OPTOUT_TOOL: Anthropic.Tool = {
  name: "set_broadcast_optout",
  description:
    "LINE のお知らせ配信（一斉配信・おすすめ配信）の受け取りを、停止または再開します。" +
    "お客様が『配信を止めてほしい』『配信はもういらない』『配信を再開したい』のように" +
    "配信の停止・再開を明確に希望されたときにだけ使用してください。連携（アカウント紐付け）の有無に関わらず有効です。" +
    "【誤作動ガード】次の場合は絶対に呼ばないでください: 『配信って何？』『どんな配信が来るの？』など" +
    "配信についての質問、頻度だけの相談、停止/再開の意思が曖昧な発言。これらは道具を使わず言葉で説明・確認します。",
  input_schema: {
    type: "object" as const,
    properties: {
      opt_out: {
        type: "boolean",
        description:
          "true=配信を停止する / false=配信を再開する。お客様の明確な意思にのみ厳密に一致させる。",
      },
    },
    required: ["opt_out"],
  },
};

/** 全ツールをエクスポート */
export const AGENT_TOOLS: Anthropic.Tool[] = [
  ESCALATION_TOOL,
  LOOKUP_ORDERS_TOOL,
  ORDER_DETAIL_TOOL,
  RECOMMEND_PRODUCT_TOOL,
  CREATE_CART_LINK_TOOL,
  // SET_BROADCAST_OPTOUT_TOOL: opt-out 機能は当面廃止（配信停止は LINE 標準ブロックに委譲・
  //   2026-07-13 オーナー方針）。AI が「配信を止めた」と偽の約束をしないよう、AI へのツール露出を停止。
  //   定義（SET_BROADCAST_OPTOUT_TOOL）・実体（broadcast-optout.ts）・core.ts ハンドラ・migration 020 は
  //   将来の再導入用に温存（眠らせるのみ・削除しない）。
];

/** 後方互換のため旧名もエクスポート */
export const ESCALATION_TOOLS = AGENT_TOOLS;
