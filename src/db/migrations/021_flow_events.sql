-- 021: flow_events — タップ/フローイベントログ（欠落(a)を埋める）— P0-1 / P0-2
--
-- 背景・設計: 統合設計書 §B-5a / §C-5 実装ノート I-4・I-6
--   https://app.notion.com/p/39c70c9d064c8129b802e99161b628a0
--
-- 解消する問題（事実）: 選択式フローのインターセプタは会話保存より前に return するため、
--   リッチメニュー・tea-menu・診断のタップは会話ログにもどこにも残らない（棚卸し表B）。
--   → 各インターセプタの return 直前に logFlowEvent() を挿入して解消する。
--
-- 設計原則:
--   (1) Supabase に置く（既存の pg_cron/RLS/台帳と同じ運用系）。
--   (2) イベントは本文なし — user_ref と選択値・番号のみ（PII を構造的に入らなくする）。
--   (3) 書き込みは fire-and-forget（失敗は握りつぶし応答優先）。
--
-- I-4: channel は 'line' のみ許可。web は GA4 / Firestore behaviorLog の既存2系統があるため、
--   将来 web を足す場合は CHECK 拡張でなく再設計判断を経る（安易な多チャネル化を防ぐ）。
--
-- 冪等性: IF NOT EXISTS で再実行安全。適用: 本番未適用（staging ゲート → Setaka 承認）。

CREATE TABLE IF NOT EXISTS flow_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_name text NOT NULL,
  user_ref text NOT NULL,            -- unified id（conversations.user_id と同一規約: LINE userId / web session）
  channel text NOT NULL DEFAULT 'line' CHECK (channel IN ('line')),  -- I-4: 'line' のみ
  step text,                         -- q1/q2/q3・page1〜3 等
  value text,                        -- 選択値 slug のみ（自由文の格納を禁止）
  product_no text,                   -- 5桁番号（tea.* / rating.* のみ）
  metadata jsonb,                    -- 追加属性。自由文キー禁止（レビューで機械チェック）
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flow_events_name_time ON flow_events (event_name, created_at);
CREATE INDEX IF NOT EXISTS idx_flow_events_user_time ON flow_events (user_ref, created_at);
CREATE INDEX IF NOT EXISTS idx_flow_events_product ON flow_events (product_no) WHERE product_no IS NOT NULL;

-- RLS: 既存テーブル（conversations 等）と同一ポリシー（service role のみ書き込み）。
-- ポリシー無し = 非 service_role 接続に deny-all。
ALTER TABLE flow_events ENABLE ROW LEVEL SECURITY;
