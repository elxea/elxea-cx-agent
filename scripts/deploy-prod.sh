#!/usr/bin/env bash
#
# deploy-prod.sh — elxea CX Agent 本番フル反映オーケストレータ（ワンコマンド）。
#
# 実行順序（.github/workflows/deploy-prod.yml もこの 1 本を呼ぶ＝実体を一本化する）:
#   1. preflight
#        - confirm == "DEPLOY-PROD" 検証（誤爆防止）
#        - git working tree clean 検証（未コミット差分での本番反映を禁止）
#        - prod Supabase ref HARD ASSERT（SUPABASE_URL の ref === bquqzrbzdzjegdovxalu）
#        - (#2) 必須 secret「名」の存在確認（wrangler secret list・名前のみ／値は見ない・欠落で中断）
#        - staging smoke が緑（pnpm test:staging-smoke が exit 0）
#        - 初回デプロイ時は追加ゲート（下記「初回 cron 活性化」）
#   2. migration 適用（明示指定制）: 未適用一覧を --dry-run で提示 → MIGRATE_ONLY で名指しされた version だけを
#                               `migrate.ts --only <versions> --apply` で適用する（schema_migrations 台帳ベース）。
#                               ⚠ bare `migrate.ts --apply`（未適用を全件適用）は本スクリプトからは実行しない。
#                                 手順書が本番非適用と定める 024 / 025 / 027 を巻き込むため（deny-list で二重にガード）。
#                               ※ 既存 DB の初回は先に `migrate.ts --baseline`（introspection・要 Setaka 承認）。
#   3. wrangler deploy（prod） : pnpm exec wrangler deploy（default env = 本番）
#   4. prod health check       : curl "$PROD_HEALTH_URL" が {"status":"ok"}（Claude API は呼ばない）
#                               + (#6) LINE webhook の設定・到達性を read-only 検証（GET endpoint / POST test）
#   5. (#5) version_skew_report: 反映した cx-agent の git SHA を刻み、web-app 側 SHA と突き合わせ可能にする
#                               （web-app は別レーン＝ここでは触らない。main push の Vercel 自動デプロイのまま）
#
# ⚠ LINE 設定について（表現の是正）: 「LINE 設定＝全部手動」ではない。OA Manager 固有設定（応答モード・
#   あいさつ・リッチメニュー画像）のみ手動で、webhook URL の設定・到達性は LINE Messaging API で検証できる（step4）。
#
# ⚠ このスクリプトは末尾で main "$@" を無条件に呼ぶ（source ガードは無い＝source でも main が走る）。
#   誤爆防止は「source 無害化」ではなく preflight の CONFIRM=="DEPLOY-PROD" 検証と各 HARD ASSERT が担う。
#   本番反映は必ず「明示実行 + CONFIRM=DEPLOY-PROD」が揃ったときだけ進む。
#
# 使い方（ローカル）:
#   # migration を当てない反映（既定形）:
#   CONFIRM=DEPLOY-PROD MIGRATE_ONLY=NONE SUPABASE_DB_PASSWORD=xxx ./scripts/deploy-prod.sh
#   # 特定の migration を当てる反映（当てるものを名指しする）:
#   CONFIRM=DEPLOY-PROD MIGRATE_ONLY=036,037 SUPABASE_DB_PASSWORD=xxx ./scripts/deploy-prod.sh
#   # 初回デプロイ（日次同期 cron の初活性化を伴う）は追加 ack が必要:
#   CONFIRM=DEPLOY-PROD MIGRATE_ONLY=NONE FIRST_DEPLOY=true FIRST_DEPLOY_ACK=SYNC-CRON-ACK \
#     SUPABASE_DB_PASSWORD=xxx ./scripts/deploy-prod.sh
#
# 環境変数:
#   CONFIRM              (必須) "DEPLOY-PROD" 固定。誤爆防止の合言葉。
#   SUPABASE_URL         本番 Supabase URL（未設定なら .dev.vars からの読み取りは migrate.ts 側に委ねる）。
#                        ここでは ref assert のため参照する（未設定時は migrate.ts の assert に委譲）。
#   SUPABASE_DB_PASSWORD 本番 Postgres 直接接続パスワード（migrate.ts --apply が使用）。
#   MIGRATE_ONLY         (必須) 今回当てる migration の version をカンマ区切りで名指しする（例: 036,037）。
#                        当てない場合は "NONE" を明示する。未指定は中断（fail-closed）。
#   MIGRATE_DENYLIST_ACK (任意) 本番非適用リスト（024 / 025 / 027）を今回だけ当てるときの明示 ack。
#                        例: MIGRATE_DENYLIST_ACK=027（LIFF 連携 G1-G3 通過後に 027 を当てるとき）。
#   STAGING_WORKER_URL   staging smoke の対象（既定: https://elxea-agent-staging.setaka-on.workers.dev）。
#   PROD_HEALTH_URL      本番ヘルスチェック URL（既定: https://elxea-agent.setaka-on.workers.dev/）。
#   FIRST_DEPLOY         "true" のとき初回デプロイ扱い（追加ゲート）。既定 false。
#   FIRST_DEPLOY_ACK     FIRST_DEPLOY=true のとき "SYNC-CRON-ACK" 必須。
#   SKIP_STAGING_SMOKE   "true" のとき staging smoke をスキップ（非推奨・緊急時のみ）。
#   SKIP_SECRET_PREFLIGHT "true" のとき (#2) 必須 secret 名の存在確認をスキップ（非推奨）。
#   SKIP_WEBHOOK_CHECK   "true" のとき (#6) LINE webhook 検証をスキップ。
#   LINE_CHANNEL_ACCESS_TOKEN 本番 OA のアクセストークン。(#6) webhook 検証にのみ使用。実行 shell に無ければ
#                        webhook 検証は skip される（Worker secret として別途投入済みでよい）。
#   WEB_APP_SHA          (任意) web-app 側の git SHA。渡すと (#5) で cx-agent SHA と突き合わせ版ずれを表示。
#
set -euo pipefail

