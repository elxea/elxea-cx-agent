# R1 復旧ランブック（FIX-1 / FIX-2 / FIX-3）

Spec v3（https://www.notion.so/39370c9d064c81a3b25bc6384a87456d）7 章の修理 Phase R1 の実行手順。

対象: `elxea-cx-agent`（Cloudflare Workers）+ 本番 Supabase。

## 安全原則（厳守）

- 本番への DDL 適用・デプロイ・手動 full sync はすべて **ENV-3 ゲート**（staging 検証 → Setaka の Tier 2 承認）を通す。
- 本ランブックのコード・migration・スクリプトは「準備」まで。**本番実行は Setaka 承認後に別途行う。**
- 適用先が **staging か本番か** を毎回確認する（接続先は `SUPABASE_URL` が指すプロジェクト。取り違え厳禁）。

## 実行順序（依存関係）

```
FIX-1（テーブル復旧・migration 018 適用）
   └─ FIX-2（同期可視化・コードをデプロイ）
         └─ FIX-3（手動 full sync で 357 件凍結を解凍）
```

FIX-3 は **FIX-1 の本番適用 + FIX-2 のデプロイが完了して初めて実行可能**。順序を飛ばさない
（FIX-2 未デプロイで full sync すると、失敗が再びサイレント化する）。

---

## FIX-1: 不在 3 テーブルの復旧

### 何を復旧するか

migration 002 / 014 が本番未適用のため、以下 3 テーブルが不在（migration 017 のコメントで明記）:

| テーブル | 由来 migration | 不在の影響 |
|---|---|---|
| customer_linkages | 002 | 注文照会・パーソナライズ・metafield 同期・セグメント配信が no-op |
| sync_logs | 002（+ 004 の sync_type 列）| 同期台帳が記録不能 = 4 ヶ月無音故障の温床 |
| pending_follow_refs | 014 | QR 経由の商品固有ウェルカムが不達 |

### 適用する migration

`src/db/migrations/018_recovery_missing_tables.sql`

- 002 / 004 / 014 を **1 本に統合**した自己完結・冪等 SQL（`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` / `ENABLE ROW LEVEL SECURITY`）。
- 002 → 004 の順序依存（004 が sync_logs 前提で ALTER）をこの 1 本で解消。単体で流せる。
- 017 と同じセキュリティ姿勢（RLS 有効化・ポリシー無し = service_role のみ）を 3 テーブルに付与。
- **再実行安全**。既存テーブルがあっても何も壊さない。

### 実行に必要なもの

**本番 Supabase の Postgres 直接接続パスワード `SUPABASE_DB_PASSWORD`**。

- 取得元: Supabase Dashboard > Project Settings > Database > Connection string / Database password。
- **`.dev.vars` には含まれない**（`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` はあるが DB パスワードは別）。実行時に環境変数か引数で渡す必要がある。
- これが提供されない限り非対話の直接適用はできない（下記 経路 B の手動適用は可能）。

### 適用手順（2 経路）

#### 経路 A: スクリプトで非対話適用（推奨・DB パスワードがある場合）

```bash
cd /Users/setaka/github/elxea/products/elxea-cx-agent

# 接続先確認（SUPABASE_URL が本番か staging か）
grep '^SUPABASE_URL=' .dev.vars

# 適用（冪等。適用後に 3 テーブルの存在を自動検証する）
SUPABASE_DB_PASSWORD='<本番 DB パスワード>' npx tsx scripts/run-recovery-migration.ts
# または
npx tsx scripts/run-recovery-migration.ts --password='<本番 DB パスワード>'
```

期待出力（末尾）:
```
  Verification: customer_linkages exists = true
  Verification: sync_logs exists = true
  Verification: pending_follow_refs exists = true
All 3 required tables present. Recovery migration verified.
```

`scripts/run-recovery-migration.ts` は既存の `scripts/run-migration-016.ts` と同じ接続方式
（`pg` で `db.<projectRef>.supabase.co:5432` に `postgres` ユーザー接続）。

#### 経路 B: Supabase SQL Editor で手動適用（DB パスワードが無い場合のフォールバック）

パスワード未設定でスクリプトを起動すると、SQL 全文と SQL Editor の URL を出力する:

```bash
npx tsx scripts/run-recovery-migration.ts   # パスワード無し → SQL と URL を表示
```

出力された `https://supabase.com/dashboard/project/<projectRef>/sql` を開き、
`src/db/migrations/018_recovery_missing_tables.sql` の全文を貼り付けて実行する。

### 適用後の検証（手動確認する場合）

Supabase SQL Editor で:

