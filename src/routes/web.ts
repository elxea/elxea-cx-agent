/**
 * Web Chat Route — POST /api/chat + GET /api/chat/history
 *
 * POST /api/chat は SSE で真のストリーミングレスポンスを返す。
 * Claude API のストリーミングレスポンスのチャンクをリアルタイムで
 * SSE イベントとしてクライアントに転送する。
 */
import type { Context } from "hono";
import type { Env } from "../index";
import { runAgent, runAgentStreaming, type StreamCallbacks } from "../agent/core";
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
import { isValidSyncApiKey } from "../lib/sync-auth";
import { withTimeout } from "../lib/utils";
import { recordResponseTime, recordApiError, sendNegativeFeedbackAlert } from "../lib/alerts";
import { recordBehaviorEvent, type BehaviorAction, type BehaviorEventMetadata } from "../lib/firestore";
import { behaviorEventType } from "../lib/cdp/event-vocabulary";
import { recordCustomerEvent } from "../lib/cdp/events-gateway";
import { resolveCanonicalUserRefs, webSeed } from "../lib/cdp/canonical";
import { runPreferencePipeline } from "../lib/preference-pipeline";

/** 入力テキストの最大文字数 */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * [SEC-B] リクエストが「サーバ経由（信頼済み）」かどうかを判定する。
 *
 * ブラウザは秘密値（SYNC_API_SECRET）を保持できないため、ブラウザから直接叩かれた
 * リクエストは常に false になる。X-API-Key が SYNC_API_SECRET と一致する
 * サーバ間呼び出し（認証済みの web-app サーバ等）だけが true になる。
 *
 * この判定を通ったときだけ、リクエストが自己申告する shopify_customer_id を
 * 「認証済み identity」として信頼する。ブラウザ自己申告の customer_id は
 * なりすまし（他人の customer_id を送るだけで他人になりすませる）を防ぐため無視し、
 * 匿名 web セッション（session_id）として扱う（fail-closed）。
 */
export function isTrustedServerCaller(c: Context<{ Bindings: Env }>): boolean {
  const apiKey = c.req.header("X-API-Key");
  const secret = (c.env as { SYNC_API_SECRET?: string }).SYNC_API_SECRET;
  return isValidSyncApiKey(apiKey, secret);
}

/**
 * [SEC-B] 行動イベント等で使う「実効ユーザーID」を決める純粋関数。
 *
 * サーバ経由（trusted=true）で shopify_customer_id が付いているときだけ
 * それを identity として採用し、それ以外は必ず session_id を使う。
 * ブラウザ自己申告（trusted=false）の customer_id は他人へのなりすまし・
 * 行動データ汚染を防ぐため一切採用しない。
 */
export function effectiveEventUserId(
  trusted: boolean,
  shopifyCustomerId: string | null | undefined,
  sessionId: string,
): string {
  return trusted && shopifyCustomerId ? shopifyCustomerId : sessionId;
}

/**
 * [SEC-3] チャットハンドラでクロスチャネル個人データ（別チャネル/別 session の
 * 履歴・連携済み顧客プロファイル）を返してよいかを決める純粋関数。
 *
 * `resolveUnifiedUserId`（Web）は `user_identity_map.web_session_id === session_id`
 * のときに isLinked=true を返す。これは「session_id を知っている」だけの弱い証明であり、
 * 束縛経路（SEC-1/SEC-2）が破られれば攻撃者の session が被害者の unified_user に
 * 解決され得る。したがってチャットハンドラでは isLinked だけでクロスチャネル個人
 * データを開かない。
 *
 * 開いてよいのは「ライブ検証済みの信頼経路」＝サーバ経由（X-API-Key 検証済み）で
 * かつ検証済み Shopify セッション由来の customer_id が付いているとき（trusted=true）
 * だけに限定する（fail-closed）。生の web_session_id 一致には依拠しない。
 * webChatHistoryHandler の `ownsIdentity` ゲートと同じ精神の多層防御。
 *
 * B-2（非対称の理由・意図的に現状維持）: LINE 側は `identity.isLinked || canonical.linked` で
 *   横断を開くのに、web 側はここで `&& trusted` を要求する。LINE の userId は webhook 署名で
 *   真正性が検証済みなのに対し、web の session_id は「知っているだけ」の弱い証明だから。
 *   この非対称を消す（web も canonical だけで開く）と SEC-3 の fail-closed が壊れる。
 */
