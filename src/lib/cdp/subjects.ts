/**
 * @layer CDP
 *
 * 主体の発行と解決（CDP 統合 Stage 1 / 設計 §3-1）。
 *
 * ─ 何をするか ─
 *   「この鍵（LINE userId / 顧客番号 / Web の匿名 ID）で観測された主体は誰か」を
 *   identity_edges に 1 段引き、無ければ **その場で発行して edge を 1 行足す**。
 *   既存行の書き換えは一切しない（E4）。
 *
 * ─ Stage 1 の範囲（ここで止める理由）─
 *   1 つの鍵 = 1 つの主体まで。「この LINE とこの顧客は同じ人だ」という **判断** は
 *   subject_links（Stage 2）が持つ。連携済みの人が一時的に 2 つの主体を持つのは
 *   想定どおりで、Stage 2 の canonical 解決がそれを 1 人として読む。
 *   消去はこの段でも取りこぼさない — 042 の解決が customer_linkages を経由して
 *   両方の鍵に届き、そこから両方の主体に届く。
 *
 * ─ SEC-1 ─
 *   email_hash では解決しない。RESOLVABLE_IDENTIFIER_KINDS に入っていない鍵で
 *   呼ばれたら、発行もせずに理由付きで戻る。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { newSubjectId, isSubjectId } from "./ulid";
import { RESOLVABLE_IDENTIFIER_KINDS, type IdentifierKind } from "./event-vocabulary";

export const SUBJECTS_TABLE = "subjects";
export const IDENTITY_EDGES_TABLE = "identity_edges";

/** 観測された鍵。value は生の値だが、**行に残るのは identity_edges だけ**（E5）。 */
export interface ObservedIdentifier {
  kind: IdentifierKind;
  value: string;
}

export type SubjectResolution =
  | { subjectId: string; issued: boolean }
  | { subjectId: null; issued: false; reason: SubjectSkipReason };

/** 主体を出せなかった理由。**無言で戻らない**ための語彙（T-12）。 */
export type SubjectSkipReason =
  | "identifier_value_empty"
  | "identifier_kind_not_resolvable"
  | "edge_lookup_failed"
  | "subject_insert_failed"
  | "edge_insert_failed";

/**
 * 鍵から主体を引き、無ければ発行する。
 *
 * @param observedBy どの経路が観測したか（slug）。edge に残る。
 */
export async function resolveOrIssueSubject(
  supabase: SupabaseClient,
  identifier: ObservedIdentifier,
  observedBy: string,
): Promise<SubjectResolution> {
  const value = typeof identifier.value === "string" ? identifier.value.trim() : "";
  if (value === "") {
    return { subjectId: null, issued: false, reason: "identifier_value_empty" };
  }
  if (!RESOLVABLE_IDENTIFIER_KINDS.has(identifier.kind)) {
    // SEC-1: email_hash 等は「観測として残せる」が「人を結ぶ根拠にはしない」。
    return { subjectId: null, issued: false, reason: "identifier_kind_not_resolvable" };
  }

  const existing = await lookupEdge(supabase, identifier.kind, value);
  if (existing.error) {
    return { subjectId: null, issued: false, reason: "edge_lookup_failed" };
  }
  if (existing.subjectId) {
    return { subjectId: existing.subjectId, issued: false };
  }

  // 発行。ULID なので衝突は実質起きないが、同時に 2 リクエストが来ると
  // edge の UNIQUE で片方が落ちる。落ちたほうは引き直す（勝ったほうに合流する）。
  const subjectId = newSubjectId();
  const { error: subjectError } = await supabase
    .from(SUBJECTS_TABLE)
    .insert({ subject_id: subjectId });
  if (subjectError) {
    return { subjectId: null, issued: false, reason: "subject_insert_failed" };
  }

  const { error: edgeError } = await supabase.from(IDENTITY_EDGES_TABLE).insert({
    subject_id: subjectId,
    identifier_kind: identifier.kind,
    identifier_value: value,
    observed_by: observedBy,
  });
  if (edgeError) {
    // 競合で負けた可能性。引き直して、あるならそれを使う。
    const retry = await lookupEdge(supabase, identifier.kind, value);
    if (retry.subjectId) return { subjectId: retry.subjectId, issued: false };
    return { subjectId: null, issued: false, reason: "edge_insert_failed" };
  }

  return { subjectId, issued: true };
}

async function lookupEdge(
  supabase: SupabaseClient,
  kind: IdentifierKind,
  value: string,
): Promise<{ subjectId: string | null; error: boolean }> {
  const { data, error } = await supabase
    .from(IDENTITY_EDGES_TABLE)
    .select("subject_id")
    .eq("identifier_kind", kind)
    .eq("identifier_value", value)
    .limit(1);

  if (error) {
    console.warn("[cdp/subjects] edge lookup failed:", error.message);
    return { subjectId: null, error: true };
  }
  const row = (data ?? [])[0] as { subject_id?: unknown } | undefined;
  const candidate = typeof row?.subject_id === "string" ? row.subject_id : null;
  return { subjectId: isSubjectId(candidate) ? candidate : null, error: false };
}
