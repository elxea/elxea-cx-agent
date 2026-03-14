-- Migration: ハイブリッド検索（ベクトル + キーワード）
-- pg_trgm を使った日本語対応キーワード検索を追加

-- トライグラム拡張を有効化（日本語テキスト検索対応）
create extension if not exists pg_trgm;

-- content カラムにトライグラム GIN インデックスを追加
create index if not exists knowledge_chunks_content_trgm_idx
  on knowledge_chunks using gin (content gin_trgm_ops);

-- source_title にもインデックス追加（タイトル検索用）
create index if not exists knowledge_chunks_title_trgm_idx
  on knowledge_chunks using gin (source_title gin_trgm_ops);

-- Notion ページの最終更新日時カラムを追加（差分同期用 MS4）
alter table knowledge_chunks
  add column if not exists notion_last_edited_at timestamptz;

-- ハイブリッド検索 RPC（ベクトル類似度 + キーワードブースト）
create or replace function search_knowledge_hybrid(
  query_embedding vector(1024),
  query_text text,
  match_count int default 5,
  match_threshold float default 0.3
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
  where (1 - (kc.embedding <=> query_embedding)) > match_threshold
     or (query_text is not null and query_text != ''
         and (kc.content ilike '%' || query_text || '%'
              or kc.source_title ilike '%' || query_text || '%'))
  order by similarity desc
  limit match_count;
end;
$$;
