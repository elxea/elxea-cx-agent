import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../index";

export function createSupabaseClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

/** 会話履歴を保存 */
export async function saveMessage(
  supabase: SupabaseClient,
  params: {
    lineUserId: string;
    role: "user" | "assistant";
    content: string;
  },
): Promise<void> {
  const { error } = await supabase.from("conversations").insert({
    line_user_id: params.lineUserId,
    role: params.role,
    content: params.content,
  });

  if (error) {
    console.error("Failed to save message:", error);
  }
}

/**
 * 直近の会話履歴を取得。
 *
 * 会話履歴が長すぎるとコンテキストウィンドウを圧迫するため、
 * 文字数上限（maxChars）でトリムする。
 */
export async function getRecentMessages(
  supabase: SupabaseClient,
  lineUserId: string,
  limit = 20,
  maxChars = 4000,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const { data, error } = await supabase
    .from("conversations")
    .select("role, content")
    .eq("line_user_id", lineUserId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("Failed to fetch messages:", error);
    return [];
  }

  // 新しい順→古い順に反転
  const messages = (data ?? []).reverse();

  // 合計文字数が maxChars を超えたら古いメッセージから除外
  let totalChars = 0;
  const trimmedStart = messages.reduceRight((acc, msg) => {
    totalChars += msg.content.length;
    if (totalChars <= maxChars) {
      acc.unshift(msg);
    }
    return acc;
  }, [] as typeof messages);

  return trimmedStart;
}

/**
 * ベクトル検索でナレッジを取得。
 *
 * MS3 3.1/3.2: threshold と topK をパラメータ化して
 * チューニング可能にする。
 */
export async function searchKnowledge(
  supabase: SupabaseClient,
  embedding: number[],
  topK = 5,
  threshold = 0.5,
): Promise<
  {
    id: string;
    content: string;
    source_type: string;
    source_title: string;
    similarity: number;
  }[]
> {
  const { data, error } = await supabase.rpc("search_knowledge", {
    query_embedding: embedding,
    match_count: topK,
    match_threshold: threshold,
  });

  if (error) {
    console.error("Knowledge search failed:", error);
    return [];
  }

  return data ?? [];
}

/**
 * ハイブリッド検索（ベクトル + キーワード）。
 *
 * MS3 3.3/3.4: pg_trgm による日本語キーワード検索を
 * ベクトル検索と組み合わせて精度を向上。
 */
export async function searchKnowledgeHybrid(
  supabase: SupabaseClient,
  embedding: number[],
  queryText: string,
  topK = 5,
  threshold = 0.3,
): Promise<
  {
    id: string;
    content: string;
    source_type: string;
    source_title: string;
    similarity: number;
  }[]
> {
  const { data, error } = await supabase.rpc("search_knowledge_hybrid", {
    query_embedding: embedding,
    query_text: queryText,
    match_count: topK,
    match_threshold: threshold,
  });

  if (error) {
    console.error("Hybrid search failed:", error);
    // フォールバック: 通常のベクトル検索
    return searchKnowledge(supabase, embedding, topK, threshold);
  }

  return data ?? [];
}

/**
 * 未回答クエリを記録（MS7 7.6: ナレッジ不足検知）。
 *
 * 検索結果が 0 件、または最大類似度が低い場合に呼び出す。
 */
export async function logUnansweredQuery(
  supabase: SupabaseClient,
  params: {
    lineUserId: string;
    queryText: string;
    maxSimilarity: number;
    resultCount: number;
    escalated: boolean;
  },
): Promise<void> {
  const { error } = await supabase.from("unanswered_queries").insert({
    line_user_id: params.lineUserId,
    query_text: params.queryText,
    max_similarity: params.maxSimilarity,
    result_count: params.resultCount,
    escalated: params.escalated,
  });

  if (error) {
    console.error("Failed to log unanswered query:", error);
  }
}
