#!/usr/bin/env bash
#
# upload-version.sh — `wrangler versions upload` に「その version の中身はどのコミットか」を
#                     刻む唯一の入口。
#
# なぜ要るか（実際に困った）:
#   2026-09-12、初回ターンのストリーミング化を段階的に本番へ入れるため
#   `npx wrangler versions upload` で version を作った。その version には --tag が
#   付いていなかったため、**Cloudflare 側のメタデータだけでは由来コミットを証明できず**、
#   「ブランチ先端とプレビューの振る舞いが一致する」という間接確認で済ませるしかなかった。
#   障害時に切り戻し先を選ぶ場面でこれをやると、「この version に何が入っているか」の
#   確定に時間が溶ける。
#
#   `wrangler versions upload` は「今 checkout している中身」を上げるだけで、それが
#   どのコミットだったかを残さない。残すには --tag / --message を渡すしかない。
#
# 何をするか:
#   scripts/lib/deploy-stamp.sh（deploy-worker.sh と同じ実装）で git から刻印を作り、
#   `wrangler versions upload --tag <短SHA> --message <完全SHA + ブランチ + 件名>` を実行する。
#   引数はそのまま wrangler へ渡すので `--env staging` 等も使える。
#
# これは「本番に載せる」操作ではない:
#   versions upload は version を作るだけで、トラフィックは動かない。載せるのは
#   `wrangler versions deploy`（段階昇格）または scripts/deploy-worker.sh（一括）。
#
# 使い方:
#   ./scripts/upload-version.sh                  # default env の version を作る
#   ./scripts/upload-version.sh --env staging    # staging
#   pnpm run upload:version                      # package.json 経由（推奨）
#   DEPLOY_STAMP_PRINT_ONLY=1 ./scripts/upload-version.sh   # 実行せず刻印だけ出す（テスト用）
#
# ⚠ git が読めないときも **アップロードは止めない**（刻印は付加情報）。理由は警告で残す。
#
set -euo pipefail

log()  { printf '\033[1m[upload-version] %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[upload-version][WARN] %s\033[0m\n' "$*" >&2; }

# shellcheck source=lib/deploy-stamp.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/deploy-stamp.sh"

compute_deploy_stamp
TAG="${STAMP_TAG}"
MESSAGE="${STAMP_MESSAGE}"

if [[ -z "${TAG}" ]]; then
  warn "git からコミットを読めなかったため、version に刻印せずアップロードする。"
  warn "  → Cloudflare 側からは「この version は何が入っているか」を後から確定できない。"
fi

if [[ "${DEPLOY_STAMP_PRINT_ONLY:-}" == "1" ]]; then
  printf 'tag=%s\n' "${TAG}"
  printf 'message=%s\n' "${MESSAGE}"
  exit 0
fi

if [[ -z "${TAG}" ]]; then
  exec pnpm exec wrangler versions upload "$@"
fi

log "version に刻む: tag=${TAG}"
log "                message=${MESSAGE}"
exec pnpm exec wrangler versions upload --tag "${TAG}" --message "${MESSAGE}" "$@"
