# elxea-agent Scripts

## 本番環境セットアップ（初回）

### 1. 環境変数ファイルの準備

```bash
cp .env.production.example .env.production
# .env.production を編集して実際の値を入力
```

### 2. Cloudflare Workers Secrets の設定

```bash
source .env.production
bash scripts/setup-production.sh
```

Cloudflare Workers の本番・ステージング両環境にシークレットを設定します。

### 3. LIFF アプリの登録

```bash
source .env.production
LIFF_ENDPOINT_URL=https://your-webapp.vercel.app/liff npx tsx scripts/setup-liff.ts
```

LINE Developers Console に LIFF アプリを登録し、`LIFF_ID` を取得します。
取得した `LIFF_ID` を Workers Secrets に追加します：

```bash
echo "YOUR_LIFF_ID" | wrangler secret put LIFF_ID
echo "YOUR_LIFF_ID" | wrangler secret put LIFF_ID --env staging
```

### 4. Vercel 環境変数の設定（elxea-web-app）

```bash
source .env.production
# NEXT_PUBLIC_LIFF_ID も設定する場合
export NEXT_PUBLIC_LIFF_ID="YOUR_LIFF_ID"
bash scripts/setup-vercel-env.sh
```

### 5. LINE リッチメニューの設定

```bash
LINE_CHANNEL_ACCESS_TOKEN=your-token npx tsx scripts/setup-rich-menu.ts
```

6 分割のリッチメニューを設定します。メニュー画像は LINE Official Account Manager で別途設定が必要です。

---

## 日次・定期スクリプト

### ナレッジ同期

```bash
npx tsx scripts/sync-knowledge.ts
```

Notion からナレッジをエージェントに同期します。通常は launchd/cron で自動実行されます。

---

## 環境変数一覧

| 変数名 | 設定先 | 必須 | 説明 |
|--------|--------|------|------|
| `LINE_CHANNEL_SECRET` | Workers Secrets | Yes | LINE Messaging API チャネルシークレット |
| `LINE_CHANNEL_ACCESS_TOKEN` | Workers Secrets | Yes | LINE アクセストークン（長期） |
| `ANTHROPIC_API_KEY` | Workers Secrets | Yes | Claude API キー |
| `SUPABASE_URL` | Workers Secrets | Yes | Supabase プロジェクト URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Workers Secrets | Yes | Supabase サービスロールキー |
| `FIREBASE_PROJECT_ID` | Workers Secrets | Yes | Firebase プロジェクト ID |
| `FIREBASE_CLIENT_EMAIL` | Workers Secrets | Yes | Firebase サービスアカウント Email |
| `FIREBASE_PRIVATE_KEY` | Workers Secrets | Yes | Firebase サービスアカウント秘密鍵 |
| `SHOPIFY_STORE_DOMAIN` | Workers Secrets | Yes | Shopify ストアドメイン |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Workers Secrets | Yes | Shopify Admin API トークン |
| `LIFF_ID` | Workers Secrets | Yes | LINE LIFF アプリ ID |
| `SYNC_API_SECRET` | Workers Secrets | Yes | /api/sync 認証トークン |
| `SLACK_WEBHOOK_URL` | Workers Secrets | No | Slack エスカレーション通知 |
| `NOTION_TOKEN` | Workers Secrets | No | Notion API トークン（ナレッジ同期） |

### elxea-web-app (Vercel)

| 変数名 | 必須 | 説明 |
|--------|------|------|
| `SHOPIFY_STORE_DOMAIN` | Yes | Shopify ストアドメイン |
| `SHOPIFY_STOREFRONT_ACCESS_TOKEN` | Yes | Shopify Storefront API トークン |
| `SHOPIFY_ADMIN_ACCESS_TOKEN` | Yes | Shopify Admin API トークン |
| `SHOPIFY_WEBHOOK_SECRET` | Yes | Webhook 署名検証シークレット |
| `SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID` | Yes | Customer Account API クライアント ID |
| `SHOPIFY_SHOP_ID` | Yes | Shopify ショップ ID |
| `SESSION_SECRET` | Yes | セッション暗号化キー（32文字以上） |
| `NEXT_PUBLIC_SANITY_PROJECT_ID` | Yes | Sanity プロジェクト ID |
| `NEXT_PUBLIC_SANITY_DATASET` | Yes | Sanity データセット名 |
| `SANITY_API_READ_TOKEN` | Yes | Sanity 読み取りトークン |
| `FIREBASE_PROJECT_ID` | Yes | Firebase プロジェクト ID |
| `FIREBASE_CLIENT_EMAIL` | Yes | Firebase サービスアカウント Email |
| `FIREBASE_PRIVATE_KEY` | Yes | Firebase サービスアカウント秘密鍵 |
| `NEXT_PUBLIC_LIFF_ID` | Yes | LIFF アプリ ID（フロントエンド参照用） |
| `NEXT_PUBLIC_GTM_ID` | No | Google Tag Manager ID |
