-- 030: 006（channel adapter）の本番ドリフト修復 — unanswered_queries の channel / user_id 欠落を冪等に補う
--
-- 背景（QA 独立検証 2026-07-24/25）:
--   006_channel_adapter.sql は unanswered_queries に対し
--     (a) channel text NOT NULL DEFAULT 'line' の追加
--     (b) line_user_id → user_id へのリネーム
--   を行うはずだったが、本番（prod ref=bquqzrbzdzjegdovxalu）では 006 が「一部未適用」で、
--   introspection の結果 unanswered_queries に channel / user_id カラムが不在だった。
--   006 の conversations 側 sentinel（user_identity_map テーブル / conversations.channel）は実在するため
--   baseline は 006 を applied と判定・登録するが、unanswered_queries 側だけがドリフトしている。
--   本 030 はその欠落を「冪等」に埋める修復専用マイグレーション（006 の意図＝型・default・NULL可否に一致）。
--
-- 006 との関係（既存 SQL は書き換えない）:
--   006 は台帳 baseline で applied として登録される（conversations 側は適用済みのため）。この 030 が
--   pending として控え、将来 --apply されたときに unanswered_queries の欠落カラムを埋める。
--   006 本体を後から書き換えると「適用済み実体との対応」を壊すため、修復は別 version（030）で行う。
--
-- 冪等性（何度実行しても安全・DDL は不足時のみ実行され、006 が正しく当たった環境では完全 no-op）:
--   - channel: ADD COLUMN IF NOT EXISTS ... NOT NULL DEFAULT 'line'
--       既存行は default 'line' で backfill される。既に列があれば無害。006(a) の型・default・NULL可否に一致。
--   - user_id: rename 優先の分岐（006(b) の rename 意図を忠実に再現する）。
--       * line_user_id が在り user_id が不在 → RENAME COLUMN line_user_id TO user_id
--         （既存の line_user_id データを新カラム名へ引き継ぐ＝006 が本来やるはずだった rename）。
--       * user_id が既に在る → 何もしない。
--       * どちらも不在（想定外だが安全側）→ ADD COLUMN user_id text（006 の型 text に一致。
--         既存行に対する NOT NULL 付与は失敗しうるため修復用途では NULL 可否を緩める＝本番のデータ
--         不整合を避ける安全側。004 の元定義は NOT NULL だが、修復は既存データを壊さないことを優先）。
--
-- 適用: 本番未適用（pending のまま）。台帳 baseline とは独立に、将来 Setaka 承認のうえ --apply で欠落を埋める。

-- ------------------------------------------------------------
-- channel: 冪等に追加（既存行は 'line' で backfill）
-- ------------------------------------------------------------
ALTER TABLE unanswered_queries ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'line';

-- ------------------------------------------------------------
-- user_id: rename 優先の冪等修復（006(b) の意図を再現）
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'unanswered_queries' AND column_name = 'line_user_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'unanswered_queries' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE unanswered_queries RENAME COLUMN line_user_id TO user_id;
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'unanswered_queries' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE unanswered_queries ADD COLUMN user_id text;
  END IF;
END
$$;

-- ------------------------------------------------------------
-- ロールバック手順（緊急時のみ）
-- ------------------------------------------------------------
-- ALTER TABLE unanswered_queries DROP COLUMN IF EXISTS channel;
-- -- user_id は 006 / 030 のどちらで作られたか判別できないため、rename の巻き戻しは手動判断で:
-- --   ALTER TABLE unanswered_queries RENAME COLUMN user_id TO line_user_id;
