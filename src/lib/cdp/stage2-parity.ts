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
 *
 * ─ 048: ログに落とすだけでは 5 営業日を数えられない ─
 *
 *   043 / 044 の cdp_stage2_parity() は **その瞬間の 1 時点**しか返さない。
 *   ここが console.log に落とす 1 行は Worker のログにしか残らず、保持期間が短い。
 *   「連続 5 営業日一致したか」を問い合わせる先がどこにも無く、リリースゲートの
 *   判定が原理的に不能だった。048 で日次スナップショット表を足し、この関数は
 *   **保存まで済ませる関数（cdp_stage2_parity_snapshot）を呼ぶ**ようにした。
 *
 *   ⚠ 048 未適用の環境（＝まだ表が無い本番・staging）では保存の関数が無い。
 *     そのときは 044 の読み取り専用の関数に落として観測だけは続ける
 *     （観測が止まるほうが損。persisted=false と理由が結果に残る）。
 *
 * ─ 「比べる相手が 0 人の日」を緑に数えない（048 の芯）─
 *
 *   044 の in_agreement は「4 つの数がすべて 0」である。旧台帳に連携済みの行が
 *   1 つも無い日も 4 つとも 0 になるので、in_agreement は **何も比べなくても true**
 *   になる。一致率 100% の分母が 0 の日を 5 日並べても完了条件は満たされない。
 *   グリーンの定義は 048 の表の生成列（in_agreement AND compared_count > 0）が正本で、
 *   ここはそれを読むだけ。ただし読む側でも compared_count を再確認する（下記）。
 */

import { createClient } from "@supabase/supabase-js";
import type { Env } from "../../index";

/** 突合そのもの（読み取り専用・044）。048 未適用の環境への退避先。 */
export const PARITY_RPC = "cdp_stage2_parity";
/** 突合 + その日の 1 行として保存（048）。通常はこちらを呼ぶ。 */
export const PARITY_SNAPSHOT_RPC = "cdp_stage2_parity_snapshot";
/** 連続何営業日グリーンか（048 の読み口・読み取り専用）。 */
export const PARITY_STREAK_RPC = "cdp_stage2_parity_streak";

export interface Stage2ParityResult {
  ok: boolean;
  /** ok=false の理由（未設定・RPC 失敗・043 未適用など）。 */
  reason?: string;
  /** SQL 側が返した観測値そのまま（判定条件を 2 か所に持たない）。 */
  metrics?: Record<string, unknown>;
  /** 新旧が一致していた日か（SQL 側の in_agreement）。 */
  inAgreement?: boolean;
  /** その日の 1 行として保存できたか（048 未適用なら false）。 */
  persisted?: boolean;
  /** persisted=false の理由（保存の関数が無い・保存が落ちた）。 */
  persistReason?: string;
  /** 保存した観測日（JST の暦日。SQL 側が決める）。 */
  snapshotDate?: string;
  /** その日突き合わせた旧台帳の行数（一致率の分母）。 */
  comparedCount?: number;
  /** 食い違いの総数。 */
  mismatchCount?: number;
  /**
   * その日を「一致した 1 日」に数えてよいか。
   *
   * 定義の正本は 048 の生成列（in_agreement AND compared_count > 0）。ここは
   * それを読んだうえで compared_count > 0 を **もう一度** 確かめる。二重定義では
   * なく fail-closed の絞り込みで、赤い日を緑にすることは構造上できない
   * （044 が in_agreement に AND を 1 つ足したのと同じ向きの変更）。
   * 保存できなかった日（048 未適用）は分母が分からないので false に倒す。
   */
  green?: boolean;
  /**
   * 連続何営業日グリーンか（048 の cdp_stage2_parity_streak の戻りそのまま）。
   *
   * 毎日の 1 行に「あと何日で完了条件を満たすか」まで載せるために読む。
   * 数え方の正本は SQL 側で、ここは写すだけ。読めなければ undefined
   * （読めなかったことが観測全体を落とすことはない）。
   */
  streak?: Record<string, unknown>;
  /** streak が読めなかった理由。 */
  streakReason?: string;
}

/** jsonb の数値は number でも文字列でも来うる。読めなければ undefined。 */
function readCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * 突合を 1 回走らせ、その日の 1 行として残して結果を返す。**決して throw しない。**
 *
 * 呼び出し側（日次 tick）は結果を 1 行の JSON ログに落とすだけでよい。
 * 5 営業日の判定は保存された表を cdp_stage2_parity_streak() で読む。
 */
export async function runStage2Parity(env: Env): Promise<Stage2ParityResult> {
  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return { ok: false, reason: "supabase_not_configured" };
    }
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    // 1. 保存まで済ませる関数を呼ぶ（048）。
    //    **観測日は引数に取らない** — 渡せてしまうと過去の日を今日の観測で
    //    埋められる。同じ日に 2 回呼んでも SQL 側の ON CONFLICT で 1 行のまま。
    const snapshot = await supabase.rpc(PARITY_SNAPSHOT_RPC);
    if (!snapshot.error) {
      const result = readResult(snapshot.data, { persisted: true });
      // 2'. 「あと何日で 5 営業日か」まで 1 行に載せる（読み取り専用・非致命）。
      //     ここが落ちても観測（保存済み）は成立しているので、結果は返す。
      const streak = await supabase.rpc(PARITY_STREAK_RPC);
      if (streak.error) {
        return { ...result, streakReason: `streak_rpc_failed:${streak.error.message}` };
      }
      if (!streak.data || typeof streak.data !== "object") {
        return { ...result, streakReason: "streak_shape_unexpected" };
      }
      return { ...result, streak: streak.data as Record<string, unknown> };
    }

    // 2. 保存の関数が無い / 落ちた。**観測は止めない**（止めるほうが損）。
    //    048 未適用の環境はここに来る。理由を必ず残す。
    const persistReason = `snapshot_rpc_failed:${snapshot.error.message}`;
    const parity = await supabase.rpc(PARITY_RPC);
    if (parity.error) {
      // migration 043 未適用の環境もここに来る（関数が無い）。観測が始まっていない
      // ことと、観測して一致していることは違うので、必ず理由を残す。
      return { ok: false, reason: `rpc_failed:${parity.error.message}`, persisted: false, persistReason };
    }
    return readResult(parity.data, { persisted: false, persistReason });
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** RPC の戻り（jsonb）を結果の形に読む。**壊れた形を中途半端に読まない**。 */
function readResult(
  data: unknown,
  persistence: { persisted: boolean; persistReason?: string },
): Stage2ParityResult {
  if (!data || typeof data !== "object") {
    return { ok: false, reason: "rpc_shape_unexpected", ...persistence };
  }

  const metrics = data as Record<string, unknown>;
  const inAgreement = metrics.in_agreement === true;
  const comparedCount = readCount(metrics.compared_count);
  const mismatchCount = readCount(metrics.mismatch_count);

  // 定義の正本は SQL の生成列。ここは読んだうえで分母をもう一度確かめる
  // （fail-closed の絞り込み。赤を緑にすることはできない）。
  const green =
    persistence.persisted &&
    metrics.is_green === true &&
    inAgreement &&
    comparedCount !== undefined &&
    comparedCount > 0;

  return {
    ok: true,
    metrics,
    inAgreement,
    green,
    ...(comparedCount !== undefined ? { comparedCount } : {}),
    ...(mismatchCount !== undefined ? { mismatchCount } : {}),
    ...(typeof metrics.snapshot_date === "string" ? { snapshotDate: metrics.snapshot_date } : {}),
    ...persistence,
  };
}
