#!/usr/bin/env bash
###############################################################################
# line-token-rotation.sh ― LINE チャネルアクセストークン (30 日失効) の自動更新
#
# 【何のためのスクリプトか】
#   本リポジトリが使う LINE チャネルアクセストークンは **短期トークン (有効期間 30 日)**
#   である。放置すると 30 日目に無言で失効し、LINE 側 API が一斉に 401 を返して
#   「お客さまへの返信も配信も止まるが、こちらは気づかない」状態になる。
#   本スクリプトはその失効を先回りして、発行から 25 日目に自動で新トークンへ差し替える。
#
#   参照 (LINE 公式 / line-openapi の channel-access-token.yml):
#     発行 POST https://api.line.me/v2/oauth/accessToken
#          form: grant_type=client_credentials / client_id=<Channel ID> / client_secret=<Channel secret>
#          応答: access_token / expires_in (秒・30 日 = 2592000) / token_type
#     検証 POST https://api.line.me/v2/oauth/verify   form: access_token   応答: client_id / expires_in / scope
#     失効 POST https://api.line.me/v2/oauth/revoke   form: access_token
#     ※ 1 チャネルにつき同時に有効なのは最大 30 本。31 本目を発行すると最古が自動失効する。
#        よって「新しいのを発行しただけで古いのが即死ぬ」ことはなく、差し替えの猶予がある。
#
# 【実行前提 (満たさずに走らせると fail-loud で止まる)】
#   1. カレントディレクトリがこのリポジトリ直下 (wrangler.toml の name=elxea-agent)。
#   2. wrangler が Cloudflare に認証済みで、対象 Worker の secret を操作できること
#      (`pnpm exec wrangler whoami` が通る状態)。OAuth ログインは事前に人が済ませておく。
#   3. .dev.vars に **チャネル ID とチャネルシークレット** が入っていること。
#        prod    : LINE_CHANNEL_ID      / LINE_CHANNEL_SECRET
#        staging : LINE_CHANNEL_ID_TEST / LINE_CHANNEL_SECRET_TEST
#      ※ 2026-08-10 時点で .dev.vars に LINE_CHANNEL_ID / LINE_CHANNEL_ID_TEST は **未設定**。
#         初回実行の前に LINE Developers コンソールのチャネル基本設定から転記すること
#         (チャネル ID は秘密情報ではないが、シークレットと同じ場所に置いて取り違えを防ぐ)。
#   4. jq / curl が使えること。
#   5. (prod のみ) vercel CLI が使えて、Web アプリのディレクトリが link 済みであること。
#      prod トークンは Cloudflare Worker だけでなく **Web アプリ (Vercel) の運営向け
#      監視通知** も消費するため、更新先が 2 つある。既定の場所は
#      ../elxea-web-app で、LINE_TOKEN_VERCEL_DIR で変更できる。
#      link されていない / CLI が無い場合は **トークンを発行する前に** 落ちる
#      (片方だけ更新して残りを無言に失効させないため)。意図的に飛ばすときだけ
#      --skip-vercel か LINE_TOKEN_ROTATION_SKIP_VERCEL=1。
#
# 【環境の取り違え防止 (このリポジトリで最も事故が重い箇所)】
#   本番と検証は Worker も LINE 公式アカウントも別物である。よって --env は **必須** で
#   既定値を持たない。env ごとに参照する変数・投入先 secret 名・状態ファイルがすべて分かれる。
#
#     --env prod      LINE_CHANNEL_ID      LINE_CHANNEL_SECRET      -> secret LINE_CHANNEL_ACCESS_TOKEN      (wrangler env なし)
#                     + Vercel (Web アプリ) の production env LINE_CHANNEL_ACCESS_TOKEN
#     --env staging   LINE_CHANNEL_ID_TEST LINE_CHANNEL_SECRET_TEST -> secret LINE_CHANNEL_ACCESS_TOKEN_TEST (wrangler --env staging)
#                     Vercel は対象外 (検証用トークンで本番 Web アプリを動かさない)
#
#   さらに prod は本番 secret の書き換えなので Tier 2 (Setaka 承認) 相当とし、
#   --yes-prod か LINE_TOKEN_ROTATION_PROD_APPROVED=1 が無い限り実行しない。
#   定期ジョブとして登録する場合は、ジョブ定義側でこの環境変数を渡す
#   (= 登録時点で Setaka が一度承認する、という設計)。
#
# 【トークン値を絶対に外へ出さない設計】
#   - トークン・シークレットを stdout / stderr / ログファイルに一切書かない。
#     表示するのは常に伏字 (`***`) と、値ではなく「桁数」「HTTP status」だけ。
#   - シークレットをコマンドライン引数に置かない (ps で見えるため)。
#     curl へはリクエストボディを 600 の一時ファイルにして `--data @file` /
#     `--data-urlencode name@file` で渡す (後者は '+' を含む値が壊れないため必須)。
#     wrangler / vercel へは標準入力で渡す。awk へは環境変数で渡す。
#   - set -x (xtrace) を明示的に無効化する。有効なまま呼ばれるとボディが丸見えになる。
#   - 一時ファイルは umask 077 + trap で必ず消す。
#   - 状態ファイルにはトークンを一切書かない (「いつ発行したか」だけ)。
#
# 【使い方】
#   判定だけ見る (書き換えなし):
#     bash scripts/line-token-rotation.sh --env staging --dry-run
#     ※ --dry-run は「書き換えを一切しない」という意味で、通信を一切しないという意味ではない。
#        --probe を併用したときだけ GET /v2/bot/info への読み取り 1 回が発生する
#        (--probe なしなら外部通信はゼロ)。
#   通常の定期実行 (25 日未経過なら SKIP して終了):
#     bash scripts/line-token-rotation.sh --env staging
#     LINE_TOKEN_ROTATION_PROD_APPROVED=1 bash scripts/line-token-rotation.sh --env prod
#   401 を検知したら即更新する (bot/info を叩いて生死を見てから判断):
#     bash scripts/line-token-rotation.sh --env prod --probe --yes-prod
#   期日を無視して今すぐ更新 (初回ブートストラップもこれ):
#     bash scripts/line-token-rotation.sh --env staging --force
#
# 【終了コード】
#   0 = 正常 (更新した / まだ期日でないのでスキップした)
#   1 = 使い方の誤り (env 未指定・prod 承認なし 等)
#   2 = 判定不能 (状態ファイル欠落・破損・時計のずれ)
#   3 = 前提不足 (依存コマンド / .dev.vars の項目 / wrangler 未認証)
#   4 = 更新の失敗 (発行 API / 検証 / secret 投入 / Vercel env 投入 のいずれかが失敗)
#   いずれも黙って 0 で終わらない。ジョブ基盤側は非 0 を必ずアラートにすること。
#
# 【登録先ジョブ基盤の案 (本スクリプトでは登録しない・Setaka 承認後に別途)】
#   案 A (推奨): ~/.config/admin-pipeline/jobs.json に単一 Job として登録し launchd で日次起動。
#                trigger=Schedule / owner=elxea-developer / org=elxea。
#                毎日走らせても 25 日未満は SKIP で即終了するので冪等かつ低コスト。
#   案 B       : Cloudflare Workers の Cron でトークン残日数だけ監視し、閾値割れを Slack 通知
#                → 更新自体は人が本スクリプトで実行 (自動書き換えを避けたい場合)。
#   いずれも登録は catalog-conformance skill (code=SoT 先行 → Notion Catalog へ projection) に従う。
###############################################################################
set -euo pipefail
set +x            # 秘密がトレースへ漏れるのを防ぐ (呼び出し元が -x でも必ず切る)
umask 077         # 以降に作る一時ファイル・状態ファイルを本人のみ読み書き可に

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 判定ロジックは副作用ゼロの別ファイル。本体を起動せずにテストできるように分離してある。
# shellcheck source=scripts/lib/line-token-rotation-decide.sh
. "$SCRIPT_DIR/lib/line-token-rotation-decide.sh"

