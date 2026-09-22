-- 056: 通数台帳に「送信予約」を持たせる — claim-before-send を DB の原子性で担保する
--
-- 背景（失敗シナリオ列挙 N-06 / N-07・プラン v6.2 §7-7）:
--   1 件指定送信（POST /api/delivery/send-one）は「LINE に送ってから記録を書く」ため、
--   送信成功の直後に Worker が落ちると記録だけが残らない。呼び出し側（Mac の予約ジョブ）は
--   「未送信」と読み、再試行して **二重送信** する。並列に 2 本届いた場合も同じ穴が開く。
--
--   対処は「送信前に予約を取る」= claim-before-send。既に migration 019 が
--   UNIQUE (notion_page_id, month) を持っており、`INSERT ... ON CONFLICT DO NOTHING` が
--   真の排他になる。足りないのは **誰の予約で、いまどの状態か** を行に残す 3 列だけ。
--
-- 役割:
--   reservation_id … 予約 ID（Mac 側が発番）。同一予約の二重到達を冪等に扱う鍵。
--                    X-Line-Retry-Key はこの値から決定的に導出する（N-08）。
--   send_state     … 'sending'（claim 直後） / 'sent'（成功応答を確認した） / 'failed'。
--                    'sending' のまま残った行は **自動再送しない**（滞留検出に回す・N-06）。
--   sent_count     … 成功応答で確認できた実送信人数。recipients（claim 時の見積）とは別に持つ。
--
-- 冪等性: 全 DDL は IF NOT EXISTS。再実行しても無害。
-- 既存行への影響: 追加列はすべて NULL 許容・既定値なし。既存の claim / 走行合計クエリは変わらない。
--   send_state に CHECK を付けない（既存 NULL 行を弾かないため。値の規約はコードが持つ:
--   src/lib/delivery-send-one.ts の ReservationClaim / SendReservationPort）。

ALTER TABLE line_message_ledger
  ADD COLUMN IF NOT EXISTS reservation_id text;

ALTER TABLE line_message_ledger
  ADD COLUMN IF NOT EXISTS send_state text;

ALTER TABLE line_message_ledger
  ADD COLUMN IF NOT EXISTS sent_count int;

-- 滞留（'sending' のまま残った予約）を引くための部分索引。
CREATE INDEX IF NOT EXISTS line_message_ledger_send_state_idx
  ON line_message_ledger (send_state)
  WHERE send_state IS NOT NULL;
