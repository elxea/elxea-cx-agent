/**
 * Cron ルーティング（純粋・I/O なし・ユニットテスト可能）。
 *
 * Workers の scheduled ハンドラは受け取った cron パターンで処理を分岐する。
 * 分岐判定を純粋関数に切り出し、entry（index.ts）の named export を増やさずに
 * テスト可能にする（entry に関数を足すと Workers が誤ってハンドラ解釈する懸念を避ける）。
 */

/**
 * 旧・配信 cron（15分毎）。**2026-08-22 に自動配信を廃止したため、この定数はもう
 * 「配信を回すパターン」ではない**（wrangler.toml の crons からも削除済み）。
 *
 * 定数と "delivery" 分岐を残す理由（削除しないこと）:
 *   classifyCron は未知パターンを "sync"（安全網）に倒す設計なので、この定数を消すと
 *   万一 15分毎パターンが cron に復活したときに **15分毎に日次同期が走る** 誤爆になる。
 *   明示的に "delivery" へ分類し、index.ts 側で **no-op**（何もしないで return）に倒すことで、
 *   「復活しても配信もしないし同期も誤爆しない」状態を保つ。
 *
 * 配信の起動経路は `POST /api/delivery/run` のみ（オンデマンド）。
 */
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

/**
 * 休眠検知 cron（毎日 20:00 UTC = 05:00 JST）。ブロック3-B。
 * 休眠中の友だちを抽出し「静かな一通」を送る（既定は送信封鎖 dry-run・runDormantReengagement）。
 * 既存 cron（配信 15分毎 / 同期 18:00 / 計測 19:00）と時刻が衝突しない 20:00 UTC に置く。
 * ⚠ wrangler.toml では staging 限定で登録する（[env.staging.triggers]）。本番 [triggers] には入れない
 *   （本番有効化は broadcast_stats が1サイクル回った後・別途 GA/昇格ゲートで判断）。
 */
export const DORMANT_CRON_PATTERN = "0 20 * * *";

/**
 * cron パターンの分類結果。
 * "delivery" は **退役済みの分類**（index.ts は no-op で握りつぶす）。誤爆防止のため型からは消さない。
 */
export type CronKind = "delivery" | "sync" | "stats" | "dormant";

/**
 * cron パターンを処理種別に分類する（純粋）。
 *
 * T3 の要点: 配信パターンだけを "delivery" に振り、それ以外（同期パターン + 想定外）はすべて
 * 同期に倒す。これにより「配信分岐の return で同期が死蔵する」問題を構造的に解消する
 * （配信パターン以外は必ず同期へ到達する）。
 *
 * 2026-08-22（完全オンデマンド化）: "delivery" は **退役分類** になった。index.ts の該当分岐は
 * 何もせず return する。この関数の役割は「15分毎パターンを sync に落とさない」誤爆防止に変わった。
 *
 * P0-7b 追加: 配信計測 fetch を 3 種目として明示分岐する（STATS_CRON_PATTERN）。
 * 明示パターンに一致しないものは従来どおり sync（安全網）に倒れる。
 *
 * @param pattern event.cron の値
 */
export function classifyCron(pattern: string): CronKind {
  if (pattern === DELIVERY_CRON_PATTERN) return "delivery";
  if (pattern === STATS_CRON_PATTERN) return "stats";
  if (pattern === DORMANT_CRON_PATTERN) return "dormant";
  // SYNC_CRON_PATTERN と、想定外パターン（安全網）は同期に倒す。
  return "sync";
}
