/**
 * @layer CDP
 *
 * ULID — 発行制 subject_id の生成（CDP 統合 Stage 1 / 設計 §3-1）。
 *
 * ─ なぜ UUID ではなく ULID か ─
 *   時刻が先頭に来るので、B-tree index に素直に載る（挿入が末尾に寄る）。
 *   26 文字・Crockford base32 なので、ログや SQL に貼っても読み違えにくい
 *   （I / L / O / U を使わない = 1 と l、0 と O の取り違えが起きない）。
 *
 * ─ なぜ「無意味」であることが要件か ─
 *   subject_id は表示しない・URL に出さない（設計 §3-1）。中身から人が推測できる
 *   情報を持たないことが、借りた鍵（LINE userId / 顧客番号）と決定的に違う点。
 *   時刻だけは含むが、これは「いつ初めて観測したか」であって本人の属性ではない。
 *
 * ─ Workers 互換 ─
 *   crypto.getRandomValues のみを使う（Node 専用 API を使わない）。
 */

/** Crockford base32（I / L / O / U を除く 32 文字）。 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 040 の CHECK 制約と同じ形。ここと SQL の 2 か所にあるが、片方が緩んでも DB 側が落とす。 */
export const ULID_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/** 48bit のミリ秒を 10 文字へ。 */
function encodeTime(ms: number): string {
  let n = Math.floor(ms);
  let out = "";
  for (let i = 0; i < 10; i += 1) {
    out = CROCKFORD[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

/** 80bit の乱数を 16 文字へ。 */
function encodeRandom(random: Uint8Array): string {
  let out = "";
  for (let i = 0; i < 16; i += 1) {
    // 1 バイトから 5bit を取り出す（16 文字 × 5bit = 80bit）。
    out += CROCKFORD[random[i] % 32];
  }
  return out;
}

/**
 * ULID を 1 つ発行する。
 *
 * @param now テスト用の時刻注入。省略時は Date.now()。
 * @param randomBytes テスト用の乱数注入。省略時は crypto.getRandomValues。
 */
export function newSubjectId(
  now: number = Date.now(),
  randomBytes?: Uint8Array,
): string {
  const bytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(16));
  return encodeTime(now) + encodeRandom(bytes);
}

/** 受け取った文字列が subject_id の形をしているか（DB に投げる前の早期検出）。 */
export function isSubjectId(value: unknown): value is string {
  return typeof value === "string" && ULID_RE.test(value);
}
