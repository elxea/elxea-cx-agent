/**
 * Web Chat 認証・レートリミット。
 *
 * 初期実装: session_id の UUID 形式バリデーション + IP ベースレートリミット。
 * 将来: Shopify OAuth トークン検証を追加予定。
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
 * Cloudflare Workers のリクエストからクライアント IP を取得する。
 * cf オブジェクトの connectingIp、または CF-Connecting-IP ヘッダーにフォールバック。
 */
export function getClientIp(req: Request): string {
  // Cloudflare Workers の cf プロパティ
  const cf = (req as unknown as { cf?: { connectingIp?: string } }).cf;
  if (cf?.connectingIp) {
    return cf.connectingIp;
  }

  // フォールバック: CF-Connecting-IP ヘッダー
  return req.headers.get("cf-connecting-ip") ?? "unknown";
}
