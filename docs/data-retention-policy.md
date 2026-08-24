# Data Retention Policy

elxea CX Agent のデータ保持・削除ポリシー。

## 概要

> **2026-08-08方針転換**: お客さんとの会話の生の文章と、感想に添える自由記述の一言は
> **永久保存**に変更した（Setaka決定）。90日自動削除は廃止する。理由は
> `message_feedback.comment` がrojiの「KPIの主役＝定性データ」そのものであり、
> 90日で消えることが事業判断の前提と矛盾するため。詳細は下記「自動削除スケジュール」節。

| データ種別 | 保持期間 | 削除方法 |
|---|---|---|
| 会話データ (`conversations`) | **無期限** | 自動削除しない（2026-08-08〜） |
| フィードバック (`message_feedback`、自由記述 `comment` を含む) | **無期限** | 自動削除しない（2026-08-08〜） |
| 未回答クエリ (`unanswered_queries`) | **無期限** | 自動削除しない（2026-08-08〜） |
| 処理済みイベント (`processed_events`) | 90日（定義のみ・本番未登録） | pg_cron自動削除（本番に未登録＝実際には動いていない） |
| 日次集計データ (`conversation_daily_stats`) | 無期限 | 削除しない |
| サーベイ回答 (`tasting_note_survey`) | 無期限 | 削除しない |
| フローイベント (`flow_events`) | 13ヶ月 | pg_cron 自動削除（P1 予定）。選択 slug のみ=低PII・前年同期比較のため |
| 商品評価 (`product_ratings`) | 無期限 | 削除しない（低PII・商品開発の長期資産 D2） |
| 配信計測 (`line_message_ledger.aggregation_unit` / broadcast_stats) | 無期限 | 集計値のみ・個人単位データなし |
| 行動ログ (`behaviorLog`, Firestore) | 発話全文の書込停止（P0-11）＋シグナル行 90日 | 書込停止済＋バックフィル削除（下記） |
| ユーザープロファイル (Firestore `users` / `lineUsers`) | 1年間非アクティブで削除検討 | 手動レビュー |
| ナレッジベース (`knowledge_chunks`) | 無期限 | Notion同期で管理 |
| **roji言葉の置き場 (`roji_words` / `roji_word_persons` / `roji_word_person_refs`)** | **永久**（期間で自動的に消さない） | **自動削除しない。** 消えるのは本人が記録を消したときだけ（`roji_erase_person()`） |
| **roji送った記録の台帳 (`roji_delivery_ledger`)** | **無期限** | 同上（本人の削除でのみ消える） |
| **roji月の締め記録 (`roji_delivery_months`)** | **無期限** | 削除しない（個人の記録ではない・月単位の集計） |
| **roji編集の記録 (`roji_edit_records`)** | **無期限** | 削除しない（運営側の作業の記録。個人へ辿れる列を構造上持たない） |

## 自動削除スケジュール

pg_cronジョブにより毎日自動実行される。

| ジョブ名 | 実行時刻 (JST) | 内容 | 状態 |
|---|---|---|---|
| `daily-conversation-stats` | 03:30 | 前日の会話統計を集計 | 稼働中（維持する） |
| `daily-feedback-stats` | 03:32 | 前日のフィードバック統計を集計 | **本番未登録**（010に定義はあるがcron.jobに無い） |
| `cleanup-old-conversations` | 04:00 | 90日超過の会話を削除 | **廃止**（031でunschedule） |
| `cleanup-old-feedback` | 04:05 | 90日超過のフィードバックを削除 | **廃止**（031でunschedule） |
| `cleanup-old-unanswered` | 04:10 | 90日超過の未回答クエリを削除 | **廃止**（031でunschedule） |
| `cleanup-old-processed-events` | 04:15 | 90日超過の処理済みイベントを削除 | **本番未登録**（010に定義はあるがcron.jobに無い） |

