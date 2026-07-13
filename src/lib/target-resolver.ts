/**
 * 対象解決の汎用化（T4）。
 *
 * 設計: 「Notion駆動 LINE配信 設計確定版 v1.0」§7 / Must-fix 9
 *   - 全員(broadcast) パス: 受信者ID不要。見積 = 想定友だち数（無料枠ガード用）。
 *   - ペルソナ(multicast) パス: getSegmentedUsers を lib 化して再利用。
 *     opt-out / ブロック / 退会 / 未リンク を除外。500 超はページングで全件。
 *   - 対象人数を返す（承認画面の通数見積・台帳ガードに使う）。
 *
 * segment-broadcast.ts の getSegmentedUsers（module-private）を置き換える汎用版。
 * 純粋な結合・除外・分割ロジックと、実 I/O アダプタを分離してユニットテスト可能にする。
 */

import type { PersonaType } from "./firestore";
import type { AudienceSpec } from "./delivery-audience";
import { chunkForMulticast, MULTICAST_MAX_RECIPIENTS } from "./line-messages";

// ---------------------------------------------------------------------------
// 型
// ---------------------------------------------------------------------------

/** LINE 紐付け行（Supabase customer_linkages + 除外フラグ）。 */
export interface LinkageRow {
  shopifyCustomerId: string;
  lineUserId: string | null;
  /** 退会（unfollow）済みなら true（migration 020: unfollowed_at IS NOT NULL）。 */
  unfollowed: boolean;
  /** 配信 opt-out 済みなら true（migration 020: broadcast_opted_out）。 */
  optedOut: boolean;
}

/** Firestore のペルソナ行。 */
export interface PersonaRow {
  shopifyCustomerId: string;
  persona: PersonaType;
}

/** 除外前の候補（結合済み）。 */
export interface Candidate {
  lineUserId: string | null;
  persona: PersonaType | null;
  linked: boolean;
  unfollowed: boolean;
  optedOut: boolean;
}

/** 対象解決の結果。 */
export type ResolvedTargets =
  | { kind: "broadcast"; estimatedRecipients: number }
  | {
      kind: "multicast";
      userIds: string[];
      batches: string[][];
      estimatedRecipients: number;
    }
  | { kind: "error"; reason: string };

// ---------------------------------------------------------------------------
// 純粋ロジック（結合・除外・分割）— 完全にテスト可能
// ---------------------------------------------------------------------------

/**
 * linkage と persona を結合して候補配列を作る（純粋）。
 * persona 行を軸に、shopifyCustomerId で linkage を引く。
 */
export function joinCandidates(
  personaRows: PersonaRow[],
  linkages: LinkageRow[],
): Candidate[] {
  const linkageByShopify = new Map<string, LinkageRow>();
  for (const l of linkages) {
    linkageByShopify.set(l.shopifyCustomerId, l);
  }
  return personaRows.map((pr) => {
    const link = linkageByShopify.get(pr.shopifyCustomerId);
    return {
      lineUserId: link?.lineUserId ?? null,
      persona: pr.persona,
      linked: !!link && !!link.lineUserId,
      unfollowed: link?.unfollowed ?? false,
      optedOut: link?.optedOut ?? false,
    };
  });
}

/**
 * 配信可能な lineUserId を抽出する（純粋・除外ロジックの中核）。
 * 除外: 未リンク / lineUserId 空 / 退会 / opt-out / ペルソナ不一致。
 * 重複 lineUserId は 1 件に畳む（二重計上防止）。
 */
export function filterEligible(
  candidates: Candidate[],
  persona: PersonaType,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of candidates) {
    if (c.persona !== persona) continue;
    if (!c.linked) continue;
    if (!c.lineUserId) continue;
    if (c.unfollowed) continue;
    if (c.optedOut) continue;
    if (seen.has(c.lineUserId)) continue;
    seen.add(c.lineUserId);
    out.push(c.lineUserId);
  }
  return out;
}

/**
 * 全員配信の配信可能 lineUserId を抽出する（純粋・案A / P0-4 の中核）。
 *
 * 決定1（案A）: 全員一斉配信（broadcast API）は廃止し、登録リスト（customer_linkages）への
 *   multicast に統一する。broadcast API は受信者を絞れず opt-out を除外できないため、
 *   opt-out 者を確実に除外するにはアドレス可能な multicast に切り替える必要がある。
 *
 * 除外: lineUserId 空 / 退会（unfollow）/ opt-out。ペルソナは問わない（全ペルソナ横断）。
 *   重複 lineUserId は 1 件に畳む（同一 line_user_id に複数連携があっても二重送信しない）。
 *
 * 注（対象母集団の限界・要判断で報告）: 対象は customer_linkages に line_user_id を持つ行に限る。
 *   Shopify 連携も opt-out もしたことがない純粋な友だちは customer_linkages に行が無く、
 *   この集合には含まれない。broadcast の「全友だち」より狭い「登録リスト」である点は
 *   決定1（登録者リストへの multicast）と整合する。
 */
export function filterEligibleAll(linkages: LinkageRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of linkages) {
    if (!l.lineUserId) continue;
    if (l.unfollowed) continue;
    if (l.optedOut) continue;
    if (seen.has(l.lineUserId)) continue;
    seen.add(l.lineUserId);
    out.push(l.lineUserId);
  }
  return out;
}

