/**
 * 嗜好抽出パイプライン — 会話完了後・購入完了後に非同期実行する。
 *
 * 会話パイプライン:
 *   extractPreferences() で嗜好を抽出し、updateTasteProfile() で Firestore を更新する。
 *   紐付け済みユーザー（Shopify Customer ID が解決可能）のみ実行する。
 *
 * 購入パイプライン:
 *   Shopify 商品タグからペルソナシグナルを抽出し、+3 の重みでスコア加算する。
 *   購入は実行動であり、会話での言及（+1）より強いシグナルとみなす。
 *
 * fire-and-forget で呼ぶことを想定:
 *   - Web: c.executionCtx.waitUntil(runPreferencePipeline(...))
 *   - LINE: processEvents 内で await (既に waitUntil のバックグラウンド)
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../index";
import { extractPreferences } from "./preference-extractor";
import {
  tryGetFirestoreEnv,
  getCustomerProfile,
  updateTasteProfile,
  updateCustomerProfile,
  getLineUserProfile,
  updateLineUserTasteProfile,
} from "./firestore";
import { syncAfterProfileUpdate } from "../sync/shopify-metafield";
import type { Channel } from "./supabase";
import {
  buildPurchaseSignals,
  PURCHASE_SIGNAL_WEIGHT,
} from "./purchase-signals";
import { createSupabaseClient } from "./supabase";
import {
  personaDeltaFromScores,
  recordPersonaSignal,
  type PersonaSignalSource,
} from "./cdp/profile-intake";
import type { ObservedIdentifier } from "./cdp/subjects";

/**
 * 点が動いたことを L0 に 1 行積む（CDP 統合 Stage 4）。
 *
 * ─ なぜ「前後の差」を積むのか ─
 *   点を動かす計算（mergePersonaScoresWithSource）は押し替えの取り消しを含むので、
 *   足した weight と実際に動いた量は一致しない。前後の差なら必ず一致する。
 *
 * ─ なぜ Firestore への書き込みの **あと**なのか ─
 *   Stage 4 は並走の段で、正本はまだ Firestore 側にある。先に L0 へ積むと
 *   Firestore の書き込みが落ちた回に「動いたことになっている点」が L1 に残る。
 *
 * **決して throw しない**（fire-and-forget の呼び出し元を落とさない）。
 */
async function emitPersonaSignal(
  env: Env,
  identifier: ObservedIdentifier,
  source: PersonaSignalSource,
  before: { serenity?: number; explorer?: number; sensory?: number } | undefined,
  after: { serenity?: number; explorer?: number; sensory?: number } | undefined,
): Promise<void> {
  const delta = personaDeltaFromScores(before, after);
  if (Object.keys(delta).length === 0) return;
  try {
    const supabase = createSupabaseClient(env);
    await recordPersonaSignal(
      supabase,
      { identifier, source: `cx-agent.preference-${source}` },
      { source, delta },
    );
  } catch (err) {
    console.warn(
      "[preference-pipeline] L0 persona signal failed (non-blocking):",
      err instanceof Error ? err.message : err,
    );
  }
}

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
    // Firestore 設定チェック（T-12: 黙ってスキップしない）。
    // 本番では入口ゲート（E6' assert）が未設定を弾くのでここは通らない。
    const fsEnv = tryGetFirestoreEnv(env, "preference-pipeline.conversation");
    if (!fsEnv) return;

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
      // 未紐付けユーザー（P0-6・欠落(d)）: LINE は lineUsers/{lineUserId} に会話由来嗜好を書く
      //   （診断が既に踏んだ道を会話由来にも広げる・weight は会話由来 +1）。Web は lineUserId を
      //   持たないため従来どおり skip（連携時に解消）。
      if (channel === "line") {
        const existingLine = await getLineUserProfile(userId, fsEnv);
        const lineUpdates = await updateLineUserTasteProfile(
          userId,
          signals,
          existingLine,
          fsEnv,
        );
        // Stage 4: 未連携の人の点も L1 に届かせる（未連携カルテ lineUsers/ が
        //   L1 に置き換わる = T-9 の置き換え先が空になるのを防ぐ）。
        await emitPersonaSignal(
          env,
          { kind: "line_messaging_uid", value: userId },
          "conversation",
          existingLine?.persona?.scores,
          lineUpdates.persona?.scores,
        );
        console.log(
          `[preference-pipeline] Unlinked LINE user — wrote lineUsers/${userId}: ` +
            `categories=${signals.preferred_categories.length}, ` +
            `persona_signals=${signals.persona_signals.length}`,
        );
      } else {
        console.log(
          "[preference-pipeline] No linkage (web) — skipping profile update",
        );
      }
      return;
    }

    const shopifyId = String(linkage.shopify_customer_id);

    // 既存プロファイルを取得
    const existingProfile = await getCustomerProfile(shopifyId, fsEnv);

    // マージして更新
    const profileUpdates = await updateTasteProfile(shopifyId, signals, existingProfile, fsEnv);

    await emitPersonaSignal(
      env,
      { kind: "shopify_customer_id", value: shopifyId },
      "conversation",
      existingProfile?.persona?.scores,
      profileUpdates.persona?.scores,
    );

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

