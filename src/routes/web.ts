/**
 * Web Chat Route — POST /api/chat + GET /api/chat/history
 *
 * POST /api/chat は SSE で真のストリーミングレスポンスを返す。
 * Claude API のストリーミングレスポンスのチャンクをリアルタイムで
 * SSE イベントとしてクライアントに転送する。
 */
import type { Context } from "hono";
import type { Env } from "../index";
import { runAgent, runAgentStreaming, type StreamCallbacks } from "../agent/core";
import { createEmbedding } from "../lib/embedding";
import {
  createSupabaseClient,
  saveMessage,
  getRecentMessages,
  getCrossChannelMessages,
} from "../lib/supabase";
import {
  validateSessionId,
  validateShopifyCustomerId,
  validateLineMessagingUserId,
  normalizeShopifyCustomerId,
  checkRateLimit,
  getClientIp,
} from "../lib/web-auth";
import {
  resolveUnifiedUserId,
  resolveWithShopifyCustomerId,
} from "../lib/identity";
import { isValidSyncApiKey } from "../lib/sync-auth";
import { resolveUsableSessionId } from "../lib/chat-session";
import { withTimeout } from "../lib/utils";
import { recordResponseTime, recordApiError, sendNegativeFeedbackAlert } from "../lib/alerts";
import { recordBehaviorEvent, type BehaviorAction, type BehaviorEventMetadata } from "../lib/firestore";
import { behaviorEventType } from "../lib/cdp/event-vocabulary";
import { recordCustomerEvent } from "../lib/cdp/events-gateway";
import {
  resolveCanonicalUserRefs,
  resolveCanonicalFromSeeds,
  webSeed,
  shopifySeed,
  lineSeed,
  lineLoginSeed,
} from "../lib/cdp/canonical";
import { appendSubjectLink, logLinkAppend } from "../lib/cdp/subject-links";
import type { ObservedIdentifier } from "../lib/cdp/subjects";
import { runPreferencePipeline } from "../lib/preference-pipeline";

/** 入力テキストの最大文字数 */
const MAX_MESSAGE_LENGTH = 2000;

/**
 * [SEC-B] リクエストが「サーバ経由（信頼済み）」かどうかを判定する。
 *
 * ブラウザは秘密値（SYNC_API_SECRET）を保持できないため、ブラウザから直接叩かれた
 * リクエストは常に false になる。X-API-Key が SYNC_API_SECRET と一致する
 * サーバ間呼び出し（認証済みの web-app サーバ等）だけが true になる。
 *
 * この判定を通ったときだけ、リクエストが自己申告する shopify_customer_id を
 * 「認証済み identity」として信頼する。ブラウザ自己申告の customer_id は
 * なりすまし（他人の customer_id を送るだけで他人になりすませる）を防ぐため無視し、
 * 匿名 web セッション（session_id）として扱う（fail-closed）。
 */
export function isTrustedServerCaller(c: Context<{ Bindings: Env }>): boolean {
  const apiKey = c.req.header("X-API-Key");
  const secret = (c.env as { SYNC_API_SECRET?: string }).SYNC_API_SECRET;
  return isValidSyncApiKey(apiKey, secret);
}

/**
 * [SEC-B] 行動イベント等で使う「実効ユーザーID」を決める純粋関数。
 *
 * サーバ経由（trusted=true）で shopify_customer_id が付いているときだけ
 * それを identity として採用し、それ以外は必ず session_id を使う。
 * ブラウザ自己申告（trusted=false）の customer_id は他人へのなりすまし・
 * 行動データ汚染を防ぐため一切採用しない。
 */
export function effectiveEventUserId(
  trusted: boolean,
  shopifyCustomerId: string | null | undefined,
  sessionId: string,
): string {
  return trusted && shopifyCustomerId ? shopifyCustomerId : sessionId;
}

/**
 * [SEC-3] チャットハンドラでクロスチャネル個人データ（別チャネル/別 session の
 * 履歴・連携済み顧客プロファイル）を返してよいかを決める純粋関数。
 *
 * `resolveUnifiedUserId`（Web）は `user_identity_map.web_session_id === session_id`
 * のときに isLinked=true を返す。これは「session_id を知っている」だけの弱い証明であり、
 * 束縛経路（SEC-1/SEC-2）が破られれば攻撃者の session が被害者の unified_user に
 * 解決され得る。したがってチャットハンドラでは isLinked だけでクロスチャネル個人
 * データを開かない。
 *
 * 開いてよいのは「ライブ検証済みの信頼経路」＝サーバ経由（X-API-Key 検証済み）で
 * **かつサーバ確定の本人 ID（Shopify 顧客 ID または LINE userId）が付いているとき**
 * だけに限定する（fail-closed）。生の web_session_id 一致には依拠しない。
 * webChatHistoryHandler の `ownsIdentity` ゲートと同じ精神の多層防御。
 *
 * ⚠ 第 2 引数に「共有鍵があるか」だけを渡してはいけない。proxy は session_id の
 *   **所有を検証しない**（ブラウザの cookie をそのまま転送する）ので、鍵だけを条件に
 *   すると、ログアウト中のブラウザが他人の session_id を送るだけでその人の横断履歴に
 *   届く。呼び出し側は `hasVerifiedIdentity` を渡すこと。
 *   LINE userId を customer_id と同格に扱うのは、どちらも web-app がサーバ側で確定した
 *   値（暗号化 cookie の復号結果 = LINE 署名済み id_token の sub）だからで、
 *   ブラウザ自己申告はこの経路に入らない（上の trusted 判定で捨てられる）。
 *
 * B-2（非対称の理由・意図的に現状維持）: LINE 側は `identity.isLinked || canonical.linked` で
 *   横断を開くのに、web 側はここで `&& trusted` を要求する。LINE の userId は webhook 署名で
 *   真正性が検証済みなのに対し、web の session_id は「知っているだけ」の弱い証明だから。
 *   この非対称を消す（web も canonical だけで開く）と SEC-3 の fail-closed が壊れる。
 *
 * ★11 の web 版（2026-08-30）: 第 1 引数には旧台帳の `identity.isLinked` **だけ**ではなく
 *   `identity.isLinked || canonical.linked` を渡す。LIFF / Account Link で連携した人は
 *   旧台帳（user_identity_map.line_user_id）に行が無いので、旧台帳だけを見ていると
 *   **ログイン済みでも横断が永久に開かない**。緩めていないのは `trusted`（信頼経路の
 *   要求）であり、SEC-3 の fail-closed はそのまま残っている。
 */
