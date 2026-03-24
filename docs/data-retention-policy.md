# Data Retention Policy

elxea CX Agent のデータ保持・削除ポリシー。

## 概要

| データ種別 | 保持期間 | 削除方法 |
|---|---|---|
| 会話データ (`conversations`) | 90日 | pg_cron 自動削除 |
| フィードバック (`message_feedback`) | 90日 | pg_cron 自動削除 |
| 未回答クエリ (`unanswered_queries`) | 90日 | pg_cron 自動削除 |
| 処理済みイベント (`processed_events`) | 90日 | pg_cron 自動削除 |
| 日次集計データ (`conversation_daily_stats`) | 無期限 | 削除しない |
| サーベイ回答 (`tasting_note_survey`) | 無期限 | 削除しない |
| ユーザープロファイル (Firestore) | 1年間非アクティブで削除検討 | 手動レビュー |
| ナレッジベース (`knowledge_chunks`) | 無期限 | Notion 同期で管理 |

## 自動削除スケジュール

pg_cron ジョブにより毎日自動実行される。

| ジョブ名 | 実行時刻 (JST) | 内容 |
|---|---|---|
| `daily-conversation-stats` | 03:30 | 前日の会話統計を集計 |
| `daily-feedback-stats` | 03:32 | 前日のフィードバック統計を集計 |
| `cleanup-old-conversations` | 04:00 | 90日超過の会話を削除 |
| `cleanup-old-feedback` | 04:05 | 90日超過のフィードバックを削除 |
| `cleanup-old-unanswered` | 04:10 | 90日超過の未回答クエリを削除 |
| `cleanup-old-processed-events` | 04:15 | 90日超過の処理済みイベントを削除 |

集計ジョブは削除ジョブの前に実行される。これにより、削除対象のデータが集計に含まれることが保証される。

## 集計データ

`conversation_daily_stats` テーブルに日次集計を保持する。

- `total_messages`: 1日の総メッセージ数
- `unique_users`: ユニークユーザー数
- `web_messages`: Web チャネル経由のメッセージ数
- `line_messages`: LINE チャネル経由のメッセージ数
- `positive_feedback`: ポジティブフィードバック数
- `negative_feedback`: ネガティブフィードバック数

生データ削除後もこれらの集計値は無期限に保持される。

## マイグレーション

`src/db/migrations/010_data_retention.sql` を Supabase SQL Editor で実行する。

## 変更履歴

- 2026-03-24: 初版策定