export function crossChannelHistoryAllowed(isLinked: boolean, trusted: boolean): boolean {
  return isLinked && trusted;
}

/** 前処理（保存+履歴+Embedding）のタイムアウト（ミリ秒） */
const TIMEOUT_PRE_PARALLEL_MS = 10_000;

/** エージェント実行のタイムアウト（ミリ秒 -- webChatImageHandler で使用） */
const TIMEOUT_RUN_AGENT_MS = 25_000;

/**
 * POST /api/chat
 *
 * リクエストボディ: { "message": string, "session_id": string }
 * レスポンス: SSE 真のストリーミング
 *
 * Claude API のストリーミングレスポンスをリアルタイムで SSE イベントとして
 * クライアントに転送する。ReadableStream を使用し、各チャンクが到着次第
 * 即座にクライアントに送信される。
 */
export async function webChatHandler(c: Context<{ Bindings: Env }>) {
  // レートリミット: 信頼済み proxy (X-API-Key 検証済み) 由来のときだけ転送された実 IP を採用
  const clientIp = getClientIp(c.req.raw, isTrustedServerCaller(c));
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
  const encoder = new TextEncoder();

  // 前処理: Identity 解決 + メッセージ保存 + 履歴取得 + Embedding 生成
  let effectiveUserId = sessionId;
  let history: Array<{ role: "user" | "assistant"; content: string }> = [];
  let embedding: number[];
  let identityIsLinked = false;

  // [SEC-B] shopify_customer_id は「サーバ経由（X-API-Key 検証済み）」のときだけ信頼する。
  // ブラウザ自己申告（X-API-Key 無し）の customer_id は無視し、匿名 web セッション扱いにする。
  const trustedCustomerId = isTrustedServerCaller(c) ? shopify_customer_id : undefined;

  try {
    const identity = trustedCustomerId
      ? await resolveWithShopifyCustomerId(supabase, trustedCustomerId, sessionId)
      : await resolveUnifiedUserId(supabase, sessionId, "web");
    effectiveUserId = identity.unifiedUserId;
    // [SEC-3] クロスチャネル個人データ（別チャネル履歴・連携済みプロファイル）は
    // ライブ検証済みの信頼経路（trustedCustomerId 由来）のときだけ開く。生の
    // web_session_id 一致（isLinked）だけでは開かない（fail-closed・多層防御）。
    const crossChannelAllowed = crossChannelHistoryAllowed(
      identity.isLinked,
      !!trustedCustomerId,
    );
    identityIsLinked = crossChannelAllowed;

    // CDP 統合 Stage 2: canonical 解決（subject_links の連結成分）で「同じ人の鍵」を引く。
    //
    // ⚠ [SEC-3] のゲート（crossChannelAllowed）は **一切緩めない**。canonical が
    //   できるのは「既に横断してよいと決まった人について、読む user_id を増やす」ことだけで、
    //   横断してよいかの判断には関与しない。LINE 側と非対称なのは意図的で、web の
    //   session_id は「知っているだけ」の弱い証明だから（crossChannelHistoryAllowed の
    //   コメント参照）。この 1 行を消せば Stage 2 以前の読み出しに戻る。
    const canonical = crossChannelAllowed
      ? await resolveCanonicalUserRefs(supabase, webSeed(sessionId))
      : { userRefs: [] as string[] };

    console.log("[web] step=pre-parallel");
    const [, fetchedHistory, emb] = await withTimeout(
      Promise.all([
        saveMessage(supabase, {
          userId: sessionId,
          channel: "web",
          role: "user",
          content: processedMessage,
        }),
        crossChannelAllowed
          ? getCrossChannelMessages(
              supabase,
              effectiveUserId,
              undefined,
              30,
              3000,
              sessionId,
              canonical.userRefs,
            )
          : getRecentMessages(supabase, effectiveUserId, "web"),
        createEmbedding(processedMessage, c.env),
      ]),
      TIMEOUT_PRE_PARALLEL_MS,
      "pre-parallel (saveMessage+history+embedding)",
    );
    history = fetchedHistory;
    embedding = emb;

    // 初回メッセージの場合、chat_started イベントを記録（fire-and-forget）
    if (fetchedHistory.length === 0) {
      recordBehaviorEvent(
        effectiveUserId, "web", "chat_started", {},
        c.env as Parameters<typeof recordBehaviorEvent>[4],
        supabase,
      ).catch((err) => console.warn("[web] chat_started event failed:", err instanceof Error ? err.message : err));
    }
  } catch (err) {
    console.error("webChatHandler pre-parallel error:", err);
    recordApiError(c.env, err instanceof Error ? err.message : String(err));
    return c.json({ error: "Internal server error" }, 500);
  }

  // SSE ストリーミングレスポンスを TransformStream で構築
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  /** SSE イベントをストリームに書き込む */
  function writeSSE(data: Record<string, unknown>) {
    writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  }

  // ストリーミングエージェント実行（バックグラウンドで実行し、チャンクを即時送信）
  const streamingPromise = (async () => {
    // meta を onDone コールバック内で参照するために外側で宣言
    let meta: Awaited<ReturnType<typeof runAgentStreaming>> | null = null;
    try {
      console.log("[web] step=runAgentStreaming");

      const callbacks: StreamCallbacks = {
        onTextDelta: (text) => writeSSE({ type: "text_delta", content: text }),
        onProductCards: (products) => writeSSE({ type: "product_card", products }),
        onCartLink: (checkoutUrl) => writeSSE({ type: "cart_link", checkout_url: checkoutUrl }),
        onQuickReplies: (items) => writeSSE({ type: "quick_replies", items }),
        onDone: (fullResponse) => {
          const elapsed = Date.now() - tStart;
          console.log(`[web] step=runAgentStreaming done, total_elapsed=${elapsed}ms`);
          recordResponseTime(c.env, elapsed);

          // done イベント送信
          writeSSE({ type: "done", session_id: sessionId });

          // アシスタント応答を保存（メタデータ付き）
          const metadata: Record<string, unknown> = {};
          if (meta && meta.productCards.length > 0) metadata.product_cards = meta.productCards;
          if (meta && meta.quickReplies.length > 0) metadata.quick_replies = meta.quickReplies;

          c.executionCtx.waitUntil(
            saveMessage(supabase, {
              userId: sessionId,
              channel: "web",
              role: "assistant",
              content: fullResponse,
              ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            }),
          );

          // 嗜好抽出パイプライン（fire-and-forget）
          const fullHistory = [
            ...history,
            { role: "user", content: processedMessage },
            { role: "assistant", content: fullResponse },
          ];
          c.executionCtx.waitUntil(
            runPreferencePipeline(fullHistory, effectiveUserId, "web", c.env, supabase),
          );
        },
        onError: (error) => writeSSE({ type: "error", message: error }),
      };

      meta = await runAgentStreaming(
        processedMessage,
        history,
        embedding,
        effectiveUserId,
        "web",
        c.env,
        callbacks,
        { isLinked: identityIsLinked },
      );
    } catch (err) {
      console.error("webChatHandler streaming error:", err);
      recordApiError(c.env, err instanceof Error ? err.message : String(err));
      try {
        writeSSE({ type: "error", message: "Internal server error" });
        writeSSE({ type: "done", session_id: sessionId });
      } catch { /* writer may already be closed */ }
    } finally {
      try { await writer.close(); } catch { /* ignore */ }
    }
  })();

  // waitUntil でストリーミング完了を保証（Workers がレスポンス送信後も実行を継続）
  c.executionCtx.waitUntil(streamingPromise);

  return new Response(readable, {
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
  const limit = Math.min(Math.max(parseInt(limitParam ?? "100", 10) || 100, 1), 200);
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
  // Web メッセージは元の sessionId で保存されるため、sessionId 自体も必ず含める。
  // また shopify_customer_id でログイン時に web_session_id が更新されるため、
  // 過去の session_id で保存されたメッセージを取りこぼさないよう、
  // conversations テーブルから該当ユーザーの過去の web user_id も収集する。
  const userIds: string[] = [identity.isLinked ? identity.unifiedUserId : (sessionId as string)];

  // 現在の sessionId を常に含める（紐付け済みでも元の sessionId でメッセージが保存されているため）
  if (identity.isLinked && !userIds.includes(sessionId as string)) {
    userIds.push(sessionId as string);
  }

  // [SEC-B] クロスチャネル（LINE 側・別 session）履歴を返してよいか。
  // 既定は isLinked に従うが、所有関係が確認できない場合は下で false に落とす。
  let crossChannelAllowed = identity.isLinked;

  if (identity.isLinked) {
    const { data: identityData } = await supabase
      .from("user_identity_map")
      .select("unified_user_id, line_user_id, web_session_id, shopify_customer_id")
      .eq("unified_user_id", identity.unifiedUserId)
      .single();

    // [SEC-B] クロスチャネル履歴（LINE 側や別 session の履歴）を返す前に、
    // 「この session_id が本当にこの unified_user の登録 web セッションか」を検証する。
    // resolveUnifiedUserId は web_session_id === session_id でのみ isLinked を返すため
    // 通常はここで一致するが、多層防御として明示的に確認し、
    // 一致しない（=所有関係が確認できない）場合はクロスチャネル拡張を行わず、
    // 自 session の web 履歴のみに限定する（未検証でクロスチャネルを返さない）。
    const ownsIdentity =
      isTrustedServerCaller(c) || identityData?.web_session_id === sessionId;

    // 所有関係が確認できないときはクロスチャネル拡張を一切行わず、
    // userIds は自 session（sessionId）のみに保つ（= 自 session の web 履歴だけを返す）。
    if (ownsIdentity) {
      if (identityData?.line_user_id && !userIds.includes(identityData.line_user_id)) {
        userIds.push(identityData.line_user_id);
      }
      if (identityData?.web_session_id && !userIds.includes(identityData.web_session_id)) {
        userIds.push(identityData.web_session_id);
      }
      if (identityData?.shopify_customer_id && !userIds.includes(identityData.shopify_customer_id)) {
        userIds.push(identityData.shopify_customer_id);
      }

      // 過去の異なる session_id で保存された Web メッセージも取得するため、
      // conversations テーブルから該当 user_id の過去の web session を収集
      const { data: pastSessions } = await supabase
        .from("conversations")
        .select("user_id")
        .in("user_id", userIds)
        .eq("channel", "web")
        .limit(1);
      // pastSessions が空 = 現在の userIds では web メッセージが見つからない場合、
      // unified_user_id に紐づく全 conversations の user_id を幅広く取得
      if (!pastSessions || pastSessions.length === 0) {
        const { data: allWebMessages } = await supabase
          .from("conversations")
          .select("user_id")
          .eq("channel", "web")
          .in("user_id", [
            ...(identityData ? [
              identityData.unified_user_id,
              identityData.line_user_id,
              identityData.web_session_id,
              identityData.shopify_customer_id,
            ].filter((id): id is string => !!id) : []),
            sessionId as string,
          ])
          .limit(50);
        if (allWebMessages) {
          for (const row of allWebMessages) {
            if (!userIds.includes(row.user_id)) {
              userIds.push(row.user_id);
            }
          }
        }
      }
    }

    // 所有未確認のときは cross-channel を出さないよう、以降の channel フィルタも web に固定する。
    if (!ownsIdentity) {
      crossChannelAllowed = false;
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
        channel_filter: crossChannelAllowed ? (channelFilter ?? null) : (channelFilter ?? "web"),
        result_limit: limit,
        result_offset: offset,
      },
    );

    if (rpcError) {
      console.error("search_conversations RPC failed, falling back to basic query:", rpcError);
      // フォールバック: 基本クエリ（RPC 未作成の場合）
      const fallbackResult = await basicHistoryQuery(
        supabase, userIds, crossChannelAllowed, channelFilter, limit, offset,
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
    const effectiveChannel = crossChannelAllowed ? channelFilter : (channelFilter ?? "web");

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
    is_linked: crossChannelAllowed,
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

// ---------------------------------------------------------------------------
// Feedback endpoints
// ---------------------------------------------------------------------------

/**
 * POST /api/chat/feedback
 *
 * リクエストボディ: { session_id, message_content, rating: 1|-1, comment?: string }
 * レスポンス: { success: true }
 */
export async function webChatFeedbackHandler(c: Context<{ Bindings: Env }>) {
  let body: {
    session_id?: string;
    message_content?: string;
    rating?: number;
    comment?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { session_id, message_content, rating, comment } = body;

  // session_id バリデーション
  const sessionError = validateSessionId(session_id);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  // rating バリデーション
  if (rating !== 1 && rating !== -1) {
    return c.json({ error: "rating must be 1 or -1" }, 400);
  }

  // message_content バリデーション
  if (typeof message_content !== "string" || message_content.trim().length === 0) {
    return c.json({ error: "message_content is required" }, 400);
  }

  const supabase = createSupabaseClient(c.env);

  // session_id から user_id を解決
  const identity = await resolveUnifiedUserId(supabase, session_id as string, "web");
  const userId = identity.unifiedUserId;

  // message_feedback テーブルに保存
  const { error } = await supabase.from("message_feedback").insert({
    user_id: userId,
    channel: "web",
    message_content: message_content.trim(),
    rating,
    comment: comment?.trim() || null,
  });

  if (error) {
    console.error("Failed to save feedback:", error);
    return c.json({ error: "Failed to save feedback" }, 500);
  }

  // rating = -1 の場合、Slack に通知
  if (rating === -1) {
    c.executionCtx.waitUntil(
      sendNegativeFeedbackAlert(c.env, userId, message_content.trim(), comment?.trim()),
    );
  }

  // 行動イベント記録（fire-and-forget）
  c.executionCtx.waitUntil(
    recordBehaviorEvent(
      userId, "web", "feedback_given",
      { query: rating === 1 ? "positive" : "negative" },
      c.env as Parameters<typeof recordBehaviorEvent>[4],
      supabase,
    ).catch((err) => console.warn("[web] feedback_given event failed:", err instanceof Error ? err.message : err)),
  );

  return c.json({ success: true });
}

/**
 * POST /api/chat/image
 *
 * 画像付きチャットメッセージを処理する。
 * リクエスト: multipart/form-data (image: File, session_id: string, message?: string, shopify_customer_id?: string)
 * レスポンス: JSON { response: string, ... }
 */
export async function webChatImageHandler(c: Context<{ Bindings: Env }>) {
  // レートリミット: 信頼済み proxy (X-API-Key 検証済み) 由来のときだけ転送された実 IP を採用
  const clientIp = getClientIp(c.req.raw, isTrustedServerCaller(c));
  const rateLimitError = checkRateLimit(clientIp);
  if (rateLimitError) {
    return c.json({ error: rateLimitError }, 429);
  }

  // multipart/form-data パース
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid form data" }, 400);
  }

  const imageFile = formData.get("image") as File | null;
  const sessionId = formData.get("session_id") as string | null;
  const message = (formData.get("message") as string | null)?.trim() || "";
  const shopifyCustomerId = formData.get("shopify_customer_id") as string | null;

  // バリデーション
  const sessionError = validateSessionId(sessionId);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  if (!imageFile || !(imageFile instanceof File)) {
    return c.json({ error: "image file is required" }, 400);
  }

  // 画像サイズ制限 (5MB)
  if (imageFile.size > 5 * 1024 * 1024) {
    return c.json({ error: "Image must be less than 5MB" }, 400);
  }

  // MIME タイプチェック
  const validTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!validTypes.includes(imageFile.type)) {
    return c.json({ error: "Image must be JPEG, PNG, WebP, or GIF" }, 400);
  }

  const supabase = createSupabaseClient(c.env);
  const tStart = Date.now();

  try {
    // 画像を base64 に変換
    const arrayBuffer = await imageFile.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const mediaType = imageFile.type === "image/png" ? "image/png" as const : "image/jpeg" as const;

    // [SEC-B] shopify_customer_id はサーバ経由（X-API-Key 検証済み）のときだけ信頼する。
    const trustedCustomerId = isTrustedServerCaller(c) ? shopifyCustomerId : null;

    // Identity 解決
    const identity = trustedCustomerId
      ? await resolveWithShopifyCustomerId(supabase, trustedCustomerId, sessionId as string)
      : await resolveUnifiedUserId(supabase, sessionId as string, "web");
    const effectiveUserId = identity.unifiedUserId;
    // [SEC-3] クロスチャネル個人データはライブ検証済みの信頼経路
    // （trustedCustomerId 由来）のときだけ開く（生の web_session_id 一致では開かない）。
    const crossChannelAllowed = crossChannelHistoryAllowed(
      identity.isLinked,
      !!trustedCustomerId,
    );

    // メッセージ保存
    await saveMessage(supabase, {
      userId: sessionId as string,
      channel: "web",
      role: "user",
      content: message || "[画像メッセージ]",
    });

    // 履歴取得
    // Stage 2: [SEC-3] ゲートはそのまま。横断してよいと決まった人だけ、読む user_id を
    //   canonical 解決の分だけ増やす（テキスト側と同じ扱い）。
    const canonical = crossChannelAllowed
      ? await resolveCanonicalUserRefs(supabase, webSeed(sessionId as string))
      : { userRefs: [] as string[] };
    const history = crossChannelAllowed
      ? await getCrossChannelMessages(
          supabase,
          effectiveUserId,
          undefined,
          30,
          3000,
          sessionId as string,
          canonical.userRefs,
        )
      : await getRecentMessages(supabase, effectiveUserId, "web");

    // 空の Embedding（画像メッセージではナレッジ検索をスキップ）
    const embedding = new Array(1536).fill(0);

    // エージェント実行（画像付き）
    const imagePrompt = message || "この画像について教えてください。";
    const result = await withTimeout(
      runAgent(
        imagePrompt,
        history,
        embedding,
        effectiveUserId,
        "web",
        c.env,
        { isLinked: crossChannelAllowed, imageContent: { base64, mediaType } },
      ),
      TIMEOUT_RUN_AGENT_MS,
      "runAgent (image)",
    );

    const elapsed = Date.now() - tStart;
    recordResponseTime(c.env, elapsed);

    // 応答保存
    c.executionCtx.waitUntil(
      saveMessage(supabase, {
        userId: sessionId as string,
        channel: "web",
        role: "assistant",
        content: result.response,
      }),
    );

    return c.json({
      response: result.response,
      session_id: sessionId,
      ...(result.productCards && result.productCards.length > 0
        ? { product_cards: result.productCards }
        : {}),
      ...(result.quickReplies && result.quickReplies.length > 0
        ? { quick_replies: result.quickReplies }
        : {}),
    });
  } catch (err) {
    console.error("webChatImageHandler error:", err);
    recordApiError(c.env, err instanceof Error ? err.message : String(err));
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * GET /api/chat/feedback/stats
 *
 * クエリパラメータ: session_id（必須）
 * レスポンス: { total, positive, negative, positive_rate }
 */
export async function webChatFeedbackStatsHandler(c: Context<{ Bindings: Env }>) {
  const sessionId = c.req.query("session_id");
  const sessionError = validateSessionId(sessionId);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  const supabase = createSupabaseClient(c.env);
  const identity = await resolveUnifiedUserId(supabase, sessionId as string, "web");
  const userId = identity.unifiedUserId;

  const { data, error } = await supabase
    .from("message_feedback")
    .select("rating")
    .eq("user_id", userId);

  if (error) {
    console.error("Failed to fetch feedback stats:", error);
    return c.json({ error: "Failed to fetch stats" }, 500);
  }

  const total = data?.length ?? 0;
  const positive = data?.filter((r) => r.rating === 1).length ?? 0;
  const negative = data?.filter((r) => r.rating === -1).length ?? 0;
  const positiveRate = total > 0 ? Math.round((positive / total) * 100) / 100 : 0;

  return c.json({
    total,
    positive,
    negative,
    positive_rate: positiveRate,
  });
}

// ---------------------------------------------------------------------------
// Behavior event endpoint
// ---------------------------------------------------------------------------

/** 有効なイベントアクション（Web クライアントから送信可能なもの） */
const VALID_WEB_EVENTS: BehaviorAction[] = [
  "chat_started",
  "product_viewed",
  "cart_link_clicked",
  "feedback_given",
  "survey_completed",
];

/**
 * POST /api/chat/event
 *
 * Web アプリからの行動イベントを Firestore に記録する。
 * リクエストボディ: { session_id, action, metadata?: { productId?, contentId?, ... } }
 * レスポンス: { success: true }
 */
export async function webChatEventHandler(c: Context<{ Bindings: Env }>) {
  let body: {
    session_id?: string;
    shopify_customer_id?: string;
    action?: string;
    metadata?: BehaviorEventMetadata;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { session_id, shopify_customer_id, action, metadata } = body;

  // バリデーション
  const sessionError = validateSessionId(session_id);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  const supabase = createSupabaseClient(c.env);

  if (!action || !VALID_WEB_EVENTS.includes(action as BehaviorAction)) {
    // E1「出来事は捨てない」— **語彙に無い action でも L0 には積む**。
    //
    //   ここは cx-agent 側で唯一「語彙が合わないという理由だけで出来事を捨てていた」
    //   場所である。捨てられた側は何も残らないので、送り手がずれたことに誰も気づけない
    //   （web-app の durationSeconds が数か月落ち続けたのと同じ壊れ方）。
    //
    //   ⚠ 応答は 400 のまま変えない。応答コードは既存クライアントとの契約であり、
    //     Stage 1 の完了条件は「既存の挙動が 1 つも変わらない」ことだから。
    //     E1 が守りたいのは出来事が消えることで、それは積んだ時点で守られている。
    //     400 を落とすのは語彙が L0 の登録簿へ一本化されたあと（Stage 4）。進捗は
    //     ratchet `event-vocabulary-drop-sites`（1 → 0）が固定する。
    if (action && session_id) {
      const occurredAt = new Date().toISOString();
      c.executionCtx.waitUntil(
        recordCustomerEvent(supabase, {
          // 形が壊れている値はここで落ちる（gateway が理由付きで数える）。
          eventType: behaviorEventType(action),
          channel: "web",
          identifier: { kind: "web_session_id", value: session_id },
          dedupe: `rejected@${occurredAt}`,
          source: "cx-agent.web-chat-event",
          occurredAt,
          payload: { rejected_by_legacy_vocabulary: true },
        }),
      );
    }
    return c.json({ error: `Invalid action. Valid actions: ${VALID_WEB_EVENTS.join(", ")}` }, 400);
  }

  // fire-and-forget で記録（レスポンスをブロックしない）
  // [SEC-B] shopify_customer_id はサーバ経由（X-API-Key 検証済み）のときだけ identity として採用する。
  // ブラウザ自己申告（X-API-Key 無し）の customer_id は無視し、匿名 session_id に紐付ける。
  const userId = effectiveEventUserId(
    isTrustedServerCaller(c),
    shopify_customer_id,
    session_id as string,
  );

  c.executionCtx.waitUntil(
    recordBehaviorEvent(
      userId,
      "web",
      action as BehaviorAction,
      metadata ?? {},
      c.env as Parameters<typeof recordBehaviorEvent>[4],
      supabase,
    ).catch((err) => {
      console.warn("[event] recordBehaviorEvent failed:", err instanceof Error ? err.message : err);
    }),
  );

  return c.json({ success: true });
}
