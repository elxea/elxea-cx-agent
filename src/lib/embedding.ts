import type { Env } from "../index";

/**
 * Cloudflare Workers AI で テキストを埋め込みベクトルに変換。
 * @cf/baai/bge-m3 を使用（多言語対応、1024 次元）。
 *
 * Workers AI が利用不可・結果が空の場合はゼロベクトルを返す
 * （検索精度は落ちるが、エンドポイント全体のハングを防止する）。
 */
export async function createEmbedding(
  text: string,
  env: Env,
): Promise<number[]> {
  try {
    const result = await env.AI.run("@cf/baai/bge-m3", {
      text: [text],
    }) as { data?: number[][] };

    if (result?.data?.[0]?.length) {
      return result.data[0];
    }

    console.error("createEmbedding: AI returned empty result", JSON.stringify(result));
    return new Array(1024).fill(0);
  } catch (err) {
    console.error("createEmbedding failed, using zero vector:", err);
    return new Array(1024).fill(0);
  }
}
