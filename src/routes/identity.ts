/**
 * Identity Link Route -- POST /api/identity/link
 *
 * LINE Login や Shopify OAuth 後に、anonymous session を
 * identified user に統合するエンドポイント。
 *
 * Web チャットの chat-provider が LINE Login 成功後に
 * session_id を送信し、過去の anonymous 会話を統合する。
 */
import type { Context } from "hono";
import type { Env } from "../index";
import { createSupabaseClient } from "../lib/supabase";
import {
  resolveWithShopifyCustomerId,
  mergeAnonymousSession,
  linkLineByEmail,
} from "../lib/identity";
import {
  validateSessionId,
  validateShopifyCustomerId,
  validateLineMessagingUserId,
  normalizeShopifyCustomerId,
} from "../lib/web-auth";
import { requireSyncApiKey } from "../lib/sync-auth";
import { upsertCustomerLinkage } from "../lib/customer-linkage";

/**
 * POST /api/identity/link-line
 *
 * Auth.js signIn callback から呼ばれる。
 * LINE Login で取得した line_user_id（実際は LINE Login userId）を
 * user_identity_map の line_login_user_id カラムに登録する。
 *
 * 注意: リクエストの `line_user_id` フィールド名は後方互換のため維持するが、
 * 内部では line_login_user_id として保存する（Messaging API userId とは異なる）。
 *
 * session_id が提供された場合、anonymous session の会話データを
 * identified user に統合する（mergeAnonymousSession）。
 *
 * Shopify Customer が同じメールで存在する場合は自動紐付け。
 *
 * リクエストボディ:
 * {
 *   line_user_id: string,        // 必須（LINE Login userId）
 *   email?: string | null,       // LINE に登録されたメール
 *   display_name?: string | null // LINE の表示名
 *   session_id?: string | null   // Web チャットの session_id（cookie から取得）
 * }
 */
