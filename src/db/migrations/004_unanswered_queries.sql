-- Migration: 未回答クエリ記録テーブル（MS7 7.6）
-- ナレッジベースに該当情報がなかった質問を自動記録し、
-- ナレッジ拡充の優先度付けに活用する。

create table if not exists unanswered_queries (
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

-- sync_logs に sync_type カラムを追加（差分同期 MS4）
alter table sync_logs
  add column if not exists sync_type text default 'full'
  check (sync_type in ('full', 'incremental'));
