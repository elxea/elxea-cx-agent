/**
 * @layer CDP
 *
 * canonical 解決 — 「この鍵の人」を 1 人として読む（CDP 統合 Stage 2 / 設計 §4 C-1 = ★11）。
 *
 * ─ いま何が壊れているか（★11）─
 *
 *   LIFF 連携と LINE 純正 Account Link は customer_linkages にしか行を書かない。
 *   ところが「横断して読むか」を決める resolveUnifiedUserId も、実際に読む
 *   getCrossChannelMessages も user_identity_map しか引かない。だから
 *   **連携したのに LINE の会話が統合ビューに出ない**。
 *
 * ─ ここが何をするか ─
 *
 *   鍵 1 つ（LINE の userId / web の session_id / Shopify の顧客番号）を渡すと、
 *   subject_links の連結成分を解いて「同じ人の鍵の全部」を返す。会話は
 *   conversations.user_id にこれらの生値で保存されているので、そのまま `IN` に使える。
 *
 * ─ フォールバック（外せば元に戻る構造）─
 *
 *   RPC が落ちても・主体がまだ発行されていなくても、**必ず resolved:false で戻る**。
 *   呼び出し側はそのとき旧 join（user_identity_map）だけで読む ＝ Stage 2 以前と
 *   まったく同じ挙動になる。canonical の分を足すのをやめれば元に戻る。
 *
 * ─ SEC-1 ─
 *   email_hash では引かない（RPC 側も同じ枝を持たない）。返る識別子にも入らない。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ObservedIdentifier } from "./subjects";

/** 1 回の読み出しで束ねる識別子の上限。超えたら truncated が立つ（黙って削らない）。 */
export const CANONICAL_MAX_REFS = 50;

export interface CanonicalResolution {
  /** canonical 解決が使えたか。false なら呼び出し側は旧 join だけで読む。 */
  resolved: boolean;
  /** 「同じ人だ」という判断が 1 本でもあるか ＝ 横断して読むべき人か。 */
  linked: boolean;
  /** 会話の user_id として使える識別子の生値（自分自身を含む）。 */
  userRefs: string[];
  /** 連結成分の代表（突合・ログ用。表示・URL には出さない）。 */
  canonicalId?: string;
  /** 連結成分の主体数。 */
  memberCount?: number;
  /** 連結成分に掛かっている link の本数。 */
  linkCount?: number;
  /** 上限に当たって識別子を全部は返していない。 */
  truncated?: boolean;
  /** resolved=false の理由（T-12: 無言で戻らない）。 */
  reason?: string;
}

const UNRESOLVED = (reason: string): CanonicalResolution => ({
  resolved: false,
  linked: false,
  userRefs: [],
  reason,
});

/**
 * 鍵 1 つから、同じ人と判定された全ての鍵を引く。**決して throw しない。**
 *
 * @param seed  この人を指す鍵。LINE の webhook なら署名検証済みの userId、
 *              web ならサーバが持っている session_id。呼び出し側で真正性を担保する。
 */
export async function resolveCanonicalUserRefs(
  supabase: SupabaseClient,
  seed: ObservedIdentifier,
  maxRefs: number = CANONICAL_MAX_REFS,
): Promise<CanonicalResolution> {
  const value = typeof seed.value === "string" ? seed.value.trim() : "";
  if (value === "") return UNRESOLVED("identifier_empty");
  // SEC-1: メールの hash から人を引く経路は作らない（RPC 側も拒否する）。
  if (seed.kind === "email_hash") return UNRESOLVED("identifier_kind_not_resolvable");

  try {
    const { data, error } = await supabase.rpc("cdp_canonical_identifiers", {
      p_kind: seed.kind,
      p_value: value,
      p_max_refs: maxRefs,
    });

    if (error) {
      // migration 043 未適用（関数が無い）もここに来る。旧 join に落ちるだけなので
      // 応答は壊れない。ただし「落ちたこと」は必ず言う。
      console.warn(
        "[cdp/canonical] rpc failed (falling back to legacy join):",
        JSON.stringify({ kind: seed.kind, reason: error.message }),
      );
      return UNRESOLVED("rpc_failed");
    }

    return readResolution(data);
  } catch (err) {
    console.warn(
      "[cdp/canonical] unexpected error (falling back to legacy join):",
      err instanceof Error ? err.message : String(err),
    );
    return UNRESOLVED("unexpected_error");
  }
}

/**
 * RPC の戻り（jsonb）を型に読む。**壊れた形は resolved:false に倒す**
 * （中途半端に読むと、足りない ID 集合で会話を引いて「履歴が消えた」ように見える）。
 */
