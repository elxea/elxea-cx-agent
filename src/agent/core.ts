import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../index";
import {
  createSupabaseClient,
  searchKnowledgeHybrid,
  logUnansweredQuery,
  type Channel,
  type KnowledgeChunk,
} from "../lib/supabase";
import { classifyQuery } from "../lib/query-classifier";
import { lookupMyOrders, getOrderDetail, createCartLink, type OrderDetailResult, type CartLinkResult } from "../lib/shopify";
import {
  getCustomerProfile,
  addBehaviorEvent,
  getFirestoreEnv,
  type CustomerProfile,
  type BehaviorEvent,
  type BehaviorChannel,
} from "../lib/firestore";
import { productCard, productCarousel, orderCard } from "../lib/flex-templates";
import { SYSTEM_PROMPT, buildPersonaPromptFragment } from "./system-prompt";
import { AGENT_TOOLS } from "./tools";
import { withTimeout } from "../lib/utils";
import { recordEscalation } from "../lib/alerts";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type AgentResult = {
  response: string;
  escalated: boolean;
  escalationReason?: string;
  escalationCategory?: string;
  /** Flex Message（商品カード等）。存在する場合はテキストとは別に LINE 送信する */
  flexMessages?: Array<{
    altText: string;
    contents: Record<string, unknown>;
  }>;
  /** チャネル非依存の商品カードデータ（Web チャット等で使用） */
  productCards?: Array<{
    name: string;
    description: string;
    price: string;
    imageUrl?: string;
    productUrl: string;
  }>;
  /** カートリンク（チェックアウトURL） */
  cartLink?: { checkoutUrl: string };
  /** Quick Reply ボタン（テキストメッセージに付与） */
  quickReplies?: Array<{ label: string; text: string }>;
};

/**
 * ストリーミング用コールバック型。
 * runAgentStreaming() が Claude API のストリーミングレスポンスを
 * リアルタイムでクライアントに転送するために使用する。
 */
export type StreamCallbacks = {
  /** テキストチャンク到着時（Claude API の content_block_delta） */
  onTextDelta: (text: string) => void;
  /** 商品カード送信時 */
  onProductCards: (products: Array<{ name: string; price: string; url: string; image: string | null; description: string }>) => void;
  /** カートリンク送信時 */
  onCartLink: (checkoutUrl: string) => void;
  /** クイックリプライ送信時 */
  onQuickReplies: (items: Array<{ label: string; text: string }>) => void;
  /** 完了時（fullResponse = 保存用の全テキスト） */
  onDone: (fullResponse: string) => void;
  /** エラー時 */
  onError: (error: string) => void;
};

/** runAgentStreaming の戻り値（保存に必要なメタデータ） */
export type StreamingAgentMeta = {
  escalated: boolean;
  escalationReason?: string;
  escalationCategory?: string;
  flexMessages: Array<{ altText: string; contents: Record<string, unknown> }>;
  productCards: Array<{ name: string; description: string; price: string; imageUrl?: string; productUrl: string }>;
  cartLink?: { checkoutUrl: string };
  quickReplies: Array<{ label: string; text: string }>;
};

/** ナレッジ不足と判定する類似度しきい値 */
const LOW_SIMILARITY_THRESHOLD = 0.4;

/** ツールループの最大回数（無限ループ防止） */
const MAX_TOOL_TURNS = 3;

/** タイムアウト設定（ミリ秒） */
const TIMEOUT_CUSTOMER_LINKAGE_MS = 5_000;
const TIMEOUT_CUSTOMER_PROFILE_MS = 5_000;
const TIMEOUT_KNOWLEDGE_SEARCH_MS = 12_000;
const TIMEOUT_LLM_CALL_MS = 18_000;

/** ハイブリッド検索のデフォルト件数 */
const KNOWLEDGE_SEARCH_TOP_K = 3;
/** ハイブリッド検索の類似度しきい値 */
const KNOWLEDGE_SEARCH_THRESHOLD = 0.4;

/** ツール実行結果（テキスト + オプションのメタデータ） */
type ToolExecResult = {
  text: string;
  orderDetail?: OrderDetailResult;
  cartLink?: CartLinkResult;
};

/**
 * エージェントのメインループ。
 *
 * 1. ハイブリッド検索（ベクトル + キーワード）で関連ナレッジを取得
 * 2. Claude を呼び出し（ツール使用があればループ）
 * 3. エスカレーション・ナレッジ不足検知
 */