# ─ リポジトリルートへ移動（どこから呼ばれても安定させる）─
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

readonly EXPECTED_PROD_REF="bquqzrbzdzjegdovxalu"
readonly PROD_HEALTH_URL="${PROD_HEALTH_URL:-https://elxea-agent.setaka-on.workers.dev/}"
# ⚠ readonly かつ「子プロセスへ渡す」変数なので export しておく（readonly な変数に対して
#   `STAGING_WORKER_URL=... cmd` の代入プレフィックスを使うと bash が
#   「readonly variable」で即死する＝set -e 下では staging smoke ゲートに到達できない）。
STAGING_WORKER_URL="${STAGING_WORKER_URL:-https://elxea-agent-staging.setaka-on.workers.dev}"
readonly STAGING_WORKER_URL
export STAGING_WORKER_URL
readonly LINE_API_BASE="https://api.line.me/v2/bot"
# 本番 Worker が起動に必要とする secret 名（launch-checklist.md / setup-production.sh の REQUIRED_VARS が SoT）。
# ⚠ 名前の存在だけを確認する（`wrangler secret list`）。値は取得不能なので検証しない。値の投入は人手のまま。
readonly REQUIRED_SECRETS=(
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
  SYNC_API_SECRET
  SLACK_WEBHOOK_URL
)

log()  { printf '\n\033[1m[deploy-prod] %s\033[0m\n' "$*"; }
warn() { printf '\n\033[1;33m[deploy-prod][WARN] %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m[deploy-prod][ABORT] %s\033[0m\n' "$*" >&2; exit 1; }

# 初回デプロイで初活性化する副作用を常に可視化する（QA 指摘）。
print_cron_warning() {
  warn "本番デプロイは cron トリガ（wrangler.toml [triggers]）を配線する。"
  cat >&2 <<'EOF'
        crons = ["*/15 * * * *", "0 18 * * *"]
          - "*/15 * * * *": 配信 scheduled（DELIVERY_SEND_ENABLED 未設定=dry-run。実送信ゼロ）。
          - "0 18 * * *"  : 日次同期（runBatchMetafieldSync 含む・毎日 AM3:00 JST）。
        ⚠ 初回の本番デプロイは、この日次同期を「初めて」活性化する（それまで登録 cron から
          一度も発火していなかった同期が回り始める）。同期自体は非破壊（ナレッジ同期 + metafield 書込）
          だが、初回だけは想定外の副作用がないか初回発火後に監視すること。
EOF
}

