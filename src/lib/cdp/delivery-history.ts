/**
 * @layer CDP
 *
 * 送った記録の台帳の読み口（roji タッチポイント地図 A-0）— TypeScript 側。
 *
 * 設計正本: roji体験目的 × タッチポイント全体地図（2026-09-02・Setaka 承認済み）第4章 A-0
 * SQL 側の本体: `src/db/migrations/053_cdp_delivery_readout.sql`
 *   （`cdp_delivery_history_for_identifier`。**引き方の正本はあちら**）
 *
 * ─ ここが何をするか、しないか ─
 *
 *   する    … RPC を呼び、返ってきた形を検査して型に読む。読めなければ空で戻る。
 *   しない  … 台帳を直に引かない / 主体の解決をここでやり直さない / 何も書かない。
 *
 *   引き方を SQL 側に置いたままにするのは、主体の解決（`cdp_subject_component`）を
 *   跨ぐ読み出しが **既に SQL 側 1 か所に寄せてある**ため。TS 側で組み直すと、
 *   同じ問いに答える経路が 2 本になる（shipment.ts が「ここに 2 本目の解決を
 *   作らない」と書いているのと同じ理由）。
 *
 * ─ L0 の `shipment.sent` との棲み分け ─
 *
 *   `src/lib/cdp/shipment.ts` の `readShipmentHistory` は **L0 の時系列**を読む
 *   （その主体の身に送付が何回起きたか）。回答率（051）の分母がそれである。
 *   こちらは **台帳の中身**を読む（その月に何を送ることにして、何が届いたか）。
 *   問いが違うので両方要る。詳しい理由は 053 の冒頭に書いた（同じ説明を写さない）。
 *
 * ─ 決して throw しない ─
 *
 *   呼び出し元は画面（じぶんのページ / 今月のお茶）である。台帳が読めないことは
 *   画面が落ちる理由にならない。読めなければ `found:false` と理由を返し、
 *   呼び出し側が「まだ何も届いていません」ではなく「いま読めません」と言えるようにする。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ObservedIdentifier } from "./subjects";

/** 1 回に返す月数の既定と上限（SQL 側 `cdp_delivery_months_bound` と同じ値）。 */
export const DELIVERY_HISTORY_DEFAULT_MONTHS = 12;
export const DELIVERY_HISTORY_MAX_MONTHS = 36;

/** 割当が指した 1 銘柄（033 の teas 1 件）。 */
export interface AssignedTea {
  /** Tea Menu の 5 桁番号。評価の口（rating.submitted）が要求するのと同じ語彙。 */
  productNo: string;
  /** 割当の時点での表示名（写し）。無ければ null。 */
  name: string | null;
}

/** その月に「送ることにした」もの（033・決めた記録）。 */
export interface AssignedForPeriod {
  /** どの号を（roji_delivery_ledger.issue_ref）。無い月は null。 */
  issueRef: string | null;
  teas: AssignedTea[];
  /** 出所。033 由来であることの印（捏造しない）。 */
  basis: "assignment";
}

/** その月に「実際に届いた」1 行（038・届いた記録）。 */
export interface DeliveredItem {
  /** 銘柄の参照（Shopify の product_id 系 / 手動投入の任意の参照）。 */
  itemRef: string;
  /** 届いた時点の表示名の写し。無ければ null。 */
  itemName: string | null;
  itemKind: "tea" | "goods" | "other" | "unknown";
  quantity: number;
  /** YYYY-MM-DD。 */
  deliveredOn: string;
  /** 日付の確からしさ（038 の date_basis）。 */
  dateBasis: "ordered" | "fulfilled" | "manual";
  /** どこから来た記録か（038 の source）。 */
  source: "shopify_order" | "manual" | "roji_assignment";
}

/**
 * 1 か月ぶん。**決めたこと と 届いたこと を同じ配列に畳まない**
 * （038 の冒頭が明記しているとおり、両者はずれることがある事実である）。
 */