export async function runAgent(
  userMessage: string,
  conversationHistory: Message[],
  embedding: number[],
  userId: string,
  channel: Channel,
  env: Env,
  options?: {
    isLinked?: boolean;
    imageContent?: { base64: string; mediaType: "image/jpeg" | "image/png" };
  },
): Promise<AgentResult> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const supabase = createSupabaseClient(env);
  const t0 = Date.now();

  // クエリカテゴリ判定（同期処理、高速）
  const sourceTypeFilter = classifyQuery(userMessage);
  console.log(`Query classified as: ${sourceTypeFilter ?? "null (no filter)"}`);

  // Firestore env を一度だけ取得してキャッシュ（複数箇所で使用）
  let fsEnv: ReturnType<typeof getFirestoreEnv> | null = null;
  try {
    fsEnv = getFirestoreEnv(env);
  } catch {
    // Firebase 未設定の場合はスキップ
  }

  // --- 並列フェーズ: 顧客プロファイル取得 + ハイブリッド検索を同時実行 ---
  // 以前は直列だった2つの重い I/O を並列化し、初回トークンまでの時間を短縮する。
  console.log("[agent] step=parallel-fetch (profile + search)");

  // (A) 顧客プロファイル取得
  const profilePromise = (async (): Promise<{
    customerProfile: CustomerProfile | null;
    firestoreCustomerId: string | null;
  }> => {
    let customerProfile: CustomerProfile | null = null;
    let firestoreCustomerId: string | null = null;
    try {
      if (!fsEnv) return { customerProfile: null, firestoreCustomerId: null };
      const linkageQuery = channel === "line"
        ? supabase.from("customer_linkages").select("shopify_customer_id").eq("line_user_id", userId).single()
        : supabase.from("customer_linkages").select("shopify_customer_id").eq("shopify_customer_id", userId).single();
      const { data: linkage } = await withTimeout(
        Promise.resolve(linkageQuery),
        TIMEOUT_CUSTOMER_LINKAGE_MS,
        "customer_linkages query",
      );
      if (linkage?.shopify_customer_id) {
        firestoreCustomerId = String(linkage.shopify_customer_id);
        customerProfile = await withTimeout(
          getCustomerProfile(firestoreCustomerId, fsEnv),
          TIMEOUT_CUSTOMER_PROFILE_MS,
          "getCustomerProfile",
        );
      }
    } catch (err) {
      console.warn("[agent] customer profile skipped:", err instanceof Error ? err.message : err);
    }
    return { customerProfile, firestoreCustomerId };
  })();

  // (B) ハイブリッド検索（ベクトル + キーワード + メタデータフィルタ）
  // タイムアウトしても LLM が一般知識で応答できるよう、エラー時は空配列で続行する
  const searchPromise = withTimeout(
    searchKnowledgeHybrid(
      supabase,
      embedding,
      userMessage,
      KNOWLEDGE_SEARCH_TOP_K,
      KNOWLEDGE_SEARCH_THRESHOLD,
      sourceTypeFilter,
    ),
    TIMEOUT_KNOWLEDGE_SEARCH_MS,
    "searchKnowledgeHybrid",
  ).catch((err) => {
    console.warn("[agent] knowledge search failed/timed out, continuing without RAG:", err instanceof Error ? err.message : err);
    return [] as KnowledgeChunk[];
  });

  // 並列待機
  const [profileResult, knowledgeResults] = await Promise.all([
    profilePromise,
    searchPromise,
  ]);

  const { customerProfile, firestoreCustomerId } = profileResult;
  console.log(`[agent] step=parallel-fetch done, search_results=${knowledgeResults.length}, has_profile=${!!customerProfile}, elapsed=${Date.now() - t0}ms`);

  // Firestore に behavior event を記録（fire-and-forget: レスポンスをブロックしない）
  if (firestoreCustomerId && fsEnv) {
    try {
      const messageEvent: BehaviorEvent = {
        action: "line_message",
        channel,
        metadata: { query: userMessage },
        personaSignal: null,
        createdAt: new Date().toISOString(),
      };
      addBehaviorEvent(firestoreCustomerId, messageEvent, fsEnv).catch((err) => {
        console.warn("[agent] addBehaviorEvent (message) failed:", err instanceof Error ? err.message : err);
      });

      const signalEvents = extractConversationSignals(userMessage, channel);
      for (const event of signalEvents) {
        addBehaviorEvent(firestoreCustomerId, event, fsEnv).catch((err) => {
          console.warn("[agent] addBehaviorEvent (signal) failed:", err instanceof Error ? err.message : err);
        });
      }
    } catch (err) {
      console.warn("[agent] behavior event recording skipped:", err instanceof Error ? err.message : err);
    }
  }

  // ナレッジ不足検知（MS7 7.6）
  const maxSimilarity =
    knowledgeResults.length > 0
      ? Math.max(...knowledgeResults.map((r) => r.similarity))
      : 0;
  const isLowKnowledge =
    knowledgeResults.length === 0 || maxSimilarity < LOW_SIMILARITY_THRESHOLD;

  // 検索結果をコンテキストに組み立て
  let knowledgeContext: string;
  if (knowledgeResults.length > 0) {
    const items = knowledgeResults
      .map(
        (r, i) =>
          `### 検索結果 ${i + 1}（${r.source_type} | 類似度: ${(r.similarity * 100).toFixed(0)}%）\n**${r.source_title}**\n${r.content}`,
      )
      .join("\n\n");
    knowledgeContext = `\n\n## 検索結果（ナレッジベース）\n以下の ${knowledgeResults.length} 件が見つかりました。この情報のみに基づいて回答してください。\n\n${items}`;
  } else {
    knowledgeContext = `\n\n## 検索結果（ナレッジベース）\n該当する情報が見つかりませんでした。\n\n**対応方針**: まずは商品名やブランド名から推測できる一般的な情報で回答を試みてください。具体的な価格・在庫・成分などの正確な情報が必要な場合のみ、「詳しい情報を確認してお返事しますね」と伝えてください。お客様を待たせる回答は最小限にしてください。`;
  }

  // 顧客プロファイルコンテキスト（Firestore から取得済みの場合）
  // ペルソナ fragment を動的注入 (MS5 5.3)
  const isLinked = options?.isLinked ?? false;
  const personaPrimary = customerProfile?.persona?.primary ?? null;
  const personaFragment = buildPersonaPromptFragment(personaPrimary);

  // customerContext: 顧客固有データ（personaFragment は第1ブロックでキャッシュするため除外）
  let customerContext = "";
  if (customerProfile) {
    const parts: string[] = [];

    // 紐付け済みフラグ: Agent にリピーター向け対応を促す
    if (isLinked) {
      parts.push("紐付け状態: LINE・Web アカウント連携済み（リピーターとして対応）");
    }

    if (customerProfile.displayName) {
      parts.push(`顧客名: ${customerProfile.displayName}`);
    }
    if (customerProfile.membershipTier && customerProfile.membershipTier !== "none") {
      parts.push(`会員ランク: ${customerProfile.membershipTier}`);
    }
    if (customerProfile.depthLevel) {
      parts.push(`茶の経験レベル: ${customerProfile.depthLevel}`);
    }

    // TasteProfile: 紐付け済み顧客の嗜好データを詳細に注入
    if (customerProfile.tasteProfile) {
      const tp = customerProfile.tasteProfile;
      if (tp.preferredCategories?.length) {
        parts.push(`好みのカテゴリ: ${tp.preferredCategories.join(", ")}`);
      }
      if (tp.flavorPreferences?.length) {
        parts.push(`好みのフレーバー: ${tp.flavorPreferences.join(", ")}`);
      }
      if (tp.scenePref) {
        parts.push(`好みのシーン: ${tp.scenePref}`);
      }
    }

    // PersonaProfile: スコア詳細も注入（紐付け済みの場合のみ）
    if (isLinked && customerProfile.persona) {
      const ps = customerProfile.persona;
      if (ps.scores) {
        parts.push(
          `ペルソナスコア: serenity=${ps.scores.serenity}, explorer=${ps.scores.explorer}, sensory=${ps.scores.sensory}`,
        );
      }
      if (ps.lastUpdated) {
        parts.push(`ペルソナ最終更新: ${ps.lastUpdated}`);
      }
    }

    if (parts.length > 0) {
      customerContext = `\n\n## 顧客データ\n${parts.join("\n")}`;
      if (isLinked) {
        customerContext += "\n\n**注意**: この顧客はアカウント連携済みです。過去の好みや購入履歴を踏まえたパーソナライズされた提案をしてください。名前で呼びかけ、以前の会話内容を自然に参照してください。\n\n**プロファイル活用ルール**:\n- 好みのカテゴリやフレーバーが記録されている場合、「前回、〇〇がお好みとのことでしたね」のように自然に参照する\n- プロファイルが空の場合は無理に参照せず、通常通り対応する\n- 好みの情報は押し付けではなく、提案の精度向上に使う";
      }
    }
  } else if (isLinked) {
    // 紐付け済みだが Firestore プロファイルが未作成のケース
    customerContext = "\n\n## 顧客データ\n紐付け状態: LINE・Web アカウント連携済み（プロファイル未作成）\n\n**注意**: この顧客はアカウント連携済みですが、詳細プロファイルはまだありません。会話の中から好みを自然に探り、リピーターとして丁寧に対応してください。";
  }

  // 入力言語検出: 英語など非日本語の場合、応答言語を強制するリマインダーを生成
  const languageReminder = detectLanguageReminder(userMessage);

  // 会話履歴を Claude のメッセージ形式に変換
  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  ];

  // 画像付きメッセージの場合、multimodal content を構築
  if (options?.imageContent) {
    const contentParts: Anthropic.ContentBlockParam[] = [
      {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: options.imageContent.mediaType,
          data: options.imageContent.base64,
        },
      },
    ];
    if (userMessage) {
      contentParts.push({ type: "text" as const, text: userMessage });
    } else {
      contentParts.push({
        type: "text" as const,
        text: "この画像について教えてください。お茶のパッケージや茶葉の写真であれば、商品の識別や種類の推定をしてください。",
      });
    }
    messages.push({ role: "user", content: contentParts });
  } else {
    messages.push({ role: "user", content: userMessage });
  }

  let escalated = false;
  let escalationReason: string | undefined;
  let escalationCategory: string | undefined;
  const flexMessages: Array<{ altText: string; contents: Record<string, unknown> }> = [];
  const productCards: Array<{ name: string; description: string; price: string; imageUrl?: string; productUrl: string }> = [];
  let cartLink: { checkoutUrl: string } | undefined;
  const usedTools: string[] = [];

  // マルチターンのツールループ
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const tLlm = Date.now();
    console.log(`[agent] step=anthropic turn=${turn}, total_elapsed=${tLlm - t0}ms`);
    const response = await withTimeout(
      client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        system: [
          {
            type: "text" as const,
            text: SYSTEM_PROMPT + personaFragment,
            cache_control: { type: "ephemeral" as const },
          },
          {
            type: "text" as const,
            text: languageReminder + customerContext + knowledgeContext,
          },
        ],
        tools: AGENT_TOOLS.map((tool, i) =>
          i === AGENT_TOOLS.length - 1
            ? { ...tool, cache_control: { type: "ephemeral" as const } }
            : tool,
        ),
        messages,
      }),
      TIMEOUT_LLM_CALL_MS,
      `anthropic.messages.create turn=${turn}`,
    );
    console.log(`[agent] step=anthropic turn=${turn} done, llm_elapsed=${Date.now() - tLlm}ms, total_elapsed=${Date.now() - t0}ms`);
    console.log(JSON.stringify({
      type: "usage",
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: (response.usage as any).cache_creation_input_tokens || 0,
      cache_read_input_tokens: (response.usage as any).cache_read_input_tokens || 0,
    }));

    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // ツール呼び出しがなければ最終応答
    if (toolUseBlocks.length === 0) {
      const finalText = textBlocks.map((b) => b.text).join("");

      // ナレッジ不足を記録
      if (isLowKnowledge) {
        logUnansweredQuery(supabase, {
          userId,
          channel,
          queryText: userMessage,
          maxSimilarity,
          resultCount: knowledgeResults.length,
          escalated,
        }).catch(console.error);
      }

      const quickReplies = generateQuickReplies(usedTools, escalated);

      return {
        response: finalText || "申し訳ありません、お返事の生成に失敗しました。",
        escalated,
        escalationReason,
        escalationCategory,
        ...(flexMessages.length > 0 ? { flexMessages } : {}),
        ...(productCards.length > 0 ? { productCards } : {}),
        ...(cartLink ? { cartLink } : {}),
        ...(quickReplies.length > 0 ? { quickReplies } : {}),
      };
    }

    // ツールを実行
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const execResult = await executeTool(toolUse, userId, channel, env);
      usedTools.push(toolUse.name);

      // 注文確認カード Flex Message 追跡
      if (toolUse.name === "get_order_detail" && execResult.orderDetail?.data) {
        const od = execResult.orderDetail.data;
        flexMessages.push({
          altText: `注文 ${od.orderName} の詳細`,
          contents: orderCard(od),
        });
      }

      // 商品カード追跡（Flex Message + チャネル非依存 productCards）
      if (toolUse.name === "recommend_product") {
        const input = toolUse.input as {
          products: Array<{
            name: string;
            description: string;
            price: string;
            product_url: string;
          }>;
        };
        const products = input.products.map((p) => ({
          name: p.name,
          description: p.description,
          price: p.price,
          productUrl: p.product_url,
        }));

        // チャネル非依存の商品カードデータを常に追加
        for (const p of products) {
          productCards.push({
            name: p.name,
            description: p.description,
            price: p.price,
            productUrl: p.productUrl,
          });
        }

        // LINE 用の Flex Message も生成（LINE チャネルで使用）
        if (products.length === 1) {
          flexMessages.push({
            altText: `商品のご案内: ${products[0].name}`,
            contents: productCard(products[0]),
          });
        } else if (products.length > 1) {
          flexMessages.push({
            altText: `${products.length}件の商品のご案内`,
            contents: productCarousel(products),
          });
        }
      }

      // カートリンク追跡
      if (toolUse.name === "create_cart_link" && execResult.cartLink?.checkoutUrl) {
        cartLink = { checkoutUrl: execResult.cartLink.checkoutUrl };

        // LINE 用: カート Flex Message（購入ボタン付き）
        flexMessages.push({
          altText: "カートを作成しました",
          contents: {
            type: "bubble",
            size: "mega",
            body: {
              type: "box",
              layout: "vertical",
              spacing: "md",
              backgroundColor: "#FFFEF2",
              contents: [
                {
                  type: "text",
                  text: "カートを作成しました",
                  weight: "bold",
                  size: "lg",
                  color: "#333333",
                },
                {
                  type: "text",
                  text: "下のボタンからお会計に進めます",
                  size: "sm",
                  color: "#666666",
                  wrap: true,
                },
              ],
            },
            footer: {
              type: "box",
              layout: "vertical",
              spacing: "sm",
              backgroundColor: "#FFFEF2",
              contents: [
                {
                  type: "button",
                  action: {
                    type: "uri",
                    label: "購入手続きへ",
                    uri: execResult.cartLink.checkoutUrl,
                  },
                  style: "primary",
                  color: "#333333",
                  height: "sm",
                },
              ],
            },
          },
        });
      }

      // エスカレーション追跡
      if (toolUse.name === "escalate_to_human") {
        escalated = true;
        // アラート: エスカレーション急増検知
        recordEscalation(env);
        const input = toolUse.input as {
          reason: string;
          category: string;
          summary: string;
        };
        escalationReason = input.reason;
        escalationCategory = input.category;
        await notifySlack(
          userId,
          channel,
          input.reason,
          input.category,
          input.summary,
          env,
        );
      }

      toolResults.push({
        type: "tool_result" as const,
        tool_use_id: toolUse.id,
        content: execResult.text,
      });
    }

    // ツール結果をメッセージに追加してループ
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  // ループ上限に達した場合のフォールバック
  if (isLowKnowledge) {
    logUnansweredQuery(supabase, {
      userId,
      channel,
      queryText: userMessage,
      maxSimilarity,
      resultCount: knowledgeResults.length,
      escalated,
    }).catch(console.error);
  }

  // ツールループ上限到達: 商品カードなど途中成果があればそれを返す
  // 何もない場合は一般的な応答で繋ぐ（「少しお待ちください」だけで終わらない）
  const fallbackResponse = productCards.length > 0
    ? "こちらの商品情報をご参考になさってください。他にもご質問がございましたら、お気軽にどうぞ。"
    : "申し訳ございません、ただいま情報の取得に少しお時間をいただいております。具体的なご質問をいただければ、改めてお調べいたしますね。";

  return {
    response: fallbackResponse,
    escalated,
    escalationReason,
    escalationCategory,
    ...(flexMessages.length > 0 ? { flexMessages } : {}),
    ...(productCards.length > 0 ? { productCards } : {}),
    ...(cartLink ? { cartLink } : {}),
  };
}

