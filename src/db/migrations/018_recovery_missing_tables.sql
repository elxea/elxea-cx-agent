-- 018: R1 復旧マイグレーション（不在 3 テーブルの冪等復旧）
--
-- 背景: migration 002（customer_linkages / sync_logs）と 014（pending_follow_refs）が
--       本番未適用（または drop 済み）。017 のコメントで不在が明記されている。
--       この 3 テーブル不在が「顧客連携の no-op 化」「同期台帳の記録不能（= 4 ヶ月無音故障）」
--       「QR 経由ウェルカム不達」の根因。
--
-- 目的: 002 / 004（sync_logs への sync_type 追加）/ 014 を 1 本に統合し、
--       単体で流せる自己完結・冪等（IF NOT EXISTS / ADD COLUMN IF NOT EXISTS）な復旧 SQL にする。
--       002 → 004 の順序依存（004 が sync_logs 前提で ALTER）をこの 1 本で解消する。
--
-- 冪等性: 全 DDL は再実行安全。既存テーブルがあっても無害（何も壊さない）。
-- 適用: docs/r1-recovery-runbook.md 参照。本番適用は ENV-3 ゲート（staging 検証 → Setaka 承認）後。

-- ===================================================================
-- 1. customer_linkages（migration 002 由来）
--    LINE user_id ↔ Shopify customer_id のマッピング
-- ===================================================================
CREATE TABLE IF NOT EXISTS customer_linkages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  line_user_id text NOT NULL UNIQUE,
  shopify_customer_id text UNIQUE,
  shopify_email text,
  linked_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_linkages_line_idx
  ON customer_linkages (line_user_id);

CREATE INDEX IF NOT EXISTS customer_linkages_shopify_idx
  ON customer_linkages (shopify_customer_id);

-- ===================================================================
-- 2. sync_logs（migration 002 由来 + 004 の sync_type カラム）
--    同期の実行台帳（開始・完了・件数・状態）。外部番犬（Spec 6.2）の監視ソース。
-- ===================================================================
CREATE TABLE IF NOT EXISTS sync_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  status text NOT NULL CHECK (status IN ('running', 'success', 'partial_failure', 'failure')),
  total_pages int DEFAULT 0,
  added_chunks int DEFAULT 0,
  updated_chunks int DEFAULT 0,
  deleted_chunks int DEFAULT 0,
  error_count int DEFAULT 0,
  error_details jsonb DEFAULT '[]',
  duration_ms int,
  created_at timestamptz DEFAULT now()
);

-- 004 由来: 差分同期の種別カラム（002 の CREATE 後に追加された列を取り込む）
ALTER TABLE sync_logs
  ADD COLUMN IF NOT EXISTS sync_type text DEFAULT 'full'
  CHECK (sync_type IN ('full', 'incremental'));

-- ===================================================================
-- 3. pending_follow_refs（migration 014 由来）
--    QR コード同梱物経由の友だち追加で ref を一時保存（ワンタイム読み取り）
-- ===================================================================
CREATE TABLE IF NOT EXISTS pending_follow_refs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  line_user_id text NOT NULL UNIQUE,
  ref text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_follow_refs_expires
  ON pending_follow_refs (expires_at);

-- ===================================================================
-- 4. RLS 有効化（migration 017 と同じセキュリティ姿勢）
--    017 は不在ゆえこの 3 テーブルを除外していた。復旧に合わせて有効化する。
--    アプリは service_role_key で接続し RLS をバイパスするためポリシーは不要
--    （ポリシー無し = 非 service_role 接続に対し deny-all）。
--    ENABLE ROW LEVEL SECURITY は再実行しても無害（冪等）。
-- ===================================================================
ALTER TABLE customer_linkages ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_follow_refs ENABLE ROW LEVEL SECURITY;
