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

/** 本番 Worker ホスト（URL 誤爆防止）。 */
export const PROD_WORKER_HOSTS = [
  "elxea-agent.setaka1103.workers.dev",
  "elxea-agent.setaka-on.workers.dev",
];

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

/**
 * 実送信フラグ（DORMANT/MARCHE_SEND_ENABLED）が立っていないか検査（実送信の芽を摘む）。
 *
 * ⚠ 2026-08-22: 一斉配信の DELIVERY_SEND_ENABLED は撤去済みのため検査対象から外した。
 *   一斉配信の実送信は env フラグではなく「実 LINE トークン + 実 Notion 行」が揃わないと
 *   起きないため、テストでの防波堤は assertNotProdEnv（本番マーカー検出）と
 *   installHermeticFetch（実ネットワーク遮断）が担う。
 */
export function assertSendDisabled(env: Record<string, unknown>): void {
  if (env.DORMANT_SEND_ENABLED === "true") {
    throw new ProdContactError("DORMANT_SEND_ENABLED=true（実送信フラグ）はテストで禁止。");
  }
  if (env.MARCHE_SEND_ENABLED === "true") {
    throw new ProdContactError("MARCHE_SEND_ENABLED=true（実送信フラグ）はテストで禁止。");
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