/**
 * エージェントのストリーミング版メインループ。
 *
 * runAgent() と同じ前処理（プロファイル取得・ハイブリッド検索）を行った後、
 * Claude API のストリーミングレスポンスをリアルタイムでコールバック経由で
 * クライアントに転送する。
 *
 * - 初回ターンは非ストリーミングで実行（ツール呼び出しの有無を確認）
 * - ツール使用後の最終ターンはストリーミング API を使用
 */
export async function runAgentStreaming(
  userMessage: string,
  conversationHistory: Message[],
  embedding: number[],
  userId: string,
  channel: Channel,
  env: Env,
  callbacks: StreamCallbacks,
  options?: {
    isLinked?: boolean;
    imageContent?: { base64: string; mediaType: "image/jpeg" | "image/png" };
  },
): Promise<StreamingAgentMeta> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const supabase = createSupabaseClient(env);
  const t0 = Date.now();

  const sourceTypeFilter = classifyQuery(userMessage);

  let fsEnv: ReturnType<typeof getFirestoreEnv> | null = null;
  try { fsEnv = getFirestoreEnv(env); } catch { /* Firebase 未設定 */ }

  // --- 並列フェーズ: 顧客プロファイル取得 + ハイブリッド検索 ---
  console.log("[agent-stream] step=parallel-fetch");

  const profilePromise = (async (): Promise<{
    customerProfile: CustomerProfile | null;
    firestoreCustomerId: string | null;
  }> => {
    let customerProfile: CustomerProfile | null = null;
    let firestoreCustomerId: string | null = null;
    try {
      if (!fsEnv) return { customerProfile: null, firestoreCustomerId: null };
      const linkageQuery = channel === "line"
        ? supabase.from("customer_linkages").select("shopify_customer_id").eq("line_user_id", userId).single()
        : supabase.from("customer_linkages").select("shopify_customer_id").eq("shopify_customer_id", userId).single();
      const { data: linkage } = await withTimeout(
        Promise.resolve(linkageQuery), TIMEOUT_CUSTOMER_LINKAGE_MS, "customer_linkages query",
      );
      if (linkage?.shopify_customer_id) {
        firestoreCustomerId = String(linkage.shopify_customer_id);
        customerProfile = await withTimeout(
          getCustomerProfile(firestoreCustomerId, fsEnv), TIMEOUT_CUSTOMER_PROFILE_MS, "getCustomerProfile",
        );
      }
    } catch (err) {
      console.warn("[agent-stream] customer profile skipped:", err instanceof Error ? err.message : err);
    }
    return { customerProfile, firestoreCustomerId };
  })();

  const searchPromise = withTimeout(
    searchKnowledgeHybrid(supabase, embedding, userMessage, KNOWLEDGE_SEARCH_TOP_K, KNOWLEDGE_SEARCH_THRESHOLD, sourceTypeFilter),
    TIMEOUT_KNOWLEDGE_SEARCH_MS, "searchKnowledgeHybrid",
  ).catch((err) => {
    console.warn("[agent-stream] knowledge search failed:", err instanceof Error ? err.message : err);
    return [] as KnowledgeChunk[];
  });

  const [profileResult, knowledgeResults] = await Promise.all([profilePromise, searchPromise]);
  const { customerProfile, firestoreCustomerId } = profileResult;
  console.log(`[agent-stream] step=parallel-fetch done, search=${knowledgeResults.length}, elapsed=${Date.now() - t0}ms`);

  // Behavior event 記録（fire-and-forget）
  if (firestoreCustomerId && fsEnv) {
    try {
      addBehaviorEvent(firestoreCustomerId, {
        action: "line_message", channel, metadata: { query: userMessage },
        personaSignal: null, createdAt: new Date().toISOString(),
      }, fsEnv).catch(() => {});
      for (const ev of extractConversationSignals(userMessage, channel)) {
        addBehaviorEvent(firestoreCustomerId, ev, fsEnv).catch(() => {});
      }
    } catch { /* skip */ }
  }

  // ナレッジコンテキスト構築
  const maxSimilarity = knowledgeResults.length > 0 ? Math.max(...knowledgeResults.map((r) => r.similarity)) : 0;
  const isLowKnowledge = knowledgeResults.length === 0 || maxSimilarity < LOW_SIMILARITY_THRESHOLD;

  let knowledgeContext: string;
  if (knowledgeResults.length > 0) {
    const items = knowledgeResults
      .map((r, i) => `### 検索結果 ${i + 1}（${r.source_type} | 類似度: ${(r.similarity * 100).toFixed(0)}%）\n**${r.source_title}**\n${r.content}`)
      .join("\n\n");
    knowledgeContext = `\n\n## 検索結果（ナレッジベース）\n以下の ${knowledgeResults.length} 件が見つかりました。この情報のみに基づいて回答してください。\n\n${items}`;
  } else {
    knowledgeContext = `\n\n## 検索結果（ナレッジベース）\n該当する情報が見つかりませんでした。\n\n**対応方針**: まずは商品名やブランド名から推測できる一般的な情報で回答を試みてください。具体的な価格・在庫・成分などの正確な情報が必要な場合のみ、「詳しい情報を確認してお返事しますね」と伝えてください。お客様を待たせる回答は最小限にしてください。`;
  }

  const isLinked = options?.isLinked ?? false;
  const personaPrimary = customerProfile?.persona?.primary ?? null;
  const personaFragment = buildPersonaPromptFragment(personaPrimary);
  const customerContext = buildCustomerContext(customerProfile, isLinked);
  const languageReminder = detectLanguageReminder(userMessage);

  // メッセージ構築
  const messages: Anthropic.MessageParam[] = [
    ...conversationHistory.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];
  if (options?.imageContent) {
    messages.push({ role: "user", content: [
      { type: "image" as const, source: { type: "base64" as const, media_type: options.imageContent.mediaType, data: options.imageContent.base64 } },
      { type: "text" as const, text: userMessage || "この画像について教えてください。お茶のパッケージや茶葉の写真であれば、商品の識別や種類の推定をしてください。" },
    ] });
  } else {
    messages.push({ role: "user", content: userMessage });
  }

  let escalated = false;
  let escalationReason: string | undefined;
  let escalationCategory: string | undefined;
  const flexMessages: Array<{ altText: string; contents: Record<string, unknown> }> = [];
  const productCards: Array<{ name: string; description: string; price: string; imageUrl?: string; productUrl: string }> = [];
  let cartLink: { checkoutUrl: string } | undefined;
  const usedTools: string[] = [];
  /** ツール使用ターンで生成されたテキストを蓄積（最終応答に含める） */
  let accumulatedText = "";

  const apiParams = {
    model: "claude-haiku-4-5-20251001" as const,
    max_tokens: 1024,
    system: [
      { type: "text" as const, text: SYSTEM_PROMPT + personaFragment, cache_control: { type: "ephemeral" as const } },
      { type: "text" as const, text: languageReminder + customerContext + knowledgeContext },
    ],
    tools: AGENT_TOOLS.map((tool, i) =>
      i === AGENT_TOOLS.length - 1 ? { ...tool, cache_control: { type: "ephemeral" as const } } : tool,
    ),
  };

  /** ツール結果の共通後処理 */
  const handleToolResult = (toolUse: Anthropic.ToolUseBlock, execResult: ToolExecResult) => {
    if (toolUse.name === "get_order_detail" && execResult.orderDetail?.data) {
      const od = execResult.orderDetail.data;
      flexMessages.push({ altText: `注文 ${od.orderName} の詳細`, contents: orderCard(od) });
    }
    if (toolUse.name === "recommend_product") {
      const input = toolUse.input as { products: Array<{ name: string; description: string; price: string; product_url: string }> };
      const products = input.products.map((p) => ({ name: p.name, description: p.description, price: p.price, productUrl: p.product_url }));
      for (const p of products) productCards.push(p);
      if (products.length === 1) flexMessages.push({ altText: `商品のご案内: ${products[0].name}`, contents: productCard(products[0]) });
      else if (products.length > 1) flexMessages.push({ altText: `${products.length}件の商品のご案内`, contents: productCarousel(products) });
      callbacks.onProductCards(products.map((p) => ({ name: p.name, price: p.price, url: p.productUrl, image: null, description: p.description })));
    }
    if (toolUse.name === "create_cart_link" && execResult.cartLink?.checkoutUrl) {
      cartLink = { checkoutUrl: execResult.cartLink.checkoutUrl };
      callbacks.onCartLink(execResult.cartLink.checkoutUrl);
      flexMessages.push({
        altText: "カートを作成しました",
        contents: { type: "bubble", size: "mega",
          body: { type: "box", layout: "vertical", spacing: "md", backgroundColor: "#FFFEF2",
            contents: [
              { type: "text", text: "カートを作成しました", weight: "bold", size: "lg", color: "#333333" },
              { type: "text", text: "下のボタンからお会計に進めます", size: "sm", color: "#666666", wrap: true },
            ] },
          footer: { type: "box", layout: "vertical", spacing: "sm", backgroundColor: "#FFFEF2",
            contents: [{ type: "button", action: { type: "uri", label: "購入手続きへ", uri: execResult.cartLink.checkoutUrl }, style: "primary", color: "#333333", height: "sm" }] },
        },
      });
    }
    if (toolUse.name === "escalate_to_human") {
      escalated = true;
      recordEscalation(env);
      const input = toolUse.input as { reason: string; category: string; summary: string };
      escalationReason = input.reason;
      escalationCategory = input.category;
      notifySlack(userId, channel, input.reason, input.category, input.summary, env).catch(console.error);
    }
  };

  /** 最終応答処理 */
  const finalize = (finalText: string) => {
    if (isLowKnowledge) {
      logUnansweredQuery(supabase, { userId, channel, queryText: userMessage, maxSimilarity, resultCount: knowledgeResults.length, escalated }).catch(console.error);
    }
    const quickReplies = generateQuickReplies(usedTools, escalated);
    if (quickReplies.length > 0) callbacks.onQuickReplies(quickReplies);
    // ツール使用ターンで蓄積されたテキストと最終テキストを結合
    const fullResponse = (accumulatedText + finalText) || "申し訳ありません、お返事の生成に失敗しました。";
    callbacks.onDone(fullResponse);
    return { escalated, escalationReason, escalationCategory, flexMessages, productCards, cartLink, quickReplies };
  };

  // ツールループ
  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const tLlm = Date.now();
    console.log(`[agent-stream] turn=${turn}, elapsed=${tLlm - t0}ms`);

    // 2回目以降（ツール使用後の応答）は Claude streaming API を使用
    if (turn > 0) {
      console.log(`[agent-stream] streaming turn=${turn}`);
      const stream = await client.messages.create({ ...apiParams, messages, stream: true });

      let fullText = "";
      let hasToolUse = false;
      const streamTools: Array<{ id: string; name: string; json: string }> = [];
      let curTool: { id: string; name: string; json: string } | null = null;

      for await (const event of stream) {
        if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
          hasToolUse = true;
          curTool = { id: event.content_block.id, name: event.content_block.name, json: "" };
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            callbacks.onTextDelta(event.delta.text);
            fullText += event.delta.text;
          } else if (event.delta.type === "input_json_delta" && curTool) {
            curTool.json += (event.delta as unknown as { partial_json: string }).partial_json;
          }
        } else if (event.type === "content_block_stop" && curTool) {
          streamTools.push(curTool);
          curTool = null;
        } else if (event.type === "message_delta") {
          console.log(`[agent-stream] streaming turn=${turn} done, llm=${Date.now() - tLlm}ms, stop=${event.delta.stop_reason}`);
        }
      }

      if (!hasToolUse) return finalize(fullText);

      // ツール呼び出しをストリーミング中に検出（稀なケース）
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      const assistantContent: Anthropic.ContentBlockParam[] = [];
      if (fullText) assistantContent.push({ type: "text" as const, text: fullText });
      for (const tb of streamTools) {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(tb.json); } catch { /* empty */ }
        const block: Anthropic.ToolUseBlock = { type: "tool_use", id: tb.id, name: tb.name, input: parsed };
        assistantContent.push({ type: "tool_use" as const, id: tb.id, name: tb.name, input: parsed });
        const execResult = await executeTool(block, userId, channel, env);
        usedTools.push(tb.name);
        handleToolResult(block, execResult);
        toolResults.push({ type: "tool_result" as const, tool_use_id: tb.id, content: execResult.text });
      }
      messages.push({ role: "assistant", content: assistantContent });
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // 初回ターン: 非ストリーミングでツール呼び出しの有無を確認
    const response = await withTimeout(
      client.messages.create({ ...apiParams, messages }), TIMEOUT_LLM_CALL_MS, `anthropic turn=${turn}`,
    );
    console.log(`[agent-stream] turn=${turn} done, llm=${Date.now() - tLlm}ms`);
    console.log(JSON.stringify({
      type: "usage", input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens: (response.usage as any).cache_creation_input_tokens || 0,
      cache_read_input_tokens: (response.usage as any).cache_read_input_tokens || 0,
    }));

    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      // ツール不使用: テキストをチャンク送信（既に生成済みのため擬似ストリーミング）
      const finalText = textBlocks.map((b) => b.text).join("");
      for (let i = 0; i < finalText.length; i += 8) {
        callbacks.onTextDelta(finalText.slice(i, i + 8));
      }
      return finalize(finalText);
    }

    // ツール使用時: テキストブロックがあればクライアントに即時送信
    // (turn 0 は非ストリーミングなので、テキストを手動でチャンク送信する)
    const turnText = textBlocks.map((b) => b.text).join("");
    if (turnText) {
      for (let i = 0; i < turnText.length; i += 8) {
        callbacks.onTextDelta(turnText.slice(i, i + 8));
      }
      accumulatedText += turnText;
    }

    // ツール実行
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUseBlocks) {
      const execResult = await executeTool(toolUse, userId, channel, env);
      usedTools.push(toolUse.name);
      handleToolResult(toolUse, execResult);
      toolResults.push({ type: "tool_result" as const, tool_use_id: toolUse.id, content: execResult.text });
    }
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
  }

  // ツールループ上限到達
  const fallback = productCards.length > 0
    ? "こちらの商品情報をご参考になさってください。他にもご質問がございましたら、お気軽にどうぞ。"
    : "申し訳ございません、ただいま情報の取得に少しお時間をいただいております。具体的なご質問をいただければ、改めてお調べいたしますね。";
  for (let i = 0; i < fallback.length; i += 8) callbacks.onTextDelta(fallback.slice(i, i + 8));
  callbacks.onDone(fallback);
  return { escalated, escalationReason, escalationCategory, flexMessages, productCards, cartLink, quickReplies: [] };
}

