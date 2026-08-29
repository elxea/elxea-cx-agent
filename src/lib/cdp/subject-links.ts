/**
 * @layer CDP
 *
 * 連携を「追記 1 行」にする（CDP 統合 Stage 2 / 設計 §3-1 / §6-1 Stage 2）。
 *
 * ─ 何をするか ─
 *   「この LINE の人と、この Shopify 顧客は同じ人だ」と分かった瞬間に、
 *   subject_links に **1 行足すだけ**。既存の統合処理（棚から棚へ荷物を移す形）は
 *   Stage 2 では残置し、これは並走で足す（撤去は Stage 5 / T-3・T-4・T-5）。
 *
 * ─ Stage 2 の並走で守ること ─
 *   (1) 既存の応答を 1 つも変えない
 *       link の追記は **決して throw しない**。失敗しても連携そのものは既に成立して
 *       いるので、HTTP 応答も LINE への返信も変えない。
 *   (2) 無言で捨てない（T-12）
 *       足せなかったら必ず理由（LinkSkipReason）を返し、呼び出し側が 1 行ログに出す。
 *   (3) J-4 を破らない
 *       1 Shopify 顧客に複数の LINE を束縛しない。DB 側のトリガ
 *       （cdp_subject_links_j4_guard・migration 043）が最終の歯で、ここは
 *       「落ちたことを j4_conflict という名前で言い直す」層。
 *
 * ─ SEC-1 ─
 *   basis に email_equality は無い（型にも DB の CHECK にも）。メール等値で人を
 *   結ぶ経路はここにも作らない。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveOrIssueSubject, type ObservedIdentifier } from "./subjects";

export const SUBJECT_LINKS_TABLE = "subject_links";

/**
 * 「なぜ同じ人だと判定したか」。**migration 043 → 047 の CHECK と 1 対 1**。
 *
 * ⚠ `email_equality` はここに無い（SEC-1）。足すことは「メールが同じなら同じ人と
 *   みなしてよい」という決定であり、identity.ts の [SEC-1] が実例を書いている
 *   乗っ取り経路をそのまま開くことを意味する。
 */
export const LINK_BASES = [
  /** LIFF: LINE 署名済み id_token の sub × サーバ認証済み Shopify セッション。 */
  "liff_id_token",
  /** LINE 純正 Account Link: single-use nonce を消費できた側だけが自社ユーザーを確定する。 */
  "line_account_link",
  /** 匿名 web セッションの昇格: 認証済みの本人が「このセッションは自分だ」と申告した経路。 */
  "anonymous_promotion",
  /**
   * Stage 2 より前に旧台帳 customer_linkages（039 で SoT と確定）で成立していた連携の
   * 写し取り（migration 047）。**「前の正本がそう言っている」以上の根拠を主張しない。**
   *
   * ⚠ ランタイムの route はこの値を使わない。書き手は
   *   `scripts/cdp-stage2-backfill.ts` の 1 本だけ（`BACKFILL_ONLY_BASES` が
   *   その約束を型と実行時の両方で持つ）。既存の liff_id_token / line_account_link に
   *   混ぜないのは、後から「この人はどう結ばれたのか」を監査する読み手を誤らせないため。
   */
  "legacy_ledger_backfill",
] as const;

export type LinkBasis = (typeof LINK_BASES)[number];

/**
 * ランタイムの連携経路が使ってはいけない basis。
 *
 * 写し取り専用の語彙を route が使い始めると、「新しく検証した」と「昔そう記録されて
 * いた」の区別が消える。型では防げない（どちらも `LinkBasis`）ので、名前で 1 か所に
 * 集めて、テスト（tests/unit/cdp-subject-links.test.ts）がランタイム経路の
 * 呼び出しを機械的に固定する。
 */
export const BACKFILL_ONLY_BASES: ReadonlySet<LinkBasis> = new Set<LinkBasis>([
  "legacy_ledger_backfill",
]);

/** link を足せなかった理由。**理由なしで戻る枝を作らない**（T-12）。 */
export type LinkSkipReason =
  /** どちらかの主体を出せなかった（発行にも失敗した）。 */
  | `subject_unavailable:${string}`
  /** 既に同じ主体だった（＝ 1 人として解決済み）。足すものが無い。 */
  | "same_subject"
  /** J-4: 1 Shopify 顧客に 2 本目の LINE を束縛しようとした。 */
  | "j4_conflict"
  /** 消去済みの主体を結ぼうとした。 */
  | "retired_subject"
  /** それ以外の書き込み失敗。 */
  | "insert_failed";

export type LinkAppendResult =
  | {
      ok: true;
      /** この呼び出しで実際に 1 行入ったか（false = 同じ判断が既にあった）。 */
      appended: boolean;
      /** 正規化後の 2 主体（subjectA < subjectB）。 */
      subjectA: string;
      subjectB: string;
      /**
       * `input.left` / `input.right` に対応する主体。
       *
       * subjectA / subjectB は並べ替え済みなので「どちらが LINE 側か」を呼び出し側が
       * 言えない。派生（delivery_identity）は LINE 側の主体に紐づくので、**引き直さずに
       * そのまま使えるよう**ここで返す（同じ鍵を 2 回解決する往復を減らす）。
       */
      leftSubjectId: string;
      rightSubjectId: string;
    }
  | { ok: false; reason: LinkSkipReason; detail?: string };