# (#2) 必須 secret「名」の存在確認。値は取得不能なので **名前だけ** を `wrangler secret list` で照合する。
# 欠けていれば中断。値の投入は人手（wrangler secret put）のまま — このゲートは投入漏れの検知だけを担う。
check_secrets() {
  if [[ "${SKIP_SECRET_PREFLIGHT:-}" == "true" ]]; then
    warn "SKIP_SECRET_PREFLIGHT=true。必須 secret 名の存在確認をスキップ（非推奨）。"
    return 0
  fi
  log "  必須 secret 名の存在確認（wrangler secret list・名前のみ／値は見ない）..."
  local list
  # 本番 Worker（default env）の secret 名一覧を取得。取得失敗は「検証不能」として中断する。
  if ! list="$(pnpm exec wrangler secret list 2>/dev/null)"; then
    die "wrangler secret list に失敗（Cloudflare 認証未設定？）。secret 名を検証できないため中断。SKIP_SECRET_PREFLIGHT=true で明示スキップ可（非推奨）。"
  fi
  local missing=()
  local name
  for name in "${REQUIRED_SECRETS[@]}"; do
    # `wrangler secret list` は [{ "name": "X", "type": "secret_text" }, ...] を返す。名前の完全一致だけを見る。
    if ! printf '%s' "${list}" | grep -qE "\"name\"[[:space:]]*:[[:space:]]*\"${name}\""; then
      missing+=("${name}")
    fi
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    die "本番 Worker の必須 secret が未投入: ${missing[*]}。値は 'wrangler secret put <NAME>'（対話入力・履歴に残さない）で人手投入してから再実行。"
  fi
  log "  [OK] 必須 secret ${#REQUIRED_SECRETS[@]} 種すべて存在（名前確認のみ・値は未検証）"
}

preflight() {
  log "STEP 1/4: preflight"

  # (a) confirm 合言葉
  if [[ "${CONFIRM:-}" != "DEPLOY-PROD" ]]; then
    die "CONFIRM='${CONFIRM:-}' が不正。本番反映には CONFIRM=DEPLOY-PROD が必須。"
  fi
  log "  [OK] confirm = DEPLOY-PROD"

  # (b) git working tree clean
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    git status --short >&2 || true
    die "working tree に未コミット差分がある。本番反映はクリーンな tree からのみ許可。"
  fi
  log "  [OK] git working tree clean"

  # (c) prod Supabase ref HARD ASSERT（SUPABASE_URL があるときのみここで検証。無ければ migrate.ts の assert に委譲）
  if [[ -n "${SUPABASE_URL:-}" ]]; then
    # https://<ref>.supabase.co → <ref>
    local host ref
    host="${SUPABASE_URL#*://}"; host="${host%%/*}"
    ref="${host%%.*}"
    if [[ "${ref}" != "${EXPECTED_PROD_REF}" ]]; then
      die "SUPABASE_URL の project ref '${ref}' が本番 '${EXPECTED_PROD_REF}' と不一致。中断。"
    fi
    log "  [OK] prod Supabase ref = ${ref}"
  else
    warn "SUPABASE_URL 未設定。prod ref assert は migrate.ts（.dev.vars 読み込み後）に委譲する。"
  fi

  # (c2) 必須 secret 名の存在確認（#2）
  check_secrets

  # (d) staging smoke が緑
  if [[ "${SKIP_STAGING_SMOKE:-}" == "true" ]]; then
    warn "SKIP_STAGING_SMOKE=true。staging smoke をスキップ（非推奨）。"
  else
    log "  staging smoke 実行中（対象: ${STAGING_WORKER_URL}）..."
    # STAGING_WORKER_URL は上部で export 済み（代入プレフィックスは readonly と衝突するため使わない）。
    if ! pnpm test:staging-smoke; then
      die "staging smoke が緑でない。本番反映を中断（先に staging を直す）。"
    fi
    log "  [OK] staging smoke green"
  fi

  # (e) 初回デプロイの追加ゲート（日次同期 cron の初活性化）
  print_cron_warning
  if [[ "${FIRST_DEPLOY:-}" == "true" ]]; then
    if [[ "${FIRST_DEPLOY_ACK:-}" != "SYNC-CRON-ACK" ]]; then
      die "FIRST_DEPLOY=true。日次同期 cron の初活性化に同意する場合は FIRST_DEPLOY_ACK=SYNC-CRON-ACK を付ける。"
    fi
    log "  [OK] first-deploy ack = SYNC-CRON-ACK（日次同期 cron 初活性化に同意）"
  fi

  log "preflight PASSED"
}

