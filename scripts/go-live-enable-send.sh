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
#   ⚠ 2026-09-22 追加変更: **一括送信の口（旧 run）も撤去済み**。今の送信口は
#     「配信 DB の 1 行だけを送る」`POST /api/delivery/send-one` のみ。
#     承認しただけでは送られない。送信口を叩いた瞬間に、指定した 1 行だけが配信される。
#     配信予定日時は送信条件ではない（Approved なら未来でも空でも送られる）。
#   - 配信したい: Notion 配信 DB の行を Status=Approved にしたうえで、
#     `POST /api/delivery/send-one`（Bearer SYNC_API_SECRET・pageId で 1 行を指定）を叩く。
#     コマンドの正本は docs/deploy-runbook.md「オンデマンド実行のしかた」節。
#   - 先にテストしたい: 検証環境（staging / テスト OA @426vlcyb）の配信 DB で同じことをし、
#     staging の送信口を叩く。テスト用 LINE に実際に届く。
#   - 止めたい: docs/deploy-runbook.md「配信を止める」節を参照。
#       全体 = 送信口を叩かない（これだけで送信ゼロ。放置で飛ぶ経路は存在しない）
#       個別 = 該当行の Status を Approved → Draft に戻す（送信口を叩く前なら確実に止まる）
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
                2026-09-22 に一括送信の口（旧 run）も撤去済み。送信口は 1 行だけ送る
                POST /api/delivery/send-one のみです。

  配信する : Notion 配信 DB の行を Status=Approved にしたうえで
             POST /api/delivery/send-one を叩く（承認しただけでは送られません）
             pageId で送る 1 行を指定します（全件が飛ぶ経路はありません）
             配信予定日時は送信条件ではありません（Approved なら未来でも空でも飛びます）
             コマンドは docs/deploy-runbook.md「オンデマンド実行のしかた」節
  テスト   : 検証環境（staging / テスト OA）の配信 DB で同じ手順 + staging の送信口
  止める   : 全体 = 送信口を叩かない（放置で飛ぶ経路はありません）
             個別 = Status を Draft に戻す（run を叩く前なら確実）

  何も実行していません（Cloudflare の secret にも deploy にも触っていません）。
MSG
exit 1