export function readResolution(data: unknown): CanonicalResolution {
  if (!data || typeof data !== "object") return UNRESOLVED("rpc_shape_unexpected");
  const row = data as Record<string, unknown>;

  if (row.found !== true) {
    // まだ主体が発行されていない人（Stage 1 の gateway を通っていない）等。
    return UNRESOLVED(typeof row.reason === "string" ? row.reason : "not_found");
  }

  const refs = Array.isArray(row.identifier_values)
    ? row.identifier_values.filter((v): v is string => typeof v === "string" && v !== "")
    : null;
  if (refs === null) return UNRESOLVED("rpc_shape_unexpected");

  const linkCount = typeof row.link_count === "number" ? row.link_count : 0;

  return {
    resolved: true,
    // link が 0 本なら「連携していない人」。呼び出し側の分岐は Stage 2 以前と変わらない。
    linked: linkCount > 0,
    userRefs: refs,
    canonicalId: typeof row.canonical_id === "string" ? row.canonical_id : undefined,
    memberCount: typeof row.member_count === "number" ? row.member_count : undefined,
    linkCount,
    truncated: row.truncated === true,
  };
}

/** LINE トークの人の鍵（webhook の userId は LINE 署名で検証済み）。 */
export function lineSeed(lineUserId: string): ObservedIdentifier {
  return { kind: "line_messaging_uid", value: lineUserId };
}

/**
 * LINE Login（OIDC の sub）の鍵。**トークの userId と同じ値でも別 kind** で並置されている
 * （migration 040 / `identity.link-line` のコメント参照）。
 *
 * ─ なぜ「別 kind なのに同じ人」として読むのか（2026-08-30 の本番切断の根因）─
 *
 *   `identity.link-line`（Web で LINE ログインした人の匿名セッション昇格）は
 *   `web_session_id ↔ line_login_uid` を結ぶ。一方 LINE の webhook は
 *   `line_messaging_uid` を種にして canonical を引く。**同じ LINE の人なのに
 *   連結成分が 2 つに割れる**ので、サイトのチャットで話した内容が LINE 側から
 *   一生見えない。実際に本番でこう割れていた:
 *
 *     成分 A（webhook から見える）: line_messaging_uid ─ shopify_customer_id …
 *     成分 B（Web から見える）    : web_session_id ─ line_login_uid
 *
 *   LINE の userId 名前空間はプロバイダ単位で一意なので、**同じ生値** が両 kind に
 *   現れたらそれは同じ人である。ここではその事実を **読むときだけ** 使う
 *   （`resolveCanonicalFromSeeds` で両方の種を引いて和を取る）。DB に新しい
 *   「同じ人だ」の主張を書き足すわけではないので、SEC-1 / J-4 の判断は動かない。
 */
export function lineLoginSeed(lineUserId: string): ObservedIdentifier {
  return { kind: "line_login_uid", value: lineUserId };
}

/**
 * 複数の鍵から連結成分を引き、**和を取って** 1 つの解決として返す。
 *
 * 1 鍵だけで引くと「同じ人なのに種の選び方で見える範囲が変わる」ことが起きる
 * （上の `lineLoginSeed` のコメントにある本番の割れ方がまさにそれ）。呼び出し側が
 * 手元に持っている真正性の確かな鍵を **全部** 渡せば、どれか 1 本でも人に届いていれば
 * 読める。
 *
 * - `resolved` … 1 つでも解決できたか
 * - `linked`   … 1 つでも「同じ人だ」の判断を持っていたか
 * - `userRefs` … 重複を除いた和（`maxRefs` で頭打ち。切ったら `truncated`）
 *
 * **決して throw しない**（各 seed の解決が never throw なので、和も never throw）。
 * 種を 1 本も渡さなければ `resolved:false` で戻る（＝旧 join だけで読む）。
 */
export async function resolveCanonicalFromSeeds(
  supabase: SupabaseClient,
  seeds: ObservedIdentifier[],
  maxRefs: number = CANONICAL_MAX_REFS,
): Promise<CanonicalResolution> {
  if (seeds.length === 0) return UNRESOLVED("no_seeds");

  const resolutions = await Promise.all(
    seeds.map((seed) => resolveCanonicalUserRefs(supabase, seed, maxRefs)),
  );

  const usable = resolutions.filter((r) => r.resolved);
  if (usable.length === 0) {
    // 全部落ちた / 誰にも届かなかった。理由は最初のものを代表として返す（無言で戻らない）。
    return UNRESOLVED(resolutions[0]?.reason ?? "not_found");
  }

  const refs: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const r of usable) {
    if (r.truncated) truncated = true;
    for (const value of r.userRefs) {
      if (seen.has(value)) continue;
      if (refs.length >= maxRefs) {
        truncated = true;
        break;
      }
      seen.add(value);
      refs.push(value);
    }
  }

  const linkCount = usable.reduce((acc, r) => acc + (r.linkCount ?? 0), 0);
  return {
    resolved: true,
    linked: usable.some((r) => r.linked),
    userRefs: refs,
    canonicalId: usable.find((r) => r.canonicalId)?.canonicalId,
    memberCount: usable.reduce((acc, r) => acc + (r.memberCount ?? 0), 0),
    linkCount,
    truncated,
  };
}

/** Web の人の鍵（session_id）。 */
export function webSeed(sessionId: string): ObservedIdentifier {
  return { kind: "web_session_id", value: sessionId };
}

/** Shopify 顧客の鍵（数値へ正規化済みの顧客番号を渡すこと）。 */
export function shopifySeed(customerId: string): ObservedIdentifier {
  return { kind: "shopify_customer_id", value: customerId };
}
