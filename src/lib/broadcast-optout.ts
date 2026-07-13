/**
 * 配信 opt-out（受け取り停止 / 再開）の実行 — UX レビュー指摘 #3。
 *
 * 背景:
 *   ⑤ elxea 紹介の末尾で「配信の頻度変更や停止をご希望の際は、いつでもこのままメッセージで
 *   お知らせください」と約束しているのに、AI 側に停止処理の道具が無かった（tools.ts の 5 道具に不在）。
 *   本モジュールは AI ツール `set_broadcast_optout` の実体で、既存 opt-out 基盤
 *   （migration 020: customer_linkages.broadcast_opted_out）へフラグを立てる/戻す。
 *
 * 除外経路（配信母集団の実装に整合）:
 *   - フラグの正本は customer_linkages.broadcast_opted_out。
 *   - 配信オーケストレータ（delivery-runtime.ts loadLinkages → target-resolver.ts filterEligible）は
 *     この列を読み、ペルソナ配信（multicast）で optedOut=true を除外する。
 *   - 未連携（shopify_customer_id 未解決）ユーザーには customer_linkages 行が無いことがあるため、
 *     LINE では line_user_id をキーに upsert して「行が無くても opt-out が確実に永続化」する。
 *     line_user_id は UNIQUE NOT NULL（migration 002）なので upsert の衝突キーに使える。
 *     shopify_customer_id は触らないため、後日 Shopify 連携が成立してもフラグは保持される
 *     （同一 line_user_id 行に連携情報が乗るだけで、opt-out は生き続ける）。
 *   - 注: 全員配信（broadcast/all）は LINE 側で受信者を絞れないため、この除外は multicast パス限定
 *     （migration 020 の設計注記どおり。技術制約であり本タスクの対象外）。
 *
 * fail-safe: 書き込み失敗（列未適用・ネットワーク等）は例外を投げず、丁寧な失敗文言を返して
 *   会話フローを止めない。誤って「停止しました」と言わないよう ok=false を明示する。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../index";
import type { Channel } from "./supabase";
import { createSupabaseClient } from "./supabase";

/** opt-out 実行結果。 */
export interface OptOutResult {
  /** DB 反映に成功したか（false のとき「停止/再開しました」と断言しない）。 */
  ok: boolean;
  /** 要求された状態（true=停止 / false=再開）。 */
  optedOut: boolean;
  /** ツール結果としてエージェントに渡すテキスト（顧客への言い回しの指針）。 */
  text: string;
}

/** テスト用の依存注入（本番は未指定で実クライアントを使う）。 */
export interface OptOutDeps {
  supabase?: SupabaseClient;
}

const STOP_OK =
  "配信停止を設定しました。お客様には『お知らせ配信の受け取りを停止しました。またご希望のときはいつでもメッセージでお知らせくださいね』と丁寧にお伝えください。";
const RESUME_OK =
  "配信再開を設定しました。お客様には『お知らせ配信の受け取りを再開しました。ありがとうございます』と丁寧にお伝えください。";
const FAIL_TEXT =
  "配信設定の変更処理に失敗しました。お客様には『設定に少し時間がかかっているようです。恐れ入りますが、もう一度お知らせいただけますか』と伝え、断定的に『停止しました』とは言わないでください。";

/**
 * 配信 opt-out フラグを設定/解除する。
 *
 * @param userId   LINE は lineUserId、Web は shopify_customer_id
 * @param channel  "line" | "web"
 * @param optOut   true=停止 / false=再開
 */
export async function setBroadcastOptOut(
  userId: string,
  channel: Channel,
  optOut: boolean,
  env: Env,
  deps?: OptOutDeps,
): Promise<OptOutResult> {
  const supabase = deps?.supabase ?? createSupabaseClient(env);
  const nowIso = new Date().toISOString();

  try {
    if (channel === "line") {
      // 未連携でも確実に永続化するため line_user_id をキーに upsert（行が無ければ作成）。
      // shopify_customer_id は指定しない = 既存連携情報を壊さない / 新規行は NULL のまま。
      const { error } = await supabase.from("customer_linkages").upsert(
        {
          line_user_id: userId,
          broadcast_opted_out: optOut,
          updated_at: nowIso,
        },
        { onConflict: "line_user_id" },
      );
      if (error) throw new Error(error.message);
    } else {
      // Web: line_user_id を持たないため、連携済み行（shopify_customer_id 一致）だけ更新する。
      // 行が無い＝配信対象になり得ないため作成はしない。
      const { error } = await supabase
        .from("customer_linkages")
        .update({ broadcast_opted_out: optOut, updated_at: nowIso })
        .eq("shopify_customer_id", userId);
      if (error) throw new Error(error.message);
    }

    return {
      ok: true,
      optedOut: optOut,
      text: optOut ? STOP_OK : RESUME_OK,
    };
  } catch (err) {
    console.warn(
      "[broadcast-optout] set failed (non-blocking):",
      err instanceof Error ? err.message : err,
    );
    return { ok: false, optedOut: optOut, text: FAIL_TEXT };
  }
}
