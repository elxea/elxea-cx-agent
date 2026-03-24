# Web Chat E2E 手動テスト手順書

Spec v2 WC4-1 に定義された4つのテストシナリオをカバーする手動テスト手順。
自動テスト (`run-web-chat-e2e.ts`) では検証しきれない項目を補完する。

---

## 前提条件

- elxea-cx-agent が本番にデプロイ済み
- Supabase のナレッジベースが同期済み
- elxea-web-app が本番稼働中

### 環境情報

| 項目 | URL |
|------|-----|
| Worker (prod) | `https://elxea-agent.elxea.workers.dev` |
| Web App (prod) | `https://www.elxea.com` |

---

## Scenario 1: Web 未ログインユーザー

### 目的
未ログイン状態で Web チャットが正常動作し、ページ遷移後も会話が維持されることを確認する。

### curl テスト手順

```bash
# 0. セッション ID を生成
SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
echo "Session ID: $SESSION_ID"

# 1. 商品問い合わせ
curl -s -X POST https://elxea-agent.elxea.workers.dev/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"おすすめのお茶を教えてください\", \"session_id\": \"$SESSION_ID\"}"

# 期待結果:
#   - SSE 形式のレスポンス（data: {...}\n\n）
#   - text_delta イベントで AI 応答テキスト
#   - product_card イベントで商品データ（name, price, url）
#   - quick_replies イベントでフォローアップボタン
#   - done イベント

# 2. フォローアップ質問（会話コンテキスト維持確認）
sleep 3
curl -s -X POST https://elxea-agent.elxea.workers.dev/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"その中で一番人気はどれですか？\", \"session_id\": \"$SESSION_ID\"}"

# 期待結果:
#   - 前の会話コンテキストを踏まえた応答（前に提案した商品について言及）
#   - 「それ」「その中で」の指示対象を理解していること

# 3. 会話履歴の確認
curl -s "https://elxea-agent.elxea.workers.dev/api/chat/history?session_id=$SESSION_ID" | python3 -m json.tool

# 期待結果:
#   - messages 配列に 4 件以上（user2 + assistant2）
#   - 各メッセージの channel が "web"
#   - is_linked: false（未ログインのため）
```

### Web App での確認項目

1. https://www.elxea.com にアクセス
2. 画面下部の ChatBar に入力欄が表示されること
3. メッセージを入力して送信
4. AI 応答がストリーミング表示されること
5. 商品カードがインライン表示されること（recommend_product 発動時）
6. 別のページに遷移してもチャットパネルの会話が維持されること
7. ブラウザリロード後に sessionStorage から復元されること

### 合格基準

- [ ] SSE レスポンスが正常にパースできる
- [ ] 商品カードに商品名・価格・URL が含まれる
- [ ] 会話履歴 API で送受信メッセージが全件取得できる
- [ ] ページ遷移後も会話が継続する（同一セッション）

---

## Scenario 2: Web ログインユーザー

### 目的
Shopify OAuth ログイン済みユーザーとして Web チャットが動作し、
Identity Resolver がペルソナ対応トーンで応答することを確認する。

### curl テスト手順

```bash
# 0. セッション ID を生成
SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
# 実際の Shopify Customer GID を使用する場合（テスト環境のみ）
SHOPIFY_CUSTOMER_ID="gid://shopify/Customer/REPLACE_WITH_REAL_ID"

# 1. ログイン済みユーザーとしてメッセージ送信
curl -s -X POST https://elxea-agent.elxea.workers.dev/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"おすすめのお茶を教えてください\", \"session_id\": \"$SESSION_ID\", \"shopify_customer_id\": \"$SHOPIFY_CUSTOMER_ID\"}"

# 期待結果:
#   - SSE 形式のレスポンス
#   - ペルソナ（explorer/sensory/serenity）に応じたトーンの応答
#     - explorer: 詳しい商品知識を含む応答
#     - sensory: 味・香りの表現が豊か
#     - serenity: くつろぎ・リラックスを意識した表現
#   - user_identity_map に Shopify Customer ID が登録される

# 2. Identity 解決の確認
curl -s "https://elxea-agent.elxea.workers.dev/api/chat/history?session_id=$SESSION_ID" | python3 -m json.tool

# 期待結果:
#   - messages 配列にメッセージが含まれる
#   - is_linked: true（紐付け済みの場合）or false（新規登録の場合）
```

### Supabase での確認項目

```sql
-- user_identity_map にレコードが作成されたか確認
SELECT * FROM user_identity_map
WHERE shopify_customer_id = 'gid://shopify/Customer/REPLACE_WITH_REAL_ID';

-- 会話が正しい user_id で保存されているか
SELECT user_id, channel, role, content, created_at
FROM conversations
WHERE user_id = '<session_id>'
ORDER BY created_at DESC
LIMIT 10;
```

### 合格基準

- [ ] Shopify Customer ID 付きリクエストが正常処理される
- [ ] user_identity_map にレコードが作成/更新される
- [ ] 紐付け済みユーザーは is_linked: true で履歴取得できる
- [ ] ペルソナが設定されている場合、対応したトーンで応答する

---

## Scenario 3: LINE -> Web 会話引き継ぎ

### 目的
LINE で行った会話が Web チャットでも参照できること（オムニチャネル統合）を確認する。