# 本番へ当てる migration は **明示指定制**（bare `--apply` は使わない）。
#
# なぜ: bare `npx tsx scripts/migrate.ts --apply` は「未適用のものを全件」当てる。
#   一方 docs/deploy-runbook.md は 024 / 025 を「本番へ当てないことが設計」、027 を
#   「LIFF 連携有効化（G1-G3）とセット」と定めている。bare `--apply` はこの手順書自身が
#   禁じている変更を本番へ入れてしまう（手順書とスクリプトの自己矛盾）。
#   よって「当てるものを名指しする」= 意図しない migration が混入しえない形にする。
#
# 使い方:
#   MIGRATE_ONLY=NONE       ... この反映では migration を当てない（migration 無しデプロイの既定形）
#   MIGRATE_ONLY=036,037    ... 名指しした version だけを番号順に当てる（migrate.ts --only に渡す）
#   MIGRATE_ONLY 未指定     ... 中断（fail-closed。「うっかり全件」を構造的に起こせなくする）
#
# deny-list は二重ゲート: 名指ししても、手順書が本番非適用と定めた version は追加 ack 無しでは通さない。
readonly PROD_MIGRATION_DENYLIST=(024 025 027)

# token（"024" / "024_broadcast_stats" 等）の先頭数字部分を返す。数字で始まらないときは空。
migration_number_of() {
  local token="$1"
  printf '%s' "${token}" | sed -n 's/^\([0-9][0-9]*\).*$/\1/p'
}

# deny-list に当たる token か（先頭番号で照合）。
migration_is_denied() {
  local num
  num="$(migration_number_of "$1")"
  [[ -z "${num}" ]] && return 1
  local d
  for d in "${PROD_MIGRATION_DENYLIST[@]}"; do
    # 先頭 0 の有無で取り違えないよう 10 進数として比較する。
    if [[ "$((10#${num}))" -eq "$((10#${d}))" ]]; then return 0; fi
  done
  return 1
}