/**
 * ページ取得関数を最後まで回して全件を集める（純粋なループ・ページング）。
 * fetchPage は cursor（初回 undefined）を受け、{ items, nextCursor } を返す。
 * nextCursor が undefined/null になるまで繰り返す。安全弁で最大 maxPages。
 */
export async function collectAllPages<T>(
  fetchPage: (
    cursor: string | undefined,
  ) => Promise<{ items: T[]; nextCursor?: string | null }>,
  maxPages = 100,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined = undefined;
  for (let i = 0; i < maxPages; i++) {
    const { items, nextCursor } = await fetchPage(cursor);
    all.push(...items);
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return all;
}

// ---------------------------------------------------------------------------
// I/O アダプタのポート（実装は runtime、テストは fake を注入）
// ---------------------------------------------------------------------------

/** 対象解決に必要な I/O。ユニットテストは fake を注入しネットワーク非接触にする。 */
export interface TargetResolverDeps {
  /** 全 LINE 紐付け行を取得（除外フラグ込み）。取得不能は throw（fail-closed）。 */
  loadLinkages(): Promise<LinkageRow[]>;
  /** persona.primary 設定済みユーザーをページングで全件取得。 */
  loadPersonaUsers(): Promise<PersonaRow[]>;
  /**
   * @deprecated 案A（決定1 / P0-4）で全員配信が multicast に統一されたため resolveTargets からは
   *   参照されなくなった（全員配信も loadLinkages ベース）。互換のため残置。
   */
  broadcastEstimate(): Promise<number | null>;
  /**
   * 社内 allowlist（LINE user ID 群）を供給する。SoT は env `LINE_INTERNAL_USER_IDS`。
   * 空/未設定は空配列を返し、resolveTargets 側で fail-closed（対象0 → 送信不可）にする。
   * PII をコードに書かないため、runtime のみが env を読んでここに注入する。
   */
  loadAllowlistUserIds(): Promise<string[]>;
}

/**
 * env のカンマ区切り文字列を LINE user ID 配列に変換する（純粋・PII 非保持）。
 * 空白トリム・空要素除去のみ。重複排除は resolveTargets が担う。
 */
export function parseAllowlist(raw: string | null | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * AudienceSpec を実対象へ解決する。
 * - all      → broadcast（見積のみ。null なら error＝ガードに載せられないため fail-closed）
 * - persona  → multicast（除外・重複排除・500 バッチ分割・件数）
 */
export async function resolveTargets(
  audience: AudienceSpec,
  deps: TargetResolverDeps,
): Promise<ResolvedTargets> {
  if (audience.kind === "all") {
    // 案A（決定1 / P0-4）: broadcast API 廃止。登録リスト（customer_linkages）への multicast に統一し、
    //   opt-out / 退会を確実に除外する（broadcast では除外できないため）。
    let linkages: LinkageRow[];
    try {
      linkages = await deps.loadLinkages();
    } catch (err) {
      return {
        kind: "error",
        reason: `全員配信の対象取得失敗: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const userIds = filterEligibleAll(linkages);
    if (userIds.length === 0) {
      return {
        kind: "error",
        reason: "配信可能な登録ユーザーが 0 件（退会/opt-out 除外後・fail-closed）",
      };
    }
    const batches = chunkForMulticast(userIds, MULTICAST_MAX_RECIPIENTS);
    return {
      kind: "multicast",
      userIds,
      batches,
      estimatedRecipients: userIds.length,
    };
  }

  if (audience.kind === "allowlist") {
    // 社内テスト配信: env 供給の LINE user ID にだけ multicast。
    // persona 結合も Firestore/Supabase も不要。除外(unfollow/opt-out)は通さないが
    // 重複排除は行う。空/未設定は fail-closed（対象0 → 送信不可）。
    let raw: string[];
    try {
      raw = await deps.loadAllowlistUserIds();
    } catch (err) {
      return {
        kind: "error",
        reason: `社内 allowlist 取得失敗: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const seen = new Set<string>();
    const userIds: string[] = [];
    for (const id of raw) {
      const t = typeof id === "string" ? id.trim() : "";
      if (t.length === 0 || seen.has(t)) continue;
      seen.add(t);
      userIds.push(t);
    }
    if (userIds.length === 0) {
      return {
        kind: "error",
        reason:
          "社内 allowlist が空/未設定（fail-closed。LINE_INTERNAL_USER_IDS を設定）",
      };
    }
    const batches = chunkForMulticast(userIds, MULTICAST_MAX_RECIPIENTS);
    return {
      kind: "multicast",
      userIds,
      batches,
      estimatedRecipients: userIds.length,
    };
  }

  // persona = multicast
  let linkages: LinkageRow[];
  let personaRows: PersonaRow[];
  try {
    [linkages, personaRows] = await Promise.all([
      deps.loadLinkages(),
      deps.loadPersonaUsers(),
    ]);
  } catch (err) {
    return {
      kind: "error",
      reason: `対象取得失敗: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const candidates = joinCandidates(personaRows, linkages);
  const userIds = filterEligible(candidates, audience.persona);
  if (userIds.length === 0) {
    return { kind: "error", reason: "対象ユーザーが 0 件（除外後）" };
  }
  const batches = chunkForMulticast(userIds, MULTICAST_MAX_RECIPIENTS);
  return {
    kind: "multicast",
    userIds,
    batches,
    estimatedRecipients: userIds.length,
  };
}
