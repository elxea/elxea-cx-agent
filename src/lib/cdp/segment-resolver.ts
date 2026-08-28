/**
 * @layer CDP
 *
 * セグメント配信の宛先を L1 から出す（CDP 統合 Stage 4 / 設計 §6-1 Stage 4 / §6-2 T-11）。
 *
 * ─ いま何が起きているか（T-11）─
 *
 *   delivery-runtime.ts は宛先を出すのに **全件スキャンを 3 本**回している:
 *     (1) Supabase customer_linkages を全件
 *     (2) Firestore users の persona EQUAL クエリ（cursor ページング）
 *     (3) Firestore lineUsers の persona EQUAL クエリ（cursor ページング・未連携用）
 *   3 本あるのは「同じ人の記録が 3 つの棚に分かれている」からで、棚が分かれている
 *   かぎり (a) 人が増えるほど遅くなり (b) 除外条件を足す場所が無く
 *   (c) 「なぜこの人が対象なのか」を後から言えない。
 *
 * ─ ここが何をするか ─
 *
 *   L1（subject_segment_state × delivery_identity）に対する **SQL 1 本**で同じ集合を出す。
 *   判定は SQL 側（migration 046 の cdp_segment_line_targets）にあり、ここは呼ぶだけ。
 *   判定条件を 2 か所に書かない。
 *
 * ─ Stage 4 は「並走」であって「切替」ではない ─
 *
 *   設計 §6-1 Stage 4 の完了条件は「配信対象が新旧で一致」。一致を **観測してから**
 *   切り替える。よって既定は shadow（旧が決め、新は数えるだけ）。旧 3 本の撤去は
 *   Stage 5（T-11）。モードは env CDP_SEGMENT_MODE:
 *
 *     off    … 新 resolver を呼ばない（旧のみ。何かおかしいときの逃げ道）
 *     shadow … 旧が決める。新も引いて食い違いを 1 行ログに残す（**既定**）
 *     cdp    … 新が決める。新が引けなかったら **送らない**（fail-closed。旧に黙って
 *              落ちると「切り替えたつもりで旧のまま」が起きる）
 *
 * ─ PII ─
 *   生の LINE userId はログに出さない（食い違いは **件数だけ**を出す）。宛先そのものは
 *   配信経路が使うだけで、可観測性のために外へ出す理由が無い。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** 新 resolver の結果。**決して throw しない**（呼び出し側が fail-closed を選ぶ）。 */
export type CdpSegmentResult =
  | {
      ok: true;
      userIds: string[];
      /** 上限に当たって全部は返していない（黙って削らない）。 */
      truncated: boolean;
      /** なぜ減ったかの内訳（件数のみ・PII なし）。 */
      excluded: Record<string, number>;
    }
  | { ok: false; reason: string };

/** 宛先解決のモード。既定は shadow（旧が決め、新は数えるだけ）。 */
export type SegmentMode = "off" | "shadow" | "cdp";

/**
 * env から宛先解決のモードを読む。
 *
 * 未設定・未知の値は **shadow**（既定）に倒す。off に倒さないのは、観測が始まらない
 * ことと観測して一致していることが区別できなくなるため（shadow は読み取りだけなので
 * 配信の挙動を変えない）。
 */
export function resolveSegmentMode(raw: string | null | undefined): SegmentMode {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "off" || v === "cdp") return v;
  return "shadow";
}

/** L1 から 1 つの好みタイプの宛先を引く。 */
export async function resolveCdpSegmentTargets(
  supabase: SupabaseClient,
  persona: string,
  limit = 5000,
): Promise<CdpSegmentResult> {
  try {
    const { data, error } = await supabase.rpc("cdp_segment_line_targets", {
      p_persona: persona,
      p_limit: limit,
    });
    if (error) {
      // migration 046 未適用（関数が無い）もここに来る。**理由を必ず残す**（T-12）。
      return { ok: false, reason: `rpc_failed:${error.message}` };
    }
    if (!data || typeof data !== "object") {
      return { ok: false, reason: "rpc_shape_unexpected" };
    }
    const row = data as Record<string, unknown>;
    const ids = Array.isArray(row.user_ids)
      ? row.user_ids.filter((v): v is string => typeof v === "string" && v.length > 0)
      : null;
    if (ids === null) return { ok: false, reason: "rpc_shape_unexpected" };

    return {
      ok: true,
      userIds: ids,
      truncated: row.truncated === true,
      excluded: readCounts(row.excluded),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function readCounts(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 新旧の突合（純粋）
// ---------------------------------------------------------------------------

/** 新旧の食い違い。**件数と、旧にしか居ない / 新にしか居ないの数だけ**を持つ。 */
export interface SegmentAgreement {
  legacyCount: number;
  cdpCount: number;
  /** 旧にだけ居た人数（新 resolver が取りこぼしている疑い）。 */
  legacyOnly: number;
  /** 新にだけ居た人数（旧が取りこぼしていた分・または新の過剰）。 */
  cdpOnly: number;
  both: number;
  /** 完全一致した（Stage 4 の完了条件はこれが全ペルソナで true）。 */
  inAgreement: boolean;
}

/**
 * 2 つの宛先集合を比べる（純粋・順序と重複を無視した集合比較）。
 *
 * ⚠ 返り値に **宛先そのものを入れない**。食い違いの調査には件数と、必要なら
 *   staging での再現で足りる。ログや Notion に生 LINE userId を出す理由は無い（E5）。
 */
export function compareTargets(legacy: string[], cdp: string[]): SegmentAgreement {
  const l = new Set(legacy.filter((s) => typeof s === "string" && s.length > 0));
  const c = new Set(cdp.filter((s) => typeof s === "string" && s.length > 0));
  let both = 0;
  for (const id of l) if (c.has(id)) both += 1;
  const legacyOnly = l.size - both;
  const cdpOnly = c.size - both;
  return {
    legacyCount: l.size,
    cdpCount: c.size,
    legacyOnly,
    cdpOnly,
    both,
    inAgreement: legacyOnly === 0 && cdpOnly === 0,
  };
}
