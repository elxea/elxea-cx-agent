# Deploy Runbook -- elxea-cx-agent

## Pre-Deploy Checklist

1. All unit tests pass: `pnpm test:unit`
2. TypeScript compiles: `pnpm typecheck`
3. No uncommitted changes: `git status`
4. Supabase migrations applied (if any)

## Staging Bring-Up（初回セットアップ: 検証チャネルで staging を立てる）

staging（`elxea-agent-staging`）を「テスト OA（@426vlcyb）」に載せて検証するための初回手順。
**全操作でテストチャネルのトークンを使うこと**（本番 OA @307tzhkw のトークンを絶対に混ぜない）。

> 前提の安全設計:
> - `wrangler.toml [env.staging.vars]` に `DELIVERY_TARGET_ENV = "test"` を固定済み。
>   staging は常にテスト OA を対象にする（`src/lib/delivery-channel.ts` が
>   `LINE_CHANNEL_ACCESS_TOKEN_TEST` を選択）。
> - `DELIVERY_SEND_ENABLED` は **未設定のまま**（= dry-run）。実送信は GA 時にのみ ON にする。

### 1. secret を staging に投入（値はコミットしない）

`.dev.vars` はローカル `wrangler dev` 用でありデプロイ先には反映されない。staging には
`wrangler secret put ... --env staging` で個別投入する（値は対話入力・履歴に残さない）。

```bash
# LINE テストチャネル（@426vlcyb）— 本番トークンを入れないこと
wrangler secret put LINE_CHANNEL_ACCESS_TOKEN_TEST --env staging
wrangler secret put LINE_CHANNEL_SECRET_TEST       --env staging

# バックエンド系（プロジェクトの実際の必要値に合わせる）
wrangler secret put ANTHROPIC_API_KEY              --env staging
wrangler secret put SUPABASE_URL                   --env staging
wrangler secret put SUPABASE_SERVICE_ROLE_KEY      --env staging
# Firebase / R2 等、配信・画像を検証する場合のみ:
wrangler secret put R2_API_TOKEN                   --env staging
# （FIREBASE_* 等はコードが要求するものだけ投入）

# 投入済み secret 名の確認（値は表示されない）
wrangler secret list --env staging
```

### 2. staging へデプロイ

```bash
pnpm deploy:staging   # = wrangler deploy --env staging
```

### 3. テストチャネルの Webhook を staging URL に登録

LINE Developers Console で **テストチャネル（@426vlcyb）** の Messaging API 設定を開き、
Webhook URL を staging の受け口に向ける（**本番チャネルの Webhook は触らない**）:

```
https://elxea-agent-staging.setaka1103.workers.dev/webhook/line
```

「Webhook の利用」を ON にし、Verify で 200 が返ることを確認する。

### 4. リッチメニューをテストチャネルへ登録

テストトークンを export してから実行する。スクリプトは `LINE_CHANNEL_ACCESS_TOKEN_TEST` を
優先して使い、起動時に対象チャネル（`test(@426vlcyb)`）をラベル表示する。

```bash
export LINE_CHANNEL_ACCESS_TOKEN_TEST=<テストチャネルのアクセストークン>
pnpm setup-rich-menu
# 出力の「🎯 対象チャネル: test(@426vlcyb)」を必ず目視確認する。
# prod(@307tzhkw) と出たら *_TEST が未設定 → 中断してトークンを設定し直す。
```

その後 LINE Official Account Manager（テスト OA 側）でリッチメニュー画像
（2500x1686px・6 分割）をアップロードする。

### 5. スタッフがテスト OA を友だち追加して確認

テスト OA（@426vlcyb）を友だち追加し、リッチメニュー表示・各ボタンの挙動・
CX エージェントとの会話を実機確認する。この段階は `DELIVERY_SEND_ENABLED` 未設定のため
配信（broadcast）は dry-run のまま。実送信検証は GA 判断後に別途行う。

> ⚠ 取り違え注意（最重要）: 手順 1・3・4 は **すべてテストチャネル（@426vlcyb）**。
> 本番 OA（@307tzhkw / 友だち 38）のトークン・Webhook・リッチメニューには一切触れない。

## Staging Deploy

```bash
# 1. Deploy to staging
pnpm deploy:staging

# 2. Verify staging (automated checks)
npx tsx scripts/verify-staging.ts

# 3. Run E2E tests against staging
pnpm test:e2e:web -- --target=https://elxea-agent-staging.setaka1103.workers.dev

# 4. Run LINE E2E tests (requires LINE_CHANNEL_SECRET)
STAGING_WORKER_URL=https://elxea-agent-staging.setaka1103.workers.dev pnpm test:e2e
```

## Production Deploy (Tier 2: Setaka Approval Required)

### Deploy Order

1. **Supabase migrations** (if any pending)
2. **elxea-cx-agent**: `pnpm deploy`
3. **elxea-web-app**: Vercel production deploy (merge to main)

### Deploy Steps

```bash
# 1. Final staging verification
npx tsx scripts/verify-staging.ts

# 2. Deploy to production
pnpm deploy

# 3. Verify production (health check only, no Claude API calls)
curl -s https://elxea-agent.elxea.workers.dev/ | jq .
# Expected: {"status":"ok","service":"elxea-agent"}

# 4. Smoke test (manual)
# - Open https://www.elxea.com
# - Send a message via ChatBar
# - Verify SSE streaming response
# - Check Slack for any error alerts
```

### Rollback

```bash
# Rollback to previous version
wrangler rollback

# Verify rollback
curl -s https://elxea-agent.elxea.workers.dev/ | jq .
```

## elxea-web-app Deploy

### Staging

Web app staging is handled via Vercel Preview deployments (automatic on feature branches).

### Production

```bash
# Merge to main triggers automatic Vercel production deploy
git push origin main

# Verify at https://www.elxea.com
# Check ChatBar functionality, login flows, account page
```

### Rollback

Use Vercel dashboard to promote previous deployment, or:

```bash
# Revert the merge commit
git revert HEAD
git push origin main
```

## Monitoring Post-Deploy

- Check Slack #alerts channel for error notifications
- Monitor Cloudflare Workers dashboard for error rate
- Check `/api/alerts/status` endpoint (requires SYNC_API_SECRET)
- Verify Notion Alerts DB for new entries
