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
    //
    //    `{ count: "exact" }` を渡さないと supabase-js は count を返さない (undefined)。
    //    従来はこれが無かったため下の `count ?? 0` が常に 0 になり、実際には数十件を
    //    移行していても戻り値 mergedCount は 0、ログの「Merged N conversations」も
    //    出ない状態だった。統合が動いているのか一件も拾えていないのかを、呼び出し側も
    //    ログの読み手も区別できない = 失敗が誰にも届かない (憲章 R1)。
    //
    //    注: この関数自体は CDP 統合 Stage 5 で `subject_links` への追記 1 行に置き換えて
    //    消える予定 (撤去一覧 T-5)。本修正は「消えるまでの間、嘘の 0 を返さない」ための
    //    暫定であり、恒久解ではない。
    const { count, error: convError } = await supabase
      .from("conversations")
      .update({ user_id: identifiedUserId }, { count: "exact" })
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

    // 3. [SEC-2] web_session_id の再束縛は行わない（無条件上書きを廃止）。
    //
    //    以前はここで identity 行の web_session_id を、呼び出し側が渡した
    //    anonymousSessionId（caller-supplied session_id）へ無条件で上書きしていた。
    //    これは所有証明のない再束縛であり、乗っ取り経路になっていた:
    //    攻撃者が被害者の unified_user_id と攻撃者自身の session_id でこの経路を
    //    通せば、被害者の identity 行の web_session_id が攻撃者の session に向き、
    //    以後 session_id だけ（X-API-Key 無しの resolveUnifiedUserId）で被害者の
    //    unified_user に解決され、クロスチャネル履歴に到達できてしまう。
    //
    //    resolveWithShopifyCustomerId の [SEC-B] 前例（本ファイル）に倣い、
    //    多層防御として web_session_id の再束縛そのものを廃止する。会話・
    //    フィードバックの統合（上の 1・2）だけを行い、identity 行の session 束縛は
    //    変更しない（所有証明のある link 経路＝新規レコード作成時のみ確立される）。

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

    // 2. [SEC-1] email は「ヒント」に過ぎず、identity を束縛する権限を持たせない。
    //
    //    以前はここで email 一致だけで line_login_user_id を既存レコードに束縛し、
    //    その unified_user_id を「認証済み」として返していた（email-based auto-linking）。
    //    これはアカウント乗っ取り経路だった: 攻撃者が被害者の email と同じ email で
    //    LINE Login を通せば、被害者の（shopify_customer_id を持つ）identity 行に
    //    束縛され、以後その unified_user_id で被害者のクロスチャネル履歴・カルテに
    //    到達できた。
    //
    //    LINE identity を Shopify 保有 identity に束縛してよいのは、サーバ検証済みの
    //    Shopify ログイン経路（link-liff / requireAuth）だけであり、email 等値は不可。
    //    よって email 一致では束縛も認証も一切行わず、この LINE Login 専用の
    //    新規 identity を作成する（下の 3. にフォールスルー）。email は新規行に
    //    ヒントとして保存されるが、他人の（特に shopify 保有の）unified_user_id は
    //    決して返さない（non-authorizing）。
    if (email) {
      const { data: existingByEmail } = await supabase
        .from("user_identity_map")
        .select("id, unified_user_id, shopify_customer_id")
        .eq("email", email)
        .single();

      if (existingByEmail) {
        // 束縛せず・authorizing せず。ヒントとしてログのみ残し、新規作成へフォールスルー。
        console.log(
          `[identity] [SEC-1] Email hint only: an account with this email exists ` +
            `(shopify_bearing=${!!existingByEmail.shopify_customer_id}); ` +
            `NOT auto-linking LINE Login ${lineLoginUserId} by email equality. ` +
            `Creating a separate identity — server-verified Shopify login is required to connect.`,
        );
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
 * @param bindSession この session_id を identity 行に束縛してよいか (既定 true)。
 *
 *   [SEC-3 書き込み側 / QA 指摘 2026-08-30] proxy は session_id の **所有を検証しない**
 *   (ブラウザの cookie をそのまま転送する)。よってログイン済みの A が他人 B の
 *   session_id を送れる。そのまま下の 3. を通すと **B の session_id が A の identity 行に
 *   束縛され**、以後 getCrossChannelMessages が legacy.web_session_id 経由で
 *   B の会話を A の読み出し集合に混ぜる。
 *
 *   呼び出し側が「この session は別人のものだ」と判定できたときは false を渡すこと。
 *   顧客 ID から解決するところまでは行い、session の束縛だけを見送る (fail-closed)。
 */
export async function resolveWithShopifyCustomerId(
  supabase: SupabaseClient,
  shopifyCustomerId: string,
  sessionId: string,
  bindSession = true,
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
      // 2. 既存レコードあり。
      //
      //    [SEC-B] web_session_id は「上書きしない」。
      //    以前はここで web_session_id = sessionId に無条件上書きしていたが、
      //    これはアカウント乗っ取り経路になっていた: 攻撃者が被害者の
      //    shopify_customer_id と攻撃者自身の session_id を送ると、被害者の
      //    unified_user に攻撃者の session_id が再束縛され、以後 session_id だけで
      //    被害者のクロスチャネル履歴・会話に到達できてしまう。
      //    本関数は X-API-Key 検証済み（サーバ経由）でのみ呼ばれる設計に変更したが、
      //    多層防御として再束縛そのものを廃止する（既存の束縛を壊さない）。
      return {
        unifiedUserId: existing.unified_user_id,
        originalUserId: sessionId,
        isLinked: !!existing.line_user_id,
      };
    }

    /* [SEC-3] 別人の session だと分かっているときは、ここから先の **束縛を一切行わない**。
       顧客 ID を unified_user_id として返すだけに留める (会話の保存・読み出しは
       呼び出し側が顧客 ID で行うので、本人の体験は落ちない)。 */
    if (!bindSession) {
      return {
        unifiedUserId: shopifyCustomerId,
        originalUserId: sessionId,
        isLinked: false,
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