export function crossChannelHistoryAllowed(isLinked: boolean, trusted: boolean): boolean {
  return isLinked && trusted;
}

/** 信頼経路で確定している「この人の鍵」たち。canonical 解決と link 追記の両方が使う。 */
export interface VerifiedWebIdentity {
  /** ブラウザの会話 ID（UUID）。 */
  sessionId: string;
  /** サーバ検証済み Shopify 顧客 ID（GID / 数値のどちらでも可）。未ログインなら undefined。 */
  shopifyCustomerId?: string;
  /** サーバ検証済み LINE userId。LINE ログインで入っている人だけ付く。 */
  lineUserId?: string;
}

/**
 * この session_id が既に **誰のものとして** 記録されているか。
 *
 * - `unowned` … まだ誰にも結ばれていない（主体が無い / link が 0 本）。結んでよい。
 * - `own`     … 既にこの人の連結成分にいる。結び直す必要は無いが、種に入れてよい。
 * - `foreign` … **別人**の連結成分にいる。種に入れても結んでもいけない。
 */
export type WebSessionOwnership = "unowned" | "own" | "foreign";

/** この人を指す「人そのものの鍵」の生値。連結成分の識別子と突き合わせる。 */
function ownerIdentifierValues(identity: VerifiedWebIdentity): string[] {
  const values: string[] = [];
  if (identity.shopifyCustomerId) {
    const normalized = normalizeShopifyCustomerId(identity.shopifyCustomerId);
    if ("numericId" in normalized) values.push(normalized.numericId);
  }
  if (identity.lineUserId) values.push(identity.lineUserId);
  return values;
}

/**
 * session_id の既存の持ち主を引く。**決して throw しない**（引けなければ fail-closed）。
 *
 * ─ なぜ要るか（QA 指摘 2026-08-30・書き込み側の乗っ取り）─
 *
 *   proxy は `session_id` の **所有を検証しない**。ブラウザの cookie をそのまま
 *   転送するだけなので、ログイン済みの A が他人 B の session_id を送れてしまう。
 *   これを素通しすると 2 つ壊れる:
 *
 *     (1) 読み  — B の連結成分が A の履歴に和され、A が B の会話を読める
 *     (2) 書き  — `subject_links` に「B の session は A のもの」が **永続追記** される
 *
 *   (2) のほうが重い。一度書けば以後ずっと B の発言が A に流れ続けるうえ、
 *   link は追記専用なので取り消せない。よって **結ぶ前に既存の持ち主を必ず確かめる**。
 *
 * ─ 判定 ─
 *   session_id で連結成分を引き、`linked`（同じ人だという判断が 1 本以上ある）なのに
 *   その成分に自分の鍵が 1 つも無ければ **別人のもの**と見なす。
 *   link が 0 本なら誰のものでもないので結んでよい（初対面の session がこれ）。
 *   RPC が落ちた等で判定できないときは `foreign` に倒す（推測で他人の棚を開けない）。
 */
export async function resolveWebSessionOwnership(
  supabase: ReturnType<typeof createSupabaseClient>,
  identity: VerifiedWebIdentity,
): Promise<WebSessionOwnership> {
  const owned = ownerIdentifierValues(identity);
  if (owned.length === 0) return "foreign"; // 本人が確定していない＝結ぶ相手がいない

  const component = await resolveCanonicalUserRefs(supabase, webSeed(identity.sessionId));

  // まだ主体が無い / 解決できなかった。
  if (!component.resolved) {
    /* `not_found` は「この session はまだ誰の記録にも出てきていない」＝安全に結べる。
       それ以外（RPC 失敗・想定外の形）は **判定できなかった** のであって
       「誰のものでもない」ではない。fail-closed で結ばない。 */
    return component.reason === "not_found" ? "unowned" : "foreign";
  }

  // 主体はあるが「同じ人だ」の判断が 1 本も無い＝まだ誰のものでもない。
  if (!component.linked) return "unowned";

  return component.userRefs.some((ref) => owned.includes(ref)) ? "own" : "foreign";
}

/**
 * canonical 解決に渡す種を組み立てる。
 *
 * session_id 1 本だけで引くと、**その session が誰かに結ばれた履歴がまだ無い間**は
 * 何も返らない（本番で実際にこうなっていた）。信頼経路で本人が確定しているなら、
 * 顧客番号・LINE userId という「人そのものの鍵」も種にしてよい。どれか 1 本でも
 * 連結成分に届けば、そこから同じ人の鍵が全部引ける。
 *
 * LINE は 2 kind とも入れる（トークの userId と LINE ログインの sub が別 kind で
 * 並置されているため。lib/cdp/canonical.ts の lineLoginSeed 参照）。
 *
 * ⚠ **別人のものと分かっている session_id は種に入れない**（QA 指摘 2026-08-30）。
 *   入れると、他人の session_id を送るだけでその人の連結成分が自分の読み出し集合に
 *   和されてしまう。人そのものの鍵（顧客番号 / LINE userId）だけで引けば、
 *   自分の履歴は従来どおり読めるので機能は落ちない。
 */
export function canonicalSeedsForWeb(
  identity: VerifiedWebIdentity,
  ownership: WebSessionOwnership,
): ObservedIdentifier[] {
  const seeds: ObservedIdentifier[] = ownership === "foreign" ? [] : [webSeed(identity.sessionId)];

  if (identity.shopifyCustomerId) {
    const normalized = normalizeShopifyCustomerId(identity.shopifyCustomerId);
    if ("numericId" in normalized) seeds.push(shopifySeed(normalized.numericId));
  }
  if (identity.lineUserId) {
    seeds.push(lineLoginSeed(identity.lineUserId));
    seeds.push(lineSeed(identity.lineUserId));
  }
  return seeds;
}

