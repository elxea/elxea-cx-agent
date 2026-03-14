-- Migration: LINE ↔ Shopify 顧客紐付けテーブル (MS6 6.5)
-- LINE user_id と Shopify customer_id のマッピングを管理

create table if not exists customer_linkages (
  id uuid primary key default gen_random_uuid(),
  line_user_id text not null unique,
  shopify_customer_id text unique,
  shopify_email text,
  linked_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index customer_linkages_line_idx
  on customer_linkages (line_user_id);

create index customer_linkages_shopify_idx
  on customer_linkages (shopify_customer_id);

-- 同期ログテーブル（MS4 4.7: 同期モニタリング）
create table if not exists sync_logs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  completed_at timestamptz,
  status text not null check (status in ('running', 'success', 'partial_failure', 'failure')),
  total_pages int default 0,
  added_chunks int default 0,
  updated_chunks int default 0,
  deleted_chunks int default 0,
  error_count int default 0,
  error_details jsonb default '[]',
  duration_ms int,
  created_at timestamptz default now()
);