LINE_API_BASE="${LINE_API_BASE:-https://api.line.me}"

# --- ログ (値は絶対に載せない。載せるのは状態・件数・HTTP status のみ) -------------
log()  { printf '[line-token-rotation] %s\n' "$*"; }
die()  { printf '[line-token-rotation][FAIL] %s\n' "$*" >&2; exit "${2:-1}"; }

# --- 引数 ---------------------------------------------------------------------
ENV_NAME=""
DO_FORCE=0
DO_PROBE=0
DRY_RUN=0
YES_PROD="${LINE_TOKEN_ROTATION_PROD_APPROVED:-0}"
SKIP_VERCEL="${LINE_TOKEN_ROTATION_SKIP_VERCEL:-0}"

usage() {
  sed -n '2,/^####/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --env)       ENV_NAME="${2:-}"; shift 2 ;;
    --env=*)     ENV_NAME="${1#*=}"; shift ;;
    --force)     DO_FORCE=1; shift ;;
    --probe)     DO_PROBE=1; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    --yes-prod)  YES_PROD=1; shift ;;
    --skip-vercel) SKIP_VERCEL=1; shift ;;
    -h|--help)   usage 0 ;;
    *)           die "不明な引数: $1 (--help で使い方)" 1 ;;
  esac
done

case "$ENV_NAME" in
  prod)
    ID_VAR="LINE_CHANNEL_ID";      SECRET_VAR="LINE_CHANNEL_SECRET"
    TARGET_SECRET="LINE_CHANNEL_ACCESS_TOKEN"
    WRANGLER_ENV_ARGS=()
    # 同じトークンを使う 2 つ目の消費者 = Web アプリ (Vercel) の production。
    VERCEL_TARGET_ENV="production"
    ;;
  staging)
    ID_VAR="LINE_CHANNEL_ID_TEST"; SECRET_VAR="LINE_CHANNEL_SECRET_TEST"
    TARGET_SECRET="LINE_CHANNEL_ACCESS_TOKEN_TEST"
    WRANGLER_ENV_ARGS=(--env staging)
    # staging のテスト OA トークンを Web アプリへ入れる運用は無い (入れると検証用
    # トークンで本番 Web アプリが動く取り違えになる)。よって対象外。
    VERCEL_TARGET_ENV=""
    ;;
  "")
    die "--env は必須です (prod | staging)。既定値は意図的に持たせていません。" 1
    ;;
  *)
    die "--env の値が不正です: '$ENV_NAME' (prod | staging)" 1
    ;;
