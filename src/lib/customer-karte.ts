/**
 * 「次の一杯」選定用カルテ（persona / tasteProfile）のローダ（fail-safe・I/O シーム）。
 *
 * @layer CDP — CDP 所有。顧客カルテという事実の読み出し口（I/O シーム）であり、
 *   複数の CX 面（会話・次の一杯）へ同じ源から供給する役割を持つ。見せ方は持たない
 *   （提示は my-karte＝CX 側）。
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
  type PersonaType,
  type TasteProfile,
} from "./firestore";
import { resolveCallerShopifyCustomerId, fetchRecentOrders, type OrderSummary } from "./shopify";
import type { NextCupKarte } from "./next-cup";
import { fetchSellingTeas, type TeaItem } from "./tea-menu";
import { getUserRatings, positiveRatedProductNos, type UserRatingRow } from "./product-ratings";
import { getLatestNextCupShown } from "./flow-events";
import { formatTeaLabel } from "./brand-copy";
import type { EntrySource } from "./personalization-context";

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

// ---------------------------------------------------------------------------
// UX② マイカルテ 表示用ローダ（read-only・全 read fail-safe）
// ---------------------------------------------------------------------------

/**
 * entrySource を正規値（marche/online/other）に絞る（未知は null）。core.ts の normalizeEntrySource と同義。
 * （表示のノイズ防止 — pkg_* / brand_card / direct 等は「入口」文言を出さない）。
 */
function normalizeEntrySource(source: string | null | undefined): EntrySource | null {
  return source === "marche" || source === "online" || source === "other" ? source : null;
}

/**
 * マイカルテ表示に必要な事実の集合（read-only で組み立てた「人間に見せる前の素材」）。
 * 生スコア（persona.scores・affinity 数値）は**含めない**。表示側 buildKarteSummary が人間語に組む。
 */
export interface KarteDisplay {
  /** Shopify 連携済みか（購入セクションの出し分けに使う）。 */
  linked: boolean;
  /** 診断ペルソナ（null=未診断）。 */
  persona: PersonaType | null;
  /** 会話/購入由来の好み（null 可）。 */
  tasteProfile: TasteProfile | null;
  /** 入口（marche/online/other・未知は null）。 */
  entrySource: EntrySource | null;
  /** 「おいしかった」= +1 評価銘柄の正準ラベル `番号｜名前`（最大 5 件）。 */
  ratedGoodLabels: string[];
  /** 好み診断を完了しているか（persona 確定を以て「済み」とみなす）。 */
  diagnosisDone: boolean;
  /** 直近のお届け（連携時のみ・未連携は空配列）。 */
  recentOrders: OrderSummary[];
  /** 直近に見せた「次の一杯」の正準ラベル（根拠表示用・無ければ null）。 */
  lastNextCupLabel: string | null;
}

/** loadKarteForDisplay の依存注入（テストは fake を注入し I/O 非接触にする）。 */
export interface KarteDisplayDeps {
  resolveShopifyId?: (lineUserId: string, supabase: SupabaseClient) => Promise<string | null>;
  getShopifyProfile?: (shopifyId: string, fsEnv: FirestoreEnv) => Promise<CustomerProfile | null>;
  getLineProfile?: (lineUserId: string, fsEnv: FirestoreEnv) => Promise<LineUserProfile | null>;
  getRatings?: (supabase: SupabaseClient, userRef: string) => Promise<UserRatingRow[]>;
  fetchTeas?: (env: Env) => Promise<TeaItem[]>;
  getOrders?: (lineUserId: string, env: Env) => Promise<OrderSummary[]>;
  getLastNextCup?: (
    supabase: SupabaseClient,
    userRef: string,
  ) => Promise<{ productNo: string | null; value: string | null } | null>;
}

/** すべて空の表示カルテ（読取総崩れ時のフォールバック・フローを止めない）。 */
const EMPTY_DISPLAY: KarteDisplay = {
  linked: false,
  persona: null,
  tasteProfile: null,
  entrySource: null,
  ratedGoodLabels: [],
  diagnosisDone: false,
  recentOrders: [],
  lastNextCupLabel: null,
};

/**
 * マイカルテ表示用のカルテを read-only で集約する（UX②）。**書き込みは一切しない**。
 *
 * 連携済み=users カルテ / 未連携 LINE=lineUsers を読む（loadCustomerKarte と同じ分岐）。評価銘柄・
 * 直近注文（連携時のみ）・直近の「次の一杯」を fail-safe に足す。どの read が失敗しても取れた事実だけで
 * 組み、決してフローを止めない（未連携ユーザーは購入セクションが空配列になるだけで完全動作する）。
 *
 * 生スコア（persona.scores / affinity 数値）は集めない。返すのは人間語化前の中立な事実のみ。
 */
