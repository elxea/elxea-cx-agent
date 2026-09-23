/**
 * 送信後の台帳補正 —「見積で建てた行を、LINE が数えた実到達数で直す」（GET のみ・fail-soft）。
 *
 * ─ なぜ要るか ─
 *   通数台帳の claim は**送信より前**に建てる（真の排他のため。message-ledger.ts 参照）。
 *   その時点で書ける人数は「送信直前に数えた友だち数」であって、実際に何通届いたかではない。
 *   全員配信は宛先指定なしなので、送信と着信の間に友だちが増減すればズレる。
 *   LINE は送信 1 回ぶんの実数を持っているので、後から引いて台帳を正す。
 *
 * ─ 取得元 ─
 *   GET https://api.line.me/v2/bot/insight/message/event?requestId=<X-Line-Request-Id>
 *     - overview.delivered = その送信で実際に配信された通数。
 *       uniqueImpression / uniqueClick と違い **20 人未満でも null にならない**（プライバシー丸めの対象外）。
 *     - 統計は**送信から 14 日間のみ**保持される（それ以降は引けない＝後付け不可）。
 *     - 配信が完了するまで status が "unready" で delivered は引けない（＝即時ではなく後追いで回す）。
 *   参照: https://developers.line.biz/en/reference/messaging-api/#get-message-event
 *
 * ─ 姿勢 ─
 *   - **GET のみ**。LINE 送信系 API（broadcast / push / multicast / narrowcast / reply）は 1 つも呼ばない。
 *   - **fail-soft**。これは帳簿の精度を上げる後追い処理であって、送信可否を握らない。
 *     取得不能・列未適用・例外はすべて ok:false（理由付き）に倒し、**決して throw しない**。
 *     （呼び出し元に配信経路が含まれるため、ここで throw すると配信を巻き添えにする）
 *   - **下げる方向の補正もする**。実数が見積より少なければ台帳も減らす（無料枠の残りを正しく戻す）。
 *   - PII 非保持: 扱うのは requestId と件数だけ。LINE userId には触れない。
 *
 * 器の正本: src/db/migrations/055_line_message_ledger_delivery_truth.sql
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../index";
import { createSupabaseClient } from "./supabase";
import { resolveDeliveryChannel } from "./delivery-channel";
import { LEDGER_TABLE } from "./message-ledger";

/** insight（送信 1 回ぶんのイベント統計）の取得エンドポイント（GET のみ）。 */
export const LINE_INSIGHT_MESSAGE_EVENT_URL =
  "https://api.line.me/v2/bot/insight/message/event";

/** LINE が統計を保持する期間（日）。これを過ぎた送信はもう引けない。 */
export const INSIGHT_RETENTION_DAYS = 14;

/**
 * 補正対象を引く PostgREST の or 条件（出所が未記録、または実数でも宛先列挙でもない行）。
 * NULL は not.in に掛からないため is.null を併記する。
 */
export const RECONCILE_PENDING_FILTER =
  "recipients_basis.is.null,recipients_basis.not.in.(actual_delivered,addressed_list)";

/** 1 回の実行で補正を試みる行数の上限（LINE への GET を無制限に撃たないための安全弁）。 */
export const RECONCILE_MAX_ROWS = 50;

/** 送信 1 回ぶんの実配信数。 */
export interface DeliveredStats {
  /** HTTP 200 かつ body をパースできたら true。 */
  ok: boolean;
  /** 実配信通数。まだ集計されていない（status=unready 等）なら null。 */
  delivered: number | null;
  /** 取得できなかった理由（PII 非記載）。成功時は undefined。 */
  reason?: string;
}

/** requestId → 実配信数 の取得関数（DI 可能にしてテストをネットワーク非接触に保つ）。 */
export type DeliveredStatsFetcher = (requestId: string) => Promise<DeliveredStats>;

/** 補正対象の台帳行（必要最小・PII なし）。 */
export interface ReconcileTargetRow {
  id: string;
  lineRequestId: string;
  recipients: number;
  createdAt: string;
}

/** 1 行ぶんの処理結果。 */
export interface ReconcileDetail {
  id: string;
  /** corrected=実数で直した / unchanged=実数と一致 / pending=まだ集計前 / failed=取得不能 */
  outcome: "corrected" | "unchanged" | "pending" | "failed";
  before: number;
  after: number | null;
  reason?: string;
}

