/**
 * assert-not-prod — 本番リソースへの接続・本番送信を fail-closed で拒否する共有ガード。
 *
 * 設計 §2-5 の中核ルール:「安全は各テストの善意に頼らず、共有ガード import を必須化して機械で固定」。
 * QA caveat（PASS-with-caveats の主 caveat）への対応: 本ガードを「任意」でなく「強制」にする。
 *   → 全ネットワーク可能テストは tests/lib/hermetic.ts の installHermeticFetch を必ず通り、
 *     install 時に assertNotProdEnv、各 outbound で assertNotProdUrl が走る。
 *     ゆえに本モジュールを import せずにネットワークへ出ることは構造的に不可能。
 *
 * ハーメティックテストは実ネットワークを使わない設計だが、万一 URL/ENV が本番を指した場合に
 *   その瞬間に throw して以降を止める「最終防波堤」として機能する。
 */

/** 本番 Supabase プロジェクト ref（設計 §5・staging=espeokdhutgztksdrpzt と対で管理）。 */
export const PROD_SUPABASE_REF = "bquqzrbzdzjegdovxalu";

/** 本番 LINE 公式アカウント（OA）ID。 */
export const PROD_OA_ID = "@307tzhkw";

/**
 * 本番 Worker ホスト（URL 誤爆防止・ブラックリスト側の保険）。
 * 宛先判定の主役は下の ALLOWED_TEST_* ホワイトリスト。本リストは
 * 「第三者ホストの文字列内に本番 Worker が混入した」ようなケースを拾う二重ガード。
 */
export const PROD_WORKER_HOSTS = [
  "elxea-agent.setaka1103.workers.dev",
  "elxea-agent.elxea.workers.dev",
  "elxea-agent.setaka-on.workers.dev",
];

/**
 * 正規の staging Worker ホスト（workers.dev サブドメインは `setaka-on` の 1 本のみ実在する。
 * `setaka1103` / `elxea` は NXDOMAIN の誤記載であり、本 SoT に載せない）。
 */
export const STAGING_WORKER_HOST = "elxea-agent-staging.setaka-on.workers.dev";

/** テストが宛先にしてよい唯一のリモート Worker ベース URL。 */
export const STAGING_WORKER_BASE_URL = `https://${STAGING_WORKER_HOST}`;

/** ローカル実行（wrangler dev / miniflare）で許可するホスト。 */
export const ALLOWED_LOCAL_HOSTS = ["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "::1"];

/**
 * 宛先ホストがテストで許可されているか（**ホワイトリスト方式**）。
 * 許可は「staging Worker（version preview 含む）」と「localhost 相当」のみ。
 * 新しい本番ドメインが増えても、ここに載らない限り自動的に拒否される（fail-closed）。
 */
export function isAllowedTestHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (ALLOWED_LOCAL_HOSTS.includes(h) || h.endsWith(".localhost")) return true;
  if (h === STAGING_WORKER_HOST) return true;
  // Cloudflare の version preview（<version-id>-elxea-agent-staging.<sub>.workers.dev）。
  // 本番 host は `elxea-agent.` 始まりで `-staging` を含まないため、ここには決して一致しない。
  if (h.endsWith(`-${STAGING_WORKER_HOST}`)) return true;
  return false;
}

/** 本番接触を検出したときに投げる専用エラー（テストで捕捉・識別しやすくする）。 */
export class ProdContactError extends Error {
  constructor(message: string) {
    super(`[assert-not-prod] ${message}`);
    this.name = "ProdContactError";
  }
}

/** 任意の文字列に本番マーカー（Supabase ref / OA / 本番 Worker host）が含まれないか検査（fail-closed）。 */
export function assertNoProdMarker(
  value: string | undefined | null,
  context: string,
): void {
  if (!value) return;
  if (value.includes(PROD_SUPABASE_REF)) {
    throw new ProdContactError(
      `${context}: 本番 Supabase ref (${PROD_SUPABASE_REF}) を検出。ハーメティックテストは本番に触れない。`,
    );
  }
  if (value.includes(PROD_OA_ID)) {
    throw new ProdContactError(
      `${context}: 本番 OA (${PROD_OA_ID}) を検出。テストで本番 OA を使うことは禁止。`,
    );
  }
  for (const host of PROD_WORKER_HOSTS) {
    if (value.includes(host)) {
      throw new ProdContactError(`${context}: 本番 Worker host (${host}) を検出。`);
    }
  }
}

/** 実送信フラグ（DELIVERY/DORMANT_SEND_ENABLED）が立っていないか検査（実送信の芽を摘む）。 */
export function assertSendDisabled(env: Record<string, unknown>): void {
  if (env.DELIVERY_SEND_ENABLED === "true") {
    throw new ProdContactError("DELIVERY_SEND_ENABLED=true（実送信フラグ）はテストで禁止。");
  }
  if (env.DORMANT_SEND_ENABLED === "true") {
    throw new ProdContactError("DORMANT_SEND_ENABLED=true（実送信フラグ）はテストで禁止。");
  }
}

/**
 * テスト env が本番を指していないことを install 時に検査（fail-closed）。
 * SUPABASE_URL / LINE トークン / LIFF URL に本番マーカーが無いこと、DELIVERY_TARGET_ENV!=prod、
 * 送信フラグが立っていないことを一括で担保する。
 */
