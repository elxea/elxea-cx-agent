# ロールバック手順書

問題発生時にサービスを前のバージョンに戻すための手順。

## 1. elxea-cx-agent (Cloudflare Workers)

### 前のバージョンに戻す

```bash
# 現在のデプロイ一覧を確認
wrangler deployments list

# 前のデプロイにロールバック（直前のバージョン）
wrangler rollback

# 特定のデプロイ ID にロールバック
wrangler rollback --version-id <deployment-id>
```

### ステージングにロールバック

```bash
wrangler deployments list --env staging
wrangler rollback --env staging
```

### 確認

```bash
# Worker が正常に動作しているか確認
curl https://elxea-agent.elxea.workers.dev/
# 期待: {"status":"ok","service":"elxea-agent"}
```

## 2. elxea-web-app (Vercel)

### Vercel Dashboard からロールバック

1. [Vercel Dashboard](https://vercel.com/) にログイン
2. elxea-web-app プロジェクトを選択
3. **Deployments** タブを開く
4. 戻したいデプロイの **...** メニューから **Promote to Production** を選択
5. 確認ダイアログで **Promote** をクリック

### CLI からロールバック（Vercel CLI）

```bash
# 本番デプロイ一覧
vercel ls --prod

# 特定のデプロイを本番に昇格
vercel promote <deployment-url>
```

### 確認

```bash
curl https://elxea.jp
# ページが正常に表示されることを確認
```

## 3. Supabase (データベース)

### マイグレーションのロールバック

各マイグレーションファイルには対応するロールバック SQL を以下に記載。
Supabase Dashboard の SQL Editor で実行する。

#### 007_conversation_search.sql のロールバック

```sql
DROP FUNCTION IF EXISTS search_conversations;
```

#### 006_channel_adapter.sql のロールバック

```sql
-- conversations テーブルを元に戻す
ALTER TABLE conversations RENAME COLUMN user_id TO line_user_id;
ALTER TABLE conversations DROP COLUMN IF EXISTS channel;
ALTER TABLE conversations DROP COLUMN IF EXISTS metadata;
DROP INDEX IF EXISTS idx_conversations_user_channel;
CREATE INDEX idx_conversations_line_user ON conversations (line_user_id, created_at DESC);

-- unanswered_queries テーブルを元に戻す
ALTER TABLE unanswered_queries RENAME COLUMN user_id TO line_user_id;
ALTER TABLE unanswered_queries DROP COLUMN IF EXISTS channel;

-- user_identity_map を削除
DROP TABLE IF EXISTS user_identity_map;
```

#### 005_metadata_filter.sql のロールバック

```sql
-- search_knowledge_hybrid の metadata filter 対応を元に戻す
-- 元の関数定義（004 時点）で再作成する
CREATE OR REPLACE FUNCTION search_knowledge_hybrid(
  query_embedding vector(1024),
  query_text text,
  match_count int DEFAULT 5,
  match_threshold float DEFAULT 0.3
)
RETURNS TABLE (
  id uuid,
  content text,
  source_type text,
  source_title text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    kc.id,
    kc.content,
    kc.source_type,
    kc.source_title,
    (
      (1 - (kc.embedding <=> query_embedding))::float +
      CASE
        WHEN query_text IS NOT NULL AND query_text != ''
             AND (kc.content ILIKE '%' || query_text || '%'
                  OR kc.source_title ILIKE '%' || query_text || '%')
        THEN 0.1
        ELSE 0
      END
    ) AS similarity
  FROM knowledge_chunks kc
  WHERE (1 - (kc.embedding <=> query_embedding)) > match_threshold
     OR (query_text IS NOT NULL AND query_text != ''
         AND (kc.content ILIKE '%' || query_text || '%'
              OR kc.source_title ILIKE '%' || query_text || '%'))
  ORDER BY similarity DESC
  LIMIT match_count;
END;
$$;
```

#### 004_unanswered_queries.sql のロールバック

```sql
DROP TABLE IF EXISTS unanswered_queries;
```

### 注意事項

- マイグレーションのロールバックはデータ損失を伴う可能性がある
- ロールバック前に必ずバックアップを取得する:
  ```sql
  -- conversations テーブルのバックアップ
  CREATE TABLE conversations_backup AS SELECT * FROM conversations;
  ```
- 本番データベースのロールバックは必ず Setaka の承認を得てから実行する

## 4. 緊急時のフロー

1. **問題検知**: Slack アラート / ユーザー報告 / ヘルスチェック失敗
2. **影響範囲の特定**: どのコンポーネントに問題があるか
   - cx-agent（AI応答が壊れている） -> Worker をロールバック
   - web-app（UIが壊れている） -> Vercel をロールバック
   - データベース（クエリエラー） -> SQL を修正 or マイグレーションをロールバック
3. **ロールバック実行**: 上記の手順に従う
4. **確認**: スモークテスト実行 (`pnpm smoke-test`)
5. **報告**: Slack でインシデント報告、All Tasks DB にタスク作成