/**
 * 「この web セッションはこの人のもの」を subject_links に 1 行足す。**never throw**。
 *
 * ─ なぜ要るか ─
 *   web の発言は `conversations.user_id = session_id` で保存される。LINE 側が
 *   それを読めるのは session_id が連結成分に入っているときだけだが、session_id を
 *   人に結ぶ経路は「Web で LINE ログインした瞬間」しか無かった。ログイン済みの人が
 *   新しいタブ（＝新しい session_id）で話すと、その発言は **どこからも辿れない**。
 *
 * ─ 何を主張するか ─
 *   basis は `anonymous_promotion`（認証済みの本人がこのセッションを自分だと申告した
 *   経路）。呼び出し側は信頼経路（X-API-Key 検証済み + サーバ確定の identity）でのみ
 *   呼ぶこと。ブラウザ自己申告で呼べば、他人のセッションを自分に結べてしまう。
 *
 * 顧客番号がある人はそちらに結ぶ（LINE のトーク側は既に顧客番号と結ばれているので
 * 1 本で両チャネルに届く）。顧客番号が無い（LINE ログインだけ）人は LINE 側に結ぶ。
 *
 * ⚠ **`unowned` のときしか結ばない**（QA 指摘 2026-08-30・書き込み側の乗っ取り）。
 *   proxy は session_id の所有を検証しないので、この歯が無いと「他人の session_id を
 *   送るだけで、その session が自分のものとして **永続的に** 記録される」。
 *   link は追記専用で取り消せないため、ここが最後の歯になる。
 */
export async function bindWebSessionToOwner(
  supabase: ReturnType<typeof createSupabaseClient>,
  identity: VerifiedWebIdentity,
  ownership: WebSessionOwnership,
): Promise<void> {
  if (ownership !== "unowned") {
    /* `own` は既に結ばれているので足すものが無い。`foreign` は結んではいけない。
       後者は「起きたこと」なので必ず 1 行残す（T-12: 無言で捨てない）。 */
    if (ownership === "foreign") {
      console.warn(
        "[cdp/link] not appended:",
        JSON.stringify({ route: "web-chat", reason: "session_owned_by_other_subject" }),
      );
    }
    return;
  }

  const owner = ownerSeedFor(identity);
  if (!owner) return;

  const result = await appendSubjectLink(supabase, {
    left: webSeed(identity.sessionId),
    right: owner,
    basis: "anonymous_promotion",
    observedBy: "web-chat",
  });
  logLinkAppend("web-chat", "anonymous_promotion", result);
}

/** 結ぶ相手（人そのものの鍵）。無ければ結ばない＝匿名のまま。 */
function ownerSeedFor(identity: VerifiedWebIdentity): ObservedIdentifier | null {
  if (identity.shopifyCustomerId) {
    const normalized = normalizeShopifyCustomerId(identity.shopifyCustomerId);
    if ("numericId" in normalized) return shopifySeed(normalized.numericId);
  }
  if (identity.lineUserId) return lineLoginSeed(identity.lineUserId);
  return null;
}

/** 前処理（保存+履歴+Embedding）のタイムアウト（ミリ秒） */
const TIMEOUT_PRE_PARALLEL_MS = 10_000;

/** エージェント実行のタイムアウト（ミリ秒 -- webChatImageHandler で使用） */
const TIMEOUT_RUN_AGENT_MS = 25_000;

/**
 * POST /api/chat
 *
 * リクエストボディ: { "message": string, "session_id": string }
 * レスポンス: SSE 真のストリーミング
 *
 * Claude API のストリーミングレスポンスをリアルタイムで SSE イベントとして
 * クライアントに転送する。ReadableStream を使用し、各チャンクが到着次第
 * 即座にクライアントに送信される。
 */
