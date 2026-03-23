-- WC1-1: DB スキーママイグレーション（conversations 汎化）
-- Channel Adapter アーキテクチャ対応: line_user_id → user_id + channel カラム追加
--
-- 実行順序:
--   1. カラム追加（channel, metadata）
--   2. 既存データにデフォルト値設定
--   3. カラムリネーム（line_user_id → user_id）
--   4. インデックス再作成
--   5. unanswered_queries テーブルも同様に変更
--   6. user_identity_map テーブル新規作成
--
-- ロールバック手順は末尾にコメントとして記載

-- ============================================================
-- 1. conversations テーブルの拡張
-- ============================================================

-- channel カラム追加（既存データは全て 'line'）
ALTER TABLE conversations ADD COLUMN channel text NOT NULL DEFAULT 'line';

-- metadata カラム追加（商品カード・クイックリプライ等の構造化データ格納用）
ALTER TABLE conversations ADD COLUMN metadata jsonb;

-- 既存データにデフォルト値を設定（明示的に）
UPDATE conversations SET channel = 'line' WHERE channel = 'line';

-- line_user_id → user_id にリネーム
ALTER TABLE conversations RENAME COLUMN line_user_id TO user_id;

-- 旧インデックスを削除
DROP INDEX IF EXISTS conversations_user_idx;

-- 新インデックス作成: (user_id, channel, created_at DESC)
CREATE INDEX idx_conversations_user_channel
  ON conversations (user_id, channel, created_at DESC);

-- ============================================================
-- 2. unanswered_queries テーブルの拡張
-- ============================================================

-- channel カラム追加
ALTER TABLE unanswered_queries ADD COLUMN channel text NOT NULL DEFAULT 'line';

-- line_user_id → user_id にリネーム
ALTER TABLE unanswered_queries RENAME COLUMN line_user_id TO user_id;

-- ============================================================
-- 3. user_identity_map テーブル新規作成
-- ============================================================

CREATE TABLE user_identity_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unified_user_id text NOT NULL,
  line_user_id text UNIQUE,
  web_session_id text,
  shopify_customer_id text UNIQUE,
  linked_at timestamptz DEFAULT now()
);

-- 検索用インデックス
CREATE INDEX idx_identity_map_unified ON user_identity_map (unified_user_id);
CREATE INDEX idx_identity_map_line ON user_identity_map (line_user_id);
CREATE INDEX idx_identity_map_web_session ON user_identity_map (web_session_id);

-- ============================================================
-- ロールバック手順（緊急時のみ実行）
-- ============================================================
-- ALTER TABLE conversations RENAME COLUMN user_id TO line_user_id;
-- ALTER TABLE conversations DROP COLUMN channel;
-- ALTER TABLE conversations DROP COLUMN metadata;
-- DROP INDEX IF EXISTS idx_conversations_user_channel;
-- CREATE INDEX conversations_user_idx ON conversations (line_user_id, created_at DESC);
--
-- ALTER TABLE unanswered_queries RENAME COLUMN user_id TO line_user_id;
-- ALTER TABLE unanswered_queries DROP COLUMN channel;
--
-- DROP TABLE IF EXISTS user_identity_map;