### 前提条件

- テスト用 LINE ユーザーと Shopify Customer の紐付けが `user_identity_map` に存在すること
- 紐付けレコード例:
  ```sql
  INSERT INTO user_identity_map (unified_user_id, line_user_id, web_session_id, shopify_customer_id)
  VALUES ('gid://shopify/Customer/TEST_ID', 'U_test_line_user', NULL, 'gid://shopify/Customer/TEST_ID');
  ```

### テスト手順

```bash
# 1. LINE 側で会話する（LINE アプリまたは E2E テスト）
#    npx tsx tests/e2e/run-e2e.ts --scenario=1
#    -> LINE ユーザー ID で conversations テーブルにメッセージが保存される

# 2. Web 側で同じユーザーとしてログイン（同じ Shopify Customer ID）
SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
SHOPIFY_CUSTOMER_ID="gid://shopify/Customer/TEST_ID"

# 3. Web チャットで会話開始
curl -s -X POST https://elxea-agent.elxea.workers.dev/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"さっき LINE で聞いた商品のことなんですが\", \"session_id\": \"$SESSION_ID\", \"shopify_customer_id\": \"$SHOPIFY_CUSTOMER_ID\"}"

# 期待結果:
#   - LINE での会話コンテキストを踏まえた応答
#   - （Identity 解決済みなら）LINE の会話履歴も参照して回答

# 4. 会話履歴の確認（全チャネル）
curl -s "https://elxea-agent.elxea.workers.dev/api/chat/history?session_id=$SESSION_ID" | python3 -m json.tool

# 期待結果:
#   - is_linked: true
#   - messages に LINE (channel: "line") と Web (channel: "web") の両方が含まれる

# 5. チャネルフィルター付きで確認
curl -s "https://elxea-agent.elxea.workers.dev/api/chat/history?session_id=$SESSION_ID&channel=line" | python3 -m json.tool
curl -s "https://elxea-agent.elxea.workers.dev/api/chat/history?session_id=$SESSION_ID&channel=web" | python3 -m json.tool
```

### Supabase での確認項目

```sql
-- unified_user_id で全チャネルの会話を確認
SELECT c.user_id, c.channel, c.role, c.content, c.created_at
FROM conversations c
JOIN user_identity_map m ON (
  c.user_id = m.unified_user_id
  OR c.user_id = m.line_user_id
  OR c.user_id = m.web_session_id
)
WHERE m.unified_user_id = 'gid://shopify/Customer/TEST_ID'
ORDER BY c.created_at DESC
LIMIT 20;
```

### 合格基準

- [ ] LINE で保存された会話が Web の履歴 API で取得できる
- [ ] is_linked: true が返る
- [ ] channel フィルターが正常に動作する
- [ ] AI が LINE での会話コンテキストを踏まえて応答する

---

## Scenario 4: エスカレーション

### 目的
Web チャットで人間対応を要求した場合に、エスカレーションが発動し Slack に通知が送信されることを確認する。

### curl テスト手順

```bash
SESSION_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

# 1. 人間対応要求
curl -s -X POST https://elxea-agent.elxea.workers.dev/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"スタッフに繋いでください\", \"session_id\": \"$SESSION_ID\"}"

# 期待結果:
#   - 「確認してお返事します」系の応答テキスト
#   - Slack に通知が送信される（SLACK_WEBHOOK_URL 設定時）

# 2. 健康被害報告（最優先エスカレーション）
SESSION_ID2=$(uuidgen | tr '[:upper:]' '[:lower:]')
curl -s -X POST https://elxea-agent.elxea.workers.dev/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"お茶を飲んだらアレルギー反応が出ました。体調が悪いです。\", \"session_id\": \"$SESSION_ID2\"}"

# 期待結果:
#   - 「確認してお返事します」+ 健康への配慮メッセージ
#   - Slack に health_safety カテゴリで通知

# 3. クレーム対応
SESSION_ID3=$(uuidgen | tr '[:upper:]' '[:lower:]')
curl -s -X POST https://elxea-agent.elxea.workers.dev/api/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"商品が届かないのですが。注文してから2週間経ちます。\", \"session_id\": \"$SESSION_ID3\"}"

# 期待結果:
#   - order_trouble カテゴリでエスカレーション
#   - Slack 通知
```

### Slack 通知の確認項目

Slack の通知チャンネルで以下形式のメッセージが届くことを目視確認:

```
*エスカレーション* [カテゴリ]

*Channel:* Web
*User:* <session_id>
*分類:* <日本語ラベル>
*理由:* <エスカレーション理由>
*会話要約:* <会話内容の要約>
```

### 合格基準

- [ ] 人間対応要求で escalate_to_human ツールが呼ばれる
- [ ] 顧客へのメッセージは「確認してお返事します」系の内容
- [ ] Slack 通知が送信される
- [ ] 通知に Channel: Web が含まれる
- [ ] health_safety カテゴリが正しく分類される

---

## テスト実施記録テンプレート

```
シナリオ: [1-4]
実施日時: YYYY-MM-DD HH:MM
実施者:
結果: Pass / Partial / Fail
観察事項:
  -
不具合:
  -
Slack 通知確認（Scenario 4）: Yes / No / N/A
```
