import type { Env } from "../index";

/**
 * 型安全に環境変数を取得するヘルパー。
 * Cloudflare Workers では c.env 経由でアクセスする。
 */
// 文字列でない束縛 (Workers AI / Analytics Engine の記録先) は対象外。
export function getEnv(env: Env, key: Exclude<keyof Env, "AI" | "STORE_TAP_EVENTS">): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
}
