#!/usr/bin/env bash
# =============================================================================
# activate-selfapproval.sh  （堅牢化版 / v2）
#
# 目的（何をするか）:
#   elxea CX Agent の「Notion 承認 → 自動配信（写真付き含む）」を本番で成立させる
#   有効化チェーンを、オーナー（Setaka）が 1 回実行するだけで確実に通す。
#   自己承認緩和コードの commit/push・本番 deploy・R2/フラグ secret 投入を順に行う。
#   これらは Claude の auto-mode 分類器がエージェント実行を機械ブロックする
#   「オーナー自身が実行すべき security-op」であるため、本スクリプトを人手で実行する。
#
#   決定根拠: 単独運用モードの自己承認採用（Setaka 明示承認 2026-07-25）
#   決定記録: https://app.notion.com/p/3a870c9d064c81f986ddc7a8b805d6af
#
# v2 の堅牢化（前回 step1 preflight 以前で停止・working tree 不変だったため）:
#   - 依存を自動解決（node_modules 不在 or tsx 未解決なら pnpm/npm で install）。
#   - git を非対話・非ハング化（GIT_TERMINAL_PROMPT=0 / ssh BatchMode）。push は非必須で WARN 続行。
#   - 各 step を ">>> [n/8] START" / "<<< [n/8] OK" で可視化。冒頭で環境情報を表示。
#   - 失敗時は最後の START 行が停止点。tee でログ保存推奨。
#
# 実送信は発生しない:
#   本スクリプトは DELIVERY_SEND_ENABLED を「一切変更しない」。
#   実送信スイッチ（DELIVERY_SEND_ENABLED=true）は dry-run 検証 + Setaka 最終 GO の
#   後に別ステップで行う。よって本スクリプト実行後も全経路 dry-run のまま
#   （顧客への LINE 送信は起きない）。
#
# 可逆手順（ロールバック）:
#   - 自己承認を即無効化: `npx wrangler secret delete DELIVERY_ALLOW_SELF_APPROVAL_PROD`
#       → 独立承認者必須（fail-closed）へ即復帰。チェック本体はコードに残存＝可逆。
#   - 画像 R2 を無効化:   `npx wrangler secret delete R2_API_TOKEN`
#       → 画像付き pin が fail-closed（テキストのみ配信は影響なし）。
#   - コードを戻す:       `git revert <このスクリプトが作った commit>`（フラグ実装を撤去）。
#   - いずれも DELIVERY_SEND_ENABLED には触れない（送信は別レイヤで常時ガード）。
#
# 冪等性:
#   - commit: 対象 3 ファイルに HEAD との差分が無ければ skip。
#   - deploy / secret put: 何度実行しても同一状態に収束（上書き）。
#
# 使い方（ログ保存推奨）:
#   bash ~/github/elxea/products/elxea-cx-agent/scripts/activate-selfapproval.sh 2>&1 | tee /tmp/activate.log
# =============================================================================

set -euo pipefail

# git を非対話・非ハング化（認証待ちで固まらず即失敗させる）
export GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND='ssh -o BatchMode=yes'

# --- 0. 位置決め & 環境情報 ------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "=============================================================="
echo "[activate-selfapproval v2] 有効化チェーン開始"
echo "  pwd            : $(pwd)"
echo "  node           : $(command -v node >/dev/null 2>&1 && node -v || echo 'NOT FOUND')"
echo "  npm            : $(command -v npm >/dev/null 2>&1 && npm -v || echo 'NOT FOUND')"
echo "  pnpm           : $(command -v pnpm >/dev/null 2>&1 && pnpm -v || echo 'NOT FOUND')"
echo "  git branch     : $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
echo "  wrangler       : $(npx --no-install wrangler --version 2>/dev/null || echo '(will use npx wrangler)')"
echo "=============================================================="

# wrangler.toml が elxea-agent であることを確認（誤ディレクトリ実行を防ぐ）
if ! grep -q '^name *= *"elxea-agent"' wrangler.toml 2>/dev/null; then
  echo "[FATAL] wrangler.toml の name が elxea-agent ではない。実行を中止。"
  exit 1
