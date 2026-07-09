-- 019: LINE 通数台帳（line_message_ledger）— Notion駆動 LINE配信の通数会計/排他基盤
--
-- 背景・設計: 「Notion駆動 LINE配信 設計確定版 v1.0」§6/§8
--   https://app.notion.com/p/39870c9d064c81f7a593f2cb248ef076
--
-- 役割: 無料枠(200通/月)を絶対に超えないための「唯一の権威（authority）」となる永続台帳。
--   - claim-before-send: 送信の前に (notion_page_id, month) をアトミックに予約（真の排他）。
--     UNIQUE(notion_page_id, month) により、同一配信ページの二重送信を DB レベルで拒否する。
--     アプリ側の SELECT→INSERT では TOCTOU レースが残るため、一意制約による排他を採用する。
--   - 走行合計: 月内の recipients 合計（= 確定消費）を主判定に使う。
--     残枠 = FREE_TIER_CAP(200) − SAFETY_HEADROOM − SUM(recipients this month)。
--   - チャネル全消費の会計: broadcast だけでなく interactive(push) も同一台帳に記録できる。
--     reply は無料のため記録しない（設計 §6 / Must-fix 4）。
--
-- 冪等性: 全 DDL は再実行安全（IF NOT EXISTS）。既存があっても無害。
-- 適用: 本番未適用。staging 適用ゲート（設計 §9 ENV-3 / docs runbook）→ Setaka 承認後に本番へ。
--       このファイル作成時点では本番 Supabase へは一切適用しない。

-- ===================================================================
-- line_message_ledger
--   month           : 会計対象月。LINE 基準(JST)の "YYYY-MM"。月次リセットの境界。
--   source          : 消費の出所。broadcast(全員/ペルソナ配信) / interactive(会話push) / other
--   recipients      : この行で消費した受信者数（1受信者=1通）。予約時は見積、確定時は実送信数。
--   notion_page_id  : 冪等キー。broadcast は Notion 配信ページ ID。
--                     interactive/other は衝突しない安定キー（例: LINE イベント ID）を渡す。
--   created_at      : 台帳記録時刻。
-- ===================================================================
CREATE TABLE IF NOT EXISTS line_message_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month text NOT NULL,
  source text NOT NULL CHECK (source IN ('broadcast', 'interactive', 'other')),
  recipients int NOT NULL CHECK (recipients >= 0),
  notion_page_id text NOT NULL,
  created_at timestamptz DEFAULT now(),
  -- claim-before-send の排他キー。同一ページ×同一月の二重 claim を DB が拒否する。
  CONSTRAINT line_message_ledger_page_month_uniq UNIQUE (notion_page_id, month)
);

-- 走行合計クエリ（SUM(recipients) WHERE month = ?）の高速化。
CREATE INDEX IF NOT EXISTS line_message_ledger_month_idx
  ON line_message_ledger (month);

-- ===================================================================
-- RLS（migration 017 / 018 と同じセキュリティ姿勢）
--   アプリは service_role_key で接続し RLS をバイパスする。
--   ポリシー無し = 非 service_role 接続に対し deny-all。
--   ENABLE ROW LEVEL SECURITY は再実行しても無害（冪等）。
-- ===================================================================
ALTER TABLE line_message_ledger ENABLE ROW LEVEL SECURITY;