esac

# 本番 secret の書き換えは Tier 2。明示承認なしでは絶対に進まない。
if [ "$ENV_NAME" = "prod" ] && [ "$YES_PROD" != "1" ] && [ "$DRY_RUN" -eq 0 ]; then
  die "prod の更新には明示承認が要ります。--yes-prod を付けるか LINE_TOKEN_ROTATION_PROD_APPROVED=1 を設定してください。" 1
fi

DEV_VARS="${LINE_TOKEN_DEV_VARS:-$REPO_ROOT/.dev.vars}"
STATE_FILE="${LINE_TOKEN_STATE_FILE:-$SCRIPT_DIR/line-token-state.$ENV_NAME.json}"

# --- 前提チェック --------------------------------------------------------------
for cmd in curl jq; do
  command -v "$cmd" >/dev/null 2>&1 || die "依存コマンドがありません: $cmd" 3
done
[ -f "$REPO_ROOT/wrangler.toml" ] || die "リポジトリ直下で実行してください (wrangler.toml が見つかりません)" 3
[ -f "$DEV_VARS" ]                || die ".dev.vars がありません: $DEV_VARS" 3

# 同じトークンを消費するのは Cloudflare Worker だけではない。Web アプリ (Vercel) の
# 運営向け監視通知も同じ prod トークンを使う。更新先から漏れると Cloudflare 側だけ
# 新しくなり、Vercel 側は 30 日で無言に失効する (2026-08 の実態がこれだった)。
# よって「Vercel を更新できる状態か」は **トークンを発行する前に** 確かめて fail-loud
# する。ここで落ちれば LINE 側にトークンを 1 本も発行していない。
UPDATE_VERCEL=0
VERCEL_DIR="${LINE_TOKEN_VERCEL_DIR:-$REPO_ROOT/../elxea-web-app}"
if [ -n "$VERCEL_TARGET_ENV" ] && [ "$SKIP_VERCEL" != "1" ]; then
  command -v vercel >/dev/null 2>&1 \
    || die "vercel CLI がありません。Web アプリ側の env を更新できないため中断します (意図的に飛ばすなら --skip-vercel)" 3
  [ -f "$VERCEL_DIR/.vercel/project.json" ] \
    || die "Vercel プロジェクトが link されていません: $VERCEL_DIR/.vercel/project.json (場所は LINE_TOKEN_VERCEL_DIR で指定 / 意図的に飛ばすなら --skip-vercel)" 3
  UPDATE_VERCEL=1
