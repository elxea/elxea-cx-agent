-- 007: 会話履歴の検索機能強化
-- keyword (全文検索), date range, pagination 対応
--
-- pg_trgm 拡張は既に有効化済み（schema.sql / 003_hybrid_search.sql）
-- conversations.content に対するトライグラムインデックスを追加し、
-- 日本語キーワード検索を実現する。

-- ============================================================
-- 1. conversations.content に pg_trgm インデックス追加
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_conversations_content_trgm
  ON conversations USING gin (content gin_trgm_ops);

-- ============================================================
-- 2. 会話履歴検索 RPC 関数
-- ============================================================
-- keyword: 部分一致検索（pg_trgm + ILIKE）
-- date_from / date_to: 日付範囲フィルタ
-- user_ids: 検索対象の user_id 配列
-- channel_filter: チャネルフィルタ（NULL なら全チャネル）
-- result_limit / result_offset: ページネーション

CREATE OR REPLACE FUNCTION search_conversations(
  user_ids text[],
  keyword text DEFAULT NULL,
  date_from timestamptz DEFAULT NULL,
  date_to timestamptz DEFAULT NULL,
  channel_filter text DEFAULT NULL,
  result_limit int DEFAULT 50,
  result_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  role text,
  content text,
  channel text,
  metadata jsonb,
  created_at timestamptz,
  total_count bigint
)
LANGUAGE plpgsql
AS $$
DECLARE
  _total bigint;
BEGIN
  -- まず total_count を取得
  SELECT count(*) INTO _total
  FROM conversations c
  WHERE c.user_id = ANY(user_ids)
    AND (channel_filter IS NULL OR c.channel = channel_filter)
    AND (keyword IS NULL OR keyword = '' OR c.content ILIKE '%' || keyword || '%')
    AND (date_from IS NULL OR c.created_at >= date_from)
    AND (date_to IS NULL OR c.created_at <= date_to);

  RETURN QUERY
  SELECT
    c.id,
    c.role,
    c.content,
    c.channel,
    c.metadata,
    c.created_at,
    _total AS total_count
  FROM conversations c
  WHERE c.user_id = ANY(user_ids)
    AND (channel_filter IS NULL OR c.channel = channel_filter)
    AND (keyword IS NULL OR keyword = '' OR c.content ILIKE '%' || keyword || '%')
    AND (date_from IS NULL OR c.created_at >= date_from)
    AND (date_to IS NULL OR c.created_at <= date_to)
  ORDER BY c.created_at ASC
  LIMIT result_limit
  OFFSET result_offset;
END;
$$;

-- ============================================================
-- ロールバック手順（緊急時のみ実行）
-- ============================================================
-- DROP FUNCTION IF EXISTS search_conversations;
-- DROP INDEX IF EXISTS idx_conversations_content_trgm;
