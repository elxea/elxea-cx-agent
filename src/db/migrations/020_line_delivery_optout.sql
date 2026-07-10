-- 020: 配信対象除外フラグ（退会 / opt-out）— Notion駆動 LINE配信 対象解決の除外基盤
--
-- 背景・設計: 「Notion駆動 LINE配信 設計確定版 v1.0」§7 / Must-fix 9
--   https://app.notion.com/p/39870c9d064c81f7a593f2cb248ef076
--
-- 役割: ペルソナ配信(multicast)の対象解決で除外する状態を永続化する。
--   - unfollowed_at      : LINE 友だち解除(unfollow=退会/ブロック相当)を検知した時刻。
--                          NOT NULL = 除外対象。unfollow webhook で記録する。
--   - broadcast_opted_out: 配信 opt-out フラグ。ユーザーが配信停止を選んだら true。
--                          （opt-out の入口 UI/コマンドは別タスク。列と除外ロジックを先に用意）。
--
-- 注: LINE の「ブロック」状態は送信前 API で判定できないため、unfollow 検知で近似する。
--     broadcast(全員配信) はLINE側で受信者を絞れないため、この除外は multicast パス限定。
--
-- 冪等性: 全 DDL は再実行安全（IF NOT EXISTS）。既存があっても無害。
-- 適用: 本番未適用。staging 適用ゲート（設計 §9 ENV-3）→ Setaka 承認後に本番へ。
--       このファイル作成時点では本番 Supabase へは一切適用しない。

ALTER TABLE customer_linkages
  ADD COLUMN IF NOT EXISTS unfollowed_at timestamptz;

ALTER TABLE customer_linkages
  ADD COLUMN IF NOT EXISTS broadcast_opted_out boolean NOT NULL DEFAULT false;

-- 対象解決クエリ（line_user_id IS NOT NULL AND unfollowed_at IS NULL AND NOT opted_out）の
-- フィルタを軽くする部分インデックス（配信可能な行のみ）。
CREATE INDEX IF NOT EXISTS customer_linkages_deliverable_idx
  ON customer_linkages (line_user_id)
  WHERE unfollowed_at IS NULL AND broadcast_opted_out = false;
