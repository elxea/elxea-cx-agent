#!/usr/bin/env bash
#
# deploy-worker.sh — wrangler deploy に「今から本番に載るコミット」を刻む唯一の入口。
#
# なぜ要るか（実際に困った）:
#   2026-08-25 の調査で「本番に載っているのはどのコミットか」を確定しようとしたところ、
#   web-app（Vercel）は production deployment の githubCommitSha で機械確定できたのに、
#   cx-agent は **最新 version の Tag も Message も空** で、時刻の近さから推測するしか
#   なかった。その 1 点のせいで「11 commit 遅れたコードを本番だと思って調べる」という
#   遠回りが実際に起きている。
#
#   `wrangler deploy` は「今 checkout している中身」を上げるだけで、それがどのコミット
#   だったかを Cloudflare 側に残さない。残すには --tag / --message を渡すしかない。
#
# 何をするか:
#   git から SHA・ブランチ・件名を読み、`wrangler deploy --tag <短SHA> --message <説明>`
#   を実行する。引数はそのまま wrangler へ渡すので `--env staging` 等も使える。
#
# 呼ばれる場所（3 経路とも同じ 1 実装を通す＝ SoT を分裂させない）:
#   - package.json の "deploy"（preflight の後段）
#   - package.json の "deploy:staging"
#   - scripts/deploy-prod.sh の STEP 3（本番フル反映オーケストレータ）
#
# 使い方:
#   ./scripts/deploy-worker.sh                 # 本番（default env）
#   ./scripts/deploy-worker.sh --env staging   # staging
#   DEPLOY_STAMP_PRINT_ONLY=1 ./scripts/deploy-worker.sh   # 実行せず引数だけ出す（テスト用）
#
# 環境変数:
#   DEPLOY_STAMP_PRINT_ONLY  "1" のとき wrangler を呼ばず、決まった tag / message を
#                            `tag=... / message=...` の 2 行で標準出力に出して終了する。
#                            テストが「何が刻まれるか」をデプロイ無しで確かめるための口。
#
# ⚠ git が読めないときも **デプロイは止めない**。刻印は「後から辿れる」ための付加情報で
#   あって、デプロイの可否を決める条件ではない（可否は deploy-preflight.sh の担当）。
#   その場合は刻印無しで上げ、理由を警告で残す。
#
set -euo pipefail

log()  { printf '\033[1m[deploy-worker] %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[deploy-worker][WARN] %s\033[0m\n' "$*" >&2; }

# 刻印の計算は scripts/lib/deploy-stamp.sh に 1 本化してある
# （versions upload 側の scripts/upload-version.sh と同じ実装を通すため）。
# shellcheck source=lib/deploy-stamp.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/deploy-stamp.sh"

compute_deploy_stamp
TAG="${STAMP_TAG}"
MESSAGE="${STAMP_MESSAGE}"

if [[ -z "${TAG}" ]]; then
  warn "git からコミットを読めなかったため、version に刻印せずデプロイする。"
  warn "  → Cloudflare 側からは「どのコミットが載ったか」を後から確定できない状態になる。"
fi

if [[ "${DEPLOY_STAMP_PRINT_ONLY:-}" == "1" ]]; then
  printf 'tag=%s\n' "${TAG}"
  printf 'message=%s\n' "${MESSAGE}"
  exit 0
fi

if [[ -z "${TAG}" ]]; then
  exec pnpm exec wrangler deploy "$@"
fi

log "version に刻む: tag=${TAG}"
log "                message=${MESSAGE}"
exec pnpm exec wrangler deploy --tag "${TAG}" --message "${MESSAGE}" "$@"
