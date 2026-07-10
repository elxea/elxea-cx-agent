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
  /** broadcast 時の想定受信者数（未設定・取得不能は null）。 */
  broadcastEstimate(): Promise<number | null>;
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
    let estimate: number | null;
    try {
      estimate = await deps.broadcastEstimate();
    } catch (err) {
      return {
        kind: "error",
        reason: `broadcast 見積取得失敗: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (estimate == null || !Number.isInteger(estimate) || estimate < 1) {
      return {
        kind: "error",
        reason:
          "broadcast の想定受信者数が未設定/不正（fail-closed。LINE_BROADCAST_ESTIMATED_RECIPIENTS_* を設定）",
      };
    }
    return { kind: "broadcast", estimatedRecipients: estimate };
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
