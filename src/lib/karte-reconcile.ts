/**
 * 毎日の照合 — 「連携しているのに合流していない人」を拾い直す（取りこぼしゼロの最後の担保）。
 *
 * 一次入力（仕様の正本）:
 *   roji同じ人だと分かる仕組み  https://www.notion.so/3b570c9d064c81d68610f9360f50c965
 *     第3章「装置3: 合流を2重に起動する — 出来事のたび + 毎日の照合」
 *     第6章 アンケート公開前に必要（5件）の 4
 *
 * ■ なぜ要るのか
 *   合流処理は会話やログインを止めないよう、**失敗しても黙って先へ進む**作りになっている
 *   （呼び出し元がすべて try/catch か .catch で握りつぶす）。出来事駆動だけだと、その一度の失敗が
 *   永久に残る。毎日 1 回拾い直すことで「合流の機会が二度と来ない」を無くす。
 *
 * ■ 回収できる範囲（正確に・範囲外は範囲外と分かる形にする）
 *   回収できる:   未連携カルテ（Firestore lineUsers/{lineUserId}）→ 本カルテ（users/{shopifyId}）
 *                 の合流。穴1（持ち越し漏れ）・穴2（好みが空で空振り）はここで戻る。
 *   回収できない: 穴3（そもそも未連携カルテに書かれていない）… 戻すものが無い。生の出来事
 *                 （flow_events の welcome.source / welcome.tap / onboarding.complete）からの
 *                 再構築が回復経路であり、この照合の範囲外。
 *                 穴4（サイト側 users/line:{id} 配下のお気に入り・農家フォロー・イベント申込）…
 *                 別リポ（elxea-web-app）の別経路。合流処理の1本化（後でよい・6）が回復経路。
 *   → 戻り値の `outOfScope` にこの 2 つを明示して返す。「照合が回ったから全部安全」と
 *     読み違えられないようにするための、意図的な自己申告。
 *
 * ■ 安全
 *   - 追加のみ。既存データを削除・書き換えしない（mergeLineUserIntoShopify が担保）。
 *   - 外部送信ゼロ。LINE も メールも一切送らない（data-only）。
 *   - 冪等: 合流済み（mergedToShopify=true）は mergeLineUserIntoShopify 側で no-op。
 *   - 1 件の失敗で全体を止めない（件数だけ数えて次へ）。
 *   - 個人データは返さない・ログにも出さない（件数と識別子の有無のみ）。
 */

import type { Env } from "../index";
import { createSupabaseClient } from "./supabase";
import {
  getFirestoreEnv,
  getLineUserProfile,
  mergeLineUserIntoShopify,
  type FirestoreEnv,
} from "./firestore";

/** 照合 1 回の結果（件数のみ・個人データを含まない）。 */
export type KarteReconcileResult = {
  /** 連携済み（shopify_customer_id を持つ）として走査した行数。 */
  scanned: number;
  /** 未連携カルテが在り、かつ未合流だったため合流を実行した件数。 */
  merged: number;
  /** 既に合流済み or 未連携カルテ不在でスキップした件数。 */
  skipped: number;
  /** 合流に失敗した件数（次回の照合で再試行される）。 */
  failed: number;
  durationMs: number;
  /** この照合では戻せないもの（範囲外の明示）。 */
  outOfScope: string[];
  /** 実行しなかった理由（設定不足等）。実行したときは null。 */
  notRun: string | null;
};

/** この照合の範囲外（第3章「穴ごとに回復経路が違う」）。 */
const OUT_OF_SCOPE = [
  "穴3: 未連携カルテに書かれていない入口の答え（回復経路 = flow_events からの再構築）",
  "穴4: サイト側 users/line:{id} 配下の足あと（回復経路 = 合流処理の1本化・別リポ）",
];

/** 1 回の照合で処理する上限（友だち約 48 人の規模に対し十分な余裕。暴走防止）。 */
const MAX_ROWS = 2000;

/**
 * 連携済みなのに合流していない人を拾い直す。
 *
 * @param env Workers 環境変数
 * @param deps テスト用 DI（本番は省略）。実 I/O を差し替えてハーメティックに検証する。
 */
export async function runKarteReconcile(
  env: Env,
  deps?: {
    listLinkages?: () => Promise<Array<{ lineUserId: string; shopifyCustomerId: string }>>;
    getLineUser?: typeof getLineUserProfile;
    merge?: typeof mergeLineUserIntoShopify;
    fsEnv?: FirestoreEnv;
  },
): Promise<KarteReconcileResult> {
  const startedAt = Date.now();
  const base = (notRun: string | null): KarteReconcileResult => ({
    scanned: 0,
    merged: 0,
    skipped: 0,
    failed: 0,
    durationMs: Date.now() - startedAt,
    outOfScope: [...OUT_OF_SCOPE],
    notRun,
  });

  let fsEnv: FirestoreEnv;
  try {
    fsEnv = deps?.fsEnv ?? getFirestoreEnv(env);
  } catch {
    // Firestore 未設定（staging 等）では静かに何もしない。cron を落とさない。
    return base("firestore not configured");
  }

  const listLinkages =
    deps?.listLinkages ??
    (async () => {
      const supabase = createSupabaseClient(env);
      const { data, error } = await supabase
        .from("customer_linkages")
        .select("line_user_id, shopify_customer_id")
        .not("shopify_customer_id", "is", null)
        .limit(MAX_ROWS);
      if (error) throw new Error(`customer_linkages query failed: ${error.message}`);
      return (data ?? [])
        .filter((r) => r.line_user_id && r.shopify_customer_id)
        .map((r) => ({
          lineUserId: String(r.line_user_id),
          shopifyCustomerId: String(r.shopify_customer_id),
        }));
    });

  const getLineUser = deps?.getLineUser ?? getLineUserProfile;
  const merge = deps?.merge ?? mergeLineUserIntoShopify;

  let rows: Array<{ lineUserId: string; shopifyCustomerId: string }>;
  try {
    rows = await listLinkages();
  } catch (err) {
    console.warn(
      "[karte-reconcile] linkage query failed (non-blocking):",
      err instanceof Error ? err.message : err,
    );
    return base("linkage query failed");
  }

  const result = base(null);
  result.scanned = rows.length;

  for (const row of rows) {
    try {
      const lineProfile = await getLineUser(row.lineUserId, fsEnv);
      // 未連携カルテが無い / 既に合流済み → 拾うものが無い。
      if (!lineProfile || lineProfile.mergedToShopify === true) {
        result.skipped++;
        continue;
      }
      // 合流を実行する。好みが空でも成立し「合流済み」の印が付く（穴2 の封鎖と同じ経路）。
      await merge(row.lineUserId, row.shopifyCustomerId, fsEnv, {
        existingLine: lineProfile,
      });
      result.merged++;
    } catch (err) {
      // 1 件の失敗で全体を止めない。次回の照合で再試行される。
      result.failed++;
      console.warn(
        "[karte-reconcile] merge failed (will retry next run):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
