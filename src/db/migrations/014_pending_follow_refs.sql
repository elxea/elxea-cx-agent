-- 014: pending_follow_refs テーブル
-- QR コード同梱物経由の友だち追加で ref パラメータを一時保存する。
-- LIFF ページが友だち追加前に POST /api/follow-ref で書き込み、
-- follow event 時に読み取って削除する（ワンタイム読み取り）。

CREATE TABLE IF NOT EXISTS pending_follow_refs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  line_user_id text NOT NULL UNIQUE,
  ref text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 期限切れレコードの自動クリーンアップ用インデックス
CREATE INDEX IF NOT EXISTS idx_pending_follow_refs_expires
  ON pending_follow_refs (expires_at);

-- RLS: サービスロールのみアクセス可
ALTER TABLE pending_follow_refs ENABLE ROW LEVEL SECURITY;
