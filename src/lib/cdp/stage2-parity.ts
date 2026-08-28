/**
 * @layer CDP
 *
 * Stage 2 の並走突合 — 新旧の解決が食い違っていないかを毎日 1 行で言う
 * （CDP 統合 Stage 2 / 設計 §6-1 Stage 2 の完了条件）。
 *
 * ─ なぜ要るか ─
 *
 *   Stage 2 の完了条件は「新旧解決の一致率 100% を 5 営業日観測（Devlog 記録）」。
 *   観測は人がやるものではなく、**毎日勝手に残る形**でないと 5 営業日は埋まらない。
 *   ここが残す 1 行がその材料になる。
 *
 * ─ 何をしないか（範囲を狭く保つ）─
 *
 *   - 直さない。読むだけ。食い違いを見つけても勝手に link を足さない
 *     （足すと「一致していた」のか「直した」のかが区別できなくなる）。
 *   - 新しい cron を作らない。既存の日次 tick（wrangler.toml の "0 18 * * *"）に
 *     相乗りする（src/index.ts の runDailySync）。Cloudflare の cron は 5 本上限で
 *     使い切っている（wrangler.toml のコメント参照）。
 *   - 外部に何も送らない。
 *
 * ─ 一致の定義（この 4 つが 0 の日が「一致した 1 日」）─
 *
 *   linked_without_link       … 旧台帳 customer_linkages で連携済みなのに link が無い人数
 *   identity_map_without_link … もう 1 冊の旧台帳 user_identity_map で同上
 *   delivery_identity_missing … 連携済みなのに配信の宛先の派生が無い人数
 *   multi_line_components     … 1 人に LINE が 2 本以上（J-4 の破れ）
 *
 *   数え方の正本は SQL 側（migration 043 → 044 の cdp_stage2_parity）。ここは呼んで
 *   ログに落とすだけで、判定条件を 2 か所に書かない。
 *
 *   ⚠ identity_map_without_link は 043 の時点でも**数えて返していた**が、
 *     in_agreement の式に入っていなかった（Stage 2 の QA 指摘 MID-1）。★11 の断線は
 *     user_identity_map を引く読出（getCrossChannelMessages / resolveUnifiedUserId）で
 *     起きているので、これは「新旧一致」の旧の側に確かに含まれる。044 で判定に入れた。
 *     数は 043 の時点から毎日ログに出ているため、**過去の日も後から判定し直せる**。
 */

import { createClient } from "@supabase/supabase-js";
import type { Env } from "../../index";

export interface Stage2ParityResult {
  ok: boolean;
  /** ok=false の理由（未設定・RPC 失敗・043 未適用など）。 */
  reason?: string;
  /** SQL 側が返した観測値そのまま（判定条件を 2 か所に持たない）。 */
  metrics?: Record<string, unknown>;
  /** 新旧が一致していた日か（SQL 側の in_agreement）。 */
  inAgreement?: boolean;
}

/**
 * 突合を 1 回走らせて結果を返す。**決して throw しない。**
 *
 * 呼び出し側（日次 tick）は結果を 1 行の JSON ログに落とすだけでよい。
 */
export async function runStage2Parity(env: Env): Promise<Stage2ParityResult> {
  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return { ok: false, reason: "supabase_not_configured" };
    }
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    const { data, error } = await supabase.rpc("cdp_stage2_parity");
    if (error) {
      // migration 043 未適用の環境もここに来る（関数が無い）。観測が始まっていない
      // ことと、観測して一致していることは違うので、必ず理由を残す。
      return { ok: false, reason: `rpc_failed:${error.message}` };
    }
    if (!data || typeof data !== "object") {
      return { ok: false, reason: "rpc_shape_unexpected" };
    }

    const metrics = data as Record<string, unknown>;
    return {
      ok: true,
      metrics,
      inAgreement: metrics.in_agreement === true,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
