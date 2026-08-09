#!/usr/bin/env bash
###############################################################################
# line-token-rotation-decide.sh ― 「今トークンを更新すべきか」だけを決める純粋ロジック
#
# 位置づけ:
#   本ファイルは **判定だけ** を行う。ネットワーク・wrangler・資格情報の読み書き・
#   ファイル書き込みを一切しない (source しても副作用ゼロ)。
#   実際の発行・secret 投入・状態更新は scripts/line-token-rotation.sh 側が行う。
#
# なぜ分けているか:
#   判定ロジック (日数計算 / 25日しきい値 / 401 即時パス) を、本体を一度も起動せずに
#   ユニットテストできるようにするため。tests/unit/line-token-rotation.test.ts は
#   このファイルだけを source して検証する (本体スクリプトは起動しない)。
#
# 使い方 (source して関数を呼ぶ):
#   . scripts/lib/line-token-rotation-decide.sh
#   LTR_TODAY=2026-09-04 LTR_STATE_JSON="$(cat state.json)" ltr_decide
#
# 入力 (すべて環境変数。引数を取らないのは JSON のクォート事故を避けるため):
#   LTR_STATE_JSON             状態ファイルの中身 (JSON 文字列)。空 = 状態なし
#   LTR_TODAY                  判定基準日 YYYY-MM-DD (省略時は date で当日 JST)
#   LTR_FORCE                  1 なら age を無視して ROTATE
#   LTR_PROBE_STATUS           直前の GET /v2/bot/info の HTTP status (空可)。401 で即 ROTATE
#   LTR_ROTATE_AFTER_DAYS      発行から何日で更新するか (既定 25)
#   LTR_NEAR_EXPIRY_DAYS       失効まで何日を切ったら更新するか (既定 5)
#
# 出力 (stdout・KEY=VALUE 1 行ずつ):
#   DECISION=SKIP|ROTATE|ERROR
#   REASON=<機械可読な理由>
#   DAYS_SINCE_ISSUED=<整数 or ->
#   DAYS_TO_EXPIRY=<整数 or ->
#
# 終了コード:
#   0 = 判定できた (SKIP / ROTATE)
#   2 = 判定できない (ERROR)。状態ファイル欠落・破損・時刻逆行など。
#       黙って更新も黙ってスキップもしない (fail-loud)。
#
# 依存: bash / jq のみ。date(1) には依存しない (LTR_TODAY 省略時のみ使う)。
#       日数計算は Howard Hinnant の days_from_civil を整数演算で実装しており、
#       タイムゾーン・ロケール・GNU/BSD date の差異の影響を受けない。
#
# セキュリティ: トークン値は入力にも出力にも一切登場しない。状態ファイルは
#              「いつ発行したか」しか持たない (SECRETS-INDEX の記載対象外)。
###############################################################################

# 既定値 (呼び出し側が環境変数で上書き可能)
: "${LTR_ROTATE_AFTER_DAYS:=25}"
: "${LTR_NEAR_EXPIRY_DAYS:=5}"

# ---------------------------------------------------------------------------
# ltr_days_from_ymd <year> <month> <day>
#   1970-01-01 を 0 とする通算日数を返す。負の年月日も扱えるが用途上は 1970 以降。
#   アルゴリズム: days_from_civil (Howard Hinnant, public domain)。
#   bash の算術は切り捨て除算なので、負値が出る前に era で正規化している。
# ---------------------------------------------------------------------------
ltr_days_from_ymd() {
  local y="$1" m="$2" d="$3"
  # 3 月始まりの暦に寄せる (閏日を年末に追いやると閏年判定が不要になる)
  if [ "$m" -le 2 ]; then y=$((y - 1)); fi
  local era yoe doy doe
  if [ "$y" -ge 0 ]; then era=$((y / 400)); else era=$(((y - 399) / 400)); fi
  yoe=$((y - era * 400))
  if [ "$m" -gt 2 ]; then
    doy=$(((153 * (m - 3) + 2) / 5 + d - 1))
  else
    doy=$(((153 * (m + 9) + 2) / 5 + d - 1))
  fi
  doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  echo $((era * 146097 + doe - 719468))
}