// ---------------------------------------------------------------------------
// 購入データ反映パイプライン
// ---------------------------------------------------------------------------

/**
 * 購入完了時にペルソナスコアを更新するパイプライン。
 *
 * Shopify orders webhook から呼ばれることを想定。
 * 購入商品のタグからペルソナシグナルを抽出し、会話より重い +3 でスコア加算する。
 *
 * @param shopifyCustomerId Shopify の数値顧客 ID
 * @param lineItems 購入商品リスト（各商品のタグ配列を含む）
 * @param env Cloudflare Workers 環境変数
 */
export async function runPurchasePreferencePipeline(
  shopifyCustomerId: string,
  lineItems: Array<{ productTags: string[] }>,
  env: Env,
): Promise<void> {
  try {
    // Firestore 設定チェック（T-12: 黙ってスキップしない）。
    //
    // ⚠ この関数は CDP 統合後の **persona の唯一の書き手** である
    //   （web-app 注文 webhook 側の persona 書込は Stage 0 / T-1 で撤去した）。
    //   ここが黙ってスキップすると、購入という最も強いシグナルがどこにも
    //   記録されないまま「成功」になる。理由を必ずログに出す。
    const fsEnv = tryGetFirestoreEnv(env, "preference-pipeline.purchase");
    if (!fsEnv) return;

    // 全商品のタグからシグナルを生成
    const allProductTags = lineItems.map((item) => item.productTags);
    const signals = buildPurchaseSignals(allProductTags);

    if (!signals) {
      // マッピング可能なタグなし — スキップ
      console.log(
        `[purchase-pipeline] No mappable tags found for customer ${shopifyCustomerId}`,
      );
      return;
    }

    // 既存プロファイルを取得
    const existingProfile = await getCustomerProfile(shopifyCustomerId, fsEnv);

    // マージして更新（購入シグナルは +3 の重み・点の出所は「購入」として内訳に積む）
    const profileUpdates = await updateTasteProfile(
      shopifyCustomerId,
      signals,
      existingProfile,
      fsEnv,
      PURCHASE_SIGNAL_WEIGHT,
      "purchase",
    );

    // Stage 4: 購入は最も強いシグナル（weight=3）。L1 でも「購入で入った点」として
    //   内訳（persona_sources.purchase）と月別内訳（persona_windows）に残る。
    await emitPersonaSignal(
      env,
      { kind: "shopify_customer_id", value: shopifyCustomerId },
      "purchase",
      existingProfile?.persona?.scores,
      profileUpdates.persona?.scores,
    );

    // lastPurchaseAt を更新
    await updateCustomerProfile(
      shopifyCustomerId,
      { lastPurchaseAt: new Date().toISOString() },
      fsEnv,
    );

    console.log(
      `[purchase-pipeline] Profile updated for customer ${shopifyCustomerId}: ` +
      `categories=${signals.preferred_categories.length}, ` +
      `flavors=${signals.flavor_preferences.length}, ` +
      `persona_signals=${signals.persona_signals.length} (weight=${PURCHASE_SIGNAL_WEIGHT})`,
    );

    // Shopify metafield への即時同期（fire-and-forget）
    const mergedProfile = { ...existingProfile, ...profileUpdates };
    syncAfterProfileUpdate(shopifyCustomerId, mergedProfile, env).catch((err) => {
      console.warn(
        "[purchase-pipeline] Shopify metafield sync failed (non-blocking):",
        err instanceof Error ? err.message : err,
      );
    });
  } catch (err) {
    // fire-and-forget なのでエラーはログのみ
    console.warn(
      "[purchase-pipeline] failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
