-- 031_stop_conversation_retention.sql
-- 会話・フィードバック・未回答クエリの「90日自動削除」を恒久停止する。
--
-- ─ なぜ止めるか ─
--   2026-08-08 に Setaka が「お客さんとの会話の生の文章は永久に残す」と決定した。
--   同じ削除対象に message_feedback が含まれており、その `comment` 列は
--   お客さんが感想に添える自由記述の一言 = roji が「KPI の主役＝定性データ」と
--   位置づけているデータそのもの。90日で消える状態は決定と矛盾するため停止する。
--   unanswered_queries（未回答の質問）も同じ理由で無期限保持に揃える。
--
-- ─ 010_data_retention.sql の該当部分は無効 ─
--   010 の 72-90 行（cleanup-old-conversations / cleanup-old-feedback /
--   cleanup-old-unanswered の cron.schedule）は本 031 で取り消され、**無効**である。
--   010 の SQL 本体は履歴として残してあるが、再適用してはならない。
--   万一 010 を再適用しても、031 は番号順で後に走るため削除ジョブは再び解除される
--   （migrate.ts はファイル名昇順で適用するため 010 → 031 の順になる）。
--
-- ─ 触らないもの ─
--   daily-conversation-stats（日次集計・無害）はそのまま残す。
--   本 migration はテーブルのデータを 1 行も削除・更新・挿入しない。cron.job のみを操作する。
--
-- ─ 冪等性 ─
--   対象ジョブが存在しない場合でもエラーにならない（存在確認してから unschedule する）。
--   pg_cron 未導入の環境でも安全に no-op で通る。

DO $$
DECLARE
  target_job text;
  target_jobs text[] := ARRAY[
    'cleanup-old-conversations',
    'cleanup-old-feedback',
    'cleanup-old-unanswered'
  ];
BEGIN
  -- pg_cron 未導入（cron.job が無い）環境では何もしない。
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE '031: cron.job が存在しないため no-op（pg_cron 未導入）';
    RETURN;
  END IF;

  FOREACH target_job IN ARRAY target_jobs LOOP
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = target_job) THEN
      PERFORM cron.unschedule(target_job);
      RAISE NOTICE '031: unscheduled %', target_job;
    ELSE
      RAISE NOTICE '031: % は未登録のためスキップ（冪等）', target_job;
    END IF;
  END LOOP;
END $$;