export interface ReconcileResult {
  ok: boolean;
  reason?: string;
  scanned: number;
  corrected: number;
  details: ReconcileDetail[];
}

/**
 * insight のレスポンス（raw JSON）から実配信数を取り出す（純粋）。
 *
 * - object でなければ取得失敗扱い。
 * - status が "ready" 以外（"unready" 等）のときは、まだ集計前として delivered=null（ok:true）。
 * - overview.delivered が数値のときだけ数として採用する（非数値・欠落は null）。
 */
export function parseDeliveredStats(raw: unknown): DeliveredStats {
  if (!raw || typeof raw !== "object") {
    return { ok: false, delivered: null, reason: "body が object でない" };
  }
  const status = (raw as { overview?: { status?: unknown } }).overview?.status;
  const overview = (raw as { overview?: unknown }).overview;
  if (!overview || typeof overview !== "object") {
    return { ok: true, delivered: null, reason: "overview 無し（集計前）" };
  }
  if (typeof status === "string" && status !== "ready") {
    return { ok: true, delivered: null, reason: `status=${status}` };
  }
  const delivered = (overview as { delivered?: unknown }).delivered;
  if (typeof delivered !== "number" || !Number.isFinite(delivered)) {
    return { ok: true, delivered: null, reason: "delivered が数値でない（集計前）" };
  }
  return { ok: true, delivered: Math.trunc(delivered) };
}

/**
 * 実 LINE Insight を叩く DeliveredStatsFetcher（GET のみ・**throw しない**）。
 * accessToken は「その配信を送った OA のトークン」を渡すこと（統計は OA 単位）。
 */