# ---------------------------------------------------------------------------
# ltr_date_to_days <YYYY-MM-DD[T...]>
#   ISO 日付 (先頭 10 文字) を通算日数へ。時刻・タイムゾーン部分は無視する。
#   日付として成立しない文字列は exit 1 (呼び出し側が ERROR に落とす)。
# ---------------------------------------------------------------------------
ltr_date_to_days() {
  local s="${1:-}"
  # 先頭 10 文字が厳密に YYYY-MM-DD であること
  case "$s" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*) : ;;
    *) return 1 ;;
  esac
  local y="${s:0:4}" m="${s:5:2}" d="${s:8:2}"
  # 先頭 0 を 10 進として扱う (08 が 8 進エラーにならないように)
  y=$((10#$y)); m=$((10#$m)); d=$((10#$d))
  [ "$m" -ge 1 ] && [ "$m" -le 12 ] || return 1
  [ "$d" -ge 1 ] && [ "$d" -le 31 ] || return 1
  ltr_days_from_ymd "$y" "$m" "$d"
}

# ---------------------------------------------------------------------------
# ltr_add_days <YYYY-MM-DD> <n>  ―  n 日後の YYYY-MM-DD を返す (civil_from_days)
#   状態ファイルの expires_at を発行日 + expires_in から組み立てるのに使う。
# ---------------------------------------------------------------------------
ltr_add_days() {
  local base_days
  base_days="$(ltr_date_to_days "$1")" || return 1
  local z=$((base_days + $2 + 719468))
  local era yoe doy mp y m d
  if [ "$z" -ge 0 ]; then era=$((z / 146097)); else era=$(((z - 146096) / 146097)); fi
  local doe=$((z - era * 146097))
  yoe=$(((doe - doe / 1460 + doe / 36524 - doe / 146096) / 365))
  y=$((yoe + era * 400))
  doy=$((doe - (365 * yoe + yoe / 4 - yoe / 100)))
  mp=$(((5 * doy + 2) / 153))
  d=$((doy - (153 * mp + 2) / 5 + 1))
  if [ "$mp" -lt 10 ]; then m=$((mp + 3)); else m=$((mp - 9)); fi
  if [ "$m" -le 2 ]; then y=$((y + 1)); fi
  printf '%04d-%02d-%02d\n' "$y" "$m" "$d"
}

# ---------------------------------------------------------------------------
# ltr_decide  ―  本体。上記の環境変数を読んで KEY=VALUE を吐く。
# ---------------------------------------------------------------------------
ltr_decide() {
  local today="${LTR_TODAY:-}"
  [ -n "$today" ] || today="$(date +%Y-%m-%d)"

  local force="${LTR_FORCE:-0}"
  local probe="${LTR_PROBE_STATUS:-}"
  local state="${LTR_STATE_JSON:-}"

  local today_days
  if ! today_days="$(ltr_date_to_days "$today")"; then
    printf 'DECISION=ERROR\nREASON=today-invalid\nDAYS_SINCE_ISSUED=-\nDAYS_TO_EXPIRY=-\n'
    return 2
  fi

  # (1) 401 即時更新パス。トークンが既に無効なので状態ファイルより優先する。
  #     「実際に落ちている」ことの観測が最強の根拠であり、暦の計算に勝たせる。
  if [ "$probe" = "401" ]; then
    printf 'DECISION=ROTATE\nREASON=unauthorized-401\nDAYS_SINCE_ISSUED=-\nDAYS_TO_EXPIRY=-\n'
    return 0
  fi

  # (2) 明示 --force。初回ブートストラップ (状態ファイルがまだ無い) もここを通す。
  if [ "$force" = "1" ]; then
    printf 'DECISION=ROTATE\nREASON=force\nDAYS_SINCE_ISSUED=-\nDAYS_TO_EXPIRY=-\n'
    return 0
  fi

  # (3) 状態ファイルが無い / 壊れている → 黙ってスキップも黙って更新もしない。
  #     ここを「無ければ更新」にすると、状態ファイルの取り違えで毎回発行し続け、
  #     30 本の同時発行上限に当たって古いトークンが黙って失効する事故になる。
  if [ -z "$state" ]; then
    printf 'DECISION=ERROR\nREASON=state-missing\nDAYS_SINCE_ISSUED=-\nDAYS_TO_EXPIRY=-\n'
    return 2
  fi
  if ! printf '%s' "$state" | jq -e . >/dev/null 2>&1; then
    printf 'DECISION=ERROR\nREASON=state-unparseable\nDAYS_SINCE_ISSUED=-\nDAYS_TO_EXPIRY=-\n'
    return 2
  fi

  local issued_at expires_at
  issued_at="$(printf '%s' "$state" | jq -r '.issued_at // empty')"
  expires_at="$(printf '%s' "$state" | jq -r '.expires_at // empty')"

  local issued_days
  if ! issued_days="$(ltr_date_to_days "$issued_at")"; then
    printf 'DECISION=ERROR\nREASON=state-issued-at-invalid\nDAYS_SINCE_ISSUED=-\nDAYS_TO_EXPIRY=-\n'
    return 2
  fi

  local days_since=$((today_days - issued_days))
  if [ "$days_since" -lt 0 ]; then
    # 未来日で発行されている = 状態ファイルの取り違えか時計のずれ。判定不能。
    printf 'DECISION=ERROR\nREASON=state-issued-in-future\nDAYS_SINCE_ISSUED=%s\nDAYS_TO_EXPIRY=-\n' "$days_since"
    return 2
  fi

  # 失効日は「あれば使う」。無い/壊れている状態ファイルでも age 判定は続行する。
  local days_to_expiry="-" expires_days
  if [ -n "$expires_at" ] && expires_days="$(ltr_date_to_days "$expires_at")"; then
    days_to_expiry=$((expires_days - today_days))
  fi

  # (4) 通常の定期更新。30 日失効に対し 25 日で回し、5 日分の余裕を残す。これが主ルール。
  if [ "$days_since" -ge "$LTR_ROTATE_AFTER_DAYS" ]; then
    printf 'DECISION=ROTATE\nREASON=age-threshold\nDAYS_SINCE_ISSUED=%s\nDAYS_TO_EXPIRY=%s\n' \
      "$days_since" "$days_to_expiry"
    return 0
  fi

  # (5) 失効間近。主ルールより「後」に置くのが重要。
  #     既定値では 25 日 + 5 日 = 30 日でちょうど有効期間と一致するため、先に置くと
  #     平常運転の 25 日目が毎回 near-expiry と報告され、age-threshold が一度も観測されない
  #     (= 主ルールが効いているのか失効直前の救済で滑り込んでいるのか、ログから区別できない)。
  #     後ろに置くことで、この節が発火するのは「25 日に達していないのに失効が近い」
  #     異常時だけになる。具体的には LINE が有効期間を 30 日より短く返した場合や、
  #     LTR_ROTATE_AFTER_DAYS を長くしすぎた場合の安全網として働く。
  if [ "$days_to_expiry" != "-" ] && [ "$days_to_expiry" -le "$LTR_NEAR_EXPIRY_DAYS" ]; then
    printf 'DECISION=ROTATE\nREASON=near-expiry\nDAYS_SINCE_ISSUED=%s\nDAYS_TO_EXPIRY=%s\n' \
      "$days_since" "$days_to_expiry"
    return 0
  fi

  printf 'DECISION=SKIP\nREASON=not-due\nDAYS_SINCE_ISSUED=%s\nDAYS_TO_EXPIRY=%s\n' \
    "$days_since" "$days_to_expiry"
  return 0
}
