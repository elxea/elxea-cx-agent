-- Migration 012: ハイブリッド検索の修正
-- 1. search_knowledge のオーバーロード問題を修正（旧3パラメータ版を削除）
-- 2. search_knowledge_hybrid のキーワード検索を改善（単語分割 OR 検索）
-- 3. NaN similarity 対策（ゼロベクトル時の安全対策）

-- 旧 search_knowledge のオーバーロードを解消
-- 3パラメータ版が残っている場合に PostgREST がオーバーロード解決に失敗する
DROP FUNCTION IF EXISTS search_knowledge(vector(1024), int, float);

-- search_knowledge を再作成（4パラメータ版のみ）
CREATE OR REPLACE FUNCTION search_knowledge(
  query_embedding vector(1024),
  match_count int default 5,
  match_threshold float default 0.5,
  filter_source_type text default null
)
RETURNS TABLE (
  id uuid,
  content text,
  source_type text,
  source_title text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    kc.source_type,
    kc.source_title,
    (1 - (kc.embedding <=> query_embedding))::float AS similarity
  FROM knowledge_chunks kc
  WHERE (1 - (kc.embedding <=> query_embedding)) > match_threshold
    AND (filter_source_type IS NULL OR kc.source_type = filter_source_type)
  ORDER BY kc.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- search_knowledge_hybrid を改善:
-- - キーワード検索をスペース区切りで分割し、各単語で OR 検索
-- - NaN similarity を除外（ゼロベクトル時の安全対策）
DROP FUNCTION IF EXISTS search_knowledge_hybrid(vector(1024), text, int, float);
DROP FUNCTION IF EXISTS search_knowledge_hybrid(vector(1024), text, int, float, text);

CREATE OR REPLACE FUNCTION search_knowledge_hybrid(
  query_embedding vector(1024),
  query_text text,
  match_count int default 5,
  match_threshold float default 0.3,
  filter_source_type text default null
)
RETURNS TABLE (
  id uuid,
  content text,
  source_type text,
  source_title text,
  similarity float
)
LANGUAGE plpgsql
AS $$
DECLARE
  keyword text;
  keywords text[];
  has_keyword_match boolean;
BEGIN
  -- クエリテキストをスペースで分割してキーワード配列を作成
  IF query_text IS NOT NULL AND query_text != '' THEN
    keywords := string_to_array(regexp_replace(trim(query_text), '\s+', ' ', 'g'), ' ');
  ELSE
    keywords := ARRAY[]::text[];
  END IF;

  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    kc.source_type,
    kc.source_title,
    (
      CASE
        WHEN (1 - (kc.embedding <=> query_embedding))::float != 'NaN'::float
        THEN (1 - (kc.embedding <=> query_embedding))::float
        ELSE 0.0
      END
      +
      -- 各キーワードのマッチに 0.05 ずつブースト（最大 0.2）
      LEAST(0.2, (
        SELECT COALESCE(SUM(
          CASE WHEN kc.content ILIKE '%' || kw || '%'
                 OR kc.source_title ILIKE '%' || kw || '%'
               THEN 0.05
               ELSE 0
          END
        ), 0)
        FROM unnest(keywords) AS kw
      ))
    )::float AS similarity
  FROM knowledge_chunks kc
  WHERE (
    -- ベクトル検索: similarity > threshold（NaN は除外）
    (
      (1 - (kc.embedding <=> query_embedding))::float != 'NaN'::float
      AND (1 - (kc.embedding <=> query_embedding)) > match_threshold
    )
    OR
    -- キーワード検索: いずれかのキーワードが content または title に含まれる
    (
      array_length(keywords, 1) > 0
      AND EXISTS (
        SELECT 1 FROM unnest(keywords) AS kw
        WHERE kc.content ILIKE '%' || kw || '%'
           OR kc.source_title ILIKE '%' || kw || '%'
      )
    )
  )
  AND (filter_source_type IS NULL OR kc.source_type = filter_source_type)
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;
