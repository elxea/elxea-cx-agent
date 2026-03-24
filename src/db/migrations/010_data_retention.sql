-- 010_data_retention.sql
-- データ保持ポリシー: 90日超過データの自動削除 + 日次集計データの永続保持
--
-- pg_cron ジョブで毎日 AM4:00 JST (= PM7:00 UTC) に古いデータを削除する。
-- 削除前に日次集計を conversation_daily_stats テーブルに保存する。

-- pg_cron 拡張を有効化（Supabase では通常有効済み）
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ---------------------------------------------------------------------------
-- 集計データ保持テーブル
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversation_daily_stats (
  date date PRIMARY KEY,
  total_messages int DEFAULT 0,
  unique_users int DEFAULT 0,
  web_messages int DEFAULT 0,
  line_messages int DEFAULT 0,
  positive_feedback int DEFAULT 0,
  negative_feedback int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 日次集計ジョブ（削除の前に実行、AM3:30 JST = PM6:30 UTC）
-- ---------------------------------------------------------------------------

SELECT cron.schedule(
  'daily-conversation-stats',
  '30 18 * * *',
  $$INSERT INTO conversation_daily_stats (date, total_messages, unique_users, web_messages, line_messages, positive_feedback, negative_feedback)
    SELECT
      (now() - interval '1 day')::date,
      count(*),
      count(DISTINCT user_id),
      count(*) FILTER (WHERE channel = 'web'),
      count(*) FILTER (WHERE channel = 'line'),
      0,
      0
    FROM conversations
    WHERE created_at >= (now() - interval '1 day')::date
      AND created_at < now()::date
    ON CONFLICT (date) DO NOTHING$$
);

-- フィードバック集計（日次集計の直後に実行）
SELECT cron.schedule(
  'daily-feedback-stats',
  '32 18 * * *',
  $$UPDATE conversation_daily_stats
    SET
      positive_feedback = sub.pos,
      negative_feedback = sub.neg
    FROM (
      SELECT
        (now() - interval '1 day')::date AS date,
        count(*) FILTER (WHERE rating = 1) AS pos,
        count(*) FILTER (WHERE rating = -1) AS neg
      FROM message_feedback
      WHERE created_at >= (now() - interval '1 day')::date
        AND created_at < now()::date
    ) sub
    WHERE conversation_daily_stats.date = sub.date$$
);

-- ---------------------------------------------------------------------------
-- 自動削除ジョブ（毎日 AM4:00 JST = PM7:00 UTC）
-- ---------------------------------------------------------------------------

-- 90日以上前の会話データを削除
SELECT cron.schedule(
  'cleanup-old-conversations',
  '0 19 * * *',
  $$DELETE FROM conversations WHERE created_at < now() - interval '90 days'$$
);

-- 90日以上前のフィードバックデータを削除
SELECT cron.schedule(
  'cleanup-old-feedback',
  '5 19 * * *',
  $$DELETE FROM message_feedback WHERE created_at < now() - interval '90 days'$$
);

-- 90日以上前の未回答クエリを削除
SELECT cron.schedule(
  'cleanup-old-unanswered',
  '10 19 * * *',
  $$DELETE FROM unanswered_queries WHERE created_at < now() - interval '90 days'$$
);

-- 90日以上前の処理済みイベントを削除
SELECT cron.schedule(
  'cleanup-old-processed-events',
  '15 19 * * *',
  $$DELETE FROM processed_events WHERE processed_at < now() - interval '90 days'$$
);
