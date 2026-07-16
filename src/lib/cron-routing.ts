/**
 * Cron ルーティング（純粋・I/O なし・ユニットテスト可能）。
 *
 * Workers の scheduled ハンドラは受け取った cron パターンで処理を分岐する。
 * 分岐判定を純粋関数に切り出し、entry（index.ts）の named export を増やさずに
 * テスト可能にする（entry に関数を足すと Workers が誤ってハンドラ解釈する懸念を避ける）。
 */

/** 配信 cron（15分毎）。runScheduledDelivery を回す。 */
export const DELIVERY_CRON_PATTERN = "*/15 * * * *";

/** 同期 cron（毎日 18:00 UTC = 03:00 JST）。ナレッジ同期 + Shopify Metafield 同期を回す。 */
export const SYNC_CRON_PATTERN = "0 18 * * *";

/**
 * 配信計測 fetch cron（毎日 19:00 UTC = 04:00 JST）。P0-7b。
 * broadcast_stats の 24h/72h/7d スナップショット取得を回す（runBroadcastStatsFetch）。
 * 同期（18:00 UTC）と 1 時間ずらして isolate 競合・負荷集中を避ける。
 * ⚠ wrangler.toml では staging 限定で登録する（[env.staging.triggers]）。本番 [triggers] には
 *   まだ入れない（本番配信計測の有効化は GA/本番昇格ゲートで別途判断する）。
 */
export const STATS_CRON_PATTERN = "0 19 * * *";

/** cron パターンの分類結果。 */
export type CronKind = "delivery" | "sync" | "stats";

/**
 * cron パターンを処理種別に分類する（純粋）。
 *
 * T3 の要点: 配信パターンだけを配信に振り、それ以外（同期パターン + 想定外）はすべて
 * 同期に倒す。これにより「配信分岐の return で同期が死蔵する」問題を構造的に解消する
 * （配信パターン以外は必ず同期へ到達する）。
 *
 * P0-7b 追加: 配信計測 fetch を 3 種目として明示分岐する（STATS_CRON_PATTERN）。
 * 明示パターンに一致しないものは従来どおり sync（安全網）に倒れる。
 *
 * @param pattern event.cron の値
 */
export function classifyCron(pattern: string): CronKind {
  if (pattern === DELIVERY_CRON_PATTERN) return "delivery";
  if (pattern === STATS_CRON_PATTERN) return "stats";
  // SYNC_CRON_PATTERN と、想定外パターン（安全網）は同期に倒す。
  return "sync";
}
