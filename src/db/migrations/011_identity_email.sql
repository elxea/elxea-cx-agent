-- 011_identity_email.sql
-- user_identity_map に email + display_name カラムを追加。
-- LINE Login (Auth.js) からのメールベース自動紐付けを可能にする。

ALTER TABLE user_identity_map ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE user_identity_map ADD COLUMN IF NOT EXISTS display_name text;
CREATE INDEX IF NOT EXISTS idx_identity_email ON user_identity_map(email);