fi

# --- .dev.vars から 1 項目だけ取り出す (source しない = 任意コード実行を避ける) ------
read_dev_var() {
  local key="$1" line val
  line="$(grep -E "^[[:space:]]*${key}=" "$DEV_VARS" | tail -n 1 || true)"
  [ -n "$line" ] || return 1
  val="${line#*=}"
  val="${val%\"}"; val="${val#\"}"      # 前後のダブルクォートを外す
  val="${val%\'}"; val="${val#\'}"      # 前後のシングルクォートを外す
  [ -n "$val" ] || return 1
  printf '%s' "$val"                    # 呼び出し側は必ず変数へ捕捉する (表示しない)
}

# --- 一時ファイル (600・必ず後始末) ---------------------------------------------
TMPDIR_WORK="$(mktemp -d "${TMPDIR:-/tmp}/line-token-rotation.XXXXXX")"
cleanup() { rm -rf "$TMPDIR_WORK"; }
trap cleanup EXIT INT TERM

# --- 任意: いま入っているトークンの生死を見る (401 なら即更新へ) --------------------
PROBE_STATUS=""
if [ "$DO_PROBE" -eq 1 ]; then
  # 見るのは必ず「これから書き換える secret と同じ名前」の現行値。env ごとに別物なので
  # ここで名前を作り直すと prod のトークンで staging の生死を見るような取り違えが起きる。
  CURRENT_TOKEN="$(read_dev_var "$TARGET_SECRET" || true)"
  if [ -z "${CURRENT_TOKEN:-}" ]; then
    log "[WARN] .dev.vars に現行トークンが無いため probe を省略します (判定は状態ファイルのみで行う)"
  else
    # ヘッダは -H で渡すため argv に載る。ps 対策としてヘッダもファイル経由にする。
    printf 'Authorization: Bearer %s\n' "$CURRENT_TOKEN" > "$TMPDIR_WORK/hdr"
    PROBE_STATUS="$(curl -s -o /dev/null -w '%{http_code}' \
      -H @"$TMPDIR_WORK/hdr" \
      "$LINE_API_BASE/v2/bot/info" || echo "000")"
    rm -f "$TMPDIR_WORK/hdr"
    unset CURRENT_TOKEN
    log "probe GET /v2/bot/info -> HTTP $PROBE_STATUS"
    if [ "$PROBE_STATUS" = "000" ]; then
      # 通信できないだけかもしれない。ここで更新に倒すと障害時に無駄な発行を繰り返す。
      log "[WARN] probe が到達しませんでした。401 とは区別し、暦の判定にフォールバックします"
      PROBE_STATUS=""
    fi
  fi
fi

# --- 判定 (副作用なし) ----------------------------------------------------------
STATE_JSON=""
[ -f "$STATE_FILE" ] && STATE_JSON="$(cat "$STATE_FILE")"

set +e
DECISION_OUT="$(
  LTR_STATE_JSON="$STATE_JSON" \
  LTR_FORCE="$DO_FORCE" \
  LTR_PROBE_STATUS="$PROBE_STATUS" \
  ltr_decide
)"
DECIDE_RC=$?
set -e

DECISION="$(printf '%s\n' "$DECISION_OUT" | sed -n 's/^DECISION=//p')"
REASON="$(printf '%s\n'   "$DECISION_OUT" | sed -n 's/^REASON=//p')"
DAYS_SINCE="$(printf '%s\n' "$DECISION_OUT" | sed -n 's/^DAYS_SINCE_ISSUED=//p')"
DAYS_LEFT="$(printf '%s\n'  "$DECISION_OUT" | sed -n 's/^DAYS_TO_EXPIRY=//p')"

