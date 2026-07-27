#!/usr/bin/env bash
###############################################################################
# go-live-enable-send.sh  ―  LINE 実配信の「本番送信スイッチ」を ON にする
#
# ⚠⚠⚠ このスクリプトは「本番の実 LINE 送信」を有効化する唯一のトリガです ⚠⚠⚠
#
# 実行すると本番 Worker(elxea-agent / OA @307tzhkw)の secret
#   DELIVERY_SEND_ENABLED = "true"
# を投入します。これ以降:
#   - Notion 配信DB で Status=Approved（かつ配信予定日時が到来）の行は、
#     cron(定期ポーリング)が拾って「実際に LINE 配信」します（dry-run ではなくなる）。
#   - 承認 pin / コンテンツハッシュ / 通数台帳 / 無料枠ガード等の多層安全弁は維持されますが、
#     「送信そのものを止める最後のスイッチ」はここで外れます。
#
# ロールバック（即時に dry-run へ戻す・実送信を再封鎖する）— 次の 2 通りはどちらも等価に OFF:
#   (a) pnpm exec wrangler secret delete DELIVERY_SEND_ENABLED
#       （secret を消すと未設定 = DELIVERY_SEND_ENABLED !== "true" となり全経路 dry-run に復帰）
#   (b) printf 'false' | pnpm exec wrangler secret put DELIVERY_SEND_ENABLED
#       （値を "false" にしても DELIVERY_SEND_ENABLED !== "true" なので同じく dry-run に復帰）
#   ※ OFF の条件は「secret が無いこと」ではなく「値が文字列 "true" でないこと」（完全一致判定）。
#      GA 前の本番の既定状態は (b) 側、すなわち「値 "false" で secret が存在する」状態である。
#
# ⚠ 本スクリプト末尾の read-back は secret 「名」の存在だけを確認する（Cloudflare は値を返さない）。
#   したがって **read-back の [OK] は「値が "true" になった」ことの証明ではない**。
#   実際に ON/OFF どちらであるかは cron 実行ログで判定する:
#     pnpm exec wrangler tail --format pretty
#       -> [delivery] env=prod(@307tzhkw) sendEnabled=true   ... ON（実送信する）
#       -> [delivery] env=prod(@307tzhkw) sendEnabled=false  ... OFF（dry-run）
#   （検証環境 staging は「未設定 = OFF」運用のため `secret list` で確認できるが、
#     本番はこの方法が使えない。詳細は docs/deploy-runbook.md「LINE 配信の運用ゲート」節。）
#
# 前提:
#   - カレントディレクトリが elxea-cx-agent リポジトリ直下（wrangler.toml name=elxea-agent）。
#   - Cloudflare 認証済み（wrangler が本番アカウントを操作できる状態）。
#   - go-live 対象行が Notion 上で Status=Approved・承認 pin 済み・配信予定日時 設定済み
#     であること（本スイッチは「送信可否」だけを切り替える。行の準備は別途）。
#
# 安全設計:
#   - 誤爆防止のため、明示フラグ --confirm-i-really-want-to-send-real-line が無いと何もしない。
#   - 実行するのは (1) secret put (2) secret list による name read-back (3) echo のみ。
#     deploy はしない（コードは既に本番反映済み前提）。
#
# 使い方（オーナー Setaka が手動実行する単一コマンド）:
#   bash scripts/go-live-enable-send.sh --confirm-i-really-want-to-send-real-line
###############################################################################
set -euo pipefail

CONFIRM_FLAG="--confirm-i-really-want-to-send-real-line"
SECRET_NAME="DELIVERY_SEND_ENABLED"
SECRET_VALUE="true"

if [ "${1:-}" != "$CONFIRM_FLAG" ]; then
  echo "[STOP] 確認フラグがありません。実行するには次を実行してください:"
  echo "         bash scripts/go-live-enable-send.sh $CONFIRM_FLAG"
  echo ""
  echo "  このスクリプトは本番 LINE の実送信を有効化します（dry-run 解除）。"
  echo "  ロールバック: pnpm exec wrangler secret delete $SECRET_NAME"
  exit 1
fi

# 誤ディレクトリ実行の防止（本番 Worker 名の確認）
if ! grep -q '^name *= *"elxea-agent"' wrangler.toml 2>/dev/null; then
  echo "[FATAL] wrangler.toml の name が elxea-agent ではありません。リポジトリ直下で実行してください。中止。"
  exit 1
fi

echo ">>> 本番 secret 投入: ${SECRET_NAME}=\"${SECRET_VALUE}\"（default env = 本番 elxea-agent）"
# 値は stdin で渡す（シェル履歴/プロセス一覧に平文を残さない）。
printf '%s' "$SECRET_VALUE" | pnpm exec wrangler secret put "$SECRET_NAME"

echo ">>> read-back（値は取得不能なので secret 名の存在のみ確認）"
if pnpm exec wrangler secret list 2>/dev/null | grep -q "\"$SECRET_NAME\""; then
  echo "[OK] $SECRET_NAME が本番 Worker の secret 一覧に存在します。"
else
  echo "[WARN] $SECRET_NAME を secret 一覧で確認できませんでした。手動で 'pnpm exec wrangler secret list' を確認してください。"
fi

echo ""
echo "============================================================"
echo "[DONE] 本番送信スイッチ ON: $SECRET_NAME=\"$SECRET_VALUE\""
echo "  これ以降、Status=Approved かつ配信予定日時到来の行は cron が実 LINE 配信します。"
echo "  ロールバック（即 dry-run 復帰・実送信封鎖）:"
echo "    pnpm exec wrangler secret delete $SECRET_NAME"
echo "============================================================"