# MIGRATE_DENYLIST_ACK に当該 version が明示されているか（例: MIGRATE_DENYLIST_ACK=027）。
migration_denylist_acked() {
  local num ack ack_num acks=()
  num="$(migration_number_of "$1")"
  [[ -z "${num}" ]] && return 1
  IFS=',' read -ra acks <<< "${MIGRATE_DENYLIST_ACK:-}"
  # ⚠ 空配列の展開は set -u で落ちる（bash 3.2）。":-" を付けて空要素 1 個として回す（下で捨てる）。
  for ack in "${acks[@]:-}"; do
    ack_num="$(migration_number_of "${ack// /}")"
    if [[ -n "${ack_num}" && "$((10#${num}))" -eq "$((10#${ack_num}))" ]]; then return 0; fi
  done
  return 1
}

run_migrations() {
  log "STEP 2/4: migration 適用（明示指定制・bare --apply は使わない）"

  # (a) まず未適用一覧を read-only で提示する（--dry-run は一切書き込まない）。
  #     「今なにが pending か」を見ないまま当てる事故を防ぐ。
  log "  未適用 migration を確認中（scripts/migrate.ts --dry-run・読み取りのみ）..."
  npx tsx scripts/migrate.ts --dry-run \
    || die "未適用 migration の確認（--dry-run）に失敗。接続情報を確認して再実行する。"

  # (b) 適用対象の明示を必須にする（未指定は中断＝ fail-closed）。
  if [[ -z "${MIGRATE_ONLY:-}" ]]; then
    die "MIGRATE_ONLY が未指定。上の未適用一覧を見て、当てるものを名指しすること。
       migration を当てない場合: MIGRATE_ONLY=NONE
       当てる場合（例）:         MIGRATE_ONLY=036,037
       ⚠ bare 'migrate.ts --apply'（未適用を全件適用）は本スクリプトからは実行しない。
         024 / 025 は本番非適用が設計、027 は LIFF 連携有効化（G1-G3）とセット。
         根拠: docs/deploy-runbook.md「Supabase Migrations」節。"
  fi

  if [[ "${MIGRATE_ONLY}" == "NONE" ]]; then
    log "  MIGRATE_ONLY=NONE。migration は適用せずに次のステップへ進む。"
    return 0
  fi

  # (c) deny-list 二重ゲート（名指ししても、手順書が本番非適用と定めたものは ack 無しでは通さない）。
  local token tokens=()
  IFS=',' read -ra tokens <<< "${MIGRATE_ONLY}"
  for token in "${tokens[@]:-}"; do
    token="${token// /}"
    [[ -z "${token}" ]] && continue
    if migration_is_denied "${token}"; then
      if migration_denylist_acked "${token}"; then
        warn "MIGRATE_ONLY に本番非適用リストの ${token} が含まれるが MIGRATE_DENYLIST_ACK で明示 ack 済み。適用を続行する。"
      else
        die "MIGRATE_ONLY に本番非適用の migration '${token}' が含まれる。
       024 / 025 = 機能（配信計測 / 休眠再訪）を本番で有効化する判断とセットでのみ適用する。
       027       = LIFF 連携の有効化とセット（G1-G3 ゲート通過が前提）。
       根拠: docs/deploy-runbook.md。どうしても今回当てるなら MIGRATE_DENYLIST_ACK=${token} を明示する。"
      fi
    fi
  done

  log "  適用対象を MIGRATE_ONLY=[${MIGRATE_ONLY}] に限定して適用する..."
  npx tsx scripts/migrate.ts --only "${MIGRATE_ONLY}" --apply
  log "migration 適用 完了（対象: ${MIGRATE_ONLY}）"
}

deploy_worker() {
  log "STEP 3/4: wrangler deploy（本番 / default env）"
  pnpm exec wrangler deploy
  log "wrangler deploy 完了"
}

# (#6) LINE webhook の設定・到達性を read-only で検証する。
#   - GET  /v2/bot/channel/webhook/endpoint : 登録 endpoint と active 状態を読む（副作用なし）。
#   - POST /v2/bot/channel/webhook/test      : LINE から webhook へ到達性テストを打つ（ユーザーへは送らない）。
# ⚠ OA Manager 固有設定（応答モード・あいさつメッセージ等）は API で触れない＝手動のまま。ここが検証するのは
#   「webhook が正しい URL に向き・到達可能か」だけ。LINE_CHANNEL_ACCESS_TOKEN が実行環境に無ければ検証不能として
#   skip（CI では token を注入しないため。ローカル本番検証時は export して実行するとゲートが効く）。
verify_webhook() {
  if [[ "${SKIP_WEBHOOK_CHECK:-}" == "true" ]]; then
    warn "SKIP_WEBHOOK_CHECK=true。LINE webhook 検証をスキップ。"
    return 0
  fi
  if [[ -z "${LINE_CHANNEL_ACCESS_TOKEN:-}" ]]; then
    warn "LINE_CHANNEL_ACCESS_TOKEN が実行環境に無いため webhook 検証を skip（Worker secret としては投入済みでも、この shell には無い）。"
    warn "  → webhook URL/到達性はローカルで LINE_CHANNEL_ACCESS_TOKEN を export して本スクリプトを回すか、手動で確認すること。"
    return 0
  fi
  log "  LINE webhook endpoint を検証中（GET /channel/webhook/endpoint・read-only）..."
  local ep
  ep="$(curl -fsS --max-time 20 -H "Authorization: Bearer ${LINE_CHANNEL_ACCESS_TOKEN}" \
    "${LINE_API_BASE}/channel/webhook/endpoint")" \
    || die "webhook endpoint の取得に失敗（LINE API）。"
  # 例: {"endpoint":"https://.../webhook/line","active":true}
  if ! printf '%s' "${ep}" | grep -q '"active":[[:space:]]*true'; then
    die "LINE webhook が active でない。応答: ${ep}（OA/Developers Console で webhook 利用を ON にする）。"
  fi
  # endpoint 値は URL のみ（token ではない）ので表示してよい。取り違え検知の材料にする。
  log "  [OK] webhook endpoint（active）: $(printf '%s' "${ep}" | grep -oE '"endpoint":"[^"]*"')"

  log "  LINE webhook 到達性テスト（POST /channel/webhook/test・LINE→webhook のみ／ユーザー送信なし）..."
  local test_res
  test_res="$(curl -fsS --max-time 20 -X POST -H "Authorization: Bearer ${LINE_CHANNEL_ACCESS_TOKEN}" \
    "${LINE_API_BASE}/channel/webhook/test")" \
    || die "webhook 到達性テストの HTTP 取得に失敗（LINE API）。"
  # 例: {"success":true,"timestamp":"...","statusCode":200,"reason":"OK","detail":"200"}
  if ! printf '%s' "${test_res}" | grep -q '"success":[[:space:]]*true'; then
    die "webhook 到達性テストが success:true でない。応答: ${test_res}。"
  fi
  log "  [OK] webhook 到達性テスト success"
}

health_check() {
  log "STEP 4/4: 本番ヘルスチェック（${PROD_HEALTH_URL}）"
  local body
  # Claude API は呼ばない。root だけを叩き {"status":"ok"} を確認する。
  body="$(curl -fsS --max-time 20 "${PROD_HEALTH_URL}")" \
    || die "ヘルスチェックの HTTP 取得に失敗（${PROD_HEALTH_URL}）。"
  if ! printf '%s' "${body}" | grep -q '"status":[[:space:]]*"ok"'; then
    die "ヘルスチェック応答に status:ok が無い。応答: ${body}"
  fi
  log "  [OK] health = status:ok"

  # (#6) webhook 設定・到達性の read-only 検証。
  verify_webhook
}

# (#5) web-app との版ずれを「束ねずに可視化」する。web-app は deploy-prod から発火しない（main push の
#   Git 連携自動デプロイのまま）。ここでは反映した cx-agent の git SHA を刻み、web-app 側 SHA
#   （VERCEL_GIT_COMMIT_SHA 等）と突き合わせられる簡易 compare を出すだけ（版ずれは消せないが検知可能にする）。
version_skew_report() {
  local cx_sha
  cx_sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  log "版ずれ可視化（#5）: 反映した cx-agent の git SHA を記録"
  printf '  DEPLOYED_CX_AGENT_SHA=%s\n' "${cx_sha}" >&2
  if [[ -n "${WEB_APP_SHA:-}" ]]; then
    # web-app の SHA を渡された場合のみ突き合わせる（Vercel には接続しない・手渡し比較）。
    if [[ "${cx_sha}" == "${WEB_APP_SHA}" ]]; then
      printf '  [OK] web-app SHA と一致（%s）\n' "${WEB_APP_SHA}" >&2
    else
      warn "cx-agent(${cx_sha}) と web-app(${WEB_APP_SHA}) の SHA が不一致。別レーンなので即エラーにはしないが、"
      warn "  API 契約変更を跨いでいないか確認すること（跨ぐ場合は後方互換 1 リリースを挟む・deploy-runbook 参照）。"
    fi
  else
    log "  （WEB_APP_SHA 未指定。web-app 側 SHA を Vercel の VERCEL_GIT_COMMIT_SHA 等から取得し、"
    log "    WEB_APP_SHA=<sha> を渡すと版ずれ compare を出力する。web-app のデプロイ自体はここでは行わない。）"
  fi
}

# ─ (#4) リッチメニュー差し替えは deploy に常時組み込まない（opt-in step）─
#   毎 deploy で新 richMenuId を作ると無駄な生成が積み上がり、順序を誤ると既定メニューの空白窓が開く。
#   よってメニュー内容を変えるときだけ、別コマンドで明示実行する:
#     export LINE_CHANNEL_ACCESS_TOKEN=<本番OAトークン>
#     export RICH_MENU_IMAGE_PATH=assets/rich-menu/richmenu-optionA-6slot-xs12-final.png
#     pnpm setup-rich-menu -- --channel prod   # --channel は明示必須
#   setup-rich-menu.ts は create→image upload→set-default→delete-old の順で差し替え、空白窓を作らない。

main() {
  log "=== elxea CX Agent 本番フル反映を開始 ==="
  preflight
  run_migrations
  deploy_worker
  health_check
  version_skew_report   # (#5) 反映 SHA を刻み web-app との版ずれを可視化（web-app 自体はここでは触らない）
  log "=== 本番フル反映 完了（migration → deploy → health OK）==="
}

main "$@"