log "env=$ENV_NAME secret=$TARGET_SECRET state=$STATE_FILE"
log "decision=$DECISION reason=$REASON days_since_issued=$DAYS_SINCE days_to_expiry=$DAYS_LEFT"

if [ "$DECIDE_RC" -ne 0 ]; then
  die "判定できませんでした (reason=$REASON)。状態ファイルを確認するか、初回は --force で発行してください: $STATE_FILE" 2
fi

if [ "$DECISION" = "SKIP" ]; then
  log "[SKIP] 発行から ${DAYS_SINCE} 日。更新は ${LTR_ROTATE_AFTER_DAYS} 日目からです。何もしません。"
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log "[SKIP] --dry-run のためここで停止します (実際なら更新していました: reason=$REASON)"
  exit 0
fi

###############################################################################
# ここから先が実際の更新。ここまでで「更新すべき」と確定している。
###############################################################################
log "更新を開始します (reason=$REASON)"

CHANNEL_ID="$(read_dev_var "$ID_VAR" || true)"
CHANNEL_SECRET="$(read_dev_var "$SECRET_VAR" || true)"
[ -n "${CHANNEL_ID:-}" ]     || die ".dev.vars に $ID_VAR がありません (LINE Developers のチャネル基本設定から転記してください)" 3
[ -n "${CHANNEL_SECRET:-}" ] || die ".dev.vars に $SECRET_VAR がありません" 3

# --- 1. 新トークンを発行 --------------------------------------------------------
# ボディをファイルにしてから渡す。argv にシークレットを載せないため。
{
  printf 'grant_type=client_credentials'
  printf '&client_id=%s' "$CHANNEL_ID"
  printf '&client_secret=%s' "$CHANNEL_SECRET"
} > "$TMPDIR_WORK/issue_body"

ISSUE_STATUS="$(curl -s -o "$TMPDIR_WORK/issue_res.json" -w '%{http_code}' \
  -X POST "$LINE_API_BASE/v2/oauth/accessToken" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data @"$TMPDIR_WORK/issue_body" || echo "000")"
rm -f "$TMPDIR_WORK/issue_body"
unset CHANNEL_SECRET

if [ "$ISSUE_STATUS" != "200" ]; then
  # 応答本文はエラー時でもトークンを含まないが、念のため error / error_description だけ出す。
  ERR="$(jq -r '[.error, .error_description] | map(select(. != null)) | join(": ")' "$TMPDIR_WORK/issue_res.json" 2>/dev/null || true)"
  die "トークン発行に失敗しました (HTTP $ISSUE_STATUS) ${ERR:+- $ERR}" 4
fi

NEW_TOKEN="$(jq -r '.access_token // empty' "$TMPDIR_WORK/issue_res.json")"
EXPIRES_IN="$(jq -r '.expires_in // empty' "$TMPDIR_WORK/issue_res.json")"
rm -f "$TMPDIR_WORK/issue_res.json"
[ -n "$NEW_TOKEN" ]  || die "発行応答に access_token がありません (HTTP $ISSUE_STATUS)" 4
[ -n "$EXPIRES_IN" ] || die "発行応答に expires_in がありません" 4
case "$EXPIRES_IN" in (*[!0-9]*) die "expires_in が数値ではありません" 4 ;; esac
log "発行 OK (長さ ${#NEW_TOKEN} 文字・有効期間 $((EXPIRES_IN / 86400)) 日)"   # 値そのものは出さない

# --- 2. 発行されたトークンが本当に想定チャネルのものか検証 --------------------------
# ここを飛ばすと、チャネルを取り違えたトークンを本番へ投入して全 API が落ちる。
#
# ボディは **必ず URL エンコードして送る** (`--data-urlencode`)。発行されるトークンは
# base64 系で '+' '/' '=' を含み、application/x-www-form-urlencoded では '+' が空白と
# して解釈される。素の `--data` で送ると LINE 側には '+' が ' ' に化けた別の文字列が
# 届くため、正しいトークンでも検証が必ず HTTP 400 になり、**ローテーションが構造的に
# 一度も完了できない** (Issue: line-rot-verify-400)。
# `name@file` 形式なので値は argv に載らない (ps から見えない) = 既存の安全規律を保つ。
printf '%s' "$NEW_TOKEN" > "$TMPDIR_WORK/verify_token"
VERIFY_STATUS="$(curl -s -o "$TMPDIR_WORK/verify_res.json" -w '%{http_code}' \
  -X POST "$LINE_API_BASE/v2/oauth/verify" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "access_token@$TMPDIR_WORK/verify_token" || echo "000")"
