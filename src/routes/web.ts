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
} from "../lib/supabase";
import {
  validateSessionId,
  checkRateLimit,
  getClientIp,
} from "../lib/web-auth";
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
  let body: { message?: string; session_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { message, session_id } = body;

  // session_id バリデーション
  const sessionError = validateSessionId(session_id);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
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

  // メイン処理を try-catch で包む（unhandled rejection によるハングを防止）
  let result: Awaited<ReturnType<typeof runAgent>>;
  try {
    console.log("[web] step=pre-parallel");
    // メッセージ保存・履歴取得・Embedding 生成を並列実行（各 8 秒タイムアウト）
    const [, history, embedding] = await withTimeout(
      Promise.all([
        saveMessage(supabase, {
          userId: sessionId,
          channel: "web",
          role: "user",
          content: processedMessage,
        }),
        getRecentMessages(supabase, sessionId, "web"),
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
        sessionId,
        "web",
        c.env,
      ),
      20_000,
      "runAgent",
    );
    console.log("[web] step=runAgent done");
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
 * クエリパラメータ: ?session_id=xxx
 * レスポンス: { messages: [...] }
 */
export async function webChatHistoryHandler(c: Context<{ Bindings: Env }>) {
  const sessionId = c.req.query("session_id");

  const sessionError = validateSessionId(sessionId);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  const supabase = createSupabaseClient(c.env);

  // メタデータも含めて取得
  const { data, error } = await supabase
    .from("conversations")
    .select("role, content, metadata, created_at")
    .eq("user_id", sessionId as string)
    .eq("channel", "web")
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    console.error("Failed to fetch chat history:", error);
    return c.json({ error: "Failed to fetch history" }, 500);
  }

  const messages = (data ?? []).map((row) => ({
    role: row.role,
    content: row.content,
    created_at: row.created_at,
    ...(row.metadata?.product_cards
      ? { product_cards: row.metadata.product_cards }
      : {}),
    ...(row.metadata?.quick_replies
      ? { quick_replies: row.metadata.quick_replies }
      : {}),
  }));

  return c.json({ messages });
}
