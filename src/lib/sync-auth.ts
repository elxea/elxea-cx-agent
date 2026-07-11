/**
 * Sync API 認証 -- 共通ヘルパー（X-API-Key / SYNC_API_SECRET）
 *
 * サーバ間（server-to-server）呼び出し専用のエンドポイントを保護する。
 * LINE Login callback / Next.js API proxy 等、秘密値を保持できる呼び出し元だけが
 * 通過できる。ブラウザから直接叩かれる公開エンドポイント（chat/event・LIFF follow-ref 等）
 * には使わない（秘密値をクライアントに置けないため）。
 *
 * 方針:
 *  - fail-closed: サーバに SYNC_API_SECRET が未設定なら、常に拒否する。
 *  - 一致判定は既存の link-line / alerts / sync ハンドラと同じ単純比較で統一。
 */
import type { Context, Env as HonoEnv } from "hono";

/**
 * X-API-Key（提供値）が SYNC_API_SECRET（サーバ秘密）と一致するか判定する純粋関数。
 *
 * fail-closed:
 *  - secret 未設定（undefined / 空文字）→ 常に false（誤設定で無認証開放しない）
 *  - providedKey 未指定 → false
 *
 * @returns 一致すれば true。
 */
export function isValidSyncApiKey(
  providedKey: string | null | undefined,
  secret: string | undefined,
): boolean {
  // fail-closed: サーバに secret が無ければ、どんな入力でも拒否する
  if (!secret) return false;
  if (!providedKey) return false;
  return providedKey === secret;
}

/**
 * Hono ハンドラ冒頭で呼ぶ認証ガード。
 *
 * X-API-Key ヘッダーが SYNC_API_SECRET と一致しなければ 401 Response を返す。
 * 一致（かつ secret 設定済み）なら null を返す。呼び出し側は次のように使う:
 *
 *   const unauthorized = requireSyncApiKey(c);
 *   if (unauthorized) return unauthorized;
 *
 * @returns 認証失敗なら 401 Response。成功なら null。
 */
export function requireSyncApiKey<E extends HonoEnv>(
  c: Context<E>,
): Response | null {
  const apiKey = c.req.header("X-API-Key");
  const secret = (c.env as { SYNC_API_SECRET?: string }).SYNC_API_SECRET;
  if (!isValidSyncApiKey(apiKey, secret)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return null;
}
