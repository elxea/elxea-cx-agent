# Deploy Runbook -- elxea-cx-agent

## Pre-Deploy Checklist

1. All unit tests pass: `pnpm test:unit`
2. TypeScript compiles: `pnpm typecheck`
3. No uncommitted changes: `git status`
4. Supabase migrations applied (if any)

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