export interface AppendSubjectLinkInput {
  /** 片方の鍵（例: LINE トーク userId）。 */
  left: ObservedIdentifier;
  /** もう片方の鍵（例: Shopify 顧客番号）。 */
  right: ObservedIdentifier;
  basis: LinkBasis;
  /** どの経路が判定したか（slug）。edges の observed_by と同じ規約。 */
  observedBy: string;
}

/**
 * 「同じ人だ」を 1 行足す。**決して throw しない。**
 *
 * 主体が未発行なら発行する（resolveOrIssueSubject）。Stage 1 の gateway をまだ
 * 通っていない人でも、連携の瞬間に主体が立つ ＝ 連携済みの人が必ず解決できる。
 */
export async function appendSubjectLink(
  supabase: SupabaseClient,
  input: AppendSubjectLinkInput,
): Promise<LinkAppendResult> {
  try {
    const left = await resolveOrIssueSubject(supabase, input.left, input.observedBy);
    if (left.subjectId === null) {
      return { ok: false, reason: `subject_unavailable:${left.reason}` };
    }
    const right = await resolveOrIssueSubject(supabase, input.right, input.observedBy);
    if (right.subjectId === null) {
      return { ok: false, reason: `subject_unavailable:${right.reason}` };
    }

    if (left.subjectId === right.subjectId) {
      // 既に 1 人として解決されている（同じ鍵が両側に来た等）。足すものが無い。
      return { ok: false, reason: "same_subject" };
    }

    const [subjectA, subjectB] = orderPair(left.subjectId, right.subjectId);

    // ⚠ ignoreDuplicates: true（= ON CONFLICT DO NOTHING）から外さないこと。
    //   DO UPDATE は既存行の UPDATE なので E4 の追記専用トリガに掛かって落ちる。
    const { error } = await supabase.from(SUBJECT_LINKS_TABLE).upsert(
      {
        subject_a: subjectA,
        subject_b: subjectB,
        basis: input.basis,
        observed_by: input.observedBy,
      },
      { onConflict: "subject_a,subject_b,basis", ignoreDuplicates: true },
    );

    if (error) {
      const reason = classifyLinkError(error);
      return { ok: false, reason, detail: error.message };
    }

    // DO NOTHING は「入ったのか、既にあったのか」を返さない。**引き直して確定させる。**
    // ここを省くと、突合（parity）が「足したはずなのに無い」を検知できない。
    const settled = await hasLink(supabase, subjectA, subjectB, input.basis);
    if (!settled.found) {
      return { ok: false, reason: "insert_failed", detail: settled.error ?? "not_visible_after_insert" };
    }

    return {
      ok: true,
      appended: settled.found,
      subjectA,
      subjectB,
      leftSubjectId: left.subjectId,
      rightSubjectId: right.subjectId,
    };
  } catch (err) {
    // 連携そのものは既に成立している。ここで投げると応答を壊すので、必ず握る。
    return {
      ok: false,
      reason: "insert_failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 無向辺を 1 行に正規化する（DB の subject_links_ordered CHECK と同じ規則）。 */
export function orderPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

/**
 * DB が返した失敗を、呼び出し側が数えられる名前に読み替える。
 *
 * J-4 のトリガは SQLSTATE 23514（check_violation）で 'J-4 violation' を名乗る。
 * basis のホワイトリスト違反も 23514 なので、メッセージで区別する
 * （どちらも「型で拒否された」だが、意味が違うものを同じ名前で数えない）。
 */
export function classifyLinkError(error: { code?: string; message?: string }): LinkSkipReason {
  const message = error.message ?? "";
  if (message.includes("J-4 violation")) return "j4_conflict";
  if (message.includes("retired subject")) return "retired_subject";
  return "insert_failed";
}

async function hasLink(
  supabase: SupabaseClient,
  subjectA: string,
  subjectB: string,
  basis: LinkBasis,
): Promise<{ found: boolean; error?: string }> {
  const { data, error } = await supabase
    .from(SUBJECT_LINKS_TABLE)
    .select("link_seq")
    .eq("subject_a", subjectA)
    .eq("subject_b", subjectB)
    .eq("basis", basis)
    .limit(1);
  if (error) return { found: false, error: error.message };
  return { found: (data ?? []).length > 0 };
}

/**
 * link の追記を 1 行ログにする。**成功も失敗も同じ形で残す**（数えられるように）。
 *
 * 生の識別子は出さない（E5）。出るのは主体 ID（不透明な 26 文字）と理由だけ。
 */
export function logLinkAppend(route: string, basis: LinkBasis, result: LinkAppendResult): void {
  if (result.ok) {
    console.log(
      "[cdp/link] appended:",
      JSON.stringify({
        route,
        basis,
        appended: result.appended,
        subject_a: result.subjectA,
        subject_b: result.subjectB,
      }),
    );
    return;
  }
  // same_subject は異常ではない（既に 1 人）。それ以外は連携済みなのに link が
  // 立っていない状態なので、日次の突合（cdp_stage2_parity）が拾う。
  const level = result.reason === "same_subject" ? console.log : console.warn;
  level(
    "[cdp/link] not appended:",
    JSON.stringify({ route, basis, reason: result.reason, detail: result.detail }),
  );
}