/**
 * 顧客プロファイルからコンテキスト文字列を構築する。
 */
function buildCustomerContext(customerProfile: CustomerProfile | null, isLinked: boolean): string {
  if (customerProfile) {
    const parts: string[] = [];
    if (isLinked) parts.push("紐付け状態: LINE・Web アカウント連携済み（リピーターとして対応）");
    if (customerProfile.displayName) parts.push(`顧客名: ${customerProfile.displayName}`);
    if (customerProfile.membershipTier && customerProfile.membershipTier !== "none") parts.push(`会員ランク: ${customerProfile.membershipTier}`);
    if (customerProfile.depthLevel) parts.push(`茶の経験レベル: ${customerProfile.depthLevel}`);
    if (customerProfile.tasteProfile) {
      const tp = customerProfile.tasteProfile;
      if (tp.preferredCategories?.length) parts.push(`好みのカテゴリ: ${tp.preferredCategories.join(", ")}`);
      if (tp.flavorPreferences?.length) parts.push(`好みのフレーバー: ${tp.flavorPreferences.join(", ")}`);
      if (tp.scenePref) parts.push(`好みのシーン: ${tp.scenePref}`);
    }
    if (isLinked && customerProfile.persona) {
      const ps = customerProfile.persona;
      if (ps.scores) parts.push(`ペルソナスコア: serenity=${ps.scores.serenity}, explorer=${ps.scores.explorer}, sensory=${ps.scores.sensory}`);
      if (ps.lastUpdated) parts.push(`ペルソナ最終更新: ${ps.lastUpdated}`);
    }
    if (parts.length > 0) {
      let ctx = `\n\n## 顧客データ\n${parts.join("\n")}`;
      if (isLinked) {
        ctx += "\n\n**注意**: この顧客はアカウント連携済みです。過去の好みや購入履歴を踏まえたパーソナライズされた提案をしてください。名前で呼びかけ、以前の会話内容を自然に参照してください。\n\n**プロファイル活用ルール**:\n- 好みのカテゴリやフレーバーが記録されている場合、「前回、〇〇がお好みとのことでしたね」のように自然に参照する\n- プロファイルが空の場合は無理に参照せず、通常通り対応する\n- 好みの情報は押し付けではなく、提案の精度向上に使う";
      }
      return ctx;
    }
  } else if (isLinked) {
    return "\n\n## 顧客データ\n紐付け状態: LINE・Web アカウント連携済み（プロファイル未作成）\n\n**注意**: この顧客はアカウント連携済みですが、詳細プロファイルはまだありません。会話の中から好みを自然に探り、リピーターとして丁寧に対応してください。";
  }
  return "";
}