集計ジョブ `daily-conversation-stats` は削除とは無関係に日次集計を作り続けるため、そのまま維持する。

### 削除ジョブを止めた経緯（2026-08-08）

- 2026-08-08、Setakaが「お客さんとの会話の生の文章は永久に残す」と決定。
- 独立QAにより、同じ削除対象に `message_feedback` が含まれ、その `comment` 列
  （お客さんが感想に添える自由記述の一言）も90日で消えることが判明した。
  この一言はrojiが「KPIの主役＝定性データ」と位置づけているデータそのもの。
- よって上記3本のcleanupジョブを `cron.unschedule` で解除し、
  `031_stop_conversation_retention.sql` に冪等な形で記録した
  （`010_data_retention.sql` の該当節は**無効**。再適用しないこと）。
- 実測（2026-08-08時点・読み取りのみ）: `cleanup-*` の稼働により
  2026-06-05〜2026-07-12に会話が実際に削除されている。**この分は復旧できない**。

## 「消せます」とお客さんに約束してはいけない（未完の宿題）

**無期限保持にした結果、記録が消える経路は「お客さんからの削除依頼」だけになった。**
ところが現在その削除処理はSupabaseの会話を消していない。

- 実装: `elxea-web-app/app/api/webhooks/gdpr/customers-redact/route.ts`（Shopify GDPR `customers/redact`）
- 現状: **Firestoreの `users/{customerId}` とその配下サブコレクション
  （`orders` / `behaviorLog` / `favorites` / `follows` / `eventRegistrations` / `conversations`）
  のみを削除する**。Supabase側の `conversations` / `message_feedback` /
  `unanswered_queries` には一切触れていない。
- つまり削除依頼を受けても、**Supabaseに残った会話本文と感想の一言は消えない**。

**この繋ぎ込みが済むまで、お客さんに「消せます」と約束してはならない。**
プライバシーポリシー・LINEの案内文・問い合わせ対応のいずれでも、削除に応じられる旨を
書いたり伝えたりしないこと。繋ぎ込み（Supabase側の削除をredact webhookに追加する）が
完了し、実際に消えることを確認してから、はじめて約束してよい。

## 削除依頼の入口（`POST /api/erase`）の応答の読み方

実装の正本は `src/lib/roji-erasure.ts`（消える範囲の定義）と `src/index.ts` の
`POST /api/erase`（応答の分岐）。**呼び出し側はHTTPステータスだけで判断しない**。

| 応答 | 意味 | 呼び出し側がすること |
|---|---|---|
| `200 {"status":"erased"}` | 消し終わった（検算もclean） | 完了として扱ってよい |
| `202 {"status":"in_progress","continue_required":true}` | 1リクエストで消しきれず**途中まで**。各段階は冪等 | **同じbodyでもう一度呼ぶ**。`erased` になるまで繰り返す |
| `500 {"status":"incomplete"}` | 全経路を回したのに消し残しがある＝異常 | 完了として扱わない。調査する |
| `500 {"error":"erase_failed"}` | 例外 | 完了として扱わない。調査する |

- ⚠ `202` は2xxだが**完了ではない**。`res.ok` だけを見る実装は「消えた」と誤読する。
  必ず本文の `status` / `continue_required` を見ること。
- 途中で止まったときはSupabase（本人を特定する別名表を含む）には進んでいない。
  だから再送すれば必ず同じ人を特定して続きから消せる。
- 1リクエストで使う呼び出し回数の上限は `ERASE_SUBREQUEST_BUDGET`（Workerのenv）で
  **引き上げ**られる（既定40 = 下限。それより下げる指定は無視される）。引き上げるほど202で
  刻む回数が減る。既定40の根拠は「旧実装が21 docで落ちた＝実際の上限は50前後」という実測。

