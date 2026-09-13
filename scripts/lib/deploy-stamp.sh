#!/usr/bin/env bash
#
# deploy-stamp.sh — 「今から Cloudflare に上がる中身はどのコミットか」を作る唯一の実装。
#
# なぜ分けたか:
#   刻印を必要とする入口が 2 つある。
#     - scripts/deploy-worker.sh   … `wrangler deploy`（本番/staging へ直接載せる）
#     - scripts/upload-version.sh  … `wrangler versions upload`（載せずに version だけ作る）
#   同じ計算を 2 か所に書くと、片方だけ直って「version により刻印の形が違う」状態に
#   なる。SoT をここ 1 本にして、両方の入口が source する。
#
# 使い方:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/deploy-stamp.sh"
#   compute_deploy_stamp          # → STAMP_TAG / STAMP_MESSAGE を設定する
#
# ⚠ git が読めないときも **失敗しない**。刻印は「後から辿れる」ための付加情報であって、
#   デプロイ/アップロードの可否を決める条件ではない（可否は deploy-preflight.sh の担当）。
#   その場合は STAMP_TAG / STAMP_MESSAGE を空にして返す。

# Cloudflare の version tag / message は長さに上限がある。刻めずに落ちるのが一番まずいので、
# こちらで先に詰める（切り詰めても先頭に SHA が来るので用は足りる）。
readonly STAMP_TAG_MAX=25
readonly STAMP_MESSAGE_MAX=100

stamp_truncate_to() {
  local value="$1" limit="$2"
  if [[ "${#value}" -le "${limit}" ]]; then
    printf '%s' "${value}"
  else
    printf '%s' "${value:0:limit}"
  fi
}

# STAMP_TAG / STAMP_MESSAGE を設定する。読めなければ両方とも空文字。
compute_deploy_stamp() {
  STAMP_TAG=""
  STAMP_MESSAGE=""

  git rev-parse --git-dir >/dev/null 2>&1 || return 0

  local sha_full sha_short suffix branch subject
  sha_full="$(git rev-parse HEAD 2>/dev/null || true)"
  [[ -n "${sha_full}" ]] || return 0
  sha_short="${sha_full:0:12}"

  # dirty tree は本番では preflight が止めるが、staging / versions upload は preflight を
  # 通らない。「その SHA と厳密には一致しない中身」を SHA だけで名乗らせない。
  suffix=""
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    suffix="-dirty"
  fi

  branch="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "detached")"
  subject="$(git log -1 --pretty=%s 2>/dev/null || true)"

  STAMP_TAG="$(stamp_truncate_to "${sha_short}${suffix}" "${STAMP_TAG_MAX}")"
  # message の先頭は **完全な SHA**。切り詰められても身元だけは必ず残る。
  STAMP_MESSAGE="$(stamp_truncate_to "${sha_full}${suffix} ${branch} ${subject}" "${STAMP_MESSAGE_MAX}")"
}
