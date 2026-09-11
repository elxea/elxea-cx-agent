/**
 * 全員配信の受信者数を「送信のたびに LINE から数える」module（GET のみ・読み取り専用）。
 *
 * ─ なぜ要るか ─
 *   全員配信は POST /v2/bot/message/broadcast を**宛先指定なし**で呼ぶ。つまり実際の到達は
 *   「送信した瞬間の友だち全員」であって、こちらが持っている数字とは無関係に決まる。
 *   それなのに無料枠ガードと通数台帳に載せる人数を env 固定値
 *   (LINE_BROADCAST_ESTIMATED_RECIPIENTS_*) で持っていたため、友だちが増えるほど台帳が
 *   実態より過少になっていた（2026-09-11 実測: 台帳48 に対し実際は 68）。
 *   オーナー判断 2026-09-11:「全員配信の『全員』は常にその時点の全員。固定値を持つこと自体が間違い」。
 *   → 本 module が送信のたびに実測し、env 固定値は**フォールバック専用**へ降格する。
 *
 * ─ 取得元 ─
 *   GET https://api.line.me/v2/bot/followers/ids
 *     - リアルタイム（当日でも引ける）。limit 最大 1000 + `next` でページング。
 *     - ブロック済みユーザーは含まれない＝ broadcast の実到達に対応する数になる
 *       （2026-09-11 実測で insight の targetedReaches と一致することを確認）。
 *     - insight/followers は当日 status=unready になり得るため採用しない。
 *
 * ─ PII の扱い（厳守）─
 *   このエンドポイントは LINE userId の配列を返すが、本 module は **数えるだけ**で
 *   userId を配列に保持しない・返さない・ログに出さない。ページ境界の継続トークン（`next`）は
 *   userId ではないため保持してよい。
 *
 * ─ 失敗方針（重要・fail-closed を壊さない）─
 *   この数字は**帳簿用**であって、実際に何人に届くかには一切影響しない（LINE 側が決める）。
 *   よって実測の失敗を理由に配信を止めない。失敗時は env 値へフォールバックする。
 *   ただし「実測も env も無い」ときは null を返し、呼び出し側（target-resolver）の既存
 *   fail-closed 判定（見積が null/不正なら kind:"error"）にそのまま載せる。
 *   = 本 module は fail-closed の**判定を一切緩めない**。null の作られ方が増えるのではなく、
 *     従来 null だった場面（env 未設定）に実測という救済経路が一本増えるだけ。
 *
 * 安全境界: GET のみ。LINE 送信系 API（broadcast / push / multicast / narrowcast / reply）は呼ばない。
 */

/** 友だちの userId 一覧の取得エンドポイント（GET のみ・読み取り専用・送信ではない）。 */
export const LINE_FOLLOWERS_IDS_URL = "https://api.line.me/v2/bot/followers/ids";

/** 1 リクエストで引ける最大件数（LINE API 制限）。 */
export const FOLLOWERS_PAGE_LIMIT = 1000;

/**
 * ページングの安全弁（最大ページ数）。1000 件/ページなので 50 ページ = 50,000 人まで。
 * LINE が壊れた `next` を返し続けても、ここで必ず止まる（無限ループ防止）。
 * 上限に当たったら実測は「不完全」として失敗扱いにする（過少な数字を正として使わない）。
 */
export const MAX_FOLLOWER_PAGES = 50;

/** 1 ページ分の取得結果。**userId は数だけ持ち、値は保持しない**。 */
export interface FollowerPage {
  /** そのページに含まれていた userId の個数。 */
  count: number;
  /** 次ページの継続トークン。無ければ undefined（= 最終ページ）。 */
  next?: string;
}

/** ページ取得関数（DI 可能にしてユニットテストをネットワーク非接触に保つ）。 */
export type FollowerPageFetcher = (start?: string) => Promise<FollowerPage>;

/** recipients の出所。台帳の recipients_basis（migration 055）と同じ語彙。 */
export type FriendCountBasis = "measured" | "env_fallback";

/** 見積解決の結果。 */
export interface FriendCountResult {
  /** 使う人数。実測・env フォールバックのどちらも取れなければ null（＝呼び出し側で fail-closed）。 */
  count: number | null;
  /** その人数がどこから来たか。 */
  basis: FriendCountBasis;
  /** 実測を諦めた理由（PII 非記載）。実測成功時は undefined。 */
  reason?: string;
  /** 実測で読んだページ数（観測用）。実測に至らなかったときは 0。 */
  pages: number;
}