export function assertNotProdEnv(env: Record<string, unknown>): void {
  assertNoProdMarker(env.SUPABASE_URL as string | undefined, "env.SUPABASE_URL");
  assertNoProdMarker(
    env.LINE_CHANNEL_ACCESS_TOKEN as string | undefined,
    "env.LINE_CHANNEL_ACCESS_TOKEN",
  );
  assertNoProdMarker(env.LIFF_LINKAGE_URL as string | undefined, "env.LIFF_LINKAGE_URL");
  // DELIVERY_TARGET_ENV="prod" は dry-run 先を本番 OA に向けるため、テストでは test 固定を要求する。
  if (env.DELIVERY_TARGET_ENV === "prod") {
    throw new ProdContactError(
      'DELIVERY_TARGET_ENV="prod" はテストで禁止（"test" 固定にする）。',
    );
  }
  assertSendDisabled(env);
}

/** 各 outbound fetch の URL を検査（fail-closed）。全ネットワークがここを通る。 */
export function assertNotProdUrl(url: string): void {
  assertNoProdMarker(url, "outbound URL");
}

// ---------------------------------------------------------------------------
// 宛先ホワイトリスト（staging / e2e エントリポイント用）
// ---------------------------------------------------------------------------

/**
 * テストの宛先 URL をホワイトリストで検査し、許可されていれば同じ URL を返す（fail-closed）。
 *
 * 許可: staging Worker（version preview 含む）と localhost 相当のみ。
 * それ以外（本番 Worker・本番カスタムドメイン・未知のホスト・URL 不正・未設定）は
 * 即座に ProdContactError を throw して**リクエスト送信前に**中断する。
 *
 * 戻り値をそのまま定数に代入して使う想定:
 *   const BASE = assertAllowedTestTarget(process.env.STAGING_BASE_URL, "e2e BASE");
 */
export function assertAllowedTestTarget(
  url: string | undefined | null,
  context = "test target",
): string {
  if (!url || url.trim() === "") {
    throw new ProdContactError(`${context}: 宛先 URL が未設定（fail-closed で中断）。`);
  }
  const raw = url.trim();

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProdContactError(`${context}: 宛先 URL を解釈できない: ${raw}`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ProdContactError(`${context}: 許可外のスキーム "${parsed.protocol}": ${raw}`);
  }

  if (!isAllowedTestHost(parsed.hostname)) {
    throw new ProdContactError(
      `${context}: 許可外の宛先ホスト "${parsed.host}"。` +
        `テストが送信してよいのは staging Worker (${STAGING_WORKER_HOST}) と localhost のみ` +
        `（ホワイトリスト方式・fail-closed）。url=${raw}`,
    );
  }

  // 二重ガード: ホストは許可でも、path/query に本番マーカーが混ざっていれば拒否する。
  assertNoProdMarker(raw, context);

  return raw;
}

/**
 * staging の宛先ベース URL を「staging 専用の明示 env」からのみ解決する（fail-closed）。
 *
 * 解決順: 明示引数 → `STAGING_BASE_URL` → `STAGING_WORKER_URL`（CI 互換の別名）→ staging 既定値。
 * **`.dev.vars` の `CX_AGENT_BASE_URL` は本番 Worker を指すため、ここでは決して参照しない。**
 * どの経路で来ても最後は assertAllowedTestTarget を通るので、本番 URL に落ちる経路は存在しない。
 */
export function resolveStagingBaseUrl(
  override?: string | undefined | null,
  context = "staging base URL",
): string {
  const env: Record<string, string | undefined> =
    typeof process !== "undefined" && process.env ? process.env : {};
  const candidate =
    (override ?? "").trim() ||
    (env.STAGING_BASE_URL ?? "").trim() ||
    (env.STAGING_WORKER_URL ?? "").trim() ||
    STAGING_WORKER_BASE_URL;
  // 末尾スラッシュを落として `${BASE}/path` の二重スラッシュを防ぐ。
  return assertAllowedTestTarget(candidate.replace(/\/+$/, ""), context);
}

/** installTestFetchGuard が差し替え済みかを示すマーカー（二重ラップ防止）。 */
const TEST_FETCH_GUARD_MARK = "__elxeaTestFetchGuard__";

/**
 * プロセス全体の globalThis.fetch に宛先ガードを敷く（staging / e2e エントリポイントの先頭で 1 回呼ぶ）。
 *
 * 二段構え:
 *   1. 全 outbound で assertNotProdUrl（本番 Supabase ref / 本番 OA / 本番 Worker host を拒否）。
 *   2. 宛先が **自前 Worker**（*.workers.dev）の場合はさらにホワイトリスト検査を強制する。
 *      → staging Worker と localhost 以外の自前 Worker には構造的に到達できない。
 *   staging Supabase / Firestore / Notion 等の第三者ホストは 1 のみを適用して素通しする
 *   （staging E2E はこれらの実サービスを使う設計のため）。
 */
export function installTestFetchGuard(context = "outbound fetch"): void {
  const current = globalThis.fetch as unknown as Record<string, unknown>;
  if (current && current[TEST_FETCH_GUARD_MARK] === true) return;

  const original = globalThis.fetch;
  const guarded = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;

    // 1. 本番マーカーの一律拒否。
    assertNotProdUrl(url);

    // 2. 自前 Worker 宛はホワイトリストを強制。
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      throw new ProdContactError(`${context}: 宛先 URL を解釈できない: ${url}`);
    }
    if (host.endsWith(".workers.dev")) {
      assertAllowedTestTarget(url, context);
    }

    return original(input as RequestInfo, init);
  }) as typeof fetch;

  (guarded as unknown as Record<string, unknown>)[TEST_FETCH_GUARD_MARK] = true;
  globalThis.fetch = guarded;
}
