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
    if (channel === "line") {
      // LINE の場合: line_user_id (Messaging API) で検索し、
      // 見つからなければ line_login_user_id (LINE Login) でも検索する
      const { data: byMessaging } = await supabase
        .from("user_identity_map")
        .select("unified_user_id")
        .eq("line_user_id", userId)
        .single();

      if (byMessaging?.unified_user_id) {
        return {
          unifiedUserId: byMessaging.unified_user_id,
          originalUserId: userId,
          isLinked: true,
        };
      }

      // line_login_user_id でもフォールバック検索
      const { data: byLogin } = await supabase
        .from("user_identity_map")
        .select("unified_user_id")
        .eq("line_login_user_id", userId)
        .single();

      if (byLogin?.unified_user_id) {
        return {
          unifiedUserId: byLogin.unified_user_id,
          originalUserId: userId,
          isLinked: true,
        };
      }

      // 未紐付け: そのまま返す
      return {
        unifiedUserId: userId,
        originalUserId: userId,
        isLinked: false,
      };
    }

    // Web の場合: web_session_id で検索
    const { data, error } = await supabase
      .from("user_identity_map")
      .select("unified_user_id")
      .eq("web_session_id", userId)
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
 * anonymous session の会話データを identified user に統合する。
 * LINE Login や Shopify OAuth 後に呼ばれる。
 *
 * 1. anonymous session の会話を identified user に移行
 * 2. anonymous session のフィードバックも移行
 * 3. user_identity_map の web_session_id を更新
 *
 * @param supabase Supabase クライアント
 * @param anonymousSessionId 統合元の anonymous session ID
 * @param identifiedUserId 統合先の identified user ID (unified_user_id)
 * @returns 移行された会話数
 */
export async function mergeAnonymousSession(
  supabase: SupabaseClient,
  anonymousSessionId: string,
  identifiedUserId: string,
): Promise<{ mergedCount: number }> {
  try {
    // 1. anonymous session の会話を identified user に移行
    const { count, error: convError } = await supabase
      .from("conversations")
      .update({ user_id: identifiedUserId })
      .eq("user_id", anonymousSessionId);

    if (convError) {
      console.warn("[identity] merge conversations failed:", convError.message);
    }

    // 2. anonymous session のフィードバックも移行
    const { error: fbError } = await supabase
      .from("message_feedback")
      .update({ user_id: identifiedUserId })
      .eq("user_id", anonymousSessionId);

    if (fbError) {
      console.warn("[identity] merge feedback failed:", fbError.message);
    }

    // 3. user_identity_map の web_session_id を更新
    const { error: mapError } = await supabase
      .from("user_identity_map")
      .update({ web_session_id: anonymousSessionId })
      .eq("unified_user_id", identifiedUserId);

    if (mapError) {
      console.warn("[identity] update identity map failed:", mapError.message);
    }

    const mergedCount = count ?? 0;
    if (mergedCount > 0) {
      console.log(
        `[identity] Merged ${mergedCount} conversations from anonymous session ${anonymousSessionId} to user ${identifiedUserId}`,
      );
    }

    return { mergedCount };
  } catch (err) {
    console.warn(
      "[identity] mergeAnonymousSession failed:",
      err instanceof Error ? err.message : err,
    );
    return { mergedCount: 0 };
  }
}

/**
 * Email アドレスで既存の identity_map レコードを検索し、
 * LINE Login 時に line_login_user_id を追加で紐付ける。
 *
 * LINE Login (Auth.js / LIFF) で取得する userId は line_login_user_id に保存する。
 * line_user_id (Messaging API) とは異なるため、別カラムで管理する。
 *
 * - line_login_user_id で既存レコードあり → email/display_name を更新
 * - email で既存レコードあり → line_login_user_id を追記して統合
 * - 既存レコードなし → 新規レコードを作成
 *
 * Auth.js signIn callback から呼ばれる。
 */
