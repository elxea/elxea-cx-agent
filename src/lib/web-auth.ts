/**
 * Web Chat 認証・レートリミット。
 *
 * - session_id: UUID v4 形式のバリデーション
 * - shopify_customer_id: Shopify GID 形式の検証（ログイン済みユーザー）
 * - IP ベースレートリミット
 */

/** UUID v4 形式のバリデーション */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * session_id を検証する。
 * @returns null なら有効。文字列ならエラーメッセージ。
 */
export function validateSessionId(sessionId: unknown): string | null {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return "session_id is required";
  }
  if (!UUID_REGEX.test(sessionId)) {
    return "session_id must be a valid UUID v4";
  }
  return null;
}

/**
 * IP ベースのレートリミット（インメモリ）。
 *
 * Cloudflare Workers はリクエストごとにインスタンスが再利用される場合があるため、
 * Map は同一 isolate 内でのみ有効。完全な分散レートリミットには
 * Durable Objects or KV が必要だが、初期実装としては十分。
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

/** レートリミット設定 */
const RATE_LIMIT_WINDOW_MS = 60_000; // 1分
const RATE_LIMIT_MAX_REQUESTS = 10; // 10req/min

/**
 * IP アドレスに基づくレートリミットチェック。
 * @returns null なら許可。文字列ならエラーメッセージ。
 */
/** Map サイズ上限（H-2 メモリリーク対策） */
const RATE_LIMIT_MAP_MAX_SIZE = 10_000;

export function checkRateLimit(ip: string): string | null {
  const now = Date.now();

  // Map サイズが上限を超えたら期限切れエントリを掃除
  if (rateLimitMap.size > RATE_LIMIT_MAP_MAX_SIZE) {
    for (const [key, val] of rateLimitMap) {
      if (now >= val.resetAt) {
        rateLimitMap.delete(key);
      }
    }
    // 掃除後もまだ上限超えなら、最も古いエントリを半分削除
    if (rateLimitMap.size > RATE_LIMIT_MAP_MAX_SIZE) {
      const toDelete = Math.floor(rateLimitMap.size / 2);
      let deleted = 0;
      for (const key of rateLimitMap.keys()) {
        if (deleted >= toDelete) break;
        rateLimitMap.delete(key);
        deleted++;
      }
    }
  }

  const entry = rateLimitMap.get(ip);

  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return null;
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return "Rate limit exceeded. Please wait a moment before sending another message.";
  }

  return null;
}

/**
 * Shopify Customer GID 形式のバリデーション。
 *
 * Shopify Customer Account API は `gid://shopify/Customer/<numeric_id>` 形式の ID を返す。
 * null/undefined は未ログインとして許可する（optional フィールド）。
 * 文字列が渡された場合は形式を検証する。
 *
 * @returns null なら有効（未指定 or 正しい形式）。文字列ならエラーメッセージ。
 */
const SHOPIFY_GID_REGEX = /^gid:\/\/shopify\/Customer\/\d+$/;

export function validateShopifyCustomerId(
  customerId: unknown,
): string | null {
  // 未指定は OK（未ログインユーザー）
  if (customerId === undefined || customerId === null || customerId === "") {
    return null;
  }
  if (typeof customerId !== "string") {
    return "shopify_customer_id must be a string";
  }
  if (!SHOPIFY_GID_REGEX.test(customerId)) {
    return "shopify_customer_id must be a valid Shopify Customer GID (gid://shopify/Customer/<id>)";
  }
  return null;
}

/**
 * Cloudflare Workers のリクエストからクライアント IP を取得する。
 *
 * 既定 (直叩き) では cf.connectingIp / CF-Connecting-IP を使う。これは Cloudflare が
 * 自身で上書きする「接続元 (直接ピア) の IP」で、クライアントからは詐称できない。
 *
 * [B2 転送元 IP レート制限] elxea-web-app のチャットを Next.js サーバ経由 (proxy) に
 * 変更したため、cx-agent から見た接続元 IP は Vercel の egress IP に集約される。
 * その IP をレートリミットのキーにすると全ユーザーが 1 バケットに束ねられ、
 * 正規ユーザーが誤ってブロックされる / 逆に効かない。
 *
 * [なりすまし防止 = fail-closed] X-Forwarded-For / X-Real-Client-IP は誰でも詐称できる
 * ため、無条件では絶対に信用しない。信頼済み proxy 由来 (trustedProxy=true = 呼び出し側で
 * X-API-Key が SYNC_API_SECRET と一致検証済み。isTrustedServerCaller と同一の信頼境界)
 * のときだけ、proxy が付与した実クライアント IP を採用する。ブラウザ直叩き (trustedProxy=false)
 * では転送ヘッダを一切読まず cf.connectingIp にフォールバックするので、攻撃者が
 * ヘッダを詐称してもレートリミットのキーを操作できない (SEC-B と同じ設計)。
 *
 * proxy 契約 (elxea-web-app lib/chat/proxy.ts): trusted=true のときだけ
 * X-Real-Client-IP と X-Forwarded-For に「実クライアント IP 単体」を付与する。
 * X-Real-Client-IP は proxy 専用の単値ヘッダ (Cloudflare は触らない) なので最優先。
 * X-Forwarded-For は Cloudflare が接続元 (Vercel egress) を追記しうるため、
 * proxy が先頭に置く実クライアント IP = 最左要素を採用する。
 *
 * @param trustedProxy 呼び出し側で X-API-Key を検証済みの信頼済み proxy 呼び出しか。
 */
export function getClientIp(req: Request, trustedProxy = false): string {
  // 信頼済み proxy 由来のときだけ、転送された実クライアント IP を採用する (fail-closed)。
  if (trustedProxy) {
    // proxy 専用の単値ヘッダ (Cloudflare 非改変) を最優先。
    const realClientIp = firstIp(req.headers.get("x-real-client-ip"));
    if (realClientIp) return realClientIp;
    // フォールバック: X-Forwarded-For の最左 (proxy が置いた実クライアント IP)。
    const forwardedIp = firstIp(req.headers.get("x-forwarded-for"));
    if (forwardedIp) return forwardedIp;
  }

  // 直叩き or 転送ヘッダ不在: Cloudflare が上書きする詐称不能な接続元 IP を使う。
  const cf = (req as unknown as { cf?: { connectingIp?: string } }).cf;
  if (cf?.connectingIp) {
    return cf.connectingIp;
  }

  // フォールバック: CF-Connecting-IP ヘッダー
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}

/** カンマ区切りヘッダの最左要素をトリムして返す。空なら null。 */
function firstIp(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const ip = headerValue.split(",")[0]?.trim();
  return ip ? ip : null;
}
