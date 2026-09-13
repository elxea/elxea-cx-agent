/**
 * 共通ユーティリティ関数
 */

/** Promise にタイムアウトを設定するユーティリティ */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

/**
 * 非同期ストリームの反復に「期限」を掛けるラッパー。
 *
 * `for await` は 1 回の `next()` が返らない限り待ち続けるため、Promise の解決
 * （＝ストリーム確立）にだけタイムアウトを掛けても本文受信ループは無制限になる。
 * ここでは各 `next()` を「期限までの残り時間」で打ち切り、期限超過時は購読側の
 * AbortController を叩いて接続を解放してから例外を投げる。
 *
 * @param stream    反復対象（Anthropic SDK の Stream 等。controller があれば abort する）
 * @param deadlineAt 期限の絶対時刻（Date.now() ベースの epoch ms）
 * @param label     タイムアウト例外に載せる識別子
 */
export async function* iterateWithDeadline<T>(
  stream: AsyncIterable<T> & { controller?: { abort: () => void } },
  deadlineAt: number,
  label: string,
): AsyncGenerator<T> {
  const iter = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const remaining = Math.max(0, deadlineAt - Date.now());
      const step = await withTimeout(iter.next(), remaining, label);
      if (step.done) return;
      yield step.value;
    }
  } catch (err) {
    try { stream.controller?.abort(); } catch { /* 解放に失敗しても元の例外を優先する */ }
    throw err;
  }
}