export interface DeliveryHistoryMonth {
  /** YYYY-MM（033 / 038 の period と同じ形）。 */
  period: string;
  /** 割当の行が無い月は null。 */
  assigned: AssignedForPeriod | null;
  /** 届いた行が無い月は空配列。 */
  delivered: DeliveredItem[];
}

/** 読み口の返り。 */
export interface DeliveryHistoryResult {
  found: boolean;
  /** found=false の理由（T-12: 無言で戻らない）。 */
  reason?: string;
  /** 実際に返した月数の上限。 */
  months?: number;
  /**
   * 台帳を引くのに使えた鍵の **件数**（値は返らない）。
   * 0 件のときに「まだ何も届いていない」のか「鍵が繋がっていない」のかを、
   * 呼ぶ側が生値を見ずに切り分けるための唯一の手がかり。
   */
  keys?: { shopifyCustomerId: number; lineMessagingUid: number };
  /** 新しい月が先頭。 */
  periods: DeliveryHistoryMonth[];
}

const EMPTY = (reason: string): DeliveryHistoryResult => ({
  found: false,
  reason,
  periods: [],
});

export interface ReadDeliveryHistoryOptions {
  /** 何か月ぶん返すか（既定 12・上限 36）。範囲外は SQL 側で丸められる。 */
  months?: number;
}

/**
 * 人を指す鍵 1 つから、月ごとの送付履歴を読む。**決して throw しない。**
 *
 * @param identifier 呼び出し側で真正性を担保した鍵（LINE webhook の署名済み userId /
 *                   サーバが持っている Shopify 顧客番号 / web の session_id 等）。
 */
export async function readDeliveryHistory(
  supabase: SupabaseClient,
  identifier: ObservedIdentifier,
  opts: ReadDeliveryHistoryOptions = {},
): Promise<DeliveryHistoryResult> {
  const value = typeof identifier?.value === "string" ? identifier.value.trim() : "";
  if (value === "") return EMPTY("identifier_empty");
  // SEC-1: メールの hash から人を引く経路は作らない（SQL 側も同じ枝を持つ）。
  if (identifier.kind === "email_hash") return EMPTY("identifier_kind_not_resolvable");

  try {
    const { data, error } = await supabase.rpc("cdp_delivery_history_for_identifier", {
      p_kind: identifier.kind,
      p_value: value,
      p_months: boundMonths(opts.months),
    });

    if (error) {
      // migration 053 未適用（関数が無い）もここに来る。画面は落とさず、
      // 「いま読めない」と言えるだけの理由を返す。
      console.warn(
        "[cdp/delivery-history] rpc failed (non-blocking):",
        JSON.stringify({ kind: identifier.kind, reason: error.message }),
      );
      return EMPTY("rpc_failed");
    }

    return readDeliveryHistoryResult(data);
  } catch (err) {
    console.warn(
      "[cdp/delivery-history] unexpected error (non-blocking):",
      err instanceof Error ? err.message : String(err),
    );
    return EMPTY("unexpected_error");
  }
}

/** 月数を既定と上限に丸める（SQL 側と同じ規則を口の側にも置く）。 */
export function boundMonths(months: number | undefined): number {
  const n =
    typeof months === "number" && Number.isFinite(months)
      ? Math.trunc(months)
      : DELIVERY_HISTORY_DEFAULT_MONTHS;
  return Math.min(Math.max(n, 1), DELIVERY_HISTORY_MAX_MONTHS);
}

/**
 * RPC の戻り（jsonb）を型に読む。**壊れた形は found:false に倒す**（純粋・テスト対象）。
 *
 * 中途半端に読まないのは、足りない履歴で「先月への返事」を書くと
 * **本当は送ったものを送っていないと言う**ことになるため。A-1 が守るべき約束
 * （「回答直後の予告と、翌月の実行の文言を一致させる」）は、材料が欠けたまま
 * 部分的に成立させてよいものではない。
 */
