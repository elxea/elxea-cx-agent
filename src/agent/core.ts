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
import { setBroadcastOptOut } from "../lib/broadcast-optout";
import {
  getCustomerProfile,
  getLineUserProfile,
  mergeLineUserIntoShopify,
  addBehaviorEvent,
  tryGetFirestoreEnv,
  type CustomerProfile,
  type FirestoreEnv,
  type TasteProfile,
  type PersonaType,
  type BehaviorEvent,
  type BehaviorChannel,
} from "../lib/firestore";
import { getUserRatings, positiveRatedProductNos } from "../lib/product-ratings";
import { fetchSellingTeas } from "../lib/tea-menu";
import {
  buildPersonalizationContext,
  type EntrySource,
  type PersonalizationFacts,
} from "../lib/personalization-context";
import { productCard, productCarousel, orderCard } from "../lib/flex-templates";
import { systemPrompt, buildPersonaPromptFragment } from "./system-prompt";
import { agentTools } from "./tools";
import {
  isSalesSurfaceEnabled,
  isSalesTool,
  SALES_TOOL_DISABLED_RESULT,
} from "../lib/sales-surface";
import { withTimeout } from "../lib/utils";
import { recordEscalation } from "../lib/alerts";
import { applyBrandGuard } from "../lib/brand-guard";
import { formatTeaLabel } from "../lib/brand-copy";

/**
 * Anthropic クライアントを作る。
 *
 * `fetch` を **遅延束縛**（呼ぶたびに globalThis から引き直す）で渡すのが要点。
 * SDK の既定は import 時点の globalThis.fetch を掴むため、テストが後から敷いたモックを
 * すり抜けて **実 API へ出てしまう**（ハーメティックの穴。2026-08-30 に動線20 の追加で実測）。
 * 遅延束縛にすればモックが確実に効く。本番挙動は変わらない
 * （Workers 上では globalThis.fetch が標準の fetch のままで、経路も回数も同じ）。
 */
function createAnthropicClient(env: Env): Anthropic {
  return new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      globalThis.fetch(input, init)) as typeof fetch,
  });
}

type Message = {
  role: "user" | "assistant";
  content: string;
  /**
   * B-3: その発言がどのチャネルで交わされたか（conversations.channel の生値）。
   *
   * getCrossChannelMessages / getRecentMessages はどちらも `channel` を選択して返すが、
   * これまでプロンプト整形時に捨てていた。捨てていると、LINE と Web の会話が混ざった履歴を
   * 見た AI が「どこで伺った話か」を言えず、混同するか黙るかのどちらかになる。
   */
  channel?: string;
};

/**
 * B-3: 会話履歴のチャネルを、お客様に向けて言うときの言い方に直す。
 *
 * ここは AI が本文で使う言葉になるので、内部語（"web" / "line" の生値）を漏らさない。
 * 未知のチャネルは null を返す（推測でラベルを作らない）。
 */
const CHANNEL_LABELS: Record<string, string> = {
  line: "LINE",
  web: "サイトのチャット",
};

export function channelLabel(channel: string | null | undefined): string | null {
  if (typeof channel !== "string" || channel === "") return null;
  return CHANNEL_LABELS[channel] ?? null;
}

/** 履歴に現れるチャネルの生値（重複なし・順序は初出順）。 */
export function historyChannels(history: Message[]): string[] {
  const seen: string[] = [];
  for (const m of history) {
    if (typeof m.channel === "string" && m.channel !== "" && !seen.includes(m.channel)) {
      seen.push(m.channel);
    }
  }
  return seen;
}

/**
 * B-3: 履歴が 2 つ以上のチャネルにまたがっているか（＝チャネル名を添える価値があるか）。
 *
 * 単一チャネルしかない人（大多数）ではラベルを一切足さない。プロンプトの見た目を
 * 変えるのは「本当に横断している人」だけに限る（既存の会話体験を動かさないため）。
 */
export function historySpansChannels(history: Message[]): boolean {
  return historyChannels(history).map(channelLabel).filter((l) => l !== null).length > 1;
}

