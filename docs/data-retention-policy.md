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
| フローイベント (`flow_events`) | 13ヶ月 | pg_cron 自動削除（P1 予定）。選択 slug のみ=低PII・前年同期比較のため |
| 商品評価 (`product_ratings`) | 無期限 | 削除しない（低PII・商品開発の長期資産 D2） |
| 配信計測 (`line_message_ledger.aggregation_unit` / broadcast_stats) | 無期限 | 集計値のみ・個人単位データなし |
| 行動ログ (`behaviorLog`, Firestore) | 発話全文の書込停止（P0-11）＋シグナル行 90日 | 書込停止済＋バックフィル削除（下記） |
| ユーザープロファイル (Firestore `users` / `lineUsers`) | 1年間非アクティブで削除検討 | 手動レビュー |
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

## behaviorLog（Firestore）の発話全文について（P0-11 / §B-7）

**問題（是正済み）**: 従来 `behaviorLog` の `line_message` イベントは `metadata.query` に発話全文を無期限に保持していた。
Supabase 会話ログ（90日 purge）と非対称で、最大の整理事項だった。

**是正内容**:
1. 発話全文（`line_message` イベント）の書き込みを**停止**（`src/agent/core.ts`）。抽出済みシグナルのみ残す。
   プロンプト注入用途は直近シグナルで足り、全文は `conversations`（90日）で参照できる。
2. 過去に蓄積された 90日超の `line_message` イベントを**バックフィル削除**する。
   ツール: `scripts/purge-behaviorlog-line-messages.ts`。
   - **既定は dry-run（数えるだけ・削除しない）**。実削除は `--execute --i-understand --confirm-staging` の全付与が必要。
   - **削除前に必ず対象件数を集計・表示**する（I-10・いきなり削除しない）。
   - **staging データのみ対象**。本番 Firestore への実行はオーナー承認前のため行わない。
3. 以後の定期 purge（`flow_events` 13ヶ月 / behaviorLog シグナル行 90日）は P1 で pg_cron 相当に組み込む。

## マイグレーション

`src/db/migrations/010_data_retention.sql`（Supabase）を SQL Editor で実行する。
新規テーブルは `021_flow_events.sql` / `022_product_ratings.sql` / `023_line_message_ledger_aggregation_unit.sql`（staging ゲート → 承認後に本番）。

## 変更履歴

- 2026-03-24: 初版策定
- 2026-07-13: P0-11 反映。flow_events(13ヶ月)/product_ratings(無期限)/broadcast_stats(無期限)/behaviorLog 発話全文停止＋バックフィル手順を追記