export async function loadKarteForDisplay(
  lineUserId: string,
  env: Env,
  supabase: SupabaseClient,
  deps?: KarteDisplayDeps,
): Promise<KarteDisplay> {
  const resolveShopifyId =
    deps?.resolveShopifyId ??
    ((id: string, sb: SupabaseClient) => resolveCallerShopifyCustomerId(id, "line", sb));
  const getShopifyProfile = deps?.getShopifyProfile ?? getCustomerProfile;
  const getLineProfile = deps?.getLineProfile ?? getLineUserProfile;
  const getRatings = deps?.getRatings ?? getUserRatings;
  const fetchTeas = deps?.fetchTeas ?? fetchSellingTeas;
  const getOrders = deps?.getOrders ?? ((id: string, e: Env) => fetchRecentOrders(id, "line", e));
  const getLastNextCup = deps?.getLastNextCup ?? getLatestNextCupShown;

  try {
    // (1) プロファイル（persona / taste / 入口）。連携解決 → users or lineUsers（fail-safe）。
    let linked = false;
    let persona: PersonaType | null = null;
    let tasteProfile: TasteProfile | null = null;
    let source: string | null | undefined = null;
    try {
      const fsEnv = getFirestoreEnv(env);
      const shopifyId = await resolveShopifyId(lineUserId, supabase);
      if (shopifyId) {
        linked = true;
        const profile = await getShopifyProfile(shopifyId, fsEnv);
        persona = profile?.persona?.primary ?? null;
        tasteProfile = profile?.tasteProfile ?? null;
        source = profile?.onboarding?.source ?? null;
      } else if (LINE_USER_ID_RE.test(lineUserId)) {
        const lineProfile = await getLineProfile(lineUserId, fsEnv);
        persona = lineProfile?.persona?.primary ?? null;
        tasteProfile = lineProfile?.tasteProfile ?? null;
        source = lineProfile?.onboarding?.source ?? null;
      }
    } catch (err) {
      // Firebase 未設定・連携解決失敗・読取失敗 → プロファイルは空のまま続行（他の事実は拾う）。
      console.warn(
        "[my-karte] profile read skipped (non-blocking):",
        err instanceof Error ? err.message : err,
      );
    }

    // (2) 「おいしかった」= +1 評価銘柄 → 販売中メニューで銘柄名に解決（最大 5 件・fail-safe）。
    const ratedGoodLabels: string[] = [];
    try {
      const ratings = await getRatings(supabase, lineUserId);
      const positives = positiveRatedProductNos(ratings);
      if (positives.length > 0) {
        const teas = await fetchTeas(env);
        for (const no of positives) {
          const tea = teas.find((t) => t.number === no);
          if (tea) ratedGoodLabels.push(formatTeaLabel({ name: tea.name, number: tea.number }));
          if (ratedGoodLabels.length >= 5) break;
        }
      }
    } catch (err) {
      console.warn(
        "[my-karte] ratings read skipped (non-blocking):",
        err instanceof Error ? err.message : err,
      );
    }

    // (3) 直近のお届け（連携時のみ・未連携は取りに行かない → 空配列）。
    let recentOrders: OrderSummary[] = [];
    if (linked) {
      try {
        recentOrders = await getOrders(lineUserId, env);
      } catch (err) {
        console.warn(
          "[my-karte] orders read skipped (non-blocking):",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // (4) 直近に見せた「次の一杯」→ 銘柄ラベルに解決（根拠表示用・fail-safe）。
    let lastNextCupLabel: string | null = null;
    try {
      const last = await getLastNextCup(supabase, lineUserId);
      if (last?.productNo) {
        const teas = await fetchTeas(env);
        const tea = teas.find((t) => t.number === last.productNo);
        lastNextCupLabel = tea
          ? formatTeaLabel({ name: tea.name, number: tea.number })
          : last.productNo;
      }
    } catch (err) {
      console.warn(
        "[my-karte] last next-cup read skipped (non-blocking):",
        err instanceof Error ? err.message : err,
      );
    }

    return {
      linked,
      persona,
      tasteProfile,
      entrySource: normalizeEntrySource(source),
      ratedGoodLabels,
      diagnosisDone: persona !== null,
      recentOrders,
      lastNextCupLabel,
    };
  } catch (err) {
    console.warn(
      "[my-karte] display load total failure (non-blocking):",
      err instanceof Error ? err.message : err,
    );
    return EMPTY_DISPLAY;
  }
}
