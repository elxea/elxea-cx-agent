-- 013_line_login_user_id.sql
-- user_identity_map に line_login_user_id カラムを追加。
-- LINE Login (Auth.js / LIFF) で取得する userId と
-- Messaging API Webhook で使われる userId が異なるため、
-- 両方を保持して正しく名寄せする。
--
-- line_user_id: Messaging API userId（既存・Webhook Follow Event で設定）
-- line_login_user_id: LINE Login userId（Auth.js signIn callback で設定）

ALTER TABLE user_identity_map ADD COLUMN IF NOT EXISTS line_login_user_id text;
CREATE INDEX IF NOT EXISTS idx_identity_line_login ON user_identity_map(line_login_user_id);