rm -f "$TMPDIR_WORK/verify_token"
[ "$VERIFY_STATUS" = "200" ] || die "発行直後の検証に失敗しました (HTTP $VERIFY_STATUS)。secret は書き換えていません。" 4

VERIFIED_CLIENT_ID="$(jq -r '.client_id // empty' "$TMPDIR_WORK/verify_res.json")"
rm -f "$TMPDIR_WORK/verify_res.json"
if [ "$VERIFIED_CLIENT_ID" != "$CHANNEL_ID" ]; then
  die "検証結果のチャネル ID が一致しません (期待 $CHANNEL_ID / 実際 $VERIFIED_CLIENT_ID)。secret は書き換えていません。" 4
fi
log "検証 OK (チャネル $CHANNEL_ID)"

# --- 3. Cloudflare Workers の secret を差し替え -----------------------------------
# 値は標準入力で渡す。--env の有無で本番/検証を分けているのはここが最後の分岐点。
# ${arr[@]+"${arr[@]}"} は「空配列 + set -u」で落ちる bash 3.2 (macOS 既定) 対策。
if ! printf '%s' "$NEW_TOKEN" \
  | pnpm exec wrangler secret put "$TARGET_SECRET" \
      ${WRANGLER_ENV_ARGS[@]+"${WRANGLER_ENV_ARGS[@]}"} \
      >/dev/null 2>"$TMPDIR_WORK/wrangler_err"; then
  log "[FAIL] wrangler の出力: $(tr -d '\r' < "$TMPDIR_WORK/wrangler_err" | tail -n 5)"
  die "secret 投入に失敗しました ($TARGET_SECRET / env=$ENV_NAME)。状態ファイルは更新していません。" 4
fi
log "secret 投入 OK ($TARGET_SECRET / env=$ENV_NAME)"

# --- 3.5 Web アプリ (Vercel) の env も同じ値へ揃える --------------------------------
# 値は標準入力で渡す (argv に載せない)。`--force` は既存値の上書き指定で、
# rm → add の 2 手順の代わりに使う (rm と add の間に「本番に値が無い」瞬間を作らない)。
if [ "$UPDATE_VERCEL" -eq 1 ]; then
  if ! printf '%s' "$NEW_TOKEN" \
    | vercel env add "$TARGET_SECRET" "$VERCEL_TARGET_ENV" \
        --cwd "$VERCEL_DIR" --force --yes \
        >/dev/null 2>"$TMPDIR_WORK/vercel_err"; then
    log "[FAIL] vercel の出力: $(tr -d '\r' < "$TMPDIR_WORK/vercel_err" | tail -n 5)"
    die "Vercel env の更新に失敗しました ($TARGET_SECRET / $VERCEL_TARGET_ENV)。Cloudflare の secret は更新済みですが状態ファイルは更新していないので、次回実行で再試行されます。" 4
  fi
  log "Vercel env 更新 OK ($TARGET_SECRET / $VERCEL_TARGET_ENV / dir=$VERCEL_DIR)"
  # Vercel の env は「次のデプロイ」から有効。稼働中のデプロイは古い値を掴み続ける。
  log "[WARN] Vercel は再デプロイするまで新しい値を読みません。本番デプロイは Tier 2 (Setaka 承認) なので、承認後に再デプロイしてください。"
fi