export function createDeliveredStatsFetcher(
  accessToken: string,
): DeliveredStatsFetcher {
  return async (requestId: string): Promise<DeliveredStats> => {
    try {
      const url = `${LINE_INSIGHT_MESSAGE_EVENT_URL}?requestId=${encodeURIComponent(requestId)}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        return { ok: false, delivered: null, reason: `insight/message/event ${res.status}` };
      }
      return parseDeliveredStats(await res.json());
    } catch (err) {
      return {
        ok: false,
        delivered: null,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  };
}

/** 統計がまだ引ける期間内か（純粋）。送信から INSIGHT_RETENTION_DAYS 以内なら true。 */
export function isWithinInsightRetention(createdAt: Date, now: Date): boolean {
  const elapsed = now.getTime() - createdAt.getTime();
  return elapsed >= 0 && elapsed <= INSIGHT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * 1 行ぶんの補正判定（純粋）。DB も LINE も触らない。
 *
 * - delivered が null（集計前）→ pending（次回に持ち越す。台帳は触らない）
 * - delivered が現在値と同じ → unchanged（basis だけ実数に格上げする価値はあるので corrected 扱いにしない）
 * - 異なる → corrected（増減どちらでも直す）
 */
export function decideCorrection(
  row: ReconcileTargetRow,
  stats: DeliveredStats,
): ReconcileDetail {
  if (!stats.ok) {
    return { id: row.id, outcome: "failed", before: row.recipients, after: null, reason: stats.reason };
  }
  if (stats.delivered == null) {
    return { id: row.id, outcome: "pending", before: row.recipients, after: null, reason: stats.reason };
  }
  if (stats.delivered === row.recipients) {
    return { id: row.id, outcome: "unchanged", before: row.recipients, after: stats.delivered };
  }
  return { id: row.id, outcome: "corrected", before: row.recipients, after: stats.delivered };
}

/** DB 側の口（テストは fake を注入する）。 */
export interface ReconcileStore {
  /** 補正待ちの行（requestId あり・まだ実数で確定していない）を取る。 */
  loadPending(limit: number): Promise<ReconcileTargetRow[]>;
  /** recipients を実数で上書きし、出所を actual_delivered に格上げする。 */
  applyActual(id: string, delivered: number, note: string): Promise<void>;
}

/** Supabase 実装の ReconcileStore。 */
export function createSupabaseReconcileStore(
  supabase: SupabaseClient,
): ReconcileStore {
  return {
    async loadPending(limit: number): Promise<ReconcileTargetRow[]> {
      const { data, error } = await supabase
        .from(LEDGER_TABLE)
        .select("id, line_request_id, recipients, created_at")
        .not("line_request_id", "is", null)
        // 既に実数で確定した行は対象外（is.null で「未確定 or 見積のまま」を拾う）。
        // 宛先を列挙した送信（addressed_list = multicast）も対象外: insight/message/event は
        //   broadcast/narrowcast の鍵でしか引けず、multicast の鍵で 14 日間 GET し続けるだけになる。
        .or(RECONCILE_PENDING_FILTER)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) {
        // migration 055 未適用なら列不在でここに来る（呼び出し側が fail-soft で理由化する）。
        throw new Error(`台帳の補正対象取得に失敗: ${error.message}`);
      }
      return (data ?? []).map(
        (r: {
          id: string;
          line_request_id: string;
          recipients: number;
          created_at: string;
        }) => ({
          id: r.id,
          lineRequestId: r.line_request_id,
          recipients: r.recipients,
          createdAt: r.created_at,
        }),
      );
    },

    async applyActual(id: string, delivered: number, note: string): Promise<void> {
      const { error } = await supabase
        .from(LEDGER_TABLE)
        .update({
          recipients: delivered,
          recipients_basis: "actual_delivered",
          note,
        })
        .eq("id", id);
      if (error) throw new Error(`台帳の補正書き込みに失敗（id=${id}）: ${error.message}`);
    },
  };
}

export interface ReconcileDeps {
  store?: ReconcileStore;
  fetchDelivered?: DeliveredStatsFetcher;
  now?: Date;
  maxRows?: number;
}

/**
 * 台帳の後追い補正を 1 巡回す。
 *
 * 手順:
 *   1. requestId を持ち、まだ実数で確定していない行を新しい順に取る（上限つき）。
 *   2. 統計保持期間（14 日）を過ぎた行は諦める（もう引けない）。
 *   3. 残りを LINE に問い合わせ、実数が出たものだけ台帳を直す。
 *
 * **決して throw しない**（配信経路から呼ばれるため。失敗は ok:false と理由で返す）。
 */
export async function runBroadcastRecipientReconcile(
  env: Env,
  deps: ReconcileDeps = {},
): Promise<ReconcileResult> {
  const now = deps.now ?? new Date();
  const maxRows = deps.maxRows ?? RECONCILE_MAX_ROWS;
  const details: ReconcileDetail[] = [];

  let store = deps.store;
  let fetchDelivered = deps.fetchDelivered;

  try {
    if (!store) store = createSupabaseReconcileStore(createSupabaseClient(env));
    if (!fetchDelivered) {
      // 送った OA のトークンで引く（統計は OA 単位）。未設定は fail-closed の resolve を fail-soft で包む。
      const channel = resolveDeliveryChannel(env);
      fetchDelivered = createDeliveredStatsFetcher(channel.accessToken);
    }
  } catch (err) {
    return {
      ok: false,
      reason: `補正の前提が揃わない: ${err instanceof Error ? err.message : String(err)}`,
      scanned: 0,
      corrected: 0,
      details,
    };
  }

  let corrected = 0;
  try {
    const rows = await store.loadPending(maxRows);
    for (const row of rows) {
      const createdAt = new Date(row.createdAt);
      if (!isWithinInsightRetention(createdAt, now)) {
        // 14 日を過ぎた行は LINE 側にもう統計が無い。見積のまま残す（嘘の数字で塗らない）。
        details.push({
          id: row.id,
          outcome: "failed",
          before: row.recipients,
          after: null,
          reason: `統計保持期間(${INSIGHT_RETENTION_DAYS}日)を超過`,
        });
        continue;
      }

      const stats = await fetchDelivered(row.lineRequestId);
      const detail = decideCorrection(row, stats);

      if (detail.outcome === "corrected" && detail.after != null) {
        await store.applyActual(
          row.id,
          detail.after,
          `送信後補正: 見積${detail.before} → 実配信${detail.after}（insight/message/event）`,
        );
        corrected++;
      } else if (detail.outcome === "unchanged" && detail.after != null) {
        // 数は同じでも「見積」から「実数」へ格上げしておく（次回以降スキャン対象から外れる）。
        await store.applyActual(
          row.id,
          detail.after,
          `送信後確認: 見積と実配信が一致（${detail.after}）`,
        );
      }
      details.push(detail);
    }

    return { ok: true, scanned: rows.length, corrected, details };
  } catch (err) {
    return {
      ok: false,
      reason: `補正に失敗（migration 055 未適用の可能性）: ${err instanceof Error ? err.message : String(err)}`,
      scanned: details.length,
      corrected,
      details,
    };
  }
}
