#!/usr/bin/env bash
#
# deploy-preflight.sh — 本番デプロイ直前の「今から本番に載るコミット」検証ゲート。
#
# なぜ要るか（実際に起きた事故）:
#   ローカルの master が origin/master より古いまま `pnpm deploy`（= bare `wrangler deploy`）を
#   撃ってしまい、**すでに本番へ入っていた修正を巻き戻したビルド**が本番 Worker に載った。
#   `wrangler deploy` は「今 checkout している中身」をそのまま上げるだけで、それが既定ブランチの
#   最新かどうかを一切見ない。つまり "古い手元" と "本番" の差は人間の記憶でしか守られていなかった。
#   このスクリプトはその差を機械が見る。
#
# 何を検証するか（すべて read-only。ネットワークは git fetch のみ）:
#   (1) git リポジトリの中にいること
#   (2) working tree が clean であること（未コミット差分・未追跡ファイルを含む）
#       → **override 不可**（何が本番に載ったかを後から再現できないビルドを作らせないため）
#   (3) HEAD の SHA が origin/<既定ブランチ> の最新 SHA と一致すること
#       → DEPLOY_ALLOW_NON_DEFAULT=1 のときのみ、差分サマリを表示した上で警告付きで通す
#
# 使い方:
#   ./scripts/deploy-preflight.sh              # 通れば exit 0、外れれば exit 1
#   DEPLOY_ALLOW_NON_DEFAULT=1 ./scripts/deploy-preflight.sh   # 既定ブランチ不一致を明示的に許可
#
# 呼ばれる場所（2 経路とも同じ 1 実装を通す＝ SoT を分裂させない）:
#   - package.json の "deploy"（bare `wrangler deploy` の前段）
#   - scripts/deploy-prod.sh の preflight STEP 1（本番フル反映オーケストレータ）
#   ※ staging（`pnpm deploy:staging`）は対象外。検証は feature ブランチから撃つのが正常運用のため。
#
# 環境変数:
#   DEPLOY_ALLOW_NON_DEFAULT  "1" / "true" / "yes" のとき、既定ブランチとの不一致（および
#                             fetch 不能による検証不能）を警告付きで通す。dirty tree は通さない。
#   DEPLOY_DEFAULT_BRANCH     既定ブランチ名（既定: master）。
#   DEPLOY_REMOTE             リモート名（既定: origin）。
#
set -euo pipefail

DEFAULT_BRANCH="${DEPLOY_DEFAULT_BRANCH:-master}"
REMOTE="${DEPLOY_REMOTE:-origin}"
TRACKING_REF="refs/remotes/${REMOTE}/${DEFAULT_BRANCH}"

log()  { printf '\033[1m[deploy-preflight] %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[deploy-preflight][WARN] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m[deploy-preflight][ABORT] %s\033[0m\n' "$*" >&2; exit 1; }

