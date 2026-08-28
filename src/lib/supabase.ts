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

/** 旧 join（user_identity_map）の 1 行。null 許容の 3 列だけを見る。 */
export type LegacyIdentityRow = {
  line_user_id?: string | null;
  web_session_id?: string | null;
  shopify_customer_id?: string | null;
};

/**
 * 「同じ人の会話」を引くための user_id の集合を組み立てる（純関数）。
 *
 * ここが Stage 2 の「フォールバック付き読出」の実体である。
 *
 *   旧 join の分（unifiedUserId + user_identity_map の 3 列 + 元の sessionId）
 * + canonical 解決の分（subject_links の連結成分から引いた鍵）
 *
 * **足すだけで、旧 join の結果は 1 つも削らない。** だから
 * `extraUserIds` を渡さなければ Stage 2 以前と 1 件も違わない結果になり、
 * canonical 側が落ちても（resolveCanonicalUserRefs が空配列を返す）
 * 履歴が減ることは無い。
 *
 * DB にも HTTP にも触れないので、新旧の差分だけを単体で固定できる
 * （tests/db/cdp-stage2-canonical.db.test.ts が合成データでこれを回す）。
 */
export function unionCrossChannelUserIds(input: {
  unifiedUserId: string;
  legacy?: LegacyIdentityRow;
  originalSessionId?: string;
  extraUserIds?: string[];
}): string[] {
  const userIds: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v !== "" && !userIds.includes(v)) userIds.push(v);
  };

  // unified_user_id 自身 + 紐づいた各チャネルの user_id（旧 join）
  add(input.unifiedUserId);
  add(input.legacy?.line_user_id);
  add(input.legacy?.web_session_id);
  add(input.legacy?.shopify_customer_id);
  // 元の sessionId（Web メッセージは sessionId で保存されるため）
  add(input.originalSessionId);
  // canonical 解決の分（★11 の断線が塞がるのはこの足し算による）
  for (const ref of input.extraUserIds ?? []) add(ref);

  return userIds;
}

/**
 * クロスチャネル会話履歴を取得（unified_user_id 対応）。
 *
 * unified_user_id に紐づく全ての user_id（元の LINE userId、session_id 等）の
 * 会話を統合して取得する。紐付け情報は user_identity_map テーブルから取得。
 *
 * ## canonical 解決の分を足す（CDP 統合 Stage 2 / ★11 の恒久解）
 *
 * `extraUserIds` は `subject_links` の連結成分から引いた「同じ人の鍵」
 * （`src/lib/cdp/canonical.ts`）。**旧 join の結果に足すだけ**で、置き換えない。
 *
 * - 足すだけなので、旧 join が拾えていた会話を 1 件も落とさない。
 * - `extraUserIds` を渡さなければ Stage 2 以前とまったく同じ結果になる
 *   （＝ 呼び出し側で引数を外せば元に戻る。これが「フォールバック付き読出」の実体）。
 * - LIFF / Account Link で連携した人は `customer_linkages` にしか行が無く、
 *   ここが引く `user_identity_map` には現れない。★11 の断線が塞がるのはこの足し算による。
 *
 * @param unifiedUserId - 解決済みの unified_user_id
 * @param channelFilter - 特定チャネルのみ取得する場合に指定（省略時は全チャネル）
 * @param extraUserIds - canonical 解決で分かった同じ人の user_id（旧 join に足す）
 */
export async function getCrossChannelMessages(
  supabase: SupabaseClient,
  unifiedUserId: string,
  channelFilter?: Channel,
  limit = 30,
  maxChars = 3000,
  /** 元の sessionId（Web メッセージは sessionId で保存されるため、検索対象に含める） */
  originalSessionId?: string,
  extraUserIds?: string[],
): Promise<{ role: "user" | "assistant"; content: string; channel: string }[]> {
  // user_identity_map から紐づいた全 user_id を取得
  const { data: identityData } = await supabase
    .from("user_identity_map")
    .select("unified_user_id, line_user_id, web_session_id, shopify_customer_id")
    .eq("unified_user_id", unifiedUserId)
    .single();

  const userIds = unionCrossChannelUserIds({
    unifiedUserId,
    legacy: identityData ?? undefined,
    originalSessionId,
    extraUserIds,
  });

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
  // NOTE: filter_source_type パラメータ付きの RPC が DB 上に存在しない場合があるため、
  // フィルタなしで検索し、アプリ側で source_type フィルタを適用する。
  const params: Record<string, unknown> = {
    query_embedding: embedding,
    match_count: filterSourceType ? topK * 3 : topK,
    match_threshold: threshold,
  };

  const { data, error } = await supabase.rpc("search_knowledge", params);

  if (error) {
    console.error("[searchKnowledge] RPC failed:", error);
    return [];
  }

  let results: KnowledgeChunk[] = data ?? [];

  // アプリ側で source_type フィルタを適用
  if (filterSourceType) {
    results = results.filter((r) => r.source_type === filterSourceType);
  }

  return results.slice(0, topK);
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
  // ゼロベクトル検知: Workers AI が失敗した場合のログ
  const isZeroVector = embedding.every((v) => v === 0);
  if (isZeroVector) {
    console.warn("[searchKnowledgeHybrid] Zero vector detected — embedding generation likely failed. Search will rely on keyword matching only.");
  }

  // NOTE: filter_source_type パラメータ付きの RPC が DB 上に存在しない場合があるため、
  // フィルタなしで検索し、アプリ側で source_type フィルタを適用する。
  const params: Record<string, unknown> = {
    query_embedding: embedding,
    query_text: queryText,
    match_count: filterSourceType ? topK * 3 : topK,
    match_threshold: threshold,
  };

  console.log(`[searchKnowledgeHybrid] query="${queryText}", filter=${filterSourceType ?? "none"}, threshold=${threshold}, topK=${topK}`);

  const { data, error } = await supabase.rpc("search_knowledge_hybrid", params);

  if (error) {
    console.error("[searchKnowledgeHybrid] RPC failed:", error);
    // フォールバック: 通常のベクトル検索（フィルタも引き継ぐ）
    return searchKnowledge(supabase, embedding, topK, threshold, filterSourceType);
  }

  // NaN similarity をフィルタ（ゼロベクトルの場合に発生し得る）
  let filtered = (data ?? []).filter(
    (r: KnowledgeChunk) => !Number.isNaN(r.similarity),
  );

  // アプリ側で source_type フィルタを適用
  if (filterSourceType) {
    filtered = filtered.filter((r: KnowledgeChunk) => r.source_type === filterSourceType);
  }

  const results = filtered.slice(0, topK);

  console.log(`[searchKnowledgeHybrid] results=${results.length} (raw=${data?.length ?? 0}, after_nan_filter=${filtered.length})`);

  return results;
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