export async function identityLinkLineHandler(c: Context<{ Bindings: Env }>) {
  // C1: Verify shared secret (SYNC_API_SECRET) via X-API-Key header（fail-closed）
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  let body: {
    line_user_id?: string;
    email?: string | null;
    display_name?: string | null;
    session_id?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { line_user_id, email, display_name, session_id } = body;

  if (!line_user_id || typeof line_user_id !== "string") {
    return c.json({ error: "line_user_id is required" }, 400);
  }

  const supabase = createSupabaseClient(c.env);

  try {
    // line_user_id は LINE Login userId なので、linkLineByEmail に渡す
    // （linkLineByEmail 内部で line_login_user_id カラムに保存される）
    const result = await linkLineByEmail(
      supabase,
      line_user_id,
      email ?? null,
      display_name ?? null,
    );

    // If session_id is provided, merge anonymous session conversations
    let mergedCount = 0;
    if (session_id && typeof session_id === "string") {
      console.log(
        `[identity/link-line] Merging anonymous session ${session_id} to unified user ${result.unifiedUserId}`,
      );
      const mergeResult = await mergeAnonymousSession(
        supabase,
        session_id,
        result.unifiedUserId,
      );
      mergedCount = mergeResult.mergedCount;
    }

    return c.json({
      success: true,
      unified_user_id: result.unifiedUserId,
      action: result.action,
      merged_count: mergedCount,
    });
  } catch (err) {
    console.error("[identity/link-line] error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * POST /api/identity/link
 *
 * リクエストボディ:
 * {
 *   session_id: string,           // 現在の Web セッション ID
 *   shopify_customer_id: string,  // Shopify Customer GID or ID
 *   line_user_id?: string,        // LINE Login で取得した LINE userId（任意）
 * }
 *
 * レスポンス:
 * {
 *   success: true,
 *   unified_user_id: string,
 *   merged_count: number,         // 統合された会話数
 *   is_linked: boolean,           // LINE とも紐付けされているか
 * }
 */
export async function identityLinkHandler(c: Context<{ Bindings: Env }>) {
  // C: Verify shared secret (SYNC_API_SECRET) via X-API-Key header（fail-closed）。
  // link-line と同じ認証を要求し、無認証での identity 束縛（なりすまし）を塞ぐ。
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  let body: {
    session_id?: string;
    shopify_customer_id?: string;
    line_user_id?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { session_id, shopify_customer_id, line_user_id } = body;

  // session_id バリデーション
  const sessionError = validateSessionId(session_id);
  if (sessionError) {
    return c.json({ error: sessionError }, 400);
  }

  // shopify_customer_id バリデーション（必須）
  if (!shopify_customer_id) {
    return c.json({ error: "shopify_customer_id is required" }, 400);
  }
  const shopifyError = validateShopifyCustomerId(shopify_customer_id);
  if (shopifyError) {
    return c.json({ error: shopifyError }, 400);
  }

  const supabase = createSupabaseClient(c.env);
  const sessionId = session_id as string;

  try {
    // 1. Shopify Customer ID で Identity を解決（自動登録含む）
    const identity = await resolveWithShopifyCustomerId(
      supabase,
      shopify_customer_id,
      sessionId,
    );

    // 2. LINE userId が提供された場合、user_identity_map に追記
    if (line_user_id) {
      const { error: lineError } = await supabase
        .from("user_identity_map")
        .update({ line_user_id })
        .eq("unified_user_id", identity.unifiedUserId);

      if (lineError) {
        console.warn("[identity/link] Failed to link LINE userId:", lineError.message);
      } else {
        console.log(
          `[identity/link] Linked LINE user ${line_user_id} to unified user ${identity.unifiedUserId}`,
        );
      }
    }

    // 3. anonymous session の会話データを統合
    const { mergedCount } = await mergeAnonymousSession(
      supabase,
      sessionId,
      identity.unifiedUserId,
    );

    return c.json({
      success: true,
      unified_user_id: identity.unifiedUserId,
      merged_count: mergedCount,
      is_linked: identity.isLinked || !!line_user_id,
    });
  } catch (err) {
    console.error("[identity/link] error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
}

/**
 * POST /api/identity/link-liff
 *
 * 案A（LIFF 連携）第1弾の中心。LINE Bot ランタイムが読む Supabase `customer_linkages`
 * に「トーク用（Messaging）userId ↔ Shopify 顧客」の 1 行を冪等に作る、これまで存在しなかった
 * 書き込み経路。既存の identity/link（user_identity_map への書き込み）は一切変更しない
 * （別テーブル・別ハンドラ）。
 *
 * 認証（server-to-server・SYNC_API_SECRET 維持）:
 *   このエンドポイントは web-app の route handler（サーバ）から X-API-Key 付きで呼ばれる。
 *   ブラウザから直叩きさせない（SYNC_API_SECRET をブラウザに置かない）。fail-closed。
 *
 * なりすまし不能性（設計の要点）:
 *   1. line_messaging_user_id は web-app が「LINE 署名済み LIFF id_token」を LINE の verify API で
 *      検証して取り出した `sub`。ブラウザは sub を詐称できない（LINE の署名鍵が要る）。
 *   2. shopify_customer_id は web-app のサーバ認証済み Shopify セッション（requireAuth）由来。
 *      ブラウザ自己申告の customer_id は使わない（他人の顧客IDで連携する穴を塞ぐ）。
 *   3. 本エンドポイントは X-API-Key（SYNC_API_SECRET）でゲートし、web-app サーバ以外から
 *      呼べないようにする。
 *   → 形式ゲート（下記バリデータ）は多層防御の 1 枚目に過ぎず、真正性の本体は上記 1–3。
 *
 * リクエストボディ:
 * {
 *   line_messaging_user_id: string,   // 必須。`U` + 32 hex（Messaging userId）
 *   shopify_customer_id: string,      // 必須。GID or 数値。内部で数値へ正規化
 *   shopify_email?: string | null,    // 任意。分かれば保存
 * }
 *
 * レスポンス:
 * { success: true, line_user_id: string, shopify_customer_id: string }
 */
export async function identityLinkLiffHandler(c: Context<{ Bindings: Env }>) {
  // C: server-to-server 認証（SYNC_API_SECRET）。fail-closed。ブラウザ直叩き不可。
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  let body: {
    line_messaging_user_id?: string;
    shopify_customer_id?: string;
    shopify_email?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { line_messaging_user_id, shopify_customer_id, shopify_email } = body;

  // line_messaging_user_id バリデーション（Messaging userId 形式）
  const lineError = validateLineMessagingUserId(line_messaging_user_id);
  if (lineError) {
    return c.json({ error: lineError }, 400);
  }

  // shopify_customer_id を数値へ正規化（GID / 数値のどちらでも受ける）
  const normalized = normalizeShopifyCustomerId(shopify_customer_id);
  if ("error" in normalized) {
    return c.json({ error: normalized.error }, 400);
  }

  const supabase = createSupabaseClient(c.env);

  try {
    const result = await upsertCustomerLinkage(supabase, {
      lineUserId: line_messaging_user_id as string,
      shopifyCustomerId: normalized.numericId,
      shopifyEmail: shopify_email ?? null,
    });

    if (!result.ok) {
      console.error("[identity/link-liff] upsert failed:", result.error);
      return c.json({ error: "Failed to persist linkage" }, 500);
    }

    console.log(
      `[identity/link-liff] linked messaging user ${result.lineUserId} <-> shopify ${result.shopifyCustomerId}`,
    );

    return c.json({
      success: true,
      line_user_id: result.lineUserId,
      shopify_customer_id: result.shopifyCustomerId,
    });
  } catch (err) {
    console.error("[identity/link-liff] error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
}