export async function linkLineByEmail(
  supabase: SupabaseClient,
  lineLoginUserId: string,
  email: string | null,
  displayName: string | null,
): Promise<{ unifiedUserId: string; action: "linked" | "created" | "updated" }> {
  try {
    // 1. line_login_user_id で既存レコードを検索
    const { data: existingByLineLogin } = await supabase
      .from("user_identity_map")
      .select("id, unified_user_id, email")
      .eq("line_login_user_id", lineLoginUserId)
      .single();

    if (existingByLineLogin) {
      // Already linked -- update email/display_name if needed
      const updates: Record<string, string | null> = {};
      if (email && !existingByLineLogin.email) {
        updates.email = email;
      }
      if (displayName) {
        updates.display_name = displayName;
      }
      if (Object.keys(updates).length > 0) {
        await supabase
          .from("user_identity_map")
          .update(updates)
          .eq("id", existingByLineLogin.id);
      }
      return { unifiedUserId: existingByLineLogin.unified_user_id, action: "updated" };
    }

    // 1b. line_user_id (旧: Messaging API userId を LINE Login で誤登録した既存データ) でも検索
    // 既存データの後方互換性を維持する
    const { data: existingByLine } = await supabase
      .from("user_identity_map")
      .select("id, unified_user_id, email, line_user_id")
      .eq("line_user_id", lineLoginUserId)
      .single();

    if (existingByLine) {
      // 旧データ: line_user_id に LINE Login userId が入っている
      // line_login_user_id に移動し、line_user_id をクリアする
      const updates: Record<string, string | null> = {
        line_login_user_id: lineLoginUserId,
        line_user_id: null, // Messaging API Follow Event で再設定される
      };
      if (email && !existingByLine.email) {
        updates.email = email;
      }
      if (displayName) {
        updates.display_name = displayName;
      }
      await supabase
        .from("user_identity_map")
        .update(updates)
        .eq("id", existingByLine.id);

      console.log(
        `[identity] Migrated LINE Login userId ${lineLoginUserId} from line_user_id to line_login_user_id (unified=${existingByLine.unified_user_id})`,
      );
      return { unifiedUserId: existingByLine.unified_user_id, action: "updated" };
    }

    // 2. email で既存レコードを検索（email-based auto-linking）
    if (email) {
      const { data: existingByEmail } = await supabase
        .from("user_identity_map")
        .select("id, unified_user_id, shopify_customer_id")
        .eq("email", email)
        .single();

      if (existingByEmail) {
        // Email match -- add line_login_user_id to existing record
        await supabase
          .from("user_identity_map")
          .update({
            line_login_user_id: lineLoginUserId,
            display_name: displayName,
          })
          .eq("id", existingByEmail.id);

        console.log(
          `[identity] Linked LINE Login ${lineLoginUserId} to existing email record (unified=${existingByEmail.unified_user_id})`,
        );
        return { unifiedUserId: existingByEmail.unified_user_id, action: "linked" };
      }
    }

    // 3. No existing record -- create new
    const unifiedUserId = lineLoginUserId; // Use LINE Login userId as unified ID for now
    const { error: insertError } = await supabase
      .from("user_identity_map")
      .insert({
        unified_user_id: unifiedUserId,
        line_login_user_id: lineLoginUserId,
        email,
        display_name: displayName,
      });

    if (insertError) {
      console.warn("[identity] linkLineByEmail insert failed:", insertError.message);
      return { unifiedUserId: lineLoginUserId, action: "created" };
    }

    console.log(
      `[identity] Created new identity mapping for LINE Login ${lineLoginUserId} (email=${email})`,
    );
    return { unifiedUserId, action: "created" };
  } catch (err) {
    console.warn(
      "[identity] linkLineByEmail failed:",
      err instanceof Error ? err.message : err,
    );
    return { unifiedUserId: lineLoginUserId, action: "created" };
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
