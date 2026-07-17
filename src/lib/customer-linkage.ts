/**
 * customer_linkages 連携行の upsert（案A: LIFF 連携の中心ギャップを埋める書き込み経路）。
 *
 * 背景（統合設計書 §A / 前任調査）:
 *   cx-agent には identity/link（shopify_customer_id → user_identity_map）は既にあったが、
 *   **LINE Bot ランタイムが読む Supabase `customer_linkages`（トーク用 Messaging userId ↔
 *   Shopify 顧客）に本番で行を作る経路が無かった**。これがブロック4（連携導線）の空洞。
 *   本モジュールはその 1 行 upsert を、冪等（onConflict=line_user_id）で提供する。
 *
 * 位置づけ（事実）:
 *   - 書き込むのは Supabase の customer_linkages のみ。Shopify には一切触れない。
 *   - line_user_id は「トーク用（Messaging）userId」。真正性は呼び出し側（route）が
 *     LINE 署名済み id_token の検証結果 `sub` を渡すことで担保する（本モジュールは受け取った
 *     値を素直に書くだけ・形式検証は route が web-auth のバリデータで行う）。
 *   - shopify_customer_id は数値文字列（webhook と同じ表現）。route が正規化して渡す。
 *
 * 冪等性:
 *   同じ line_user_id で複数回呼んでも 1 行（onConflict=line_user_id で更新）。
 *   これにより Bot「連携」の二度押し・再送でも安全（重複行・エラーにならない）。
 */
import type { SupabaseClient } from "@supabase/supabase-js";

/** 連携 upsert の入力（すべて正規化済み・route 側で検証済みの値を受ける）。 */
export type CustomerLinkageInput = {
  /** トーク用（Messaging）userId。`U` + 32 hex。id_token 検証済みの sub。 */
  lineUserId: string;
  /** Shopify 顧客 ID（数値文字列）。 */
  shopifyCustomerId: string;
  /** 任意: Shopify 登録メール（分かれば保存。不明なら省略）。 */
  shopifyEmail?: string | null;
  /**
   * 任意: 連携の発生源（migration 026 の source 列）。'liff' / 'owner_kit' / 'follow_ref' 等。
   * 指定時のみ書く（未指定は列に触れない = 既存値を消さない）。
   */
  source?: string | null;
};

/** 連携 upsert の結果。 */
export type CustomerLinkageResult =
  | { ok: true; lineUserId: string; shopifyCustomerId: string }
  | { ok: false; error: string };

/**
 * customer_linkages に 1 行 upsert する（冪等・onConflict=line_user_id）。
 *
 * - shopify_customer_id は指定した値で更新する（連携先の付け替えも同一 line_user_id で吸収）。
 * - broadcast_opted_out / unfollowed_at 等の既存フラグ列には触れない（連携の再実行で
 *   配信除外状態を巻き戻さない）。
 * - linked_at / updated_at を now で更新する（既存 broadcast-optout / test-linkage-kit と同じ列運用）。
 *
 * ロールバック安全（expand/contract）: source 列（migration 026）が未適用の環境でも、連携そのものは
 *   壊さない。source 列不在エラー（PostgREST PGRST204 / Postgres 42703）を検知したら source を落として
 *   1 度だけ再試行する。これにより「コード先行デプロイ → DDL 後追い」の順序でも 500 にならない
 *   （本番は deploy-runbook 手順1で migration を先に適用するため常に列あり。staging 過渡期の保険）。
 *
 * @returns ok:true なら成功。ok:false なら Supabase エラー理由。
 */
/** source 列が未適用（未存在）を示す PostgREST/Postgres エラーか。 */
function isMissingSourceColumnError(error: {
  code?: string;
  message?: string;
}): boolean {
  const code = error.code ?? "";
  const msg = error.message ?? "";
  // PGRST204 = schema cache に列が無い / 42703 = column does not exist。
  if (code === "PGRST204" || code === "42703") return /source/i.test(msg) || msg.length === 0;
  return /['"]?source['"]? column/i.test(msg) || /column .*source.* does not exist/i.test(msg);
}

export async function upsertCustomerLinkage(
  supabase: SupabaseClient,
  input: CustomerLinkageInput,
): Promise<CustomerLinkageResult> {
  const nowIso = new Date().toISOString();

  const baseRow: Record<string, unknown> = {
    line_user_id: input.lineUserId,
    shopify_customer_id: input.shopifyCustomerId,
    linked_at: nowIso,
    updated_at: nowIso,
  };
  // email は分かるときだけ書く（null で既存値を消さない）。
  if (input.shopifyEmail) {
    baseRow.shopify_email = input.shopifyEmail;
  }

  // source（発生源）は指定時だけ書く（未指定で既存の source を null で消さない）。
  const row = input.source ? { ...baseRow, source: input.source } : baseRow;

  const { error } = await supabase
    .from("customer_linkages")
    .upsert(row, { onConflict: "line_user_id" });

  if (error) {
    // source 列未適用のときだけ、source を落として 1 度再試行（連携本体は成立させる）。
    if (input.source && isMissingSourceColumnError(error)) {
      console.warn(
        "[customer-linkage] source column missing (migration 026 未適用?) — source を落として再試行:",
        error.message,
      );
      const { error: retryError } = await supabase
        .from("customer_linkages")
        .upsert(baseRow, { onConflict: "line_user_id" });
      if (retryError) {
        return { ok: false, error: retryError.message };
      }
      return {
        ok: true,
        lineUserId: input.lineUserId,
        shopifyCustomerId: input.shopifyCustomerId,
      };
    }
    return { ok: false, error: error.message };
  }

  return {
    ok: true,
    lineUserId: input.lineUserId,
    shopifyCustomerId: input.shopifyCustomerId,
  };
}
