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

  const expected = normalizeSecret(secret);
  /* 空白だけの secret は「未設定」と同じ。trim した結果が空になったものを
     突き合わせに使うと、空白 1 文字を送れば通ってしまう。 */
  if (expected === "") return false;

  return constantTimeEquals(normalizeSecret(providedKey), expected);
}

/**
 * 比較の前に両側の前後空白を落とす。
 *
 * ## なぜ trim するのか（2026-08-30 の本番障害の再発防止）
 *
 * 呼び出し元の web-app は `lib/config/spec.ts` で `SYNC_API_SECRET` を
 * `optionalTrimmed()` として読む ＝ **送る側は必ず trim 済み**。ところがこちらは
 * 生の値と `===` で突き合わせていた。この非対称のせいで、Worker 側の secret に
 * 末尾改行が 1 文字混ざるだけで **どう頑張っても一致しない 401** が生まれる。
 * `wrangler secret put` に `echo` を使うと改行が付くので、これは操作ミスというより
 * 待ち構えている落とし穴である（2026-08-22 の LINE Channel Secret 障害と同型で、
 * `lib/env.ts` の `readSecretEnvTrimmed` は web-app 側で同じ結論に達している）。
 *
 * ⚠ これは認証を緩めない。落とすのは前後の空白だけで、共有秘密が空白だけ違う 2 つの
 *   値を持つことに意味は無い（むしろ事故の形でしかない）。中身が 1 文字でも違えば
 *   従来どおり拒否する。
 */
function normalizeSecret(value: string): string {
  return value.trim();
}

/**
 * 長さと内容を、**入力に依存しない時間で**突き合わせる。
 *
 * `===` は最初の不一致文字で打ち切るため、比較に掛かった時間が「どこまで合っていたか」
 * を漏らす。共有秘密の照合でそれを残す理由が無いので、全文字を必ず走査する形にする。
 * 長さの違いも早期 return せず、xor に畳んでから 1 回だけ判定する。
 */
function constantTimeEquals(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
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
 * ## 拒否したことを必ずログに残す（沈黙させない）
 *
 * この 401 は**両側から見えない失敗**だった。web-app 側は
 * `[line-linkage-status] reverse lookup returned 401` としか書けず（応答本文は
 * `{"error":"Unauthorized"}` だけなので理由が分からない）、cx-agent 側は何も
 * 出していなかった。結果、鍵がずれたときに残る痕跡はどこにも無く、症状だけが
 * 「連携済みのお客さまのマイページが未連携に見える」という形で表に出た。
 *
 * ローテートで鍵が片側だけ更新される・末尾に改行が紛れる、といった壊れ方は
 * 実際に起きている（2026-08-22 の LINE Channel Secret 障害と同型）。理由まで
 * 書き分けておけば `wrangler tail` で即座に切り分けられる。
 *
 * ⚠ **鍵の値・長さ・先頭数文字は出さない**。出るのは「なぜ弾いたか」の分類だけ。
 *   応答は従来どおり `{"error":"Unauthorized"}` のまま変えない（呼び出し元に
 *   理由を返すと、鍵の有無を外から探れる）。
 */
export function requireSyncApiKey<E extends HonoEnv>(
  c: Context<E>,
): Response | null {
  const apiKey = c.req.header("X-API-Key");
  const secret = (c.env as { SYNC_API_SECRET?: string }).SYNC_API_SECRET;
  if (!isValidSyncApiKey(apiKey, secret)) {
    /* 3 つの壊れ方は原因も対処も違う:
     *   secret-unset  … この Worker に SYNC_API_SECRET が無い（デプロイ/環境の事故）
     *   key-absent    … 呼び出し側がヘッダーを付けていない（配線の事故）
     *   key-mismatch  … 両側に鍵はあるが違う（ローテートの片側漏れ・改行混入） */
    const reason = !secret
      ? "secret-unset"
      : !apiKey
        ? "key-absent"
        : "key-mismatch";

    console.warn(
      `[sync-auth] rejected server-to-server request: reason=${reason} path=${c.req.path ?? "(unknown)"}`,
    );
    return c.json({ error: "Unauthorized" }, 401);
  }
  return null;
}
