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
 * ─ 並行して呼ばれたときに何が起きるか ─
 *   同じ鍵で同時に 2 つ走ると、両方が「無い」と見てから両方が発行しにいく。
 *   edge の UNIQUE は (kind, value) の 2 列なので、**必ず片方だけが入る**。
 *   もう片方は引き直して勝者に合流するので、返る subject_id は 1 つに収束し、
 *   identity_edges は 1 行のままになる。
 *
 * ─ 負けた側が発行した subjects の行は残る ─
 *   edge を持たない 26 文字が 1 行残るだけで、どの鍵からも辿れず、本人に
 *   結びつく情報も持たない（E4 により消せもしない ＝ 消す必要も無い）。
 *   1 鍵 = 1 主体は edge 側の UNIQUE が保つので、この残骸はその不変条件を破らない。
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

  // 発行。ここが「同じ鍵に同時に 2 リクエストが来た」ときの分岐点になる。
  //
  // 収束の根拠は **index の列構成** にある: identity_edges_uniq は
  // (identifier_kind, identifier_value) の 2 列（migration 040）。subject_id を
  // 含まないので、後から来たほうは必ず衝突する。3 列だった初版では衝突せず、
  // 「同じ鍵を指す主体が 2 つ」が黙って成立していた（QA 指摘 MID-1）。
  //
  // 衝突したときに例外を投げさせない（= on_conflict do nothing にする）のは、
  // 「負けた」ことは異常ではなく **合流すべき正常な結果** だから。負けた側は
  // 下の引き直しで勝ったほうの subject_id を受け取る。
  //
  // ⚠ ignoreDuplicates: true（= ON CONFLICT DO NOTHING）から外さないこと。
  //   DO UPDATE は既存行の UPDATE なので、E4 の追記専用トリガに掛かって落ちる。
  const subjectId = newSubjectId();
  const { error: subjectError } = await supabase
    .from(SUBJECTS_TABLE)
    .insert({ subject_id: subjectId });
  if (subjectError) {
    return { subjectId: null, issued: false, reason: "subject_insert_failed" };
  }

  const { error: edgeError } = await supabase.from(IDENTITY_EDGES_TABLE).upsert(
    {
      subject_id: subjectId,
      identifier_kind: identifier.kind,
      identifier_value: value,
      observed_by: observedBy,
    },
    { onConflict: "identifier_kind,identifier_value", ignoreDuplicates: true },
  );
  if (edgeError) {
    // DO NOTHING でも拾えない失敗（接続断など）。引き直して、あるならそれを使う。
    const retry = await lookupEdge(supabase, identifier.kind, value);
    if (retry.subjectId) return { subjectId: retry.subjectId, issued: false };
    return { subjectId: null, issued: false, reason: "edge_insert_failed" };
  }

  // DO NOTHING は「入ったのか、既にあったのか」を返さない。**必ず引き直して**
  // 勝者を確定させる。ここを省くと、負けたリクエストが自分の subject_id を
  // 返してしまい、同じ人に 2 つの主体で出来事が積まれる。
  const settled = await lookupEdge(supabase, identifier.kind, value);
  if (settled.subjectId) {
    // 自分が入れたものと一致していれば発行者は自分。違えば合流した側。
    return { subjectId: settled.subjectId, issued: settled.subjectId === subjectId };
  }
  return { subjectId: null, issued: false, reason: "edge_insert_failed" };
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
