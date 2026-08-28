/**
 * @layer CDP
 *
 * L1（subject_profile）の読み口 — 解釈を 1 冊から読む（CDP 統合 Stage 4 / 設計 §3-2）。
 *
 * ─ ここが何をするか ─
 *
 *   L1 は「L0 を畳んだ解釈」で、畳み方の正本は migration 046 の cdp_l1_build_profile に
 *   ある。TypeScript 側は **読むだけ**で、畳み方を持たない（持つと 2 か所になり、
 *   片方だけ直した日に「一致していない」のか「直した」のか区別できなくなる）。
 *
 * ─ 読み手（Stage 4 時点）─
 *
 *   * roji 月次割当（scripts/roji-monthly-run.ts）… 除外条件（「もういらない」・安全申告）
 *   * 日次の突合（stage4-parity.ts）… 再計算一致の観測
 *   * 配信の宛先解決は L1 を **直接は読まない**（SQL 1 本 = cdp_segment_line_targets が
 *     セグメントと宛先を同時に解くため。segment-resolver.ts）
 *
 * ─ フォールバック ─
 *   046 未適用・RPC 失敗は必ず `ok:false` + 理由で戻る（**決して throw しない**）。
 *   呼び出し側は「除外条件が読めなかった」を **無視せず**扱えるようにする
 *   （割当は読めなかったら止める。黙って除外なしで配る、をやらせない）。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** ハード制約（点数では絶対に覆らないもの）。 */
export interface SubjectExclusions {
  /** 「もういらない」お茶の銘柄番号（項目13 noneOf の L1 版）。 */
  teaRefs: string[];
  /** 安全に関する申告のタグ（項目6）。**減らす方向に畳まれない**。 */
  safetyTags: string[];
  /** 配信を止める申告が出ている。 */
  broadcastSuppressed: boolean;
}

export const EMPTY_EXCLUSIONS: SubjectExclusions = {
  teaRefs: [],
  safetyTags: [],
  broadcastSuppressed: false,
};

/** jsonb の exclusions を型に読む（欠け・壊れは空に倒す。**部分的に読まない**）。 */
export function readExclusions(value: unknown): SubjectExclusions {
  if (!value || typeof value !== "object") return { ...EMPTY_EXCLUSIONS };
  const row = value as Record<string, unknown>;
  return {
    teaRefs: strings(row.tea_refs),
    safetyTags: strings(row.safety_tags),
    broadcastSuppressed: row.broadcast_suppressed === true,
  };
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export type ExclusionsByShopifyResult =
  | { ok: true; byShopifyCustomerId: Map<string, SubjectExclusions> }
  | { ok: false; reason: string };

/**
 * Shopify 顧客番号の一覧に対する除外条件をまとめて引く（割当用）。
 *
 * 引ける人だけが Map に入る（L1 がまだ無い人は入らない ＝ 除外なし）。
 * **決して throw しない。**
 */
export async function loadExclusionsByShopifyIds(
  supabase: SupabaseClient,
  shopifyCustomerIds: string[],
): Promise<ExclusionsByShopifyResult> {
  const ids = Array.from(
    new Set(
      (shopifyCustomerIds ?? [])
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter((v) => v.length > 0),
    ),
  );
  if (ids.length === 0) return { ok: true, byShopifyCustomerId: new Map() };

  try {
    const { data, error } = await supabase.rpc("cdp_l1_exclusions_by_shopify", {
      p_shopify_customer_ids: ids,
    });
    if (error) return { ok: false, reason: `rpc_failed:${error.message}` };
    if (!data || typeof data !== "object") return { ok: false, reason: "rpc_shape_unexpected" };

    const out = new Map<string, SubjectExclusions>();
    for (const [shopifyId, raw] of Object.entries(data as Record<string, unknown>)) {
      out.set(shopifyId, readExclusions(raw));
    }
    return { ok: true, byShopifyCustomerId: out };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 「もういらない」を 1 つの集合に畳む（純粋）。
 *
 * カルテ（Firestore teaRequests.noneOf）と L1（subject_profile.exclusions.tea_refs）の
 * **和**を採る。片方にしか無い申告を落とさないため（Stage 4 は並走なので、書き手が
 * 両側に居る期間がある）。除外は「消す方向に畳まない」が原則で、和はその原則そのもの。
 */
export function unionNoneOf(
  karteNoneOf: readonly string[] | null | undefined,
  l1TeaRefs: readonly string[] | null | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of [karteNoneOf ?? [], l1TeaRefs ?? []]) {
    for (const raw of src) {
      const v = typeof raw === "string" ? raw.trim() : "";
      if (v.length === 0 || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