/**
 * 使用ツール・状況に応じた Quick Reply を生成（MS5 5.5）。
 * LINE の Quick Reply は最大13個まで。
 */
function generateQuickReplies(
  usedTools: string[],
  escalated: boolean,
): Array<{ label: string; text: string }> {
  if (escalated) {
    return [
      { label: "はい、お待ちします", text: "はい、お待ちしています" },
    ];
  }

  if (usedTools.includes("create_cart_link")) {
    return [
      { label: "他の商品も追加", text: "他の商品もカートに追加したいです" },
      { label: "おすすめを見る", text: "他のおすすめ商品も教えてください" },
    ];
  }

  if (usedTools.includes("recommend_product")) {
    return [
      { label: "詳しく教えて", text: "この商品についてもっと詳しく教えてください" },
      { label: "他の商品も見たい", text: "他のおすすめ商品も教えてください" },
      { label: "購入したい", text: "この商品を購入したいです" },
    ];
  }

  if (usedTools.includes("get_order_detail") || usedTools.includes("lookup_my_orders")) {
    return [
      { label: "配送状況を確認", text: "配送状況を詳しく教えてください" },
      { label: "他の注文も確認", text: "他の注文も確認したいです" },
    ];
  }

  // ツール未使用（通常の回答）の場合は Quick Reply なし
  return [];
}

