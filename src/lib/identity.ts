/**
 * Identity Resolver -- unified_user_id 解決
 *
 * LINE userId / Web session_id を user_identity_map テーブルで検索し、
 * 紐付け済みユーザーの場合は unified_user_id を返す。
 * 未紐付けの場合は元の userId をそのまま返す（graceful fallback）。
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