export async function webChatHandler(c: Context<{ Bindings: Env }>) {
  // レートリミット: 信頼済み proxy (X-API-Key 検証済み) 由来のときだけ転送された実 IP を採用
  const clientIp = getClientIp(c.req.raw, isTrustedServerCaller(c));
  const rateLimitError = checkRateLimit(clientIp);
  if (rateLimitError) {
    return c.json({ error: rateLimitError }, 429);
  }

  // リクエストボディのパース
  let body: {
    message?: string;
    session_id?: string;
    session_proof?: string;
    shopify_customer_id?: string;
    line_user_id?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { message, session_id, session_proof, shopify_customer_id, line_user_id } = body;

  // session_id バリデーション
  const sessionError = validateSessionId(session_id);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  // shopify_customer_id バリデーション（optional）
  const shopifyError = validateShopifyCustomerId(shopify_customer_id);
  if (shopifyError) {
    return c.json({ error: shopifyError }, 400);
  }

  // line_user_id バリデーション（optional）。
  //   web-app が **サーバ確定値**（暗号化 cookie の復号結果 = LINE 署名済み id_token の sub）
  //   として渡す。ブラウザ自己申告は下の trusted 判定で捨てるので、ここは形式ゲート。
  if (line_user_id !== undefined && validateLineMessagingUserId(line_user_id)) {
    return c.json(
      { error: "line_user_id must be a LINE userId (U followed by 32 hex chars)" },
      400,
    );
  }

  // message バリデーション
  if (typeof message !== "string" || message.trim().length === 0) {
    return c.json({ error: "message is required" }, 400);
  }

  /* [SEC-3 前提] `session_id` は **サーバが発行したものだけ** を鍵として使う。
     ブラウザ自作の UUID をそのまま鍵にしていたのが P1/P2/P3（他人の session を
     奪う・読む・書き込む）に共通する前提だった。署名が確かめられないときは
     その場限りの ID にすり替える（応答は止めない）。理由は lib/chat-session.ts。 */
  const claimedSessionId = session_id as string;
  const sessionResolution = await resolveUsableSessionId({
    claimedSessionId,
    proof: session_proof,
    trusted: isTrustedServerCaller(c),
    secret: (c.env as { CHAT_SESSION_SECRET?: string }).CHAT_SESSION_SECRET,
  });
  if (!sessionResolution.proven) {
    // 無言で捨てない（T-12）。生の session_id は出さない。
    console.warn(
      "[web] session not proven:",
      JSON.stringify({ route: "api/chat", reason: sessionResolution.reason }),
    );
  }
  const sessionId = sessionResolution.sessionId;

  let processedMessage = message.trim();
  if (processedMessage.length > MAX_MESSAGE_LENGTH) {
    processedMessage = processedMessage.slice(0, MAX_MESSAGE_LENGTH);
  }

  const supabase = createSupabaseClient(c.env);
  const tStart = Date.now();
  const encoder = new TextEncoder();

  // 前処理: Identity 解決 + メッセージ保存 + 履歴取得 + Embedding 生成
  let effectiveUserId = sessionId;
  let history: Array<{ role: "user" | "assistant"; content: string }> = [];
  let embedding: number[];
  let identityIsLinked = false;

  // [SEC-B] 自己申告の identity は「サーバ経由（X-API-Key 検証済み）」のときだけ信頼する。
  // ブラウザ直叩き（X-API-Key 無し）は無視し、匿名 web セッション扱いにする。
  const trusted = isTrustedServerCaller(c);
  const trustedCustomerId = trusted ? shopify_customer_id : undefined;
  const trustedLineUserId = trusted ? line_user_id : undefined;

  /* [SEC-3] 「ライブ検証済みの信頼経路」= サーバ経由 **かつ** 検証済みの本人 ID が
     付いていること。共有鍵だけでは足りない。
     鍵だけを条件にすると、ログアウト中のブラウザが他人の session_id を proxy 経由で
     送るだけで、その session が属する人の横断履歴に届いてしまう（proxy は session_id の
     所有を検証しない）。本人 ID を要求すれば「いま誰として話しているか」がサーバで
     確定している状態に限定できる。
     Shopify 顧客 ID **または** LINE userId のどちらでもよい（どちらもサーバ確定値）。
     元は customer_id 限定だったが、LINE ログインの人が identity を持てなかったのが
     今回の障害なので、同格の証明として LINE userId を並べる。 */
  const hasVerifiedIdentity = !!(trustedCustomerId || trustedLineUserId);

  try {
    /* [SEC-3 書き込み側] この session_id が既に **別人のもの** として記録されていないかを
       **identity 解決より先に** 確かめる。proxy は session_id の所有を検証しない
       (ブラウザの cookie をそのまま転送する) ので、ログイン済みの A が他人 B の
       session_id を送れてしまう。確かめずに進むと 3 つ壊れる:
         (1) 旧台帳 — B の session_id が A の identity 行に束縛される
         (2) 読み   — B の連結成分が A の読み出し集合に和される
         (3) 新台帳 — 「B の session は A のもの」が subject_links に **永続追記** される
       (3) は追記専用で取り消せない。以下の 3 か所すべてでこの判定を効かせる。 */
    const verifiedIdentity: VerifiedWebIdentity = {
      sessionId,
      shopifyCustomerId: trustedCustomerId,
      lineUserId: trustedLineUserId,
    };
    const sessionOwnership: WebSessionOwnership = hasVerifiedIdentity
      ? await resolveWebSessionOwnership(supabase, verifiedIdentity)
      : "foreign";
    /** 別人の session は「知っているだけ」なので、読み書きのどの経路にも通さない。 */
    const sessionIsOwn = sessionOwnership !== "foreign";

    const identity = trustedCustomerId
      ? await resolveWithShopifyCustomerId(supabase, trustedCustomerId, sessionId, sessionIsOwn)
      : await resolveUnifiedUserId(supabase, sessionId, "web");
    effectiveUserId = identity.unifiedUserId;

    // CDP 統合 Stage 2: canonical 解決（subject_links の連結成分）で「同じ人の鍵」を引く。
    //
    // ⚠ [SEC-3] の fail-closed（信頼経路でなければ絶対に横断しない）は **一切緩めない**。
    //   下の `trusted &&` がそれで、生の web_session_id 一致だけでは今も開かない。
    //
    // ★11 の web 版（2026-08-30 の本番切断の手当て）: LINE 側は
    //   `identity.isLinked || canonical.linked` なのに、web 側は旧台帳の
    //   `identity.isLinked` だけを見ていた。LIFF / Account Link で連携した人は
    //   customer_linkages と subject_links にしか行が無く、`user_identity_map.line_user_id`
    //   は null のままなので、**ログイン済みでも横断が永久に開かない**。旧台帳しか見て
    //   いない非対称を、LINE 側と同じ形に揃える（信頼経路の要求は残したまま）。
    const canonical = hasVerifiedIdentity
      ? await resolveCanonicalFromSeeds(
          supabase,
          canonicalSeedsForWeb(verifiedIdentity, sessionOwnership),
        )
      : { linked: false, userRefs: [] as string[] };

    const crossChannelAllowed = crossChannelHistoryAllowed(
      identity.isLinked || canonical.linked,
      hasVerifiedIdentity,
    );
    identityIsLinked = crossChannelAllowed;

    // この session を「本人の鍵」として連結成分に載せる（追記 1 行・never throw）。
    //
    // ─ なぜ要るか（2026-08-30 の本番切断の本丸）─
    //   web の発言は `conversations.user_id = session_id` で保存される（下の saveMessage）。
    //   ところが session_id を人に結びつける経路は「Web で LINE ログインした瞬間の
    //   `identity.link-line`」しか無く、**ログイン済みの人が新しいタブで話した分は
    //   どの連結成分にも入らない**。結果、LINE 側から読むと存在しないのと同じになる。
    //   ログイン済み（＝信頼経路で本人が確定している）なら、その場で 1 行足して
    //   「このセッションはこの人のもの」を残す。basis は既存の語彙
    //   `anonymous_promotion`（認証済みの本人がこのセッションを自分だと申告した経路）。
    /* 署名が確かめられた session だけを人に結ぶ。すり替えた使い捨て ID を結ぶと
       subject_links に一度きりのゴミ行が積み上がるだけで、誰の役にも立たない。 */
    if (hasVerifiedIdentity && sessionResolution.proven) {
      c.executionCtx.waitUntil(
        bindWebSessionToOwner(supabase, verifiedIdentity, sessionOwnership),
      );
    }

    console.log("[web] step=pre-parallel");
    const [, fetchedHistory, emb] = await withTimeout(
      Promise.all([
        saveMessage(supabase, {
          userId: sessionId,
          channel: "web",
          role: "user",
          content: processedMessage,
        }),
        crossChannelAllowed
          ? getCrossChannelMessages(
              supabase,
              effectiveUserId,
              undefined,
              30,
              3000,
              /* [SEC-3] 別人の session はチャネル横断の読み出し集合に入れない。
                 ここに生の session_id を渡すと、canonical の種から外しても
                 `unionCrossChannelUserIds` が結局それを足してしまう
                 (他人の session_id を送るだけで、その人の LINE 会話まで読める)。 */
              sessionIsOwn ? sessionId : undefined,
              canonical.userRefs,
            )
          : /* 横断しないときも **書いた鍵で読む**。web の発言は session_id で保存される
               のに、ここは長らく effectiveUserId（連携済みなら Shopify 顧客 GID）で
               読んでいた。両者がずれると履歴が毎ターン 0 件になり、**同じ画面の
               2 つ前の自分の発言すら見えない**（2026-08-30 の本番で実際にこうなった:
               「花の香りの紅茶が好き」→ 24 秒後の「覚えておいて」に対して
               「何を覚えますか？」と聞き返している）。
               2 つが同じ（＝匿名の人）なら往復を増やさず従来どおり 1 本で引く。
               ずれている人だけ channel を web に固定して両方の鍵で引く（channel 固定
               なので横断ではない — LINE 側の発言は 1 件も入らない）。 */
            effectiveUserId === sessionId
              ? getRecentMessages(supabase, sessionId, "web")
              : getCrossChannelMessages(supabase, effectiveUserId, "web", 30, 3000, sessionId),
        createEmbedding(processedMessage, c.env),
      ]),
      TIMEOUT_PRE_PARALLEL_MS,
      "pre-parallel (saveMessage+history+embedding)",
    );
    history = fetchedHistory;
    embedding = emb;

    // 初回メッセージの場合、chat_started イベントを記録（fire-and-forget）
    if (fetchedHistory.length === 0) {
      recordBehaviorEvent(
        effectiveUserId, "web", "chat_started", {},
        c.env as Parameters<typeof recordBehaviorEvent>[4],
        supabase,
      ).catch((err) => console.warn("[web] chat_started event failed:", err instanceof Error ? err.message : err));
    }
  } catch (err) {
    console.error("webChatHandler pre-parallel error:", err);
    recordApiError(c.env, err instanceof Error ? err.message : String(err));
    return c.json({ error: "Internal server error" }, 500);
  }

  // SSE ストリーミングレスポンスを TransformStream で構築
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  /** SSE イベントをストリームに書き込む */
  function writeSSE(data: Record<string, unknown>) {
    writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
  }

  // ストリーミングエージェント実行（バックグラウンドで実行し、チャンクを即時送信）
  const streamingPromise = (async () => {
    // meta を onDone コールバック内で参照するために外側で宣言
    let meta: Awaited<ReturnType<typeof runAgentStreaming>> | null = null;
    try {
      console.log("[web] step=runAgentStreaming");

      const callbacks: StreamCallbacks = {
        onTextDelta: (text) => writeSSE({ type: "text_delta", content: text }),
        onProductCards: (products) => writeSSE({ type: "product_card", products }),
        onCartLink: (checkoutUrl) => writeSSE({ type: "cart_link", checkout_url: checkoutUrl }),
        onQuickReplies: (items) => writeSSE({ type: "quick_replies", items }),
        onDone: (fullResponse) => {
          const elapsed = Date.now() - tStart;
          console.log(`[web] step=runAgentStreaming done, total_elapsed=${elapsed}ms`);
          recordResponseTime(c.env, elapsed);

          // done イベント送信
          writeSSE({ type: "done", session_id: sessionId });

          // アシスタント応答を保存（メタデータ付き）
          const metadata: Record<string, unknown> = {};
          if (meta && meta.productCards.length > 0) metadata.product_cards = meta.productCards;
          if (meta && meta.quickReplies.length > 0) metadata.quick_replies = meta.quickReplies;

          c.executionCtx.waitUntil(
            saveMessage(supabase, {
              userId: sessionId,
              channel: "web",
              role: "assistant",
              content: fullResponse,
              ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
            }),
          );

          // 嗜好抽出パイプライン（fire-and-forget）
          const fullHistory = [
            ...history,
            { role: "user", content: processedMessage },
            { role: "assistant", content: fullResponse },
          ];
          c.executionCtx.waitUntil(
            runPreferencePipeline(fullHistory, effectiveUserId, "web", c.env, supabase),
          );
        },
        onError: (error) => writeSSE({ type: "error", message: error }),
      };

      meta = await runAgentStreaming(
        processedMessage,
        history,
        embedding,
        effectiveUserId,
        "web",
        c.env,
        callbacks,
        { isLinked: identityIsLinked },
      );
    } catch (err) {
      console.error("webChatHandler streaming error:", err);
      recordApiError(c.env, err instanceof Error ? err.message : String(err));
      try {
        writeSSE({ type: "error", message: "Internal server error" });
        writeSSE({ type: "done", session_id: sessionId });
      } catch { /* writer may already be closed */ }
    } finally {
      try { await writer.close(); } catch { /* ignore */ }
    }
  })();

  // waitUntil でストリーミング完了を保証（Workers がレスポンス送信後も実行を継続）
  c.executionCtx.waitUntil(streamingPromise);

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

/**
 * GET /api/chat/history
 *
 * クエリパラメータ:
 *   - session_id: セッション ID（必須）
 *   - channel: チャネルフィルター（任意: "line" | "web"、省略時は全チャネル for linked users）
 *   - keyword: 全文検索キーワード（任意、日本語対応 pg_trgm）
 *   - from: 日付範囲開始（任意、ISO-8601 形式）
 *   - to: 日付範囲終了（任意、ISO-8601 形式）
 *   - limit: 取得件数上限（任意、デフォルト 50、最大 200）
 *   - offset: 取得開始位置（任意、デフォルト 0）
 * レスポンス: { messages: [...], is_linked: boolean, total_count: number, limit: number, offset: number }
 */
export async function webChatHistoryHandler(c: Context<{ Bindings: Env }>) {
  const claimedSessionId = c.req.query("session_id");
  const channelFilter = c.req.query("channel") as "line" | "web" | undefined;
  const keyword = c.req.query("keyword") ?? null;
  const dateFrom = c.req.query("from") ?? null;
  const dateTo = c.req.query("to") ?? null;
  const limitParam = c.req.query("limit");
  const offsetParam = c.req.query("offset");

  const sessionError = validateSessionId(claimedSessionId);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  /* [SEC-3 前提] 履歴の読み出しも、**サーバが発行した session_id** でしか行わない。
     ここが素通しだと「他人の session_id を query に入れるだけでその人の Web 会話が
     読める」(QA 指摘 P2) がそのまま残る。理由は lib/chat-session.ts。 */
  const sessionResolution = await resolveUsableSessionId({
    claimedSessionId: claimedSessionId as string,
    proof: c.req.query("session_proof"),
    trusted: isTrustedServerCaller(c),
    secret: (c.env as { CHAT_SESSION_SECRET?: string }).CHAT_SESSION_SECRET,
  });
  if (!sessionResolution.proven) {
    console.warn(
      "[web] session not proven:",
      JSON.stringify({ route: "api/chat/history", reason: sessionResolution.reason }),
    );
  }
  const sessionId = sessionResolution.sessionId;

  // channel パラメータのバリデーション
  if (channelFilter && channelFilter !== "line" && channelFilter !== "web") {
    return c.json({ error: "channel must be 'line' or 'web'" }, 400);
  }

  // limit/offset バリデーション
  const limit = Math.min(Math.max(parseInt(limitParam ?? "100", 10) || 100, 1), 200);
  const offset = Math.max(parseInt(offsetParam ?? "0", 10) || 0, 0);

  // date バリデーション
  if (dateFrom && isNaN(Date.parse(dateFrom))) {
    return c.json({ error: "'from' must be a valid ISO-8601 date" }, 400);
  }
  if (dateTo && isNaN(Date.parse(dateTo))) {
    return c.json({ error: "'to' must be a valid ISO-8601 date" }, 400);
  }

  const supabase = createSupabaseClient(c.env);

  // Identity Resolver: unified_user_id を解決
  const identity = await resolveUnifiedUserId(supabase, sessionId as string, "web");

  // 検索対象の user_id 一覧を構築
  // Web メッセージは元の sessionId で保存されるため、sessionId 自体も必ず含める。
  // また shopify_customer_id でログイン時に web_session_id が更新されるため、
  // 過去の session_id で保存されたメッセージを取りこぼさないよう、
  // conversations テーブルから該当ユーザーの過去の web user_id も収集する。
  const userIds: string[] = [identity.isLinked ? identity.unifiedUserId : (sessionId as string)];

  // 現在の sessionId を常に含める（紐付け済みでも元の sessionId でメッセージが保存されているため）
  if (identity.isLinked && !userIds.includes(sessionId as string)) {
    userIds.push(sessionId as string);
  }

  // [SEC-B] クロスチャネル（LINE 側・別 session）履歴を返してよいか。
  // 既定は isLinked に従うが、所有関係が確認できない場合は下で false に落とす。
  let crossChannelAllowed = identity.isLinked;

  if (identity.isLinked) {
    const { data: identityData } = await supabase
      .from("user_identity_map")
      .select("unified_user_id, line_user_id, web_session_id, shopify_customer_id")
      .eq("unified_user_id", identity.unifiedUserId)
      .single();

    // [SEC-B] クロスチャネル履歴（LINE 側や別 session の履歴）を返す前に、
    // 「この session_id が本当にこの unified_user の登録 web セッションか」を検証する。
    // resolveUnifiedUserId は web_session_id === session_id でのみ isLinked を返すため
    // 通常はここで一致するが、多層防御として明示的に確認し、
    // 一致しない（=所有関係が確認できない）場合はクロスチャネル拡張を行わず、
    // 自 session の web 履歴のみに限定する（未検証でクロスチャネルを返さない）。
    const ownsIdentity =
      isTrustedServerCaller(c) || identityData?.web_session_id === sessionId;

    // 所有関係が確認できないときはクロスチャネル拡張を一切行わず、
    // userIds は自 session（sessionId）のみに保つ（= 自 session の web 履歴だけを返す）。
    if (ownsIdentity) {
      if (identityData?.line_user_id && !userIds.includes(identityData.line_user_id)) {
        userIds.push(identityData.line_user_id);
      }
      if (identityData?.web_session_id && !userIds.includes(identityData.web_session_id)) {
        userIds.push(identityData.web_session_id);
      }
      if (identityData?.shopify_customer_id && !userIds.includes(identityData.shopify_customer_id)) {
        userIds.push(identityData.shopify_customer_id);
      }

      // 過去の異なる session_id で保存された Web メッセージも取得するため、
      // conversations テーブルから該当 user_id の過去の web session を収集
      const { data: pastSessions } = await supabase
        .from("conversations")
        .select("user_id")
        .in("user_id", userIds)
        .eq("channel", "web")
        .limit(1);
      // pastSessions が空 = 現在の userIds では web メッセージが見つからない場合、
      // unified_user_id に紐づく全 conversations の user_id を幅広く取得
      if (!pastSessions || pastSessions.length === 0) {
        const { data: allWebMessages } = await supabase
          .from("conversations")
          .select("user_id")
          .eq("channel", "web")
          .in("user_id", [
            ...(identityData ? [
              identityData.unified_user_id,
              identityData.line_user_id,
              identityData.web_session_id,
              identityData.shopify_customer_id,
            ].filter((id): id is string => !!id) : []),
            sessionId as string,
          ])
          .limit(50);
        if (allWebMessages) {
          for (const row of allWebMessages) {
            if (!userIds.includes(row.user_id)) {
              userIds.push(row.user_id);
            }
          }
        }
      }
    }

    // 所有未確認のときは cross-channel を出さないよう、以降の channel フィルタも web に固定する。
    if (!ownsIdentity) {
      crossChannelAllowed = false;
    }
  }

  // 検索パラメータの有無を判定（keyword/date がある場合は RPC 検索を使用）
  const hasSearchParams = keyword || dateFrom || dateTo;

  let data: Array<{
    id?: string;
    role: string;
    content: string;
    channel: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
    total_count?: number;
  }> | null = null;
  let error: unknown = null;
  let totalCount = 0;

  if (hasSearchParams) {
    // RPC 検索: keyword, date range, pagination 対応
    const { data: rpcData, error: rpcError } = await supabase.rpc(
      "search_conversations",
      {
        user_ids: userIds,
        keyword: keyword || null,
        date_from: dateFrom ? new Date(dateFrom).toISOString() : null,
        date_to: dateTo ? new Date(dateTo).toISOString() : null,
        channel_filter: crossChannelAllowed ? (channelFilter ?? null) : (channelFilter ?? "web"),
        result_limit: limit,
        result_offset: offset,
      },
    );

    if (rpcError) {
      console.error("search_conversations RPC failed, falling back to basic query:", rpcError);
      // フォールバック: 基本クエリ（RPC 未作成の場合）
      const fallbackResult = await basicHistoryQuery(
        supabase, userIds, crossChannelAllowed, channelFilter, limit, offset,
      );
      data = fallbackResult.data;
      error = fallbackResult.error;
      totalCount = fallbackResult.data?.length ?? 0;
    } else {
      data = rpcData;
      totalCount = (rpcData && rpcData.length > 0) ? Number(rpcData[0].total_count) : 0;
    }
  } else {
    // 基本クエリ（従来互換 + pagination 対応）
    const effectiveChannel = crossChannelAllowed ? channelFilter : (channelFilter ?? "web");

    let query = supabase
      .from("conversations")
      .select("role, content, channel, metadata, created_at", { count: "exact" })
      .in("user_id", userIds);

    if (effectiveChannel) {
      query = query.eq("channel", effectiveChannel);
    }

    const result = await query
      .order("created_at", { ascending: true })
      .range(offset, offset + limit - 1);

    data = result.data;
    error = result.error;
    totalCount = result.count ?? data?.length ?? 0;
  }

  if (error) {
    console.error("Failed to fetch chat history:", error);
    return c.json({ error: "Failed to fetch history" }, 500);
  }

  const messages = (data ?? []).map((row) => ({
    role: row.role,
    content: row.content,
    channel: row.channel,
    created_at: row.created_at,
    ...(row.metadata?.product_cards
      ? { product_cards: row.metadata.product_cards }
      : {}),
    ...(row.metadata?.quick_replies
      ? { quick_replies: row.metadata.quick_replies }
      : {}),
  }));

  return c.json({
    messages,
    is_linked: crossChannelAllowed,
    total_count: totalCount,
    limit,
    offset,
  });
}

/**
 * 基本的な履歴クエリ（RPC フォールバック用）。
 * search_conversations RPC が利用不可の場合に使用。
 */
async function basicHistoryQuery(
  supabase: ReturnType<typeof createSupabaseClient>,
  userIds: string[],
  isLinked: boolean,
  channelFilter: "line" | "web" | undefined,
  limit: number,
  offset: number,
) {
  const effectiveChannel = isLinked ? channelFilter : (channelFilter ?? "web");

  let query = supabase
    .from("conversations")
    .select("role, content, channel, metadata, created_at")
    .in("user_id", userIds);

  if (effectiveChannel) {
    query = query.eq("channel", effectiveChannel);
  }

  return query
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
}

// ---------------------------------------------------------------------------
// Feedback endpoints
// ---------------------------------------------------------------------------

/**
 * POST /api/chat/feedback
 *
 * リクエストボディ: { session_id, message_content, rating: 1|-1, comment?: string }
 * レスポンス: { success: true }
 */
export async function webChatFeedbackHandler(c: Context<{ Bindings: Env }>) {
  let body: {
    session_id?: string;
    message_content?: string;
    rating?: number;
    comment?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { session_id, message_content, rating, comment } = body;

  // session_id バリデーション
  const sessionError = validateSessionId(session_id);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  // rating バリデーション
  if (rating !== 1 && rating !== -1) {
    return c.json({ error: "rating must be 1 or -1" }, 400);
  }

  // message_content バリデーション
  if (typeof message_content !== "string" || message_content.trim().length === 0) {
    return c.json({ error: "message_content is required" }, 400);
  }

  const supabase = createSupabaseClient(c.env);

  // session_id から user_id を解決
  const identity = await resolveUnifiedUserId(supabase, session_id as string, "web");
  const userId = identity.unifiedUserId;

  // message_feedback テーブルに保存
  const { error } = await supabase.from("message_feedback").insert({
    user_id: userId,
    channel: "web",
    message_content: message_content.trim(),
    rating,
    comment: comment?.trim() || null,
  });

  if (error) {
    console.error("Failed to save feedback:", error);
    return c.json({ error: "Failed to save feedback" }, 500);
  }

  // rating = -1 の場合、Slack に通知
  if (rating === -1) {
    c.executionCtx.waitUntil(
      sendNegativeFeedbackAlert(c.env, userId, message_content.trim(), comment?.trim()),
    );
  }

  // 行動イベント記録（fire-and-forget）
  c.executionCtx.waitUntil(
    recordBehaviorEvent(
      userId, "web", "feedback_given",
      { query: rating === 1 ? "positive" : "negative" },
      c.env as Parameters<typeof recordBehaviorEvent>[4],
      supabase,
    ).catch((err) => console.warn("[web] feedback_given event failed:", err instanceof Error ? err.message : err)),
  );

  return c.json({ success: true });
}

/**
 * POST /api/chat/image
 *
 * 画像付きチャットメッセージを処理する。
 * リクエスト: multipart/form-data (image: File, session_id: string, message?: string, shopify_customer_id?: string)
 * レスポンス: JSON { response: string, ... }
 */
export async function webChatImageHandler(c: Context<{ Bindings: Env }>) {
  // レートリミット: 信頼済み proxy (X-API-Key 検証済み) 由来のときだけ転送された実 IP を採用
  const clientIp = getClientIp(c.req.raw, isTrustedServerCaller(c));
  const rateLimitError = checkRateLimit(clientIp);
  if (rateLimitError) {
    return c.json({ error: rateLimitError }, 429);
  }

  // multipart/form-data パース
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "Invalid form data" }, 400);
  }

  const imageFile = formData.get("image") as File | null;
  const sessionId = formData.get("session_id") as string | null;
  const message = (formData.get("message") as string | null)?.trim() || "";
  const shopifyCustomerId = formData.get("shopify_customer_id") as string | null;

  // バリデーション
  const sessionError = validateSessionId(sessionId);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  if (!imageFile || !(imageFile instanceof File)) {
    return c.json({ error: "image file is required" }, 400);
  }

  // 画像サイズ制限 (5MB)
  if (imageFile.size > 5 * 1024 * 1024) {
    return c.json({ error: "Image must be less than 5MB" }, 400);
  }

  // MIME タイプチェック
  const validTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
  if (!validTypes.includes(imageFile.type)) {
    return c.json({ error: "Image must be JPEG, PNG, WebP, or GIF" }, 400);
  }

  const supabase = createSupabaseClient(c.env);
  const tStart = Date.now();

  try {
    // 画像を base64 に変換
    const arrayBuffer = await imageFile.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const mediaType = imageFile.type === "image/png" ? "image/png" as const : "image/jpeg" as const;

    // [SEC-B] shopify_customer_id はサーバ経由（X-API-Key 検証済み）のときだけ信頼する。
    const trustedCustomerId = isTrustedServerCaller(c) ? shopifyCustomerId : null;

    // Identity 解決
    const identity = trustedCustomerId
      ? await resolveWithShopifyCustomerId(supabase, trustedCustomerId, sessionId as string)
      : await resolveUnifiedUserId(supabase, sessionId as string, "web");
    const effectiveUserId = identity.unifiedUserId;
    // [SEC-3] クロスチャネル個人データはライブ検証済みの信頼経路
    // （trustedCustomerId 由来）のときだけ開く（生の web_session_id 一致では開かない）。
    const crossChannelAllowed = crossChannelHistoryAllowed(
      identity.isLinked,
      !!trustedCustomerId,
    );

    // メッセージ保存
    await saveMessage(supabase, {
      userId: sessionId as string,
      channel: "web",
      role: "user",
      content: message || "[画像メッセージ]",
    });

    // 履歴取得
    // Stage 2: [SEC-3] ゲートはそのまま。横断してよいと決まった人だけ、読む user_id を
    //   canonical 解決の分だけ増やす（テキスト側と同じ扱い）。
    const canonical = crossChannelAllowed
      ? await resolveCanonicalUserRefs(supabase, webSeed(sessionId as string))
      : { userRefs: [] as string[] };
    const history = crossChannelAllowed
      ? await getCrossChannelMessages(
          supabase,
          effectiveUserId,
          undefined,
          30,
          3000,
          sessionId as string,
          canonical.userRefs,
        )
      : await getRecentMessages(supabase, effectiveUserId, "web");

    // 空の Embedding（画像メッセージではナレッジ検索をスキップ）
    const embedding = new Array(1536).fill(0);

    // エージェント実行（画像付き）
    const imagePrompt = message || "この画像について教えてください。";
    const result = await withTimeout(
      runAgent(
        imagePrompt,
        history,
        embedding,
        effectiveUserId,
        "web",
        c.env,
        { isLinked: crossChannelAllowed, imageContent: { base64, mediaType } },
      ),
      TIMEOUT_RUN_AGENT_MS,
      "runAgent (image)",
    );

    const elapsed = Date.now() - tStart;
    recordResponseTime(c.env, elapsed);

    // 応答保存
    c.executionCtx.waitUntil(
      saveMessage(supabase, {
        userId: sessionId as string,
        channel: "web",
        role: "assistant",
        content: result.response,
      }),
    );

    return c.json({
      response: result.response,
      session_id: sessionId,
      ...(result.productCards && result.productCards.length > 0
        ? { product_cards: result.productCards }
        : {}),
      ...(result.quickReplies && result.quickReplies.length > 0
        ? { quick_replies: result.quickReplies }
        : {}),
    });
  } catch (err) {
    console.error("webChatImageHandler error:", err);
    recordApiError(c.env, err instanceof Error ? err.message : String(err));
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * GET /api/chat/feedback/stats
 *
 * クエリパラメータ: session_id（必須）
 * レスポンス: { total, positive, negative, positive_rate }
 */
export async function webChatFeedbackStatsHandler(c: Context<{ Bindings: Env }>) {
  const sessionId = c.req.query("session_id");
  const sessionError = validateSessionId(sessionId);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  const supabase = createSupabaseClient(c.env);
  const identity = await resolveUnifiedUserId(supabase, sessionId as string, "web");
  const userId = identity.unifiedUserId;

  const { data, error } = await supabase
    .from("message_feedback")
    .select("rating")
    .eq("user_id", userId);

  if (error) {
    console.error("Failed to fetch feedback stats:", error);
    return c.json({ error: "Failed to fetch stats" }, 500);
  }

  const total = data?.length ?? 0;
  const positive = data?.filter((r) => r.rating === 1).length ?? 0;
  const negative = data?.filter((r) => r.rating === -1).length ?? 0;
  const positiveRate = total > 0 ? Math.round((positive / total) * 100) / 100 : 0;

  return c.json({
    total,
    positive,
    negative,
    positive_rate: positiveRate,
  });
}

// ---------------------------------------------------------------------------
// Behavior event endpoint
// ---------------------------------------------------------------------------

/** 有効なイベントアクション（Web クライアントから送信可能なもの） */
const VALID_WEB_EVENTS: BehaviorAction[] = [
  "chat_started",
  "product_viewed",
  "cart_link_clicked",
  "feedback_given",
  "survey_completed",
];

/**
 * POST /api/chat/event
 *
 * Web アプリからの行動イベントを Firestore に記録する。
 * リクエストボディ: { session_id, action, metadata?: { productId?, contentId?, ... } }
 * レスポンス: { success: true }
 */
export async function webChatEventHandler(c: Context<{ Bindings: Env }>) {
  let body: {
    session_id?: string;
    shopify_customer_id?: string;
    action?: string;
    metadata?: BehaviorEventMetadata;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { session_id, shopify_customer_id, action, metadata } = body;

  // バリデーション
  const sessionError = validateSessionId(session_id);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  const supabase = createSupabaseClient(c.env);

  if (!action || !VALID_WEB_EVENTS.includes(action as BehaviorAction)) {
    // E1「出来事は捨てない」— **語彙に無い action でも L0 には積む**。
    //
    //   ここは cx-agent 側で唯一「語彙が合わないという理由だけで出来事を捨てていた」
    //   場所である。捨てられた側は何も残らないので、送り手がずれたことに誰も気づけない
    //   （web-app の durationSeconds が数か月落ち続けたのと同じ壊れ方）。
    //
    //   ⚠ 応答は 400 のまま変えない。応答コードは既存クライアントとの契約であり、
    //     Stage 1 の完了条件は「既存の挙動が 1 つも変わらない」ことだから。
    //     E1 が守りたいのは出来事が消えることで、それは積んだ時点で守られている。
    //     400 を落とすのは語彙が L0 の登録簿へ一本化されたあと（Stage 4）。進捗は
    //     ratchet `event-vocabulary-drop-sites`（1 → 0）が固定する。
    if (action && session_id) {
      const occurredAt = new Date().toISOString();
      c.executionCtx.waitUntil(
        recordCustomerEvent(supabase, {
          // 形が壊れている値はここで落ちる（gateway が理由付きで数える）。
          eventType: behaviorEventType(action),
          channel: "web",
          identifier: { kind: "web_session_id", value: session_id },
          dedupe: `rejected@${occurredAt}`,
          source: "cx-agent.web-chat-event",
          occurredAt,
          payload: { rejected_by_legacy_vocabulary: true },
        }),
      );
    }
    return c.json({ error: `Invalid action. Valid actions: ${VALID_WEB_EVENTS.join(", ")}` }, 400);
  }

  // fire-and-forget で記録（レスポンスをブロックしない）
  // [SEC-B] shopify_customer_id はサーバ経由（X-API-Key 検証済み）のときだけ identity として採用する。
  // ブラウザ自己申告（X-API-Key 無し）の customer_id は無視し、匿名 session_id に紐付ける。
  const userId = effectiveEventUserId(
    isTrustedServerCaller(c),
    shopify_customer_id,
    session_id as string,
  );

  c.executionCtx.waitUntil(
    recordBehaviorEvent(
      userId,
      "web",
      action as BehaviorAction,
      metadata ?? {},
      c.env as Parameters<typeof recordBehaviorEvent>[4],
      supabase,
    ).catch((err) => {
      console.warn("[event] recordBehaviorEvent failed:", err instanceof Error ? err.message : err);
    }),
  );

  return c.json({ success: true });
}
