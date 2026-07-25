# ソフトローンチ動作確認チェックリスト

## 実行日: ____

## 自動テスト

```bash
# スモークテスト（本番）
pnpm smoke-test

# スモークテスト（ステージング）
pnpm smoke-test -- --target=https://elxea-agent-staging.setaka1103.workers.dev

# 入力バリデーションテスト
pnpm test:e2e:web:validation
```

## 手動確認項目

> LINE 設定の切り分け（表現の是正）: 「LINE 設定＝全部手動」ではない。**OA Manager 固有設定のみ手動**
> （応答モード・あいさつメッセージ・リッチメニュー画像）で、**webhook URL の設定・到達性は Messaging API で
> 検証できる**。本番フル反映（`scripts/deploy-prod.sh`）は health check 段で
> `GET /v2/bot/channel/webhook/endpoint`（active 判定）＋ `POST /v2/bot/channel/webhook/test`（到達性）を
> read-only で自動検証する（ユーザーへは何も送信しない）。以下の手動項目は OA Manager 固有・実機挙動の確認。

### LINE チャネル

- [ ] LINE で質問を送信 -> 応答が返る
  - テストメッセージ: 「おすすめのお茶を教えてください」
  - 確認: テキスト応答 + 商品カード（Flex Message）が表示される
- [ ] LINE で会話を継続 -> 文脈が維持される
  - テストメッセージ: 「その中で一番人気はどれですか？」
  - 確認: 前の会話を踏まえた応答が返る
- [ ] LINE で「買いたい」 -> カートリンクが生成される（cart_link ツール実装済みの場合）
  - テストメッセージ: 「この商品を購入したいです」
  - 確認: カート Flex Message（購入手続きへボタン）が表示される

### Web チャットチャネル

- [ ] Web チャットで質問 -> 応答が返る（SSE ストリーミング）
  - ブラウザで https://elxea.com を開き、下部のチャットバーに入力
  - 確認: テキストがストリーミング表示される
- [ ] Web チャットで商品おすすめ -> 商品カードが表示される
  - テストメッセージ: 「おすすめのお茶を教えて」
  - 確認: チャット内に商品カードがインライン表示される
- [ ] ページ遷移後も会話が維持される
  - チャットで会話後、別ページに遷移してチャットパネルを開く
  - 確認: 以前の会話履歴が表示されている

### オムニチャネル（紐付け済みユーザーのみ）

- [ ] LINE で会話 -> Web で同じ履歴が見える
  - 前提: LINE と Web アカウントが紐付け済み
  - LINE で会話 -> Web のチャット履歴に LINE での会話が表示される

### エスカレーション

- [ ] エスカレーション -> Slack 通知が飛ぶ
  - テストメッセージ: 「人間のスタッフに繋いでください」
  - 確認: Slack の指定チャンネルに通知が届く
  - 確認: 通知にユーザーID、カテゴリ、理由、会話要約が含まれる

### ナレッジベース

- [ ] RAG ナレッジが最新
  - `POST /api/sync` を実行して最新ナレッジを同期
  - 確認: 同期結果のログに処理件数が表示される
  - 最終同期日時: ____

### 環境変数

- [ ] 本番環境の全環境変数が設定されている
  ```bash
  wrangler secret list
  ```
  必須シークレット:
  - LINE_CHANNEL_SECRET
  - LINE_CHANNEL_ACCESS_TOKEN
  - ANTHROPIC_API_KEY
  - SUPABASE_URL
  - SUPABASE_SERVICE_ROLE_KEY
  - FIREBASE_PROJECT_ID
  - FIREBASE_CLIENT_EMAIL
  - FIREBASE_PRIVATE_KEY
  - SHOPIFY_STORE_DOMAIN
  - SHOPIFY_ADMIN_ACCESS_TOKEN
  - SYNC_API_SECRET
  - SLACK_WEBHOOK_URL

## 判定

- [ ] 全自動テスト PASS
- [ ] 全手動確認項目 OK
- [ ] ロールバック手順を確認済み（docs/rollback.md 参照）
- [ ] Setaka に結果報告済み

**判定結果**: PASS / FAIL

**確認者**: ____
**確認日時**: ____
