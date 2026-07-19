/**
 * 「次の一杯」選定用カルテ（persona / tasteProfile）のローダ（fail-safe・I/O シーム）。
 *
 * 監査 punch-list #2 の是正配線: 会話側（agent/core.ts の buildPersonalizationBlock）が
 * カルテを AI 文脈へ読むのと同じ源から、tea-menu の「次の一杯」選定にも persona/tasteProfile を
 * 供給する（「会話はカルテを読むのに次の提案は読まない」非対称の解消）。
 *
 * source は core.ts と一致させる（読む面をそろえて一貫性を保つ）:
 *   - 連携済み: customer_linkages（Supabase）で lineUserId → shopify_customer_id を解決し、
 *     users/{shopifyId}=CustomerProfile を読む。
 *   - 未連携 LINE（U + 32hex）: lineUsers/{lineUserId}=LineUserProfile を直読み。
 *
 * 購入シグナルの扱い: 購入由来の好みは上流（firestore.ts computeTasteProfileUpdates を weight=3 で適用）で
 * すでに persona/tasteProfile へ畳み込み済み。よってここで Shopify を叩かず、会話側と同じ「畳み込み済み
 * プロファイル」を読む（Shopify 開店前=staging でも安全・会話側と同一の読み取り面）。
 *
 * fail-safe: Firebase 未設定・リンク解決失敗・Firestore 読取失敗は、いずれも空カルテ
 * （{persona:null, tasteProfile:null}）を返して選定を止めない（従来の番号昇順にフォールバック）。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../index";
import {
  getFirestoreEnv,
  getCustomerProfile,
  getLineUserProfile,
  type CustomerProfile,
  type LineUserProfile,
  type FirestoreEnv,
} from "./firestore";
import { resolveCallerShopifyCustomerId } from "./shopify";
import type { NextCupKarte } from "./next-cup";

/** LINE Messaging API の userId 形式（"U" + 32 hex）。lineUsers 直読みの前提チェック。 */
const LINE_USER_ID_RE = /^U[0-9a-fA-F]{32}$/;

/** 空カルテ（フォールバック）。 */
const EMPTY_KARTE: NextCupKarte = { persona: null, tasteProfile: null };

/**
 * loadCustomerKarte の依存注入（テストは fake を注入しネットワーク非接触にする・
 * subscriber-linkage.ts / preference-diagnosis.ts と同じ流儀）。本番は未指定で実 I/O を使う。
 */
export interface CustomerKarteDeps {
  /** lineUserId → shopify_customer_id（customer_linkages・未連携は null）。 */
  resolveShopifyId?: (lineUserId: string, supabase: SupabaseClient) => Promise<string | null>;
  /** 連携済みカルテ取得（users/{shopifyId}）。 */
  getShopifyProfile?: (shopifyId: string, fsEnv: FirestoreEnv) => Promise<CustomerProfile | null>;
  /** 未連携カルテ取得（lineUsers/{lineUserId}）。 */
  getLineProfile?: (lineUserId: string, fsEnv: FirestoreEnv) => Promise<LineUserProfile | null>;
}

/**
 * lineUserId のカルテ（persona / tasteProfile）を読む（fail-safe）。
 * 連携済みなら users、未連携 LINE なら lineUsers を読む（会話側 core.ts と同じ分岐）。
 */
export async function loadCustomerKarte(
  lineUserId: string,
  env: Env,
  supabase: SupabaseClient,
  deps?: CustomerKarteDeps,
): Promise<NextCupKarte> {
  const resolveShopifyId =
    deps?.resolveShopifyId ??
    ((id: string, sb: SupabaseClient) => resolveCallerShopifyCustomerId(id, "line", sb));
  const getShopifyProfile = deps?.getShopifyProfile ?? getCustomerProfile;
  const getLineProfile = deps?.getLineProfile ?? getLineUserProfile;

  let fsEnv: FirestoreEnv;
  try {
    fsEnv = getFirestoreEnv(env);
  } catch {
    // Firebase 未設定（staging / ハーメティックテスト）→ カルテ無しで従来挙動に倒す。
    return EMPTY_KARTE;
  }

  try {
    const shopifyId = await resolveShopifyId(lineUserId, supabase);
    if (shopifyId) {
      const profile = await getShopifyProfile(shopifyId, fsEnv);
      return {
        persona: profile?.persona?.primary ?? null,
        tasteProfile: profile?.tasteProfile ?? null,
      };
    }
    if (LINE_USER_ID_RE.test(lineUserId)) {
      const lineProfile = await getLineProfile(lineUserId, fsEnv);
      return {
        persona: lineProfile?.persona?.primary ?? null,
        tasteProfile: lineProfile?.tasteProfile ?? null,
      };
    }
    return EMPTY_KARTE;
  } catch (err) {
    console.warn(
      "[next-cup] karte load skipped (non-blocking):",
      err instanceof Error ? err.message : err,
    );
    return EMPTY_KARTE;
  }
}