/**
 * ツールの実行。
 * ツール名に応じて対応する関数を呼び出す。
 */
async function executeTool(
  toolUse: Anthropic.ToolUseBlock,
  userId: string,
  channel: Channel,
  env: Env,
): Promise<ToolExecResult> {
  try {
    switch (toolUse.name) {
      case "escalate_to_human":
        return { text: "オペレーターに通知しました。" };

      case "lookup_my_orders":
        return { text: await lookupMyOrders(userId, channel, env) };

      case "get_order_detail": {
        const input = toolUse.input as { order_number: string };
        const orderResult = await getOrderDetail(input.order_number, env);
        return { text: orderResult.text, orderDetail: orderResult };
      }

      case "recommend_product":
        return { text: "商品カードを送信しました。テキストでも簡潔に商品を紹介してください。" };

      case "create_cart_link": {
        const input = toolUse.input as {
          items: Array<{ variant_id: string; quantity?: number }>;
        };
        const items = input.items.map((item) => ({
          variantId: item.variant_id,
          quantity: item.quantity ?? 1,
        }));
        const cartResult = await createCartLink(items, env);
        return { text: cartResult.text, cartLink: cartResult };
      }

      default:
        return { text: `不明なツール: ${toolUse.name}` };
    }
  } catch (error) {
    console.error(`Tool execution error (${toolUse.name}):`, error);
    return { text: `ツールの実行中にエラーが発生しました。お客様には「確認してお返事します」と伝えてください。` };
  }
}