fi

FILES=(src/lib/delivery-approval.ts src/index.ts tests/unit/delivery-send.test.ts)
ORIG_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

# --- 1. 依存の自動解決（tsx が動かず即 exit するのを防ぐ）--------------------------
echo ""
echo ">>> [1/8] START: 依存解決（node_modules / tsx）"
NEED_INSTALL=0
[ -d node_modules ] || NEED_INSTALL=1
npx --no-install tsx --version >/dev/null 2>&1 || NEED_INSTALL=1
if [ "$NEED_INSTALL" -eq 1 ]; then
  echo "[info] 依存が未解決。install を実行する。"
  if [ -f pnpm-lock.yaml ] && command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile || pnpm install
  elif [ -f package-lock.json ]; then
    npm ci || npm install
  elif command -v pnpm >/dev/null 2>&1; then
    pnpm install
  else
    npm install
  fi
else
  echo "[info] 依存は解決済み（install skip）。"
fi
# ここで tsx が使えることを最終確認（使えなければ FATAL）
if ! npx --no-install tsx --version >/dev/null 2>&1; then
  echo "[FATAL] tsx が解決できない。手動で 'pnpm install'（または npm install）後に再実行。"
  exit 1
fi
echo "<<< [1/8] OK: 依存解決完了"

# --- 2. プリフライト: 自己承認ユニットテスト（green でなければ deploy しない）--------
echo ""
echo ">>> [2/8] START: プリフライト delivery-send ユニットテスト"
npx tsx tests/unit/delivery-send.test.ts
echo "<<< [2/8] OK: ユニットテスト green（この gate を通らなければ以降は実行されない）"

# --- 3. commit（必須・冪等）------------------------------------------------------
echo ""
echo ">>> [3/8] START: 自己承認フラグ実装を commit"
if git diff --quiet HEAD -- "${FILES[@]}"; then
  echo "[skip] 対象 3 ファイルに HEAD との差分なし＝既に commit 済みと判断。"
else
  git add "${FILES[@]}"
  # commit は必須。失敗したら set -e で即 FATAL（有効化の土台が無いため）。
  git commit -m "feat(delivery): 単独運用モードの prod 自己承認フラグを有効化（可逆・既定fail-closed）

承認者∉担当者ロックを prod 限定フラグ DELIVERY_ALLOW_SELF_APPROVAL_PROD=\"true\"
のときだけ免除する Tier2 例外ゲート。未設定/非\"true\"は独立承認者必須(fail-closed)へ
復帰＝完全に可逆。チェック本体は削除しない。

単独運用モード自己承認・Setaka 承認 2026-07-25。
決定記録: 3a870c9d064c81f986ddc7a8b805d6af

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
  echo "[info] commit 完了。"
fi
echo "<<< [3/8] OK: commit 段階完了"

# --- 4. push（非必須・VC 衛生。失敗しても activation は続行）------------------------
echo ""
echo ">>> [4/8] START: push（現ブランチ + master ff-only・非必須）"
if git push origin "$ORIG_BRANCH"; then
  echo "[OK] origin/$ORIG_BRANCH へ push。"
else
  echo "[WARN] $ORIG_BRANCH の push に失敗/認証待ち（activation は続行）。後で手動 push 可。"
fi
if [ "$ORIG_BRANCH" != "master" ]; then
  if git fetch origin master 2>/dev/null \
     && git checkout master \
     && git merge --ff-only "$ORIG_BRANCH" \
     && git push origin master; then
    echo "[OK] master を $ORIG_BRANCH に fast-forward して push。"
  else
    echo "[WARN] master への ff-only 反映に失敗（分岐/認証/CI 要）。PR 経由でマージ可。"
  fi
  git checkout "$ORIG_BRANCH" 2>/dev/null || true
fi
echo "<<< [4/8] OK: push 段階完了（成否に依らず続行）"

