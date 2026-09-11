/**
 * 2 環境（本番 / テスト）の LINE チャネル切替（設計 確定要件 1）。
 *
 * 本番 OA @307tzhkw / テスト OA @426vlcyb。
 * チャネルトークンと「友だち数のフォールバック値」を prod/test で切り替える。secret 名を分ける。
 *
 * ⚠ 友だち数をここに固定値で持つのをやめた（2026-09-11・オーナー判断）:
 *   全員配信は宛先指定なしで送るため、実際の到達は**その時点の友だち全員**。固定値は必ず陳腐化する
 *   （env の 48 に対し 2026-09-11 実測 68。2 ヶ月で台帳が 20 通ぶん過少になっていた）。
 *   受信者数の正は送信のたびの実測（src/lib/line-audience-size.ts）で、env 値は
 *   **実測できなかったときのフォールバック専用**へ降格した。だからここに現在値を書かない
 *   （書けば必ずまた古くなる）。実数は LINE が持っている。
 *
 * fail-closed 方針:
 *   - 既定は "test"（未設定・不正値は本番に流さない）。
 *   - 選択環境のアクセストークンが無ければ resolve は throw（送信経路に載せない）。
 *
 * このモジュールは値の解決のみ。実送信・外部 I/O はしない。
 */

import type { Env } from "../index";
import { parseFallbackCount } from "./line-audience-size";

/** 配信の対象環境。 */
export type DeliveryTargetEnv = "prod" | "test";

/** 解決済みチャネル（実送信は line-messages.ts の LineSender が担う）。 */
export interface DeliveryChannel {
  targetEnv: DeliveryTargetEnv;
  /** チャネルアクセストークン（値はログ・Notion に出さない）。 */
  accessToken: string;
  /**
   * broadcast 時の想定受信者数の**フォールバック値**（env 由来）。未設定なら null。
   * 正は送信のたびの実測（line-audience-size.ts）。ここは実測が取れなかったときだけ使う。
   */
  fallbackFriendCount: number | null;
  /** ログ・結果表示用の環境ラベル（トークンは含めない）。 */
  label: string;
}

/** DELIVERY_TARGET_ENV を厳格にパース（不正・未設定は "test" に倒す）。 */
export function parseTargetEnv(raw: string | undefined): DeliveryTargetEnv {
  return raw === "prod" ? "prod" : "test";
}

/**
 * 環境に応じた LINE チャネルを解決する。
 *
 * prod:
 *   - accessToken = LINE_CHANNEL_ACCESS_TOKEN（既存・本番）
 *   - fallbackFriendCount = LINE_BROADCAST_ESTIMATED_RECIPIENTS_PROD（フォールバック専用）
 * test:
 *   - accessToken = LINE_CHANNEL_ACCESS_TOKEN_TEST
 *   - fallbackFriendCount = LINE_BROADCAST_ESTIMATED_RECIPIENTS_TEST（フォールバック専用）
 *
 * 選択環境のトークン未設定は throw（fail-closed）。
 */
export function resolveDeliveryChannel(env: Env): DeliveryChannel {
  const targetEnv = parseTargetEnv(env.DELIVERY_TARGET_ENV);

  const accessToken =
    targetEnv === "prod"
      ? env.LINE_CHANNEL_ACCESS_TOKEN
      : env.LINE_CHANNEL_ACCESS_TOKEN_TEST;

  if (!accessToken) {
    throw new Error(
      `resolveDeliveryChannel: access token for "${targetEnv}" is not configured (fail-closed)`,
    );
  }

  const rawCount =
    targetEnv === "prod"
      ? env.LINE_BROADCAST_ESTIMATED_RECIPIENTS_PROD
      : env.LINE_BROADCAST_ESTIMATED_RECIPIENTS_TEST;
  const fallbackFriendCount = parseFallbackCount(rawCount);

  return {
    targetEnv,
    accessToken,
    fallbackFriendCount,
    label: targetEnv === "prod" ? "prod(@307tzhkw)" : "test(@426vlcyb)",
  };
}