export function readDeliveryHistoryResult(data: unknown): DeliveryHistoryResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return EMPTY("rpc_shape_unexpected");
  }
  const row = data as Record<string, unknown>;

  if (row.found !== true) {
    return EMPTY(typeof row.reason === "string" && row.reason !== "" ? row.reason : "not_found");
  }
  if (!Array.isArray(row.periods)) return EMPTY("rpc_shape_unexpected");

  const periods: DeliveryHistoryMonth[] = [];
  for (const raw of row.periods) {
    const month = readMonth(raw);
    if (month) periods.push(month);
  }

  return {
    found: true,
    months: intOr(row.months, DELIVERY_HISTORY_DEFAULT_MONTHS),
    keys: readKeys(row.keys),
    // SQL 側が新しい月順で返すが、口の側でも並べ直す（並び順を 1 か所に頼らない）。
    periods: periods.sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0)),
  };
}

// ---------------------------------------------------------------------------
// 内部（形の検査）
// ---------------------------------------------------------------------------

const PERIOD_FORM = /^\d{4}-\d{2}$/;
const DAY_FORM = /^\d{4}-\d{2}-\d{2}$/;
const ITEM_KINDS: ReadonlySet<string> = new Set(["tea", "goods", "other", "unknown"]);
const DATE_BASES: ReadonlySet<string> = new Set(["ordered", "fulfilled", "manual"]);
const LEDGER_SOURCES: ReadonlySet<string> = new Set([
  "shopify_order",
  "manual",
  "roji_assignment",
]);

function readMonth(raw: unknown): DeliveryHistoryMonth | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const period = str(row.period);
  if (!PERIOD_FORM.test(period)) return null;

  return {
    period,
    assigned: readAssigned(row.assigned),
    delivered: Array.isArray(row.delivered)
      ? row.delivered.map(readDelivered).filter((x): x is DeliveredItem => x !== null)
      : [],
  };
}

function readAssigned(raw: unknown): AssignedForPeriod | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  const teas: AssignedTea[] = [];
  if (Array.isArray(row.teas)) {
    for (const t of row.teas) {
      if (!t || typeof t !== "object" || Array.isArray(t)) continue;
      const item = t as Record<string, unknown>;
      const productNo = str(item.product_no);
      if (productNo === "") continue;
      teas.push({ productNo, name: nullableStr(item.name) });
    }
  }

  return { issueRef: nullableStr(row.issue_ref), teas, basis: "assignment" };
}

function readDelivered(raw: unknown): DeliveredItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  const itemRef = str(row.item_ref);
  if (itemRef === "") return null;
  const deliveredOn = str(row.delivered_on);
  if (!DAY_FORM.test(deliveredOn)) return null;

  const kind = str(row.item_kind);
  const dateBasis = str(row.date_basis);
  const source = str(row.source);

  // 出所タグが語彙どおりでない行は落とす。**捏造して埋めない** —
  // 「どこから来た記録か分からないもの」を既定値で埋めると、出所タグを
  // 付けている意味（どれを本人に見せてよいか / 直させてよいかの判定）が消える。
  if (!ITEM_KINDS.has(kind) || !DATE_BASES.has(dateBasis) || !LEDGER_SOURCES.has(source)) {
    return null;
  }

  return {
    itemRef,
    itemName: nullableStr(row.item_name),
    itemKind: kind as DeliveredItem["itemKind"],
    quantity: Math.max(1, intOr(row.quantity, 1)),
    deliveredOn,
    dateBasis: dateBasis as DeliveredItem["dateBasis"],
    source: source as DeliveredItem["source"],
  };
}

function readKeys(raw: unknown): DeliveryHistoryResult["keys"] {
  const row =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    shopifyCustomerId: intOr(row.shopify_customer_id, 0),
    lineMessagingUid: intOr(row.line_messaging_uid, 0),
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function nullableStr(v: unknown): string | null {
  const s = str(v);
  return s === "" ? null : s;
}

function intOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}
