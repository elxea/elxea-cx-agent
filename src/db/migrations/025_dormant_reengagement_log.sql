-- 025: 休眠検知「静かな一通」の意思決定台帳（dormant_reengagement_log）— ブロック3-B
--
-- 背景・設計: 統合設計書 §B（休眠検知＋静かな一通）／リポ体験原則（静かで丁寧・プッシュを増やさない）
--
-- 役割: 休眠中の友だちへの「静かな一通」について、
--   (1) 恒久的な重複送信防止（1 人 1 回まで・再送は最短 90 日間隔）
--   (2) 送信封鎖（dry-run）中の「候補者＋送るはずだった本文」の観測記録
--   を担う永続台帳。
--
--   月次予算（LINE 無料枠 200 通/月）の会計は line_message_ledger（migration 019）が権威。
--   本台帳は「同一人物への再送を 90 日は許さない」再送間隔ガードと dry-run 観測を担当し、
--   実送信時は line_message_ledger にも source='interactive' で claim する（二重会計しない・役割分担）。
--
-- 冪等性:
--   - IF NOT EXISTS で再実行安全。
--   - UNIQUE(line_user_id, decision_date) で「同一人物・同一 JST 日」の決定行を 1 行に集約
--     （cron の同日再実行・手動トリガ重複は ON CONFLICT DO NOTHING で無害）。
--
-- 再送間隔ガード（90 日）は sent=true の行のみを対象にする（dry-run 行は実送信枠を消費しない）:
--   候補選定時に「sent=true かつ sent_at >= now()-90日」の行を持つ line_user_id を除外する。
--   → dry-run を何度回しても実送信の 90 日枠は消費されず、フラグ ON 後に正しく初回送信できる。
--
-- 適用: 本番未適用。staging 適用ゲート → Setaka 承認後に本番へ。
--       このファイル作成時点では本番 Supabase へは一切適用しない。

CREATE TABLE IF NOT EXISTS dormant_reengagement_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 対象 LINE userId（"U" + 32 hex）。Messaging API の宛先そのもの。
  line_user_id text NOT NULL,
  -- 決定日（JST の暦日 "YYYY-MM-DD"）。同日再実行の冪等キー（line_user_id と複合一意）。
  decision_date date NOT NULL,
  -- 休眠判定の根拠になった観測値（lineUsers/{id}.lastActiveAt。無い場合もあるため NULL 許容）。
  last_active_at timestamptz,
  -- 実送信したか（dry-run は false）。90 日再送ガードはこの true 行のみを見る。
  sent boolean NOT NULL DEFAULT false,
  -- 実送信時刻（dry-run は NULL）。再送間隔ガードの基準。
  sent_at timestamptz,
  -- 送信封鎖（dry-run）だったか。観測用（true = 送っていない・候補記録のみ）。
  dry_run boolean NOT NULL DEFAULT true,
  -- 送った / 送るはずだった本文（brand-copy の正本文言のスナップショット。監査・観測用）。
  body_preview text,
  -- LINE unit 別統計の集計単位名（将来 insight 照会用・任意）。
  aggregation_unit text,
  created_at timestamptz DEFAULT now(),
  -- 同一人物・同一 JST 日の決定は 1 行に集約（冪等・ON CONFLICT DO NOTHING 用）。
  CONSTRAINT dormant_reengagement_user_date_uniq UNIQUE (line_user_id, decision_date)
);

-- 再送間隔ガード（sent=true かつ sent_at >= now()-90日 の line_user_id 逆引き）の高速化。
CREATE INDEX IF NOT EXISTS dormant_reengagement_sent_idx
  ON dormant_reengagement_log (line_user_id, sent, sent_at);

-- ===================================================================
-- RLS（migration 017 / 018 / 019 / 024 と同じセキュリティ姿勢）
--   アプリは service_role_key で接続し RLS をバイパスする。
--   ポリシー無し = 非 service_role 接続に対し deny-all。
--   ENABLE ROW LEVEL SECURITY は再実行しても無害（冪等）。
-- ===================================================================
ALTER TABLE dormant_reengagement_log ENABLE ROW LEVEL SECURITY;
