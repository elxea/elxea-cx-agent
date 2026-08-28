/**
 * @layer CDP
 *
 * Stage 4 の日次観測 — 「解釈は元とずれていないか」「配信対象は新旧で一致しているか」
 * （CDP 統合 Stage 4 / 設計 §5 E8' / §6-1 Stage 4 の完了条件）。
 *
 * ─ なぜ要るか ─
 *
 *   Stage 4 の完了条件は 2 つとも **観測でしか言えない**:
 *     (1) E8' … L1 は L0 から再計算したものと一致するか（作り置きが元とずれていないか）
 *     (2) 配信対象が新旧で一致するか（旧 3 本の全件スキャン ↔ 新 SQL 1 本）
 *   観測は人がやるものではなく **毎日勝手に残る形**でないと 5 営業日は埋まらない
 *   （Stage 2 の stage2-parity.ts と同じ考え方・同じ置き場に相乗りする）。
 *
 * ─ 何をしないか（範囲を狭く保つ）─
 *
 *   - 直さない。食い違いを見つけても宛先を寄せたりしない。
 *   - 新しい cron を作らない。既存の日次 tick（wrangler.toml の "0 18 * * *"）に
 *     相乗りする（src/index.ts の runDailySync）。Cloudflare の cron は 5 本上限で
 *     使い切っている。
 *   - 外部に何も送らない。
 *   - **旧 resolver をここに書き写さない**。旧の 3 本は delivery-runtime.ts にしかなく、
 *     ここに写すと「全件スキャンの口」が 1 つ増える（T-11 を増やす方向になる）。
 *     よって新旧比較は呼び出し側から注入する（compareSegments）。
 *
 * ─ 畳み直しも 1 回だけここでやる ─
 *   L1 は L0 の派生なので、誰かが畳み直さないと古いままになる。日次の観測の直前に
 *   cdp_l1_recompute_all を 1 回呼ぶ（上限付き・畳み残しは件数で返る）。
 *   ⚠ 畳み直し → 観測の順にするのは、「古いまま放置していたこと」を「一致していない」
 *     と読み違えないため。逆順にすると毎日必ず不一致になる。
 */

import { createClient } from "@supabase/supabase-js";
import type { Env } from "../../index";
import type { SegmentAgreement } from "./segment-resolver";

/** 1 回分の観測結果。ログに 1 行落とすだけで足りる形にする。 */
export interface Stage4ParityResult {
  ok: boolean;
  /** ok=false の理由（未設定・046 未適用・RPC 失敗など）。 */
  reason?: string;
  /** 畳み直しの結果（recomputed / still_pending / delivery_identity）。 */
  recompute?: Record<string, unknown>;
  /** E8'（L1 再計算一致）の観測値。 */
  l1?: Record<string, unknown>;
  /** 配信対象の新旧一致（ペルソナ別）。注入されなければ undefined。 */
  segments?: Record<string, SegmentAgreement>;
  /** その日「一致していた」と言えるか（下の 2 条件がともに真）。 */
  inAgreement?: boolean;
}

export interface Stage4ParityDeps {
  /**
   * 配信対象の新旧比較（ペルソナ別）。旧 resolver を持っている側
   * （delivery-runtime.ts）から注入する。**決して throw しない**実装を渡すこと。
   */
  compareSegments?: () => Promise<Record<string, SegmentAgreement>>;
  /** 1 回の畳み直しの上限（既定 500）。 */
  recomputeLimit?: number;
  /** 1 回の再計算一致の検査件数（既定 200）。 */
  parityLimit?: number;
}

/**
 * 観測を 1 回走らせて結果を返す。**決して throw しない。**
 */
export async function runStage4Parity(
  env: Env,
  deps: Stage4ParityDeps = {},
): Promise<Stage4ParityResult> {
  try {
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      return { ok: false, reason: "supabase_not_configured" };
    }
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

    // 1. 畳み直し（観測の前に。古いまま放置していたことを不一致と読み違えない）。
    const recomputed = await supabase.rpc("cdp_l1_recompute_all", {
      p_limit: deps.recomputeLimit ?? 500,
    });
    if (recomputed.error) {
      // migration 046 未適用の環境もここに来る。観測が始まっていないことと、
      // 観測して一致していることは違うので、必ず理由を残す。
      return { ok: false, reason: `recompute_failed:${recomputed.error.message}` };
    }

    // 2. E8'（L1 再計算一致）。
    const parity = await supabase.rpc("cdp_l1_recompute_parity", {
      p_limit: deps.parityLimit ?? 200,
    });
    if (parity.error) {
      return { ok: false, reason: `parity_failed:${parity.error.message}` };
    }
    const l1 = (parity.data ?? {}) as Record<string, unknown>;

    // 3. 配信対象の新旧一致（注入された側が旧 resolver を持っている）。
    let segments: Record<string, SegmentAgreement> | undefined;
    if (deps.compareSegments) {
      try {
        segments = await deps.compareSegments();
      } catch (err) {
        // 比較が落ちても観測全体は落とさない（E8' の側は取れているため）。
        console.warn(
          "[cdp/stage4-parity] segment compare failed (non-blocking):",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return {
      ok: true,
      recompute: (recomputed.data ?? {}) as Record<string, unknown>,
      l1,
      ...(segments ? { segments } : {}),
      inAgreement: judgeAgreement(l1, segments),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * その日を「一致した 1 日」と言えるか（純粋）。
 *
 * ─ 空虚合格を作らない ─
 *   比較を 1 本もしていない日は false。「観測していない」を「一致していた」と
 *   書き残すと、5 営業日の数え上げが嘘になる（Stage 2 で同じ設計にした理由）。
 */
export function judgeAgreement(
  l1: Record<string, unknown> | undefined,
  segments: Record<string, SegmentAgreement> | undefined,
): boolean {
  if (!l1 || l1.in_agreement !== true) return false;
  if (!segments) return false;
  const entries = Object.values(segments);
  if (entries.length === 0) return false;
  return entries.every((s) => s.inAgreement);
}
