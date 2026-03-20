#!/usr/bin/env bash
# =============================================================================
# elxea-agent 本番環境セットアップスクリプト
#
# 実行前の前提:
#   1. wrangler がインストール済み: npm install -g wrangler
#   2. Cloudflare にログイン済み: wrangler login
#   3. 以下の環境変数がシェルに設定済み（または .env ファイルを source する）
#
# 使い方:
#   1. .env.production.example をコピーして .env.production を作成
#   2. 各値を記入する（実際のシークレット値を入力）
#   3. source .env.production && bash scripts/setup-production.sh
#
# 注意:
#   - このスクリプト自体にシークレット値を含めない
#   - .env.production は .gitignore に含まれていること
# =============================================================================

set -euo pipefail

WORKER_NAME="elxea-agent"

# ------------------------------------------------------------------
# カラー出力ユーティリティ
# ------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }
section() { echo -e "\n${YELLOW}=== $1 ===${NC}"; }

# ------------------------------------------------------------------
# 前提チェック
# ------------------------------------------------------------------
section "前提チェック"

command -v wrangler >/dev/null 2>&1 || error "wrangler がインストールされていません。npm install -g wrangler を実行してください。"
info "wrangler OK: $(wrangler --version)"

# ------------------------------------------------------------------
# 必須環境変数チェック
# ------------------------------------------------------------------
section "必須環境変数チェック"

REQUIRED_VARS=(
  LINE_CHANNEL_SECRET
  LINE_CHANNEL_ACCESS_TOKEN
  ANTHROPIC_API_KEY
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  FIREBASE_PROJECT_ID
  FIREBASE_CLIENT_EMAIL
  FIREBASE_PRIVATE_KEY
  SHOPIFY_STORE_DOMAIN
  SHOPIFY_ADMIN_ACCESS_TOKEN
  LIFF_ID
  SYNC_API_SECRET
)

MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    MISSING+=("$var")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "以下の環境変数が未設定です:"
  printf '  - %s\n' "${MISSING[@]}"
  error "source .env.production してから再実行してください。"
fi

info "すべての必須環境変数が設定されています"

# ------------------------------------------------------------------
# Cloudflare Workers Secrets の設定（本番）
# ------------------------------------------------------------------
section "Cloudflare Workers Secrets 設定（本番: ${WORKER_NAME}）"

set_secret() {
  local key="$1"
  local value="${!key}"
  info "Setting secret: ${key}"
  echo "${value}" | wrangler secret put "${key}" --name "${WORKER_NAME}"
}

set_secret LINE_CHANNEL_SECRET
set_secret LINE_CHANNEL_ACCESS_TOKEN
set_secret ANTHROPIC_API_KEY
set_secret SUPABASE_URL
set_secret SUPABASE_SERVICE_ROLE_KEY
set_secret FIREBASE_PROJECT_ID
set_secret FIREBASE_CLIENT_EMAIL
set_secret FIREBASE_PRIVATE_KEY
set_secret SHOPIFY_STORE_DOMAIN
set_secret SHOPIFY_ADMIN_ACCESS_TOKEN
set_secret LIFF_ID
set_secret SYNC_API_SECRET

# オプション
if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
  set_secret SLACK_WEBHOOK_URL
fi
if [[ -n "${NOTION_TOKEN:-}" ]]; then
  set_secret NOTION_TOKEN
fi
if [[ -n "${NOTION_PRODUCT_LIST_DB_ID:-}" ]]; then
  set_secret NOTION_PRODUCT_LIST_DB_ID
fi

info "本番 Workers Secrets 設定完了"

# ------------------------------------------------------------------
# ステージング環境の Secrets も設定
# ------------------------------------------------------------------
section "Cloudflare Workers Secrets 設定（ステージング）"

set_secret_env() {
  local key="$1"
  local value="${!key}"
  info "Setting staging secret: ${key}"
  echo "${value}" | wrangler secret put "${key}" --env staging
}

set_secret_env LINE_CHANNEL_SECRET
set_secret_env LINE_CHANNEL_ACCESS_TOKEN
set_secret_env ANTHROPIC_API_KEY
set_secret_env SUPABASE_URL
set_secret_env SUPABASE_SERVICE_ROLE_KEY
set_secret_env FIREBASE_PROJECT_ID
set_secret_env FIREBASE_CLIENT_EMAIL
set_secret_env FIREBASE_PRIVATE_KEY
set_secret_env SHOPIFY_STORE_DOMAIN
set_secret_env SHOPIFY_ADMIN_ACCESS_TOKEN
set_secret_env LIFF_ID
set_secret_env SYNC_API_SECRET

info "ステージング Workers Secrets 設定完了"

# ------------------------------------------------------------------
# 完了
# ------------------------------------------------------------------
section "セットアップ完了"
info "Cloudflare Workers Secrets の設定が完了しました"
echo ""
warn "次のステップ:"
echo "  1. bash scripts/setup-vercel-env.sh  -- elxea-web-app の Vercel 環境変数設定"
echo "  2. bash scripts/setup-liff.sh        -- LIFF アプリ登録 + LIFF_ID 取得"
echo "  3. pnpm setup-rich-menu              -- LINE リッチメニュー設定"
echo "  4. wrangler deploy                   -- 本番デプロイ"