/**
 * B-3: 会話履歴を Claude のメッセージ列へ変換する。
 *
 * 履歴が複数チャネルにまたがるときだけ、各発言の頭に `[LINE]` / `[サイトのチャット]` を付ける。
 * これで AI は「LINE で伺った」「サイトのチャットで伺った」と言い分けられる。
 * 印の意味は buildCrossChannelNote がシステム側で説明する（印そのものは本文に出させない）。
 */
export function buildHistoryMessages(history: Message[]): Anthropic.MessageParam[] {
  const labelled = historySpansChannels(history);
  return history.map((m) => {
    const label = labelled ? channelLabel(m.channel) : null;
    return {
      role: m.role as "user" | "assistant",
      content: label ? `[${label}] ${m.content}` : m.content,
    };
  });
}

/**
 * B-3: 上のチャネル印の読み方をシステムプロンプトに 1 ブロックだけ足す。
 * 単一チャネルの人には空文字を返す（プロンプトを 1 文字も変えない）。
 */
export function buildCrossChannelNote(history: Message[]): string {
  if (!historySpansChannels(history)) return "";
  const labels = historyChannels(history)
    .map(channelLabel)
    .filter((l): l is string => l !== null);
  return `\n\n## 会話履歴のチャネル表示\n過去の発言の先頭にある [${labels.join("] / [")}] は、その発言がどこで交わされた会話かを示す内部の印です（お客様の画面には出ていません）。\n- 以前の話に触れるときは「${labels[0]}で伺った」のように、どこでの会話かを添えて自然に参照してください。\n- 印そのもの（角括弧の表記）を返答本文に書いてはいけません。`;
}

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

/**
 * チャット返信で使う Anthropic モデル。
 * env.ANTHROPIC_MODEL で上書き可能。未設定時は現行モデル（最安クラス Haiku 4.5）にフォールバック。
 */