背景（修正F6 / 2026-08-24）: 旧実装は「途中まで消した」状態も `500 erase_failed` に
落としていたため、再送すれば済む状態が呼び出し側から失敗にしか見えなかった（実測21 doc）。
またEC上の顧客番号が `gid://shopify/Customer/…` 形式の人はFirestoreを1件も掘らないのに
検算も同じ理由で0件と数え、**消していないのに `clean:true`** を返していた。両方を根治済み。

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

適用は `scripts/migrate.ts`（番号順・台帳 `schema_migrations` でスキップ）で行う。

- `src/db/migrations/010_data_retention.sql`: 集計テーブルとcron定義の初版。
  **削除ジョブ3本の節は031で無効化済み。単独で再適用しないこと。**
- `src/db/migrations/031_stop_conversation_retention.sql`: 削除ジョブ3本の解除（冪等）。
  番号順適用により010 → 031の順で走るため、010を再適用しても最終状態は「削除ジョブ無し」になる。
- `src/db/migrations/032_roji_words.sql` / `033_roji_delivery_ledger.sql`:
  rojiカルテの器（言葉の置き場 / 送った記録の台帳 / 編集の記録 / 月の締め記録）。
  **追加のみ**（新設テーブルのみ・既存テーブルへの変更ゼロ）。**自動削除ジョブを1本も足していない。**

```bash
npx tsx scripts/migrate.ts --only 031 --dry-run   # 適用予定の確認（非破壊）
npx tsx scripts/migrate.ts --only 031 --apply     # 本適用
```

### rojiの器に「90日削除」を入れ直してはならない

`roji_words` は**お客さんの言葉の原文そのもの**を置く場所で、保存期間は**永久**と確定している
（2026-08-08 Q6）。同じ理由で台帳・編集の記録・月の締め記録も期間で消さない。

- 新設テーブルに対する `cron.schedule` を書いた時点で、この確定に反する。
- 機械チェックあり: `tests/unit/roji-containers.test.ts` がmigration 032/033に
  `cron.schedule` / `cleanup` が含まれないことを検証し、
  `tests/db/roji-containers.db.test.ts` が**実DBの `cron.job` にroji系のジョブが
  1本も無いこと**を検証する（本番でも `--env prod` で読み取り確認できる）。
- 消えるのは「本人が記録を消したとき」だけ。その処理は `roji_erase_person(subject_kind, subject_id)`
  （migration 033）。**匿名の言葉・編集の記録・月の締め記録は消えない**（設計どおり）。

## 変更履歴

- 2026-03-24: 初版策定
- 2026-07-13: P0-11反映。flow_events(13ヶ月)/product_ratings(無期限)/broadcast_stats(無期限)/behaviorLog発話全文停止＋バックフィル手順を追記
- **2026-08-08 (Setaka決定・Boss実行)**: 会話 (`conversations`) / 感想の自由記述
  (`message_feedback.comment`) / 未回答クエリ (`unanswered_queries`) を**無期限保持**に変更。
  90日自動削除ジョブ3本を廃止し `031_stop_conversation_retention.sql` に記録。
  あわせて「消せます」と約束できない旨の注意書きを追加。
- **2026-08-08本番適用完了（Setaka指示・Boss実行）**: 本番Supabaseに031を適用し、
  `cleanup-old-conversations` / `cleanup-old-feedback` / `cleanup-old-unanswered` の3本を解除。
  適用後の `cron.job` は `daily-conversation-stats`（日次集計）1本のみ。
  `conversations` は適用前後とも347件・最古2026-06-06で不変（データ操作なし）。
- **2026-08-08 (rojiカルテの器・タスク07)**: `032_roji_words.sql` / `033_roji_delivery_ledger.sql`
  をstaging → 本番の順に適用（`--only 032,033`）。新設6テーブルすべて**永久 / 無期限**で
  上表に追記した。**自動削除ジョブは1本も追加していない**（適用前後とも `cron.job` は
  `daily-conversation-stats` 1本のみ）。適用は追加のみで、既存20テーブルの行数は
  `schema_migrations`（27→29・台帳登録2件）以外すべて不変。