# --- 5. 本番 deploy（必須・elxea-agent, keep_vars=true）---------------------------
echo ""
echo ">>> [5/8] START: 本番 deploy（wrangler deploy）"
echo "[info] keep_vars=true のため既存 secret は消えない。deploy はコードのみ更新。"
npx wrangler deploy
echo "<<< [5/8] OK: deploy 完了"

# --- 6. R2_API_TOKEN 投入（値は取得元から実行時読取り・生書きしない）------------------
echo ""
echo ">>> [6/8] START: R2_API_TOKEN（画像ホスティング）"
BROADCASTER_ENV="$HOME/github/elxea/agents/elxea-broadcaster/.env.local"
echo "[info] 取得元: $BROADCASTER_ENV の R2_API_TOKEN（broadcaster 既存トークン・option b）"
echo "       ※ Bitwarden 管理に切替える場合はこの取得行を 'bw get ...' に差し替える。"
if [ ! -f "$BROADCASTER_ENV" ]; then
  echo "[FATAL] 取得元ファイルが無い: $BROADCASTER_ENV"
  exit 1
fi
R2_TOKEN="$(grep -E '^R2_API_TOKEN=' "$BROADCASTER_ENV" | head -1 | sed -E 's/^R2_API_TOKEN=//' | tr -d "\"'" | tr -d '[:space:]')"
if [ -z "$R2_TOKEN" ]; then
  echo "[FATAL] R2_API_TOKEN が空。取得元を確認して再実行。"
  exit 1
fi
printf '%s' "$R2_TOKEN" | npx wrangler secret put R2_API_TOKEN
unset R2_TOKEN
echo "<<< [6/8] OK: R2_API_TOKEN 投入（値はログに出していない）"

# --- 7. DELIVERY_ALLOW_SELF_APPROVAL_PROD=true（自己承認フラグ有効化）-------------
echo ""
echo ">>> [7/8] START: DELIVERY_ALLOW_SELF_APPROVAL_PROD=true"
printf 'true' | npx wrangler secret put DELIVERY_ALLOW_SELF_APPROVAL_PROD
echo "<<< [7/8] OK: 自己承認フラグ有効化（フラグ削除で即 fail-closed へ戻せる・可逆）"

# !!! DELIVERY_SEND_ENABLED は絶対に触らない（送信スイッチは後の別ステップ）!!!
echo ""
echo "[GUARD] DELIVERY_SEND_ENABLED は本スクリプトでは一切変更していない＝dry-run 継続。"

# --- 8. read-back（secret 名で存在確認・値は表示不可）----------------------------
echo ""
echo ">>> [8/8] START: read-back（secret list）"
echo "[info] 期待: R2_API_TOKEN と DELIVERY_ALLOW_SELF_APPROVAL_PROD が存在し、"
echo "       DELIVERY_SEND_ENABLED は従来どおり存在（値は未変更・list は名前のみ表示）。"
SECRETS="$(npx wrangler secret list 2>/dev/null)"
for KEY in R2_API_TOKEN DELIVERY_ALLOW_SELF_APPROVAL_PROD DELIVERY_SEND_ENABLED \
           LINE_BROADCAST_ESTIMATED_RECIPIENTS_PROD R2_ACCOUNT_ID R2_BUCKET_NAME R2_PUBLIC_BASE; do
  if printf '%s' "$SECRETS" | grep -q "\"$KEY\""; then
    echo "  [OK]   $KEY : present"
  else
    echo "  [FAIL] $KEY : MISSING"
  fi
done
echo "<<< [8/8] OK: read-back 表示完了"

echo ""
echo "=============================================================="
echo "[DONE] 有効化チェーン完了。実送信は未発生（DELIVERY_SEND_ENABLED 未変更＝dry-run）。"
echo "  次: dry-run 検証（承認pin受理 / 画像R2host / 全員target解決 / dry-run到達）→"
echo "      QA 検証 + Setaka 最終 GO の後に DELIVERY_SEND_ENABLED=true を別途実行。"
echo "=============================================================="
