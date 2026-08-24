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

-- 会話履歴（v2: チャネル抽象化対応）
create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,              -- 汎用（line_user_id or session_id）
  channel text not null default 'line', -- 'line' | 'web'
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  metadata jsonb,                     -- 商品カード、クイックリプライ等
  created_at timestamptz default now()
);

create index idx_conversations_user_channel
  on conversations (user_id, channel, created_at desc);

-- 顧客プロフィール（CDP）— **廃止（migration 039）**
--
-- ランタイム参照ゼロ（`from("customer_profiles")` が src/ に 0 件）の死蔵表で、
-- 消去 RPC だけが「別名表」として参照していた。「この LINE はどの顧客か」を持つ表が
-- 3 つある状態そのものが、書く側と読む側が別の表を見る事故の温床だった（再設計 F11）。
--
-- 正本は customer_linkages。user_identity_map は会話履歴の名寄せ用の従属ビュー。
-- 新しいコードはこの表を復活させないこと。

-- 処理済みイベント（べき等性担保）
create table processed_events (
  webhook_event_id text primary key,
  processed_at timestamptz default now()
);

-- 未回答クエリ記録テーブル（ナレッジ不足検知）（v2: チャネル抽象化対応）
create table unanswered_queries (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  channel text not null default 'line',
  query_text text not null,
  max_similarity float default 0,
  result_count int default 0,
  escalated boolean default false,
  created_at timestamptz default now()
);

create index unanswered_queries_created_idx
  on unanswered_queries (created_at desc);

-- ユーザー ID 統合マップ（v2: オムニチャネル対応）
create table user_identity_map (
  id uuid primary key default gen_random_uuid(),
  unified_user_id text not null,
  line_user_id text unique,
  web_session_id text,
  shopify_customer_id text unique,
  linked_at timestamptz default now()
);

create index idx_identity_map_unified on user_identity_map (unified_user_id);
create index idx_identity_map_line on user_identity_map (line_user_id);
create index idx_identity_map_web_session on user_identity_map (web_session_id);

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
