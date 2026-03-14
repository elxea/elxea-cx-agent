import type { Env } from "../index";

/**
 * Cloudflare Workers AI で テキストを埋め込みベクトルに変換。
 * @cf/baai/bge-m3 を使用（多言語対応、1024 次元）。
 */
export async function createEmbedding(
  text: string,
  env: Env,
): Promise<number[]> {
  const result = await env.AI.run("@cf/baai/bge-m3", {
    text: [text],
  }) as { data: number[][] };

  return result.data[0];
}
