/**
 * Web Chat Route — POST /api/chat + GET /api/chat/history
 *
 * SSE でストリーミングレスポンスを返す。
 * 現時点では runAgent() は同期的に全応答を取得するため、
 * SSE は runAgent() 完了後にレスポンスをチャンクに分割して送信する。
 */
import type { Context } from "hono";
import type { Env } from "../index";
import { runAgent } from "../agent/core";
import { createEmbedding } from "../lib/embedding";
import {
  createSupabaseClient,
  saveMessage,
  getRecentMessages,
  getCrossChannelMessages,
} from "../lib/supabase";
import {
  validateSessionId,
  validateShopifyCustomerId,
  checkRateLimit,
  getClientIp,
} from "../lib/web-auth";
import {
  resolveUnifiedUserId,
  resolveWithShopifyCustomerId,
} from "../lib/identity";
import { withTimeout } from "../lib/utils";

/** 入力テキストの最大文字数 */
const MAX_MESSAGE_LENGTH = 2000;

/** SSE text_delta のチャンクサイズ（文字数） */
const TEXT_CHUNK_SIZE = 20;

/**
 * POST /api/chat
 *
 * リクエストボディ: { "message": string, "session_id": string }
 * レスポンス: SSE ストリーミング
 */
export async function webChatHandler(c: Context<{ Bindings: Env }>) {
  // レートリミット
  const clientIp = getClientIp(c.req.raw);
  const rateLimitError = checkRateLimit(clientIp);
  if (rateLimitError) {
    return c.json({ error: rateLimitError }, 429);
  }

  // リクエストボディのパース
  let body: { message?: string; session_id?: string; shopify_customer_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { message, session_id, shopify_customer_id } = body;

  // session_id バリデーション
  const sessionError = validateSessionId(session_id);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  // shopify_customer_id バリデーション（optional）
  const shopifyError = validateShopifyCustomerId(shopify_customer_id);
  if (shopifyError) {
    return c.json({ error: shopifyError }, 400);
  }

  // message バリデーション
  if (typeof message !== "string" || message.trim().length === 0) {
    return c.json({ error: "message is required" }, 400);
  }

  const sessionId = session_id as string;
  let processedMessage = message.trim();
  if (processedMessage.length > MAX_MESSAGE_LENGTH) {
    processedMessage = processedMessage.slice(0, MAX_MESSAGE_LENGTH);
  }

  const supabase = createSupabaseClient(c.env);
  const tStart = Date.now();

  // メイン処理を try-catch で包む（unhandled rejection によるハングを防止）
  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    // Identity Resolver: unified_user_id を解決
    // ログイン済み（shopify_customer_id あり）→ Shopify Customer ID ベースで解決
    // 未ログイン → 従来の session_id ベースで解決
    const identity = shopify_customer_id
      ? await resolveWithShopifyCustomerId(supabase, shopify_customer_id, sessionId)
      : await resolveUnifiedUserId(supabase, sessionId, "web");
    const effectiveUserId = identity.unifiedUserId;

    console.log("[web] step=pre-parallel");
    // メッセージ保存・履歴取得・Embedding 生成を並列実行（各 8 秒タイムアウト）
    // 保存は元の sessionId で行い、取得は effectiveUserId で行う
    // 紐付け済みユーザーはクロスチャネルで会話を取得
    const [, history, embedding] = await withTimeout(
      Promise.all([
        saveMessage(supabase, {
          userId: sessionId,
          channel: "web",
          role: "user",
          content: processedMessage,
        }),
        identity.isLinked
          ? getCrossChannelMessages(supabase, effectiveUserId)
          : getRecentMessages(supabase, effectiveUserId, "web"),
        createEmbedding(processedMessage, c.env),
      ]),
      8_000,
      "pre-parallel (saveMessage+history+embedding)",
    );

    console.log("[web] step=runAgent");
    // エージェント実行（20 秒タイムアウト — Workers の 30 秒制限内に収める）
    result = await withTimeout(
      runAgent(
        processedMessage,
        history,
        embedding,
        effectiveUserId,
        "web",
        c.env,
      ),
      20_000,
      "runAgent",
    );
    console.log(`[web] step=runAgent done, total_elapsed=${Date.now() - tStart}ms`);
  } catch (err) {
    console.error("webChatHandler fatal error:", err);
    return c.json(
      { error: "Internal server error" },
      500,
    );
  }

  // アシスタント応答を保存（メタデータ付き）
  const metadata: Record<string, unknown> = {};
  if (result.productCards && result.productCards.length > 0) {
    metadata.product_cards = result.productCards;
  }
  if (result.quickReplies && result.quickReplies.length > 0) {
    metadata.quick_replies = result.quickReplies;
  }

  c.executionCtx.waitUntil(
    saveMessage(supabase, {
      userId: sessionId,
      channel: "web",
      role: "assistant",
      content: result.response,
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    }),
  );

  // SSE レスポンスを文字列として構築し、一括返却
  // （ReadableStream は Cloudflare Workers 本番でハングするため回避）
  const events: string[] = [];

  function pushEvent(data: Record<string, unknown>) {
    events.push(`data: ${JSON.stringify(data)}\n\n`);
  }

  // テキストをチャンクに分割して text_delta イベントとして送信
  const text = result.response;
  for (let i = 0; i < text.length; i += TEXT_CHUNK_SIZE) {
    const chunk = text.slice(i, i + TEXT_CHUNK_SIZE);
    pushEvent({ type: "text_delta", content: chunk });
  }

  // 商品カード
  if (result.productCards && result.productCards.length > 0) {
    pushEvent({
      type: "product_card",
      products: result.productCards.map((p) => ({
        name: p.name,
        price: p.price,
        url: p.productUrl,
        image: p.imageUrl ?? null,
        description: p.description,
      })),
    });
  }

  // クイックリプライ
  if (result.quickReplies && result.quickReplies.length > 0) {
    pushEvent({
      type: "quick_replies",
      items: result.quickReplies,
    });
  }

  // 完了
  pushEvent({ type: "done", session_id: sessionId });

  return new Response(events.join(""), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * GET /api/chat/history
 *
 * クエリパラメータ:
 *   - session_id: セッション ID（必須）
 *   - channel: チャネルフィルター（任意: "line" | "web"、省略時は全チャネル for linked users）
 *   - keyword: 全文検索キーワード（任意、日本語対応 pg_trgm）
 *   - from: 日付範囲開始（任意、ISO-8601 形式）
 *   - to: 日付範囲終了（任意、ISO-8601 形式）
 *   - limit: 取得件数上限（任意、デフォルト 50、最大 200）
 *   - offset: 取得開始位置（任意、デフォルト 0）
 * レスポンス: { messages: [...], is_linked: boolean, total_count: number, limit: number, offset: number }
 */
export async function webChatHistoryHandler(c: Context<{ Bindings: Env }>) {
  const sessionId = c.req.query("session_id");
  const channelFilter = c.req.query("channel") as "line" | "web" | undefined;
  const keyword = c.req.query("keyword") ?? null;
  const dateFrom = c.req.query("from") ?? null;
  const dateTo = c.req.query("to") ?? null;
  const limitParam = c.req.query("limit");
  const offsetParam = c.req.query("offset");

  const sessionError = validateSessionId(sessionId);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  // channel パラメータのバリデーション
  if (channelFilter && channelFilter !== "line" && channelFilter !== "web") {
    return c.json({ error: "channel must be 'line' or 'web'" }, 400);
  }

  // limit/offset バリデーション
  const limit = Math.min(Math.max(parseInt(limitParam ?? "50", 10) || 50, 1), 200);
  const offset = Math.max(parseInt(offsetParam ?? "0", 10) || 0, 0);

  // date バリデーション
  if (dateFrom && isNaN(Date.parse(dateFrom))) {
    return c.json({ error: "'from' must be a valid ISO-8601 date" }, 400);
  }
  if (dateTo && isNaN(Date.parse(dateTo))) {
    return c.json({ error: "'to' must be a valid ISO-8601 date" }, 400);
  }

  const supabase = createSupabaseClient(c.env);

  // Identity Resolver: unified_user_id を解決
  const identity = await resolveUnifiedUserId(supabase, sessionId as string, "web");

  // 検索対象の user_id 一覧を構築
  const userIds: string[] = [identity.isLinked ? identity.unifiedUserId : (sessionId as string)];

  if (identity.isLinked) {
    const { data: identityData } = await supabase
      .from("user_identity_map")
      .select("unified_user_id, line_user_id, web_session_id")
      .eq("unified_user_id", identity.unifiedUserId)
      .single();

    if (identityData?.line_user_id && identityData.line_user_id !== identity.unifiedUserId) {
      userIds.push(identityData.line_user_id);
    }
    if (identityData?.web_session_id && identityData.web_session_id !== identity.unifiedUserId) {
      userIds.push(identityData.web_session_id);
    }
  }

  // 検索パラメータの有無を判定（keyword/date がある場合は RPC 検索を使用）
  const hasSearchParams = keyword || dateFrom || dateTo;

  let data: Array<{
    id?: string;
    role: string;
    content: string;
    channel: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
    total_count?: number;
  }> | null = null;
  let error: unknown = null;
  let totalCount = 0;

  if (hasSearchParams) {
    // RPC 検索: keyword, date range, pagination 対応
    const { data: rpcData, error: rpcError } = await supabase.rpc(
      "search_conversations",
      {
        user_ids: userIds,
        keyword: keyword || null,
        date_from: dateFrom ? new Date(dateFrom).toISOString() : null,
        date_to: dateTo ? new Date(dateTo).toISOString() : null,
        channel_filter: identity.isLinked ? (channelFilter ?? null) : (channelFilter ?? "web"),
        result_limit: limit,
        result_offset: offset,
      },
    );

    if (rpcError) {
      console.error("search_conversations RPC failed, falling back to basic query:", rpcError);
      // フォールバック: 基本クエリ（RPC 未作成の場合）
      const fallbackResult = await basicHistoryQuery(
        supabase, userIds, identity.isLinked, channelFilter, limit, offset,
      );
      data = fallbackResult.data;
      error = fallbackResult.error;
      totalCount = fallbackResult.data?.length ?? 0;
    } else {
      data = rpcData;
      totalCount = (rpcData && rpcData.length > 0) ? Number(rpcData[0].total_count) : 0;
    }
  } else {
    // 基本クエリ（従来互換 + pagination 対応）
    const effectiveChannel = identity.isLinked ? channelFilter : (channelFilter ?? "web");

    let query = supabase
      .from("conversations")
      .select("role, content, channel, metadata, created_at", { count: "exact" })
      .in("user_id", userIds);

    if (effectiveChannel) {
      query = query.eq("channel", effectiveChannel);
    }

    const result = await query
      .order("created_at", { ascending: true })
      .range(offset, offset + limit - 1);

    data = result.data;
    error = result.error;
    totalCount = result.count ?? data?.length ?? 0;
  }

  if (error) {
    console.error("Failed to fetch chat history:", error);
    return c.json({ error: "Failed to fetch history" }, 500);
  }

  const messages = (data ?? []).map((row) => ({
    role: row.role,
    content: row.content,
    channel: row.channel,
    created_at: row.created_at,
    ...(row.metadata?.product_cards
      ? { product_cards: row.metadata.product_cards }
      : {}),
    ...(row.metadata?.quick_replies
      ? { quick_replies: row.metadata.quick_replies }
      : {}),
  }));

  return c.json({
    messages,
    is_linked: identity.isLinked,
    total_count: totalCount,
    limit,
    offset,
  });
}

/**
 * 基本的な履歴クエリ（RPC フォールバック用）。
 * search_conversations RPC が利用不可の場合に使用。
 */
async function basicHistoryQuery(
  supabase: ReturnType<typeof createSupabaseClient>,
  userIds: string[],
  isLinked: boolean,
  channelFilter: "line" | "web" | undefined,
  limit: number,
  offset: number,
) {
  const effectiveChannel = isLinked ? channelFilter : (channelFilter ?? "web");

  let query = supabase
    .from("conversations")
    .select("role, content, channel, metadata, created_at")
    .in("user_id", userIds);

  if (effectiveChannel) {
    query = query.eq("channel", effectiveChannel);
  }

  return query
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
}
