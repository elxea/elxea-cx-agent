-- Migration 005: メタデータフィルタリング対応
-- search_knowledge / search_knowledge_hybrid に source_type フィルタパラメータを追加
-- Claude がクエリ内容からカテゴリを判定し、フィルタパラメータを設定する方式

-- source_type インデックスを追加（フィルタリング高速化）
create index if not exists knowledge_chunks_source_type_idx
  on knowledge_chunks (source_type);

-- ベクトル検索 RPC をフィルタリング対応に更新
create or replace function search_knowledge(
  query_embedding vector(1024),
  match_count int default 5,
  match_threshold float default 0.5,
  filter_source_type text default null  -- NULL の場合はフィルタなし
)
returns table (
  id uuid,
  content text,
  source_type text,
  source_title text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    kc.id,
    kc.content,
    kc.source_type,
    kc.source_title,
    1 - (kc.embedding <=> query_embedding) as similarity
  from knowledge_chunks kc
  where 1 - (kc.embedding <=> query_embedding) > match_threshold
    and (filter_source_type is null or kc.source_type = filter_source_type)
  order by kc.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- ハイブリッド検索 RPC をフィルタリング対応に更新
create or replace function search_knowledge_hybrid(
  query_embedding vector(1024),
  query_text text,
  match_count int default 5,
  match_threshold float default 0.3,
  filter_source_type text default null  -- NULL の場合はフィルタなし
)
returns table (
  id uuid,
  content text,
  source_type text,
  source_title text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    kc.id,
    kc.content,
    kc.source_type,
    kc.source_title,
    (
      (1 - (kc.embedding <=> query_embedding))::float +
      case
        when query_text is not null and query_text != ''
             and (kc.content ilike '%' || query_text || '%'
                  or kc.source_title ilike '%' || query_text || '%')
        then 0.1
        else 0
      end
    ) as similarity
  from knowledge_chunks kc
  where (
    (1 - (kc.embedding <=> query_embedding)) > match_threshold
    or (query_text is not null and query_text != ''
        and (kc.content ilike '%' || query_text || '%'
             or kc.source_title ilike '%' || query_text || '%'))
  )
  and (filter_source_type is null or kc.source_type = filter_source_type)
  order by similarity desc
  limit match_count;
end;
$$;
