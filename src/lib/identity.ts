/**
 * Identity Resolver -- unified_user_id 解決
 *
 * LINE userId / Web session_id / Shopify Customer ID を user_identity_map テーブルで検索し、
 * 紐付け済みユーザーの場合は unified_user_id を返す。
 * 未紐付けの場合は元の userId をそのまま返す（graceful fallback）。
 *
 * Shopify OAuth ログイン済みユーザーの場合:
 * - shopify_customer_id で user_identity_map を検索
 * - 紐付け済み → unified_user_id を返す（LINE との統合会話が可能）
 * - 未紐付け → 自動登録（shopify_customer_id を unified_user_id として使用）
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Channel } from "./supabase";

/** Identity Resolver の結果 */
export type IdentityResult = {
  /** 解決された unified_user_id（紐付け済み）または元の userId（未紐付け） */
  unifiedUserId: string;
  /** 元の userId（LINE userId or session_id） */
  originalUserId: string;
  /** unified_user_id に解決されたかどうか */
  isLinked: boolean;
};

/**
 * userId と channel から unified_user_id を解決する。
 *
 * - LINE: user_identity_map.line_user_id で検索
 * - Web: user_identity_map.web_session_id で検索
 * - 紐付け済み -> unified_user_id を返す
 * - 未紐付け -> 元の userId をそのまま返す
 *
 * エラー時もクラッシュせず元の userId で fallback する。
 */
export async function resolveUnifiedUserId(
  supabase: SupabaseClient,
  userId: string,
  channel: Channel,
): Promise<IdentityResult> {
  try {
    const column = channel === "line" ? "line_user_id" : "web_session_id";

    const { data, error } = await supabase
      .from("user_identity_map")
      .select("unified_user_id")
      .eq(column, userId)
      .single();

    if (error || !data?.unified_user_id) {
      // 未紐付け: そのまま返す
      return {
        unifiedUserId: userId,
        originalUserId: userId,
        isLinked: false,
      };
    }

    return {
      unifiedUserId: data.unified_user_id,
      originalUserId: userId,
      isLinked: true,
    };
  } catch (err) {
    // DB 接続エラー等: graceful fallback
    console.warn(
      "[identity] resolveUnifiedUserId failed, falling back to original userId:",
      err instanceof Error ? err.message : err,
    );
    return {
      unifiedUserId: userId,
      originalUserId: userId,
      isLinked: false,
    };
  }
}

/**
 * Shopify Customer ID を使った Web ユーザーの Identity 解決。
 *
 * ログイン済みユーザーの場合に呼び出す。以下のロジックで処理:
 *
 * 1. shopify_customer_id で user_identity_map を検索
 * 2. 既存レコードがある場合:
 *    - web_session_id が未設定 or 異なる → 更新して紐付け
 *    - unified_user_id を返す（LINE 紐付け済みなら会話統合可能）
 * 3. 既存レコードがない場合:
 *    - shopify_customer_id を unified_user_id として新規登録
 *    - session_id も同時に紐付け
 *
 * @param shopifyCustomerId Shopify Customer GID (例: gid://shopify/Customer/12345)
 * @param sessionId Web session UUID
 */
export async function resolveWithShopifyCustomerId(
  supabase: SupabaseClient,
  shopifyCustomerId: string,
  sessionId: string,
): Promise<IdentityResult> {
  try {
    // 1. shopify_customer_id で既存レコードを検索
    const { data: existing, error: selectError } = await supabase
      .from("user_identity_map")
      .select("unified_user_id, web_session_id, line_user_id")
      .eq("shopify_customer_id", shopifyCustomerId)
      .single();

    if (selectError && selectError.code !== "PGRST116") {
      // PGRST116 = "no rows returned" — それ以外は本当のエラー
      console.warn(
        "[identity] resolveWithShopifyCustomerId select error:",
        selectError.message,
      );
      // session_id ベースにフォールバック
      return resolveUnifiedUserId(supabase, sessionId, "web");
    }

    if (existing?.unified_user_id) {
      // 2. 既存レコードあり — web_session_id を更新（別セッションからのログインに対応）
      if (existing.web_session_id !== sessionId) {
        await supabase
          .from("user_identity_map")
          .update({ web_session_id: sessionId })
          .eq("shopify_customer_id", shopifyCustomerId);
        console.log(
          `[identity] Updated web_session_id for Shopify customer ${shopifyCustomerId}`,
        );
      }

      return {
        unifiedUserId: existing.unified_user_id,
        originalUserId: sessionId,
        isLinked: !!existing.line_user_id,
      };
    }

    // 3. 新規登録 — shopify_customer_id を unified_user_id として使用
    //    session_id で既存の未紐付けレコードがあるかチェック
    const { data: sessionRecord } = await supabase
      .from("user_identity_map")
      .select("id, unified_user_id")
      .eq("web_session_id", sessionId)
      .single();

    if (sessionRecord) {
      // session_id で既にレコードがある → shopify_customer_id を追加
      await supabase
        .from("user_identity_map")
        .update({
          shopify_customer_id: shopifyCustomerId,
          unified_user_id: shopifyCustomerId,
        })
        .eq("id", sessionRecord.id);
      console.log(
        `[identity] Linked Shopify customer ${shopifyCustomerId} to existing session record`,
      );

      return {
        unifiedUserId: shopifyCustomerId,
        originalUserId: sessionId,
        isLinked: false,
      };
    }

    // 完全に新規 — レコード作成
    const { error: insertError } = await supabase
      .from("user_identity_map")
      .insert({
        unified_user_id: shopifyCustomerId,
        web_session_id: sessionId,
        shopify_customer_id: shopifyCustomerId,
      });

    if (insertError) {
      console.warn(
        "[identity] Failed to create identity mapping:",
        insertError.message,
      );
      // フォールバック: session_id ベース
      return {
        unifiedUserId: sessionId,
        originalUserId: sessionId,
        isLinked: false,
      };
    }

    console.log(
      `[identity] Created new identity mapping for Shopify customer ${shopifyCustomerId}`,
    );

    return {
      unifiedUserId: shopifyCustomerId,
      originalUserId: sessionId,
      isLinked: false,
    };
  } catch (err) {
    console.warn(
      "[identity] resolveWithShopifyCustomerId failed, falling back to session-based:",
      err instanceof Error ? err.message : err,
    );
    return resolveUnifiedUserId(supabase, sessionId, "web");
  }
}
