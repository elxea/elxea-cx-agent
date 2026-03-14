-- elxea-agent: Supabase schema
-- 拡張を有効化
create extension if not exists vector;
create extension if not exists pg_trgm;

-- ナレッジベース（Notion から同期されたチャンク）
create table knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  notion_page_id text not null,
  source_type text not null, -- 'product', 'faq', 'content', 'brand'
  source_title text not null,
  content text not null,
  embedding vector(1024), -- @cf/baai/bge-m3 (Cloudflare Workers AI)
  metadata jsonb default '{}',
  notion_last_edited_at timestamptz,
  synced_at timestamptz default now(),
  created_at timestamptz default now(),

  -- 同じ Notion ページ ID + チャンク位置での重複を防止
  unique (notion_page_id, content)
);

-- ベクトル検索用のインデックス
create index knowledge_chunks_embedding_idx
  on knowledge_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- キーワード検索用のトライグラムインデックス（日本語対応）
create index knowledge_chunks_content_trgm_idx
  on knowledge_chunks using gin (content gin_trgm_ops);

create index knowledge_chunks_title_trgm_idx
  on knowledge_chunks using gin (source_title gin_trgm_ops);

-- 会話履歴
create table conversations (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz default now()
);

create index conversations_user_idx
  on conversations (line_user_id, created_at desc);

-- 顧客プロフィール（CDP）
create table customer_profiles (
  id uuid primary key default gen_random_uuid(),
  line_user_id text unique,
  shopify_customer_id text unique,
  email text,
  display_name text,
  preferences jsonb default '{}',
  metadata jsonb default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index customer_profiles_line_idx
  on customer_profiles (line_user_id);

-- 処理済みイベント（べき等性担保）
create table processed_events (
  webhook_event_id text primary key,
  processed_at timestamptz default now()
);

-- 未回答クエリ記録テーブル（ナレッジ不足検知）
create table unanswered_queries (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null,
  query_text text not null,
  max_similarity float default 0,
  result_count int default 0,
  escalated boolean default false,
  created_at timestamptz default now()
);

create index unanswered_queries_created_idx
  on unanswered_queries (created_at desc);

-- ナレッジ検索用の RPC 関数（ベクトル検索のみ）
create or replace function search_knowledge(
  query_embedding vector(1024),
  match_count int default 5,
  match_threshold float default 0.5
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
  order by kc.embedding <=> query_embedding
  limit match_count;
end;
$$;

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
