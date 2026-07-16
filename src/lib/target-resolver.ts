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
 *
 * ブロック1 拡張（LINE単独の個別体験＋ペルソナ配信ループ・Spec 2026-07-16）:
 *   ペルソナ別解決を「customer_linkages 必須」から
 *   「lineUsers 直読み（persona.primary が該当タイプ）∪ 連携済み users 経由」の**和集合**へ拡張する。
 *   lineUsers ドキュメント ID は webhook 由来の Messaging API userId なので、そのまま multicast 可能
 *   （2種類の LINE ID 橋渡し問題を踏まない）。重複は lineUserId で一意化する。
 *   これにより customer_linkages が 0 行でもペルソナ配信の宛先が成立する。
 *   500件バッチ・通数台帳・DELIVERY_SEND_ENABLED ゲート・承認フローは一切変更しない。
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

/**
 * Firestore lineUsers/{lineUserId} のペルソナ行（ブロック1・未連携ユーザーの直読み用）。
 * lineUserId は webhook 由来の Messaging API userId（= ドキュメント ID）なので multicast にそのまま使える。
 */
export interface LineUserPersonaRow {
  lineUserId: string;
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
 * 除外: 未リンク / lineUserId 空 / 退会（unfollow=ブロック相当）/ ペルソナ不一致。
 * 重複 lineUserId は 1 件に畳む（二重計上防止）。
 *
 * 注（2026-07-13 オーナー方針）: opt-out 機能は当面廃止（配信停止は LINE 標準ブロックに委譲）。
 *   したがって配信経路（本関数）は broadcast_opted_out を**参照しない**。
 *   LinkageRow.optedOut / migration 020 の列は将来の再導入用に温存（dead metadata）。
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
    // opt-out は廃止のため除外しない（c.optedOut は参照しない・温存）。
    if (seen.has(c.lineUserId)) continue;
    seen.add(c.lineUserId);
    out.push(c.lineUserId);
  }
  return out;
}

/**
 * 連携経由の対象（filterEligible 済み）と lineUsers 直読みの対象を和集合して
 * lineUserId で一意化する（純粋・ブロック1 の本丸）。
 *
 * @param linkedUserIds users×linkages を filterEligible で除外済みの lineUserId 群（連携経由）。
 * @param lineUserRows  lineUsers 直読み行（未連携でペルソナを持つユーザーを含む）。
 * @param persona       対象ペルソナ。lineUserRows 側はここで一致判定する。
 * @param excludeLineUserIds 退会(unfollow)等で配信不可の lineUserId（linkages 由来）。直読み側にも適用する（安全側）。
 *
 * 重複は lineUserId で畳む（連携経由を先に積み、直読みは未出のものだけ足す）。
 * opt-out(broadcast_opted_out) は 2026-07-13 決定で配信経路から廃止済み（除外しない・列は温存）。
 * 退会(unfollow=ブロック相当) は安全側として直読み経路にも適用し、ブロック済みユーザーへ送らない。
 */
export function unionEligible(
  linkedUserIds: string[],
  lineUserRows: LineUserPersonaRow[],
  persona: PersonaType,
  excludeLineUserIds: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of linkedUserIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const row of lineUserRows) {
    if (row.persona !== persona) continue;
    if (!row.lineUserId) continue;
    if (excludeLineUserIds.has(row.lineUserId)) continue;
    if (seen.has(row.lineUserId)) continue;
    seen.add(row.lineUserId);
    out.push(row.lineUserId);
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
   * lineUsers/{lineUserId}.persona.primary 設定済みユーザーを直読みで全件取得（ブロック1）。
   * 未連携（customer_linkages 無し）でもペルソナ配信の宛先に含めるための直読み経路。
   * 省略時（未注入）は空配列扱い＝従来の「連携済み users 経由」だけの解決に縮退する（後方互換）。
   */
  loadPersonaLineUsers?(): Promise<LineUserPersonaRow[]>;
  /** broadcast（全員配信）時の想定受信者数（無料枠ガードの見積用）。未設定・取得不能は null。 */
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
    // 全員配信は LINE 標準 broadcast に戻す（案A multicast 統一を撤回・2026-07-13 オーナー方針）。
    //   opt-out 廃止（配信停止は LINE 標準ブロックに委譲）のため、opt-out 除外目的の multicast は不要。
    //   broadcast は受信者 ID 不要で全友だちへ届く。見積は無料枠ガード用（LINE_BROADCAST_ESTIMATED_*）。
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

  // persona = multicast（ブロック1: lineUsers 直読み ∪ 連携済み users 経由の和集合）
  let linkages: LinkageRow[];
  let personaRows: PersonaRow[];
  let lineUserRows: LineUserPersonaRow[];
  try {
    [linkages, personaRows, lineUserRows] = await Promise.all([
      deps.loadLinkages(),
      deps.loadPersonaUsers(),
      deps.loadPersonaLineUsers
        ? deps.loadPersonaLineUsers()
        : Promise.resolve<LineUserPersonaRow[]>([]),
    ]);
  } catch (err) {
    return {
      kind: "error",
      reason: `対象取得失敗: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 連携経由（users×linkages）: 従来どおり退会/未リンク/別ペルソナを除外する。
  const candidates = joinCandidates(personaRows, linkages);
  const linkedUserIds = filterEligible(candidates, audience.persona);

  // 退会(unfollow=ブロック相当)の lineUserId は直読み経路にも適用する除外集合（安全側）。
  //   opt-out(broadcast_opted_out) は 2026-07-13 決定で配信経路から廃止済み（ここには入れない）。
  const excludeLineUserIds = new Set<string>();
  for (const l of linkages) {
    if (l.unfollowed && l.lineUserId) excludeLineUserIds.add(l.lineUserId);
  }

  // 和集合 + lineUserId 一意化（customer_linkages 0 行でも lineUsers 直読みで非ゼロになりうる）。
  const userIds = unionEligible(
    linkedUserIds,
    lineUserRows,
    audience.persona,
    excludeLineUserIds,
  );
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