# DEPLOY_ALLOW_NON_DEFAULT が「明示的に真」か。空・0・その他文字列は偽（fail-closed）。
allow_non_default() {
  case "${DEPLOY_ALLOW_NON_DEFAULT:-}" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

# 既定ブランチと外れているときの共通処理。override があれば警告して継続、無ければ中断。
# 第 1 引数 = 理由の 1 行説明。
handle_mismatch() {
  local reason="$1"
  if allow_non_default; then
    warn "${reason}"
    warn "DEPLOY_ALLOW_NON_DEFAULT による明示 override で続行する。"
    warn "⚠ 今から本番に載るのは ${REMOTE}/${DEFAULT_BRANCH} の最新ではない。上の差分を必ず確認すること。"
    return 0
  fi
  die "${reason}
  対処:
    git fetch ${REMOTE} && git checkout ${DEFAULT_BRANCH} && git merge --ff-only ${REMOTE}/${DEFAULT_BRANCH}
  それでも今の HEAD を載せる必要があるなら、意図を明示して再実行する:
    DEPLOY_ALLOW_NON_DEFAULT=1 <deploy command>"
}

# ─ (1) git リポジトリの中か ─
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  die "git リポジトリの外で実行されている。本番に載るコミットを特定できないため中断。"
fi

# ─ (2) working tree clean（override 不可）─
# 未追跡ファイルも dirty 扱いにする（scripts/deploy-prod.sh の従来判定と同じ厳しさを保つ）。
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  git status --short >&2 || true
  die "working tree に未コミット差分（未追跡ファイル含む）がある。本番反映はクリーンな tree からのみ許可。
  ※ この条件は DEPLOY_ALLOW_NON_DEFAULT では解除できない（何を本番に載せたか後から再現できなくなるため）。"
fi
log "[OK] working tree clean"

# ─ (3) HEAD == ${REMOTE}/${DEFAULT_BRANCH} ─
HEAD_SHA="$(git rev-parse HEAD)"

# 明示 refspec で remote-tracking ref を更新する（`git fetch <remote> <branch>` の
# opportunistic update に頼らない＝ CI の shallow clone / detached HEAD でも確実に取れる）。
if ! git fetch --quiet "${REMOTE}" "+refs/heads/${DEFAULT_BRANCH}:${TRACKING_REF}" 2>/dev/null; then
  handle_mismatch "${REMOTE}/${DEFAULT_BRANCH} を fetch できず、HEAD が最新かを検証できない（ネットワーク/認証を確認）。"
  exit 0
fi

if ! REMOTE_SHA="$(git rev-parse --verify --quiet "${TRACKING_REF}")"; then
  handle_mismatch "${TRACKING_REF} が解決できず、HEAD が最新かを検証できない。"
  exit 0
fi

if [[ "${HEAD_SHA}" == "${REMOTE_SHA}" ]]; then
  log "[OK] HEAD == ${REMOTE}/${DEFAULT_BRANCH} (${HEAD_SHA:0:12})"
  log "preflight PASSED"
  exit 0
fi

# ─ 不一致: 差分サマリを出してから判定（override 有無に関わらず必ず表示する）─
{
  printf '\n\033[1m[deploy-preflight] HEAD と %s/%s の差分\033[0m\n' "${REMOTE}" "${DEFAULT_BRANCH}"
  printf '  %-28s : %s\n' "HEAD（今から載るもの）" "${HEAD_SHA}"
  printf '  %-28s : %s\n' "${REMOTE}/${DEFAULT_BRANCH}（最新）" "${REMOTE_SHA}"
  # ahead/behind（shallow clone 等で算出できないときは黙って諦める）
  if counts="$(git rev-list --left-right --count "${HEAD_SHA}...${REMOTE_SHA}" 2>/dev/null)"; then
    printf '  %-28s : %s commit\n' "ahead（HEAD にだけある）" "$(printf '%s' "${counts}" | awk '{print $1}')"
    printf '  %-28s : %s commit\n' "behind（最新にだけある）" "$(printf '%s' "${counts}" | awk '{print $2}')"
  fi
  # 「巻き戻るコミット」= 最新にあって HEAD に無いもの。事故（本番の修正を消す）の実体はこれ。
  behind_log="$(git --no-pager log --oneline --max-count=20 "${HEAD_SHA}..${REMOTE_SHA}" 2>/dev/null || true)"
  if [[ -n "${behind_log}" ]]; then
    printf '  ⚠ 本番から巻き戻るコミット（%s/%s にあって HEAD に無い）:\n' "${REMOTE}" "${DEFAULT_BRANCH}"
    printf '%s\n' "${behind_log}" | sed 's/^/    - /'
  else
    printf '  巻き戻るコミットは無い（HEAD は最新を含むが、まだ %s/%s に入っていない変更を載せようとしている）\n' \
      "${REMOTE}" "${DEFAULT_BRANCH}"
  fi
} >&2

handle_mismatch "HEAD が ${REMOTE}/${DEFAULT_BRANCH} の最新と一致しない。古い（または分岐した）コミットを本番に載せようとしている。"
log "preflight PASSED (override)"
