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

# Cloudflare の version tag / message は長さに上限がある。刻めずにデプロイが落ちるのが
# 一番まずいので、こちらで先に詰める（切り詰めても先頭に SHA が来るので用は足りる）。
readonly TAG_MAX=25
readonly MESSAGE_MAX=100

truncate_to() {
  local value="$1" limit="$2"
  if [[ "${#value}" -le "${limit}" ]]; then
    printf '%s' "${value}"
  else
    printf '%s' "${value:0:limit}"
  fi
}

TAG=""
MESSAGE=""

if git rev-parse --git-dir >/dev/null 2>&1; then
  SHA_FULL="$(git rev-parse HEAD 2>/dev/null || true)"
  if [[ -n "${SHA_FULL}" ]]; then
    SHA_SHORT="${SHA_FULL:0:12}"

    # dirty tree は本番では preflight が止めるが、staging は preflight を通らない。
    # 「その SHA と厳密には一致しない中身」を SHA だけで名乗らせない。
    SUFFIX=""
    if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
      SUFFIX="-dirty"
    fi

    BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")"
    SUBJECT="$(git log -1 --pretty=%s 2>/dev/null || true)"

    TAG="$(truncate_to "${SHA_SHORT}${SUFFIX}" "${TAG_MAX}")"
    # message の先頭は **完全な SHA**。切り詰められても身元だけは必ず残る。
    MESSAGE="$(truncate_to "${SHA_FULL}${SUFFIX} ${BRANCH} ${SUBJECT}" "${MESSAGE_MAX}")"
  fi
fi

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