const DEFAULT_REPLY_MODEL = "claude-haiku-4-5-20251001";
const replyModel = (env: Env): string => env.ANTHROPIC_MODEL || DEFAULT_REPLY_MODEL;

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
    /**
     * A-1: product_ratings 等を引くキー（チャネル固有 ID）。
     * LINE では生の lineUserId（product_ratings.user_ref と一致）。省略時は userId。
     */
    ratingUserRef?: string;
  },
): Promise<AgentResult> {
  const client = createAnthropicClient(env);
  const supabase = createSupabaseClient(env);
  const t0 = Date.now();

  // クエリカテゴリ判定（同期処理、高速）
  const sourceTypeFilter = classifyQuery(userMessage);
  console.log(`Query classified as: ${sourceTypeFilter ?? "null (no filter)"}`);

  // Firestore env を一度だけ取得してキャッシュ（複数箇所で使用）。
  // T-12: 未設定は黙ってスキップしない（理由付きで 1 行出す）。
  const fsEnv = tryGetFirestoreEnv(env, "agent.core.generateResponse");

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
      // P0-11（§B-7）: 発話全文（metadata.query）の behaviorLog 書き込みを停止する。
      //   全文は conversations（90日 purge）で参照でき、プロンプト注入用途は抽出済みシグナルで足りる。
      //   Supabase 会話ログ90日と非対称な「無期限の発話全文」を behaviorLog から無くす。
      //   → line_message（全文）イベントは記録せず、抽出済みシグナルのみ残す。
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
  //
  // B-1: ここは runAgentStreaming と同じ buildCustomerContext を呼ぶ（以前は同内容を写経していた）。
  //   連携済み向けの「以前の会話内容を自然に参照してください」という指示はこの 1 か所が正本で、
  //   2 箇所に分かれていると片方だけ直って挙動がずれる。
  const customerContext = buildCustomerContext(customerProfile, isLinked);

  // 入力言語検出: 英語など非日本語の場合、応答言語を強制するリマインダーを生成
  const languageReminder = detectLanguageReminder(userMessage);

  // A-1 文脈接続: positive/neutral な事実 + 境界 4 ルールを注入する断片（fail-safe・空可）。
  const personalizationBlock = await buildPersonalizationBlock({
    supabase,
    env,
    fsEnv,
    channel,
    userId,
    ratingUserRef: options?.ratingUserRef ?? userId,
    customerProfile,
    firestoreCustomerId,
  });

  // B-3: 履歴が複数チャネルにまたがるときだけ、印の読み方をシステム側に足す。
  const crossChannelNote = buildCrossChannelNote(conversationHistory);

  // 会話履歴を Claude のメッセージ形式に変換（B-3: 横断時のみチャネル印を付ける）
  const messages: Anthropic.MessageParam[] = [...buildHistoryMessages(conversationHistory)];

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
        model: replyModel(env),
        max_tokens: 768,
        system: [
          // 第1ブロック = 完全に不変な SYSTEM_PROMPT のみ。ここに cache_control を置くことで
          // tools + SYSTEM_PROMPT (計 ~7,000 tokens) を全リクエスト・全ペルソナ横断で共有キャッシュする。
          // personaFragment はペルソナ (serenity/explorer/sensory/未判定) ごとに変わるため
          // キャッシュ断片化を避けて第2ブロック (可変) 側へ移動する。
          {
            type: "text" as const,
            text: systemPrompt(env),
            cache_control: { type: "ephemeral" as const },
          },
          {
            type: "text" as const,
            text: personaFragment + languageReminder + customerContext + crossChannelNote + personalizationBlock + knowledgeContext,
          },
        ],
        // 売り込み面が無効（既定）なら購入ボタン・商品カードの道具は渡さない（sales-surface.ts）。
        tools: (() => {
          const tools = agentTools(env);
          return tools.map((tool, i) =>
            i === tools.length - 1
              ? { ...tool, cache_control: { type: "ephemeral" as const } }
              : tool,
          );
        })(),
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
      // egress brand-fact ガード: 送信直前に AI 生成応答の非正本ブランド文言を正本語へ是正する。
      const finalText = applyBrandGuard(
        textBlocks.map((b) => b.text).join(""),
        { channel, userId },
      );

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

      const quickReplies = generateQuickReplies(usedTools, escalated, isSalesSurfaceEnabled(env));

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
      // 売り込み面が無効（既定）ならカードは組み立てない（三重ガード: 露出停止・実行拒否・描画停止）。
      if (toolUse.name === "recommend_product" && isSalesSurfaceEnabled(env)) {
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

      // カートリンク追跡（売り込み面が無効なら executeTool が実行を拒否するため cartLink は付かない）
      if (
        toolUse.name === "create_cart_link" &&
        isSalesSurfaceEnabled(env) &&
        execResult.cartLink?.checkoutUrl
      ) {
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
    /** A-1: product_ratings 等を引くキー（チャネル固有 ID）。省略時は userId。 */
    ratingUserRef?: string;
  },
): Promise<StreamingAgentMeta> {
  const client = createAnthropicClient(env);
  const supabase = createSupabaseClient(env);
  const t0 = Date.now();

  const sourceTypeFilter = classifyQuery(userMessage);

  // T-12: 未設定は黙ってスキップしない（理由付きで 1 行出す）。
  const fsEnv = tryGetFirestoreEnv(env, "agent.core.generateResponseStream");

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
      // P0-11（§B-7）: 発話全文（metadata.query）の behaviorLog 書き込みを停止（抽出済みシグナルのみ）。
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
  // B-3: 履歴が複数チャネルにまたがるときだけ、印の読み方をシステム側に足す。
  const crossChannelNote = buildCrossChannelNote(conversationHistory);

  // A-1 文脈接続: positive/neutral な事実 + 境界 4 ルールを注入する断片（fail-safe・空可）。
  const personalizationBlock = await buildPersonalizationBlock({
    supabase,
    env,
    fsEnv,
    channel,
    userId,
    ratingUserRef: options?.ratingUserRef ?? userId,
    customerProfile,
    firestoreCustomerId,
  });

  // メッセージ構築（B-3: 横断時のみチャネル印を付ける）
  const messages: Anthropic.MessageParam[] = [...buildHistoryMessages(conversationHistory)];
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
    model: replyModel(env),
    max_tokens: 768,
    system: [
      // 第1ブロック = 不変な SYSTEM_PROMPT のみを cache_control で共有キャッシュ (全ペルソナ横断)。
      // personaFragment はペルソナ可変なので断片化回避のため第2ブロック側へ移す。
      { type: "text" as const, text: systemPrompt(env), cache_control: { type: "ephemeral" as const } },
      { type: "text" as const, text: personaFragment + languageReminder + customerContext + crossChannelNote + personalizationBlock + knowledgeContext },
    ],
    // 売り込み面が無効（既定）なら購入ボタン・商品カードの道具は渡さない（sales-surface.ts）。
    tools: (() => {
      const tools = agentTools(env);
      return tools.map((tool, i) =>
        i === tools.length - 1 ? { ...tool, cache_control: { type: "ephemeral" as const } } : tool,
      );
    })(),
  };

  /** ツール結果の共通後処理 */
  const handleToolResult = (toolUse: Anthropic.ToolUseBlock, execResult: ToolExecResult) => {
    if (toolUse.name === "get_order_detail" && execResult.orderDetail?.data) {
      const od = execResult.orderDetail.data;
      flexMessages.push({ altText: `注文 ${od.orderName} の詳細`, contents: orderCard(od) });
    }
    // 売り込み面が無効（既定）ならカードは組み立てない（三重ガード: 露出停止・実行拒否・描画停止）。
    if (toolUse.name === "recommend_product" && isSalesSurfaceEnabled(env)) {
      const input = toolUse.input as { products: Array<{ name: string; description: string; price: string; product_url: string }> };
      const products = input.products.map((p) => ({ name: p.name, description: p.description, price: p.price, productUrl: p.product_url }));
      for (const p of products) productCards.push(p);
      if (products.length === 1) flexMessages.push({ altText: `商品のご案内: ${products[0].name}`, contents: productCard(products[0]) });
      else if (products.length > 1) flexMessages.push({ altText: `${products.length}件の商品のご案内`, contents: productCarousel(products) });
      callbacks.onProductCards(products.map((p) => ({ name: p.name, price: p.price, url: p.productUrl, image: null, description: p.description })));
    }
    if (
      toolUse.name === "create_cart_link" &&
      isSalesSurfaceEnabled(env) &&
      execResult.cartLink?.checkoutUrl
    ) {
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
    const quickReplies = generateQuickReplies(usedTools, escalated, isSalesSurfaceEnabled(env));
    if (quickReplies.length > 0) callbacks.onQuickReplies(quickReplies);
    // ツール使用ターンで蓄積されたテキストと最終テキストを結合
    // egress brand-fact ガード: 保存・最終確定に使う全文を送信直前に是正する（冪等）。
    const fullResponse =
      applyBrandGuard(accumulatedText + finalText, { channel, userId }) ||
      "申し訳ありません、お返事の生成に失敗しました。";
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
      // ツール不使用: テキストをチャンク送信（既に生成済みのため擬似ストリーミング）。
      // turn 0 は非ストリーミングで全文が揃っているため、チャンク送信前に egress ガードを適用でき、
      // クライアントへ流れる delta も是正済みになる。
      const finalText = applyBrandGuard(
        textBlocks.map((b) => b.text).join(""),
        { channel, userId },
      );
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
 *
 * B-1: `isLinked` はここ（＝プロンプトの文言）だけに効くフラグで、**どのデータを読むかは
 *   一切決めていない**（customerProfile は呼び出し前に別経路で取得済み）。連携済みの人に
 *   true を渡しても「存在しないキーでカルテを引く」ことは起きない。
 */
export function buildCustomerContext(customerProfile: CustomerProfile | null, isLinked: boolean): string {
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
    // B-1: ここが「連携はしているが Firestore カルテがまだ無い人」の枝で、LIFF / Account Link で
    //   連携したばかりの人はほぼ全員ここに来る。以前はこの枝にだけ「以前の会話内容を自然に
    //   参照してください」が無く、履歴が目の前にあるのに AI が「覚えていない」と否認していた。
    //   カルテの有無は記憶の有無ではないので、参照の指示はカルテがなくても出す。
    return "\n\n## 顧客データ\n紐付け状態: LINE・Web アカウント連携済み（プロファイル未作成）\n\n**注意**: この顧客はアカウント連携済みです。詳細プロファイルはまだありませんが、上の会話履歴には別のチャネルでのやり取りも含まれています。以前の会話内容を自然に参照してください（履歴にあることを「覚えていない」「確認できない」と否定しないこと）。会話の中から好みを自然に探り、リピーターとして丁寧に対応してください。";
  }
  return "";
}

/** LINE Messaging API の userId 形式（"U" + 32 hex）。lineUsers 直読みの前提チェック。 */
const LINE_USER_ID_RE = /^U[0-9a-fA-F]{32}$/;

/** entrySource を正規値（marche/online/other）に絞る。未知は null（ノイズを注入しない）。 */
function normalizeEntrySource(source: string | null | undefined): EntrySource | null {
  return source === "marche" || source === "online" || source === "other" ? source : null;
}

/**
 * A-1 文脈接続: positive/neutral な事実を収集し、プロンプト断片へ組む（fail-safe）。
 *
 * データ源（設計 v2 / Phase 0 as-built）:
 *   - persona / tasteProfile / 入口: 連携済み=users カルテ（customerProfile）/
 *     未連携 LINE=lineUsers/{lineUserId} を直読み。
 *   - +1 評価銘柄: Supabase product_ratings（ratingUserRef で引く）→ 販売中メニューで銘柄名に解決。
 *
 * どの取得が失敗しても空文字ではなく「取れた事実だけ」で断片を組み、フローを止めない。
 * -1 評価・休眠等の負の事実は収集対象にしない（ビルダーへ渡さない＝応答文脈に出さない）。
 */
async function buildPersonalizationBlock(params: {
  supabase: ReturnType<typeof createSupabaseClient>;
  env: Env;
  fsEnv: FirestoreEnv | null;
  channel: Channel;
  userId: string;
  ratingUserRef: string;
  customerProfile: CustomerProfile | null;
  /** 連携済み LINE ユーザーの Shopify 顧客 ID（customer_linkages 解決値）。QA S-1 のマージに使う。 */
  firestoreCustomerId?: string | null;
}): Promise<string> {
  const { supabase, env, fsEnv, channel, userId, ratingUserRef, customerProfile, firestoreCustomerId } = params;
  try {
    let persona: PersonaType | null = customerProfile?.persona?.primary ?? null;
    let tasteProfile: TasteProfile | null = customerProfile?.tasteProfile ?? null;
    let source: string | null | undefined = customerProfile?.onboarding?.source ?? null;

    // 未連携 LINE ユーザー: lineUsers/{lineUserId} を直読みして persona/taste/入口を補う。
    if (!customerProfile && channel === "line" && fsEnv && LINE_USER_ID_RE.test(userId)) {
      try {
        const lineProfile = await getLineUserProfile(userId, fsEnv);
        persona = lineProfile?.persona?.primary ?? null;
        tasteProfile = lineProfile?.tasteProfile ?? null;
        source = lineProfile?.onboarding?.source ?? null;
      } catch (err) {
        console.warn("[agent] lineUsers personalization read skipped:", err instanceof Error ? err.message : err);
      }
    }

    // QA S-1 読み取り時フォールバック: 連携済みでも lineUsers の好みが users へ未統合なら統合して使う。
    //   連携ハンドラでの書込マージが（Firestore 一時不通等で）漏れても、以後の会話で取りこぼさない。
    //   mergeLineUserIntoShopify は mergedToShopify フラグで冪等（二重加算しない）。best-effort。
    if (
      customerProfile &&
      channel === "line" &&
      fsEnv &&
      firestoreCustomerId &&
      LINE_USER_ID_RE.test(userId)
    ) {
      try {
        const merged = await mergeLineUserIntoShopify(userId, firestoreCustomerId, fsEnv, {
          existingShopify: customerProfile,
        });
        if (merged) {
          persona = merged.persona?.primary ?? persona;
          tasteProfile = merged.tasteProfile ?? tasteProfile;
          source = merged.onboarding?.source ?? source;
        }
      } catch (err) {
        console.warn("[agent] lineUsers→users merge (read fallback) skipped:", err instanceof Error ? err.message : err);
      }
    }

    // +1 評価銘柄 → 販売中メニューで銘柄名に解決（最大 5 件・prompt を肥大させない）。
    const ratedGoodLabels: string[] = [];
    try {
      const ratings = await getUserRatings(supabase, ratingUserRef);
      const positives = positiveRatedProductNos(ratings);
      if (positives.length > 0) {
        const teas = await fetchSellingTeas(env);
        for (const no of positives) {
          const tea = teas.find((t) => t.number === no);
          if (tea) ratedGoodLabels.push(formatTeaLabel({ name: tea.name, number: tea.number }));
          if (ratedGoodLabels.length >= 5) break;
        }
      }
    } catch (err) {
      console.warn("[agent] rated-good personalization read skipped:", err instanceof Error ? err.message : err);
    }

    const facts: PersonalizationFacts = {
      persona,
      entrySource: normalizeEntrySource(source),
      ratedGoodLabels,
      tasteProfile,
    };
    return buildPersonalizationContext(facts);
  } catch (err) {
    console.warn("[agent] personalization block skipped:", err instanceof Error ? err.message : err);
    return "";
  }
}

/**
 * 使用ツール・状況に応じた Quick Reply を生成（MS5 5.5）。
 * LINE の Quick Reply は最大13個まで。
 *
 * 売り込み面のゲート（fail-closed）:
 *   `usedTools` は実行可否と無関係に積まれる（モデルが呼んだ事実がそのまま入る）ため、
 *   executeTool 側で実行を拒否しても、ここを素通りさせると
 *   「購入したい」「おすすめを見る」等の**買う導線だけが Quick Reply として顧客に出る**。
 *   よって executeTool の fail-closed guard と同じ想定（＝モデルが呼びうる前提）で、
 *   `salesEnabled` が false のときは売り込みツール由来の分岐を丸ごとスキップする。
 */
export function generateQuickReplies(
  usedTools: string[],
  escalated: boolean,
  salesEnabled: boolean,
): Array<{ label: string; text: string }> {
  if (escalated) {
    return [
      { label: "はい、お待ちします", text: "はい、お待ちしています" },
    ];
  }

  if (salesEnabled && usedTools.includes("create_cart_link")) {
    return [
      { label: "他の商品も追加", text: "他の商品もカートに追加したいです" },
      { label: "おすすめを見る", text: "他のおすすめ商品も教えてください" },
    ];
  }

  if (salesEnabled && usedTools.includes("recommend_product")) {
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
    // fail-closed: 売り込み面が無効なら、万一 AI が過去履歴等から売り込みツールを呼んでも実行しない
    //   （露出停止＝呼べない、に加えた二重ガード。Shopify カート生成 API にも触れない）。
    if (isSalesTool(toolUse.name) && !isSalesSurfaceEnabled(env)) {
      console.warn(`[sales-surface] blocked disabled tool call: ${toolUse.name}`);
      return { text: SALES_TOOL_DISABLED_RESULT };
    }

    switch (toolUse.name) {
      case "escalate_to_human":
        return { text: "オペレーターに通知しました。" };

      case "lookup_my_orders":
        return { text: await lookupMyOrders(userId, channel, env) };

      case "get_order_detail": {
        const input = toolUse.input as { order_number: string };
        // [SEC-A] 呼び出しユーザー（userId/channel）を渡し、本人の注文だけに限定する。
        const orderResult = await getOrderDetail(input.order_number, env, {
          userId,
          channel,
        });
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

      case "set_broadcast_optout": {
        const input = toolUse.input as { opt_out: boolean };
        const result = await setBroadcastOptOut(userId, channel, input.opt_out, env);
        return { text: result.text };
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
