import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../index";
import type { SourceType } from "./query-classifier";

export function createSupabaseClient(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

/** チャネル型 */
export type Channel = "line" | "web";

/** 会話履歴を保存 */
export async function saveMessage(
  supabase: SupabaseClient,
  params: {
    userId: string;
    channel: Channel;
    role: "user" | "assistant";
    content: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const { error } = await supabase.from("conversations").insert({
    user_id: params.userId,
    channel: params.channel,
    role: params.role,
    content: params.content,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });

  if (error) {
    console.error("Failed to save message:", error);
  }
}

/** getRecentMessages のオプション */
export type GetRecentMessagesOptions = {
  /** 取得件数上限（デフォルト: 20） */
  limit?: number;
  /** 合計文字数上限（デフォルト: 2500） */
  maxChars?: number;
  /**
   * true の場合、channel フィルターを外して全チャネルの会話を取得する。
   * unified_user_id が解決済みのユーザーに対して使用する。
   * デフォルト: false
   */
  crossChannel?: boolean;
  /**
   * 特定チャネルのみに絞る場合に指定。
   * crossChannel=true と併用した場合、crossChannel が優先される。
   */
  channelFilter?: Channel;
};

/**
 * 直近の会話履歴を取得。
 *
 * 会話履歴が長すぎるとコンテキストウィンドウを圧迫するため、
 * 文字数上限（maxChars）でトリムする。
 *
 * crossChannel=true の場合、unified_user_id に紐づく全チャネルの
 * 会話を横断して取得する（オムニチャネル会話統合）。
 */
export async function getRecentMessages(
  supabase: SupabaseClient,
  userId: string,
  channel: Channel,
  limitOrOptions?: number | GetRecentMessagesOptions,
  maxChars?: number,
): Promise<{ role: "user" | "assistant"; content: string }[]> {
  // 後方互換: 第4引数が number の場合は旧シグネチャとして扱う
  let options: GetRecentMessagesOptions;
  if (typeof limitOrOptions === "number") {
    options = { limit: limitOrOptions, maxChars: maxChars ?? 2500 };
  } else {
    options = limitOrOptions ?? {};
  }

  const effectiveLimit = options.limit ?? 20;
  const effectiveMaxChars = options.maxChars ?? 2500;
  const crossChannel = options.crossChannel ?? false;

  let query = supabase
    .from("conversations")
    .select("role, content, channel")
    .eq("user_id", userId);

  if (crossChannel) {
    // 全チャネル横断: user_identity_map で紐づいた全 user_id の会話を取得
    // ここでは unified_user_id で保存されたレコードを取得する
    // channel フィルターは適用しない
  } else if (options.channelFilter) {
    query = query.eq("channel", options.channelFilter);
  } else {
    query = query.eq("channel", channel);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(effectiveLimit);

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
    if (totalChars <= effectiveMaxChars) {
      acc.unshift(msg);
    }
    return acc;
  }, [] as typeof messages);

  return trimmedStart;
}

/**
 * クロスチャネル会話履歴を取得（unified_user_id 対応）。
 *
 * unified_user_id に紐づく全ての user_id（元の LINE userId、session_id 等）の
 * 会話を統合して取得する。紐付け情報は user_identity_map テーブルから取得。
 *
 * @param unifiedUserId - 解決済みの unified_user_id
 * @param channelFilter - 特定チャネルのみ取得する場合に指定（省略時は全チャネル）
 */
export async function getCrossChannelMessages(
  supabase: SupabaseClient,
  unifiedUserId: string,
  channelFilter?: Channel,
  limit = 20,
  maxChars = 2500,
): Promise<{ role: "user" | "assistant"; content: string; channel: string }[]> {
  // user_identity_map から紐づいた全 user_id を取得
  const { data: identityData } = await supabase
    .from("user_identity_map")
    .select("unified_user_id, line_user_id, web_session_id")
    .eq("unified_user_id", unifiedUserId)
    .single();

  // unified_user_id 自身 + 紐づいた各チャネルの user_id を収集
  const userIds: string[] = [unifiedUserId];
  if (identityData?.line_user_id && identityData.line_user_id !== unifiedUserId) {
    userIds.push(identityData.line_user_id);
  }
  if (identityData?.web_session_id && identityData.web_session_id !== unifiedUserId) {
    userIds.push(identityData.web_session_id);
  }

  let query = supabase
    .from("conversations")
    .select("role, content, channel")
    .in("user_id", userIds);

  if (channelFilter) {
    query = query.eq("channel", channelFilter);
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("Failed to fetch cross-channel messages:", error);
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

/** ナレッジ検索結果の型 */
export type KnowledgeChunk = {
  id: string;
  content: string;
  source_type: string;
  source_title: string;
  similarity: number;
};

/**
 * ベクトル検索でナレッジを取得。
 *
 * MS3 3.1/3.2: threshold と topK をパラメータ化して
 * チューニング可能にする。
 *
 * @param filterSourceType null の場合はフィルタなし（全 source_type を検索）
 */
export async function searchKnowledge(
  supabase: SupabaseClient,
  embedding: number[],
  topK = 5,
  threshold = 0.5,
  filterSourceType: SourceType = null,
): Promise<KnowledgeChunk[]> {
  const params: Record<string, unknown> = {
    query_embedding: embedding,
    match_count: topK,
    match_threshold: threshold,
  };
  if (filterSourceType) {
    params.filter_source_type = filterSourceType;
  }

  const { data, error } = await supabase.rpc("search_knowledge", params);

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
 *
 * @param filterSourceType null の場合はフィルタなし。classifyQuery() で自動判定した値を渡す。
 */
export async function searchKnowledgeHybrid(
  supabase: SupabaseClient,
  embedding: number[],
  queryText: string,
  topK = 5,
  threshold = 0.3,
  filterSourceType: SourceType = null,
): Promise<KnowledgeChunk[]> {
  const params: Record<string, unknown> = {
    query_embedding: embedding,
    query_text: queryText,
    match_count: topK,
    match_threshold: threshold,
  };
  if (filterSourceType) {
    params.filter_source_type = filterSourceType;
  }

  const { data, error } = await supabase.rpc("search_knowledge_hybrid", params);

  if (error) {
    console.error("Hybrid search failed:", error);
    // フォールバック: 通常のベクトル検索（フィルタも引き継ぐ）
    return searchKnowledge(supabase, embedding, topK, threshold, filterSourceType);
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
    userId: string;
    channel: Channel;
    queryText: string;
    maxSimilarity: number;
    resultCount: number;
    escalated: boolean;
  },
): Promise<void> {
  const { error } = await supabase.from("unanswered_queries").insert({
    user_id: params.userId,
    channel: params.channel,
    query_text: params.queryText,
    max_similarity: params.maxSimilarity,
    result_count: params.resultCount,
    escalated: params.escalated,
  });

  if (error) {
    console.error("Failed to log unanswered query:", error);
  }
}
