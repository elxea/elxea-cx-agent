/**
 * 嗜好抽出パイプライン — 会話完了後に非同期実行する。
 *
 * extractPreferences() で嗜好を抽出し、updateTasteProfile() で Firestore を更新する。
 * 紐付け済みユーザー（Shopify Customer ID が解決可能）のみ実行する。
 *
 * fire-and-forget で呼ぶことを想定:
 *   - Web: c.executionCtx.waitUntil(runPreferencePipeline(...))
 *   - LINE: processEvents 内で await (既に waitUntil のバックグラウンド)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../index";
import { extractPreferences } from "./preference-extractor";
import {
  getFirestoreEnv,
  getCustomerProfile,
  updateTasteProfile,
  type FirestoreEnv,
} from "./firestore";
import { syncAfterProfileUpdate } from "../sync/shopify-metafield";
import type { Channel } from "./supabase";

/**
 * 嗜好抽出 + プロファイル更新パイプライン。
 *
 * @param conversationHistory 今回の会話履歴（user + assistant）
 * @param userId LINE userId or session_id
 * @param channel "line" | "web"
 * @param env Cloudflare Workers 環境変数
 * @param supabase Supabase クライアント
 */
export async function runPreferencePipeline(
  conversationHistory: Array<{ role: string; content: string }>,
  userId: string,
  channel: Channel,
  env: Env,
  supabase: SupabaseClient,
): Promise<void> {
  try {
    // Firestore 設定チェック
    let fsEnv: FirestoreEnv;
    try {
      fsEnv = getFirestoreEnv(env);
    } catch {
      // Firebase 未設定 — スキップ
      return;
    }

    // 嗜好シグナルを抽出
    const signals = await extractPreferences(conversationHistory, env);
    if (!signals) {
      // 嗜好キーワードなし or 抽出結果なし — スキップ
      return;
    }

    // Shopify Customer ID を解決
    const column = channel === "line" ? "line_user_id" : "shopify_customer_id";
    const { data: linkage } = await supabase
      .from("customer_linkages")
      .select("shopify_customer_id")
      .eq(column, userId)
      .single();

    if (!linkage?.shopify_customer_id) {
      // 未紐付けユーザー — プロファイル更新不可
      console.log("[preference-pipeline] No linkage found, skipping profile update");
      return;
    }

    const shopifyId = String(linkage.shopify_customer_id);

    // 既存プロファイルを取得
    const existingProfile = await getCustomerProfile(shopifyId, fsEnv);

    // マージして更新
    const profileUpdates = await updateTasteProfile(shopifyId, signals, existingProfile, fsEnv);

    console.log(
      `[preference-pipeline] Profile updated for customer ${shopifyId}: ` +
      `categories=${signals.preferred_categories.length}, ` +
      `flavors=${signals.flavor_preferences.length}, ` +
      `scenes=${signals.scene_preferences.length}, ` +
      `persona_signals=${signals.persona_signals.length}`,
    );

    // Shopify metafield への即時同期（fire-and-forget）
    // 既存プロファイルと更新分をマージして同期
    const mergedProfile = { ...existingProfile, ...profileUpdates };
    syncAfterProfileUpdate(shopifyId, mergedProfile, env).catch((err) => {
      console.warn(
        "[preference-pipeline] Shopify metafield sync failed (non-blocking):",
        err instanceof Error ? err.message : err,
      );
    });
  } catch (err) {
    // fire-and-forget なのでエラーはログのみ
    console.warn(
      "[preference-pipeline] failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
