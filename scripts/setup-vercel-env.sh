#!/usr/bin/env bash
# =============================================================================
# elxea-web-app Vercel 環境変数設定スクリプト
#
# 実行前の前提:
#   1. Vercel CLI がインストール済み: npm install -g vercel
#   2. Vercel にログイン済み: vercel login
#   3. プロジェクトが Vercel にリンク済み: cd ../elxea-web-app && vercel link
#   4. 環境変数が設定済み（または .env.production を source する）
#
# 使い方:
#   cd elxea-agent
#   source .env.production && bash scripts/setup-vercel-env.sh
#
# 注意:
#   - この スクリプト自体にシークレット値を含めない
# =============================================================================

set -euo pipefail

WEBAPP_DIR="${WEBAPP_DIR:-../elxea-web-app}"

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

command -v vercel >/dev/null 2>&1 || error "Vercel CLI がインストールされていません。npm install -g vercel を実行してください。"
info "Vercel CLI OK: $(vercel --version)"

[[ -d "${WEBAPP_DIR}" ]] || error "elxea-web-app ディレクトリが見つかりません: ${WEBAPP_DIR}"

# ------------------------------------------------------------------
# 環境変数チェック
# ------------------------------------------------------------------
section "必須環境変数チェック"

REQUIRED_VARS=(
  SHOPIFY_STORE_DOMAIN
  SHOPIFY_STOREFRONT_ACCESS_TOKEN
  SHOPIFY_ADMIN_ACCESS_TOKEN
  SHOPIFY_WEBHOOK_SECRET
  SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID
  SHOPIFY_SHOP_ID
  SESSION_SECRET
  SANITY_API_READ_TOKEN
  FIREBASE_PROJECT_ID
  FIREBASE_CLIENT_EMAIL
  FIREBASE_PRIVATE_KEY
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
  error "環境変数を設定してから再実行してください。"
fi

info "必須環境変数 OK"

# ------------------------------------------------------------------
# Vercel 環境変数の設定
# ------------------------------------------------------------------
section "Vercel 環境変数設定 (production + preview)"

add_env() {
  local key="$1"
  local value="${!key}"
  local envs="${2:-production,preview}"
  info "Setting: ${key} (${envs})"
  # vercel env add は対話形式のため、echo でパイプ入力
  echo "${value}" | vercel env add "${key}" production --yes --cwd "${WEBAPP_DIR}" 2>/dev/null || true
  echo "${value}" | vercel env add "${key}" preview --yes --cwd "${WEBAPP_DIR}" 2>/dev/null || true
}

add_env SHOPIFY_STORE_DOMAIN
add_env SHOPIFY_STOREFRONT_ACCESS_TOKEN
add_env SHOPIFY_ADMIN_ACCESS_TOKEN
add_env SHOPIFY_WEBHOOK_SECRET
add_env SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID
add_env SHOPIFY_SHOP_ID
add_env SESSION_SECRET
add_env SANITY_API_READ_TOKEN
add_env FIREBASE_PROJECT_ID
add_env FIREBASE_CLIENT_EMAIL
add_env FIREBASE_PRIVATE_KEY

# オプション
if [[ -n "${NEXT_PUBLIC_LIFF_ID:-}" ]]; then
  add_env NEXT_PUBLIC_LIFF_ID
fi
if [[ -n "${NEXT_PUBLIC_SANITY_PROJECT_ID:-}" ]]; then
  add_env NEXT_PUBLIC_SANITY_PROJECT_ID
fi
if [[ -n "${NEXT_PUBLIC_SANITY_DATASET:-}" ]]; then
  add_env NEXT_PUBLIC_SANITY_DATASET
fi
if [[ -n "${NEXT_PUBLIC_GTM_ID:-}" ]]; then
  add_env NEXT_PUBLIC_GTM_ID
fi

# ------------------------------------------------------------------
# 完了
# ------------------------------------------------------------------
section "Vercel 環境変数設定完了"
info "設定済み環境変数の一覧:"
vercel env ls --cwd "${WEBAPP_DIR}" 2>/dev/null || warn "環境変数一覧の取得に失敗しました"

echo ""
warn "次のステップ:"
echo "  1. vercel --prod --cwd ${WEBAPP_DIR}  -- 本番デプロイ"
echo "  2. curl https://your-app.vercel.app/api/health  -- ヘルスチェック"
