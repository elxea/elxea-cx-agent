import type { Env } from "../index";

/**
 * 型安全に環境変数を取得するヘルパー。
 * Cloudflare Workers では c.env 経由でアクセスする。
 */
export function getEnv(env: Env, key: Exclude<keyof Env, "AI">): string {
  const value = env[key];
  if (!value) {
    throw new Error(`Missing environment variable: ${key}`);
  }
  return value;
}
