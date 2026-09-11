-- 055: 通数台帳に「送信リクエストの参照」と「人数の出所」を持たせる — 全員配信の見積を実測に置き換える
--
-- 背景（2026-09-11 に判明した実害）:
--   全員配信は POST /v2/bot/message/broadcast を宛先指定なしで呼ぶため、実際の到達は
--   **その時点の友だち全員**。ところが無料枠ガードと通数台帳に載せる人数は env 固定値
--   LINE_BROADCAST_ESTIMATED_RECIPIENTS_PROD（=48・2026-07-25 時点の値）のまま 2 ヶ月放置され、
--   台帳が実態より過少になっていた（LINE Insight 実測との突合）:
--     2026-07-10 台帳38 / 実測38（一致） ・ 2026-08-05 台帳48 / 実測56
--     2026-08-22 台帳48 / 実測63        ・ 2026-09-11 台帳48 / 実測68
--   無料枠(200通/月)を守るための台帳が、守る対象の数字を取り違えていた。
--
-- 役割:
--   1. line_request_id  … broadcast 応答ヘッダ X-Line-Request-Id。送信 1 回を一意に指す鍵。
--        これが無いと「その送信が実際に何通届いたか」を後から LINE に問い合わせる術が無い
--        （insight/message/event は requestId でしか引けず、統計は送信から 14 日で消える＝後付け不可）。
--   2. recipients_basis … recipients の出所。どの数字がどれだけ確かかを行ごとに残す。
--        'measured'            : 送信直前に followers/ids を数えた実測値（既定の正）
--        'env_fallback'        : 実測に失敗し env 固定値へ退避した見積（帳簿用・到達人数には影響しない）
--        'actual_delivered'    : 送信後に insight/message/event の overview.delivered で補正した実数
--        'manual_correction'   : 人が根拠を持って訂正した値
--        NULL                  : 本 migration 以前の行（出所不明）
--   3. note … 訂正の根拠メモ。**個人を特定する記述・LINE userId は書かない**。
--
-- 設計方針の出典: オーナー判断 2026-09-11「全員配信の『全員』は常にその時点の全員。
--   固定値を持つこと自体が間違い」。env 固定値はフォールバック専用へ降格する。
--
-- 冪等性: 全 DDL は IF NOT EXISTS。再実行しても無害。
-- 既存行への影響: 追加列はすべて NULL 許容・既定値なし。既存の claim / 走行合計クエリは一切変わらない。
--   recipients_basis に CHECK を付けない（既存 NULL 行を弾かないため。値の規約はコードが持つ:
--   src/lib/message-ledger.ts の RecipientsBasis）。

-- 送信 1 回を指す LINE 側の鍵（broadcast 応答ヘッダ X-Line-Request-Id）。
--   NULL 許容: 本 migration 以前の行 / multicast・push 等で未取得の行。
ALTER TABLE line_message_ledger
  ADD COLUMN IF NOT EXISTS line_request_id text;

-- recipients の出所（上記 4 種 + NULL）。
ALTER TABLE line_message_ledger
  ADD COLUMN IF NOT EXISTS recipients_basis text;

-- 訂正の根拠メモ（PII 非記載）。
ALTER TABLE line_message_ledger
  ADD COLUMN IF NOT EXISTS note text;

-- 後追い補正ジョブが「まだ実数で補正していない送信」を引くための索引。
--   requestId を持つ行だけが補正対象なので部分索引にする。
CREATE INDEX IF NOT EXISTS line_message_ledger_request_id_idx
  ON line_message_ledger (line_request_id)
  WHERE line_request_id IS NOT NULL;
