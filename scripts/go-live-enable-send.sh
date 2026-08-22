#!/usr/bin/env bash
###############################################################################
# go-live-enable-send.sh  ―  【廃止済み / tombstone】2026-08-22
#
# このスクリプトは「本番 LINE の実送信スイッチ（secret DELIVERY_SEND_ENABLED）を
# "true" にする」ためのものだったが、**そのスイッチ自体を撤去した**ため役目を終えた。
#
# 廃止の理由（Setaka 指示 2026-08-22）:
#   Notion で承認済みの配信が「本番の実送信スイッチが OFF」というだけで送られず、
#   配信が数時間遅延する事故が起きた。関門が多すぎることが運用上の障害になっていたため、
#   staging・本番の双方から実送信スイッチを撤去した。
#
# 今の運用（このスクリプトの代わりにやること）:
#   ⚠ 2026-08-22 追加変更: **cron の自動配信も廃止した（完全オンデマンド）**。
#     承認しただけでは送られない。`POST /api/delivery/run` を叩いた瞬間だけ配信が走る。
#     配信予定日時は送信条件ではない（Approved なら未来でも空でも送られる）。
#   - 配信したい: Notion 配信 DB の行を Status=Approved にしたうえで、
#     `POST /api/delivery/run`（Bearer SYNC_API_SECRET）を叩く。
#     コマンドの正本は docs/deploy-runbook.md「オンデマンド実行のしかた」節。
#   - 先にテストしたい: 検証環境（staging / テスト OA @426vlcyb）の配信 DB で同じことをし、
#     staging の run を叩く。テスト用 LINE に実際に届く。
#   - 止めたい: docs/deploy-runbook.md「配信を止める」節を参照。
#       全体 = run を叩かない（これだけで送信ゼロ。放置で飛ぶ経路は存在しない）
#       個別 = 該当行の Status を Approved → Draft に戻す（run を叩く前なら確実に止まる）
#
# Cloudflare 側に残っている同名 secret は無害（コードがどこからも読まない）。
# 消したい場合のみ: pnpm exec wrangler secret delete DELIVERY_SEND_ENABLED
#   （挙動は変わらない。掃除目的の任意作業）
#
# 本スクリプトは何も実行せず終了する（secret も deploy も触らない）。
###############################################################################
set -euo pipefail

cat <<'MSG'
[廃止] このスクリプトは使えません（2026-08-22 に役目を終えました）。

  かつての役目: 本番 LINE の「実送信スイッチ」を ON にする
  現在        : そのスイッチ自体を撤去済み。さらに cron の自動配信も廃止（完全オンデマンド）。

  配信する : Notion 配信 DB の行を Status=Approved にしたうえで
             POST /api/delivery/run を叩く（承認しただけでは送られません）
             配信予定日時は送信条件ではありません（Approved なら未来でも空でも飛びます）
             コマンドは docs/deploy-runbook.md「オンデマンド実行のしかた」節
  テスト   : 検証環境（staging / テスト OA）の配信 DB で同じ手順 + staging の run
  止める   : 全体 = run を叩かない（放置で飛ぶ経路はありません）
             個別 = Status を Draft に戻す（run を叩く前なら確実）

  何も実行していません（Cloudflare の secret にも deploy にも触っていません）。
MSG
exit 1