/**
 * followers/ids の生 JSON を FollowerPage に変換する（純粋・**userId を保持しない**）。
 *
 * - userIds が配列でなければ 0 件として扱う（壊れた body を「0 人」と誤認しないよう、
 *   呼び出し側は「全ページ合計 0 かつ 1 ページ目」を成功とはみなすが 0 のまま返す。
 *   0 人の OA は実在し得るため、ここでエラーにはしない）。
 * - next が非空文字列のときだけ継続トークンとして採用する。
 */
export function parseFollowerPage(raw: unknown): FollowerPage {
  if (!raw || typeof raw !== "object") return { count: 0 };
  const ids = (raw as { userIds?: unknown }).userIds;
  const count = Array.isArray(ids) ? ids.length : 0;
  const nextRaw = (raw as { next?: unknown }).next;
  const next =
    typeof nextRaw === "string" && nextRaw.length > 0 ? nextRaw : undefined;
  return { count, next };
}

/**
 * 実 LINE API を叩く FollowerPageFetcher（GET のみ）。
 * 非 2xx は status を含めて throw する（429 等を呼び出し側が理由として記録できるように）。
 * **レスポンス body（userId の配列）はここで数に潰し、外へ出さない。**
 */
export function createLineFollowerPageFetcher(
  accessToken: string,
): FollowerPageFetcher {
  return async (start?: string): Promise<FollowerPage> => {
    const url =
      `${LINE_FOLLOWERS_IDS_URL}?limit=${FOLLOWERS_PAGE_LIMIT}` +
      (start ? `&start=${encodeURIComponent(start)}` : "");
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      // body は userId を含み得るので中身は読まない（status だけを理由にする）。
      throw new Error(`followers/ids ${res.status}`);
    }
    return parseFollowerPage(await res.json());
  };
}

/**
 * 友だち数を数える（ページングの安全弁つき）。
 *
 * 安全弁は 2 本:
 *   (1) MAX_FOLLOWER_PAGES を超えたら「不完全」として throw（過少な数字を正にしない）。
 *   (2) 同じ継続トークンが返ってきたら（LINE 側の異常）その場で throw（無限ループ防止）。
 *
 * @returns 総数と読んだページ数。
 */
export async function countFollowers(
  fetchPage: FollowerPageFetcher,
  maxPages: number = MAX_FOLLOWER_PAGES,
): Promise<{ count: number; pages: number }> {
  let total = 0;
  let pages = 0;
  let cursor: string | undefined = undefined;
  const seen = new Set<string>();

  for (;;) {
    const page: FollowerPage = await fetchPage(cursor);
    total += page.count;
    pages++;

    if (!page.next) return { count: total, pages };

    if (seen.has(page.next)) {
      throw new Error(`followers/ids: 継続トークンが循環した（pages=${pages}）`);
    }
    seen.add(page.next);

    if (pages >= maxPages) {
      throw new Error(
        `followers/ids: ページ上限 ${maxPages} に到達し全件を数えられなかった`,
      );
    }
    cursor = page.next;
  }
}

/** env 由来のフォールバック値を厳格にパースする（純粋）。不正・未設定は null。 */
export function parseFallbackCount(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export interface BroadcastEstimateDeps {
  /** 実測の口（未指定なら実測を行わず即フォールバック）。 */
  fetchPage?: FollowerPageFetcher;
  /** env 固定値（フォールバック専用へ降格した値）。 */
  envFallback: number | null;
  /** ページングの安全弁（テスト用に上書き可能）。 */
  maxPages?: number;
}

/**
 * 全員配信の受信者数を解決する。**実測が正・env はフォールバック**。
 *
 * - 実測成功 → { count: 実測値, basis: "measured" }（0 人でも実測は実測。そのまま返す）
 * - 実測失敗（429 / ネットワーク / ページ上限 / 口が無い）→ env へ退避
 *     → env があれば { count: env 値, basis: "env_fallback", reason }
 *     → env も無ければ { count: null, basis: "env_fallback", reason }
 *       = 呼び出し側の既存 fail-closed（見積 null は送信不可）にそのまま載る
 *
 * この関数は**決して throw しない**（配信を止める権限を持たない）。
 */
export async function resolveBroadcastRecipientEstimate(
  deps: BroadcastEstimateDeps,
): Promise<FriendCountResult> {
  if (!deps.fetchPage) {
    return {
      count: deps.envFallback,
      basis: "env_fallback",
      reason: "実測の口が配線されていない",
      pages: 0,
    };
  }

  try {
    const { count, pages } = await countFollowers(
      deps.fetchPage,
      deps.maxPages ?? MAX_FOLLOWER_PAGES,
    );
    return { count, basis: "measured", pages };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      count: deps.envFallback,
      basis: "env_fallback",
      reason,
      pages: 0,
    };
  }
}