// ---------------------------------------------------------------------------
// 入力言語検出 — 非日本語入力時に応答言語を強制するリマインダーを生成
// ---------------------------------------------------------------------------

/**
 * ユーザーメッセージの言語を簡易判定し、非日本語の場合に
 * 応答言語を強制するリマインダー文字列を返す。
 *
 * system prompt 全体が日本語であるため、LLM が日本語で応答する傾向がある。
 * 明示的なリマインダーを動的コンテキストに追加することで、
 * ユーザーの言語に合わせた応答を確実にする。
 */
function detectLanguageReminder(message: string): string {
  // 短文（5文字未満）は言語判定を行わない（"OK", "Hi" 等の共通語で誤検出を防止）
  if (message.length < 5) {
    return "";
  }

  // 日本語文字（ひらがな・カタカナ・漢字）の割合で判定
  const jaChars = message.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3400-\u4DBF]/g);
  const jaRatio = jaChars ? jaChars.length / message.length : 0;

  // 日本語文字が10%未満 かつ ASCII文字が多い場合、英語と判定
  if (jaRatio < 0.1 && message.length > 0) {
    // ASCII ラテン文字の割合で英語かどうかを推定
    const latinChars = message.match(/[a-zA-Z]/g);
    const latinRatio = latinChars ? latinChars.length / message.length : 0;

    if (latinRatio > 0.3) {
      return `\n\n## CRITICAL: Response Language\nThe user's message is in English. You MUST respond in English. Do NOT respond in Japanese. Use a friendly, professional tone. The tone rules in the system prompt (敬語 etc.) do not apply — use natural English instead.`;
    }
  }

  // 日本語入力の場合はリマインダー不要
  return "";
}

