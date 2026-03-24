import type { Env } from "../index";

// ---------------------------------------------------------------------------
// Embedding キャッシュ（同一 isolate 内で有効）
// 頻出クエリ（「おすすめ」「送料」等）の Embedding 再生成を回避し、
// Workers AI 呼び出しを節約する。LRU 方式で最大 100 エントリ。
// ---------------------------------------------------------------------------

const EMBEDDING_CACHE_MAX_SIZE = 100;

/** キャッシュエントリ: ベクトル + 最終アクセス時刻 */
type CacheEntry = { vector: number[]; accessedAt: number };

const embeddingCache = new Map<string, CacheEntry>();

/**
 * キャッシュキーを生成する。テキストを正規化（trim + 小文字）して
 * 同義の入力でキャッシュヒットするようにする。
 */
function cacheKey(text: string): string {
  return text.trim().toLowerCase();
}

/** LRU 方式でキャッシュサイズを上限内に維持する */
function evictIfNeeded(): void {
  if (embeddingCache.size <= EMBEDDING_CACHE_MAX_SIZE) return;

  // 最もアクセスが古いエントリを削除
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of embeddingCache) {
    if (entry.accessedAt < oldestTime) {
      oldestTime = entry.accessedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    embeddingCache.delete(oldestKey);
  }
}

/**
 * Cloudflare Workers AI で テキストを埋め込みベクトルに変換。
 * @cf/baai/bge-m3 を使用（多言語対応、1024 次元）。
 *
 * Workers AI が利用不可・結果が空の場合はゼロベクトルを返す
 * （検索精度は落ちるが、エンドポイント全体のハングを防止する）。
 *
 * 同一テキストの Embedding はインメモリキャッシュから返す（LRU、最大 100 件）。
 */
export async function createEmbedding(
  text: string,
  env: Env,
): Promise<number[]> {
  const key = cacheKey(text);

  // キャッシュヒット
  const cached = embeddingCache.get(key);
  if (cached) {
    cached.accessedAt = Date.now();
    console.log("[embedding] cache hit");
    return cached.vector;
  }

  try {
    const result = await env.AI.run("@cf/baai/bge-m3", {
      text: [text],
    }) as { data?: number[][] };

    if (result?.data?.[0]?.length) {
      const vector = result.data[0];
      // キャッシュに保存
      embeddingCache.set(key, { vector, accessedAt: Date.now() });
      evictIfNeeded();
      return vector;
    }

    console.error("createEmbedding: AI returned empty result", JSON.stringify(result));
    return new Array(1024).fill(0);
  } catch (err) {
    console.error("createEmbedding failed, using zero vector:", err);
    return new Array(1024).fill(0);
  }
}
