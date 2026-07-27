/**
 * 2 環境（本番 / テスト）の LINE チャネル切替（設計 確定要件 1）。
 *
 * 本番 OA @307tzhkw（友だち約 48 人・LINE Insight targetedReaches 実測 2026-07-27／変動する）
 * / テスト OA @426vlcyb（友だち数名）。
 * チャネルトークン・想定友だち数を prod/test で切り替える。secret 名を分ける。
 *
 * fail-closed 方針:
 *   - 既定は "test"（未設定・不正値は本番に流さない）。
 *   - 選択環境のアクセストークンが無ければ resolve は throw（送信経路に載せない）。
 *
 * このモジュールは値の解決のみ。実送信・外部 I/O はしない。
 */

import type { Env } from "../index";

/** 配信の対象環境。 */
export type DeliveryTargetEnv = "prod" | "test";

/** 解決済みチャネル（実送信は line-messages.ts の LineSender が担う）。 */
export interface DeliveryChannel {
  targetEnv: DeliveryTargetEnv;
  /** チャネルアクセストークン（値はログ・Notion に出さない）。 */
  accessToken: string;
  /** broadcast 時の想定受信者数（無料枠ガードの見積に使う）。未設定なら null。 */
  estimatedFriendCount: number | null;
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
 *   - estimatedFriendCount = LINE_BROADCAST_ESTIMATED_RECIPIENTS_PROD
 * test:
 *   - accessToken = LINE_CHANNEL_ACCESS_TOKEN_TEST
 *   - estimatedFriendCount = LINE_BROADCAST_ESTIMATED_RECIPIENTS_TEST
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
  const parsed = rawCount != null ? Number.parseInt(rawCount, 10) : NaN;
  const estimatedFriendCount =
    Number.isInteger(parsed) && parsed >= 0 ? parsed : null;

  return {
    targetEnv,
    accessToken,
    estimatedFriendCount,
    label: targetEnv === "prod" ? "prod(@307tzhkw)" : "test(@426vlcyb)",
  };
}