// ---------------------------------------------------------------------------
// 会話シグナル検出（チャネル非依存）
// ---------------------------------------------------------------------------

/** お茶の種類キーワード（tea_mention） */
const TEA_MENTION_KEYWORDS = [
  "ほうじ茶", "hojicha",
  "緑茶", "sencha", "煎茶",
  "玉露",
  "抹茶", "matcha",
  "烏龍茶", "ウーロン茶", "oolong",
  "紅茶", "black tea",
  "白茶", "白茶", "white tea",
  "プーアル茶", "pu-erh",
  "ほうじ", "玄米茶", "genmaicha",
  "かぶせ茶",
];

/** フレーバー・味覚表現キーワード（flavor_preference） */
const FLAVOR_KEYWORDS = [
  "甘い", "甘み", "あまい",
  "苦い", "苦み", "にがい",
  "渋い", "渋み",
  "まろやか",
  "すっきり",
  "コク", "深み",
  "香ばしい", "香り",
  "フローラル", "floral",
  "フルーティ", "fruity",
  "スモーキー", "smoky",
  "軽い", "さっぱり",
  "濃い", "こい",
  "ペアリング", "pairing",
  "食事に合う",
];

/** 関心トピックキーワード（topic_interest） */
const TOPIC_INTEREST_KEYWORDS = [
  "産地", "農園", "茶畑",
  "製法", "作り方",
  "茶師", "生産者", "農家",
  "新茶", "旬",
  "おすすめ", "人気",
  "飲み方", "淹れ方",
  "リラックス", "くつろぎ",
  "夜", "朝", "食後",
  "カフェイン",
  "栄養", "健康",
  "ギフト", "プレゼント",
];

/**
 * 会話メッセージからお茶関連シグナルを抽出する。
 *
 * キーワードマッチングによるルールベース検出。
 * 1回の会話から複数シグナルが発生する場合もある（例: 茶種 + フレーバー言及）。
 */
function extractConversationSignals(message: string, channel: BehaviorChannel): BehaviorEvent[] {
  const normalized = message.toLowerCase();
  const events: BehaviorEvent[] = [];
  const now = new Date().toISOString();

  // お茶の種類言及チェック
  const teaMentions = TEA_MENTION_KEYWORDS.filter((kw) =>
    normalized.includes(kw.toLowerCase()),
  );
  if (teaMentions.length > 0) {
    events.push({
      action: "tea_mention",
      channel,
      metadata: { query: teaMentions.join(",") },
      personaSignal: "explorer", // 茶種に興味 → explorer傾向
      createdAt: now,
    });
  }

  // フレーバー・味の好みチェック
  const flavorHints = FLAVOR_KEYWORDS.filter((kw) =>
    normalized.includes(kw.toLowerCase()),
  );
  if (flavorHints.length > 0) {
    events.push({
      action: "flavor_preference",
      channel,
      metadata: { query: flavorHints.join(",") },
      personaSignal: "sensory", // 味覚表現 → sensory傾向
      createdAt: now,
    });
  }

  // 関心トピックチェック
  const topicHints = TOPIC_INTEREST_KEYWORDS.filter((kw) =>
    normalized.includes(kw.toLowerCase()),
  );
  if (topicHints.length > 0) {
    // リラックス系は serenity、それ以外は explorer
    const relaxKeywords = ["リラックス", "くつろぎ", "夜", "食後"];
    const isSerenity = relaxKeywords.some((kw) => normalized.includes(kw.toLowerCase()));
    events.push({
      action: "topic_interest",
      channel,
      metadata: { query: topicHints.join(",") },
      personaSignal: isSerenity ? "serenity" : "explorer",
      createdAt: now,
    });
  }

  return events;
}

/** カテゴリの日本語ラベル */
const CATEGORY_LABELS: Record<string, string> = {
  knowledge_gap: "ナレッジ不足",
  complaint: "クレーム・返品",
  human_request: "人間対応要求",
  health_safety: "健康・安全",
  personal_info: "個人情報確認",
  order_trouble: "注文トラブル",
  uncertain: "回答不確実",
};

/** Slack にエスカレーション通知を送信 */
async function notifySlack(
  userId: string,
  channel: Channel,
  reason: string,
  category: string,
  summary: string,
  env: Env,
): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) {
    console.warn("SLACK_WEBHOOK_URL is not set, skipping notification");
    return;
  }

  const categoryLabel = CATEGORY_LABELS[category] ?? category;
  const channelLabel = channel === "line" ? "LINE" : "Web";

  const payload = {
    text: `*エスカレーション* [${categoryLabel}]\n\n*Channel:* ${channelLabel}\n*User:* ${userId}\n*分類:* ${categoryLabel}\n*理由:* ${reason}\n*会話要約:* ${summary}`,
  };

  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error("Slack notification failed:", await res.text());
  }
}
