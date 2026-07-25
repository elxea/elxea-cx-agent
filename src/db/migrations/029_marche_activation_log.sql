-- 026: マルシェ入口「番号未送信」活性化ナッジの意思決定台帳（marche_activation_log）— spec drift #1
--
-- 背景・設計: personalization-spec §6 優先2 / Table B 監査 #1（⚠️ 設計最大の抜け）。
--   ジャーニーマップ §17:334 は「マルシェ入口＝最大の入口」と名指すが、袋の 5 桁番号を送らずに
--   離脱した友だちには短期ホライズンの再喚起が無く、唯一の再エンゲージ（休眠 60 日・本番 OFF）
--   では day-1..数日の drop-off を拾えない。本台帳は「追加後 短期の 1 回だけの静かなナッジ」を担う。
--
-- 役割（dormant_reengagement_log = migration 025 と同じ思想）:
--   (1) 恒久的な重複送信防止（1 人 1 回まで。activation は再送間隔を持たない = 一度送ったら二度と送らない）。
--   (2) 送信封鎖（dry-run）中の「候補者＋送るはずだった本文」の観測記録。
--
--   月次予算（LINE 無料枠 200 通/月）の会計は line_message_ledger（migration 019）が権威。
--   実送信時は line_message_ledger にも source='interactive' で claim する（二重会計しない・役割分担）。
--
-- 冪等性:
--   - IF NOT EXISTS で再実行安全。
--   - UNIQUE(line_user_id, decision_date) で「同一人物・同一 JST 日」の決定行を 1 行に集約
--     （cron の同日再実行・手動トリガ重複は ON CONFLICT DO NOTHING で無害）。
--
-- 恒久 dedup（1 人 1 回）は sent=true の行のみを対象にする（dry-run 行は実送信枠を消費しない）:
--   候補選定時に「sent=true」の行を持つ line_user_id を除外する。
--   → dry-run を何度回しても実送信の「1 回」枠は消費されず、フラグ ON 後に正しく初回送信できる。
--   dormant（90 日再送）と違い activation は再送間隔を持たない（追加直後の 1 回きりの活性化）。
--
-- 適用: 本番未適用。staging 適用ゲート → Setaka 承認後に本番へ。
--       このファイル作成時点では本番 Supabase へは一切適用しない。

CREATE TABLE IF NOT EXISTS marche_activation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 対象 LINE userId（"U" + 32 hex）。Messaging API の宛先そのもの。
  line_user_id text NOT NULL,
  -- 決定日（JST の暦日 "YYYY-MM-DD"）。同日再実行の冪等キー（line_user_id と複合一意）。
  decision_date date NOT NULL,
  -- 活性化ウィンドウ判定の根拠になった観測値（lineUsers/{id}.createdAt = 追加時刻。無い場合もあるため NULL 許容）。
  user_created_at timestamptz,
  -- 実送信したか（dry-run は false）。恒久 dedup（1 人 1 回）はこの true 行のみを見る。
  sent boolean NOT NULL DEFAULT false,
  -- 実送信時刻（dry-run は NULL）。
  sent_at timestamptz,
  -- 送信封鎖（dry-run）だったか。観測用（true = 送っていない・候補記録のみ）。
  dry_run boolean NOT NULL DEFAULT true,
  -- 送った / 送るはずだった本文（brand-copy の正本文言のスナップショット。監査・観測用）。
  body_preview text,
  -- LINE unit 別統計の集計単位名（将来 insight 照会用・任意）。
  aggregation_unit text,
  created_at timestamptz DEFAULT now(),
  -- 同一人物・同一 JST 日の決定は 1 行に集約（冪等・ON CONFLICT DO NOTHING 用）。
  CONSTRAINT marche_activation_user_date_uniq UNIQUE (line_user_id, decision_date)
);

-- 恒久 dedup ガード（sent=true の line_user_id 逆引き）の高速化。
CREATE INDEX IF NOT EXISTS marche_activation_sent_idx
  ON marche_activation_log (line_user_id, sent);

-- ===================================================================
-- RLS（migration 017 / 018 / 019 / 024 / 025 と同じセキュリティ姿勢）
--   アプリは service_role_key で接続し RLS をバイパスする。
--   ポリシー無し = 非 service_role 接続に対し deny-all。
--   ENABLE ROW LEVEL SECURITY は再実行しても無害（冪等）。
-- ===================================================================
ALTER TABLE marche_activation_log ENABLE ROW LEVEL SECURITY;