```sql
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('customer_linkages', 'sync_logs', 'pending_follow_refs');
-- 3 行返れば復旧成功
```

### ロールバック

- 復旧 migration は **追加のみ**（テーブル/列/インデックス/RLS の作成）。既存データを変更・削除しない。
- 問題時は作成物を個別に `DROP` すれば適用前状態へ戻る（通常は不要）。復旧が既存機能に与える回帰は unit + smoke で確認する。

---

## FIX-2: 同期失敗の可視化（デプロイ）

コード修正は本ブランチに実装済み（`src/sync/knowledge.ts` / `src/lib/alerts.ts`）。内容:

- sync_logs の insert / 完了 update エラーを **握りつぶさず throw**（同期を失敗として終了）。
- **起動時 preflight**: `sync_logs` / `knowledge_chunks` の存在を同期開始前にチェックし、無ければ即失敗。
- 通知を **失敗時のみ** に反転（成功の定常通知を廃止。見出しは「ナレッジ同期失敗」、成否の絵文字表現を廃止）。
- Notion アラート送信失敗（監査 #4）を握りつぶさず、非緊急アラートでも失敗時は Slack にフォールバック。

### デプロイ手順（ENV-3 準拠）

```bash
# 1. staging へデプロイ
pnpm exec wrangler deploy --env staging

# 2. staging で失敗系を実証（Spec FIX-2 完了条件）
#    - preflight: staging DB で sync_logs を一時的に不在にして POST /api/sync → エラー終了 + Slack 通知を確認
#    - 通知: SLACK_WEBHOOK_URL（staging 用）に「ナレッジ同期失敗」が届くことを確認
# 3. 既存 unit test green を確認
pnpm test:unit
# 4. Setaka 承認（Tier 2）後に本番へ
pnpm deploy      # = wrangler deploy（本番）
```

> 本番デプロイは Setaka 承認後にのみ実行する。crons（`wrangler.toml`）は R1 では空のまま触らない（cron 再開は FIX-13）。

---

## FIX-3: 凍結ナレッジの解凍（手動 full sync）

357 件で凍結中の `knowledge_chunks` を、Notion Ready 記事から再構築する。

### 前提（順序厳守）

1. FIX-1 が **本番に適用済み**（sync_logs が存在 = 台帳記録が可能）。
2. FIX-2 が **本番にデプロイ済み**（失敗が可視化される状態で流す）。

上記が揃う前に full sync を流さない。

### 必要なもの

- 本番 Worker の `SYNC_API_SECRET`（Bearer 認証）。Cloudflare Secrets に設定済みの値。
- 本番 Worker の URL（例: `https://elxea-agent.<...>.workers.dev`。正は FIX-10 でサブドメインを確定）。

### 実行

```bash
curl -X POST 'https://<本番 Worker URL>/api/sync' \
  -H "Authorization: Bearer ${SYNC_API_SECRET}" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"full"}'
# 即時レスポンス: {"status":"sync_started","mode":"full"}
# 実処理は waitUntil で非同期に走る。完了は下記で検証する。
```

### 検証（完了条件）

**(1) sync_logs に成功記録が残る**（Supabase SQL Editor）:

```sql
SELECT id, sync_type, status, total_pages,
       added_chunks, updated_chunks, error_count,
       started_at, completed_at
FROM sync_logs
ORDER BY started_at DESC
LIMIT 1;
-- status = 'success'、completed_at が埋まっていること
```

**(2) knowledge_chunks 件数が Notion Ready 記事数と整合**:

```sql
-- 同期後のチャンク総数
SELECT count(*) AS total_chunks FROM knowledge_chunks;

-- ソース種別ごとの内訳（product / set_menu / tea / article / crm）
SELECT source_type, count(*) FROM knowledge_chunks GROUP BY source_type ORDER BY source_type;
```

- Notion 側の Ready/Published 記事数（Content Hub の Channel=Roji/LINE CRM かつ Status=Ready/Published）と `source_type='article'`/`'crm'` の対応を突合する。1 記事が複数チャンクに分割される（`splitIntoChunks`）ため、**件数は「記事数 ≤ チャンク数」で一致検証する**（記事 0 件の source_type が無いこと、凍結時の 357 件から更新されていることを確認）。
- 失敗時（status != success）は Slack に「ナレッジ同期失敗」が届く。届いた内容の error_details を見て原因を特定する。

### 補足

- full は「source_type 単位で全削除 → 再挿入」（`syncDBFull`）。凍結分を作り直すため full を使う。以後の定常運用は incremental（FIX-13 の cron 再開後）。
- 解凍完了は Spec の launch-checklist LC-2（最終同期成功が 7 日以内 + 件数一致）の入力になる。