# --- 4. .dev.vars を同じ値に揃える (ローカル開発が古いトークンで動かないように) --------
# awk へは環境変数で渡す。argv に置くと ps から見える。
if grep -qE "^[[:space:]]*${TARGET_SECRET}=" "$DEV_VARS"; then
  NEW_TOKEN_ENV="$NEW_TOKEN" awk -v key="$TARGET_SECRET" '
    $0 ~ "^[[:space:]]*" key "=" { print key "=" ENVIRON["NEW_TOKEN_ENV"]; next }
    { print }
  ' "$DEV_VARS" > "$TMPDIR_WORK/dev_vars_new"
else
  cp "$DEV_VARS" "$TMPDIR_WORK/dev_vars_new"
  NEW_TOKEN_ENV="$NEW_TOKEN" awk -v key="$TARGET_SECRET" \
    'BEGIN { print key "=" ENVIRON["NEW_TOKEN_ENV"] }' >> "$TMPDIR_WORK/dev_vars_new"
fi
chmod 600 "$TMPDIR_WORK/dev_vars_new"
mv "$TMPDIR_WORK/dev_vars_new" "$DEV_VARS"
log ".dev.vars 更新 OK ($TARGET_SECRET)"
unset NEW_TOKEN

# --- 5. 状態ファイルを更新 (トークンは書かない) ------------------------------------
TODAY="$(date +%Y-%m-%d)"
EXPIRES_DAYS=$((EXPIRES_IN / 86400))
EXPIRES_AT="$(ltr_add_days "$TODAY" "$EXPIRES_DAYS")"
PREV_COUNT=0
if [ -n "$STATE_JSON" ]; then
  PREV_COUNT="$(printf '%s' "$STATE_JSON" | jq -r '.rotation_count // 0' 2>/dev/null || echo 0)"
  case "$PREV_COUNT" in (*[!0-9]*|"") PREV_COUNT=0 ;; esac
fi

jq -n \
  --arg env "$ENV_NAME" \
  --arg secret_name "$TARGET_SECRET" \
  --arg issued_at "$TODAY" \
  --arg expires_at "$EXPIRES_AT" \
  --argjson expires_in_seconds "$EXPIRES_IN" \
  --arg last_rotation_reason "$REASON" \
  --arg last_checked_at "$TODAY" \
  --argjson rotation_count "$((PREV_COUNT + 1))" \
  '{env: $env, secret_name: $secret_name, issued_at: $issued_at, expires_at: $expires_at,
    expires_in_seconds: $expires_in_seconds, last_rotation_reason: $last_rotation_reason,
    last_checked_at: $last_checked_at, rotation_count: $rotation_count}' \
  > "$TMPDIR_WORK/state_new.json"
chmod 600 "$TMPDIR_WORK/state_new.json"
mv "$TMPDIR_WORK/state_new.json" "$STATE_FILE"
log "状態ファイル更新 OK (issued_at=$TODAY expires_at=$EXPIRES_AT)"

# --- 6. 旧トークンの失効について -----------------------------------------------
# あえて自動で revoke しない。理由は 2 つ:
#   (a) secret 投入は即時反映ではなく、切り替わるまでの数秒〜数十秒、実行中のリクエストが
#       旧トークンを使い続ける。ここで revoke すると、その間の返信・配信が 401 で落ちる。
#   (b) LINE は 1 チャネル 30 本まで同時に有効で、31 本目の発行で最古が自動失効する。
#       月 1 回の更新なら 2 年半ぶん溜めても上限に当たらず、放置の実害がない。
# 明示的に失効させたい場合 (漏洩時など) は、旧トークンを 600 のファイルに置いて次を実行する。
# ここも verify と同じ理由で **--data-urlencode が必須** (素の --data だと '+' を含む
# トークンが空白に化けて別の文字列になり、失効させたつもりで失効していない):
#   umask 077; printf '%s' "$OLD" > /tmp/old_token
#   curl -s -X POST https://api.line.me/v2/oauth/revoke \
#     -H 'Content-Type: application/x-www-form-urlencoded' \
#     --data-urlencode "access_token@/tmp/old_token"; rm -f /tmp/old_token
log "旧トークンは失効させていません (切り替え中の 401 を避けるため。詳細はスクリプト末尾のコメント)"

log "[OK] 更新完了 (env=$ENV_NAME reason=$REASON 次回更新目安=${LTR_ROTATE_AFTER_DAYS} 日後)"
exit 0
