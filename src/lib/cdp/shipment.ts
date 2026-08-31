/**
 * @layer CDP
 *
 * 送付台帳を L0 の出来事にする —「誰に・いつ・どのお茶を・どの号を送ったか」を
 * subject_id から読めるようにする（roji マスタースペック 第4章 / CDP 統合設計 §5 E1）。
 *
 * ─ 何が既に在って、ここが何を足すのか（単一正本の線引き・重要）─
 *
 *   既に在るもの（新設しない）:
 *     - `tea_delivery_ledger`（migration 038）… 届いた事実の台帳。1人 × 1回 × 1銘柄。
 *       書き込み規則は DB 関数 `record_tea_deliveries`、行の組み立ては
 *       `src/lib/delivery-ledger.ts`、自動の入口は Shopify 注文 webhook。
 *     - `roji_delivery_ledger`（migration 033）… roji の「割当を決めた記録」（1人1月1行）。
 *       号の参照（issue_ref）はこちらが持つ。
 *
 *   足りていなかったもの（ここが埋める）:
 *     台帳の鍵は **EC の顧客番号 / LINE の ID** であって `subject_id` ではない。
 *     だから「この主体に何を送ったか」が L0（customer_events）から一切引けない。
 *     未連携の LINE の人と、連携後の顧客番号の人が **同じ人だと分かっていても**、
 *     送付の履歴だけは 2 つに割れたままになる（Stage 2 の canonical 解決が効かない）。
 *
 *   よって **台帳の器は 1 つも増やさず**、送付という出来事を L0 に 1 行積む。
 *   台帳（038）が「何がどう届いたかの詳しい正本」、L0 が「誰の身に何が起きたかの
 *   時系列」という役割分担で、数の正本は台帳の側に残す。
 *
 * ─ 冪等 ─
 *   dedupe は **注文（出荷）の参照 1 本**。同じ注文について後から
 *   「発送された」ことが分かって台帳の日付が ordered → fulfilled に上がっても、
 *   L0 には 2 行目を作らない（冪等キーが同じ → gateway が duplicate として弾く）。
 *   日付の精度を上げるのは台帳（038）の仕事で、L0 は「送った」を 1 回だけ数える。
 *
 * ─ PII ─
 *   payload に生の LINE userId・メール・住所・宛名を入れない。銘柄の参照と数量、
 *   届いた日、号の参照だけを置く（roji 正本 第4章の「置かないと決めたもの」と同じ姿勢）。
 *   人の鍵は identifier として gateway に渡すだけで、payload には落ちない。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  toJstDate,
  type DeliveryItemKind,
  type DeliveryRecord,
} from "../delivery-ledger";
import { CUSTOMER_EVENTS_TABLE, type CustomerFact } from "./events-gateway";
import {
  isWellFormedShipmentPayload,
  SHIPMENT_SENT_EVENT_TYPE,
} from "./event-vocabulary";
import type { ObservedIdentifier } from "./subjects";

/**
 * 型名と payload の形の正本は登録簿（event-vocabulary）の側にある。
 * ここから再輸出するのは、送付まわりの入口をこのモジュール 1 つに見せるためで、
 * **2 つ目の定義ではない**（値は 1 か所にしかない）。
 */
export { SHIPMENT_SENT_EVENT_TYPE, isWellFormedShipmentPayload };

/** 届いた日の形（台帳 038 の delivered_on と同じ）。 */
const SHIPPED_ON_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// 書く側 — 台帳の行から L0 の 1 件を組み立てる（純粋）
// ---------------------------------------------------------------------------

/** payload に載る 1 銘柄（名前は載せない。名前の正本は台帳と商品マスタ）。 */
export interface ShipmentPayloadItem {
  ref: string;
  kind: DeliveryItemKind;
  quantity: number;
}

export interface BuildShipmentFactOptions {
  /** どの経路が観測したか（slug）。gateway の source にそのまま入る。 */
  source: string;
  /** "shopify" / "line" / "web"。既知の語彙に載っている値を使う。 */
  channel: string;
  /**
   * どの号を送ったか（roji_delivery_ledger.issue_ref と同じ参照）。
   * EC の注文には号が無いので **省略が既定**。roji の割当から起こすときだけ渡す。
   */
  issueRef?: string | null;
}

/**
 * 台帳へ書いた行（1 注文ぶん）→ L0 の 1 件。
 *
 * 返り値が null になるのは「そもそも送付として数えられないとき」だけ:
 *   - 行が 0 件（guest checkout / 銘柄の参照が 1 つも無い注文）
 *   - 誰に届いたかの鍵が無い
 *   - 出所の参照が空（冪等キーが作れない = 二重計上を止められない）
 *
 * ⚠ 行が複数の日付・複数の出所にまたがっていたら組み立てない。1 件の
 *   `shipment.sent` は **1 回の送付**を表すので、混ざった行から 1 件を作ると
 *   どちらの日付とも違う出来事が L0 に残る（静かに歪む）。呼ぶ側で分けてから渡す。
 */
export function buildShipmentFact(
  rows: DeliveryRecord[],
  opts: BuildShipmentFactOptions,
): CustomerFact | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const first = rows[0];
  const sourceRef = (first.sourceRef ?? "").trim();
  if (sourceRef === "") return null;

  const shippedOn = (first.deliveredOn ?? "").trim();
  if (!SHIPPED_ON_RE.test(shippedOn)) return null;

  // 混ざった束は組み立てない（上の ⚠）。
  const mixed = rows.some(
    (r) => (r.sourceRef ?? "").trim() !== sourceRef || (r.deliveredOn ?? "").trim() !== shippedOn,
  );
  if (mixed) return null;

  const identifier = identifierForDelivery(first);
  if (!identifier) return null;

  const items: ShipmentPayloadItem[] = [];
  for (const r of rows) {
    const ref = (r.itemRef ?? "").trim();
    if (ref === "") continue;
    const quantity = Math.max(1, Math.trunc(r.quantity ?? 1));
    items.push({ ref, kind: r.itemKind ?? "unknown", quantity });
  }
  if (items.length === 0) return null;

  const issueRef = opts.issueRef?.trim() || null;

  return {
    eventType: SHIPMENT_SENT_EVENT_TYPE,
    channel: opts.channel,
    identifier,
    // 冪等キーの元は出所の参照 1 本（同じ注文は何度受けても 1 行）。
    dedupe: sourceRef,
    source: opts.source,
    // 届いた日を JST の 0 時に固定する。台帳が持つのは暦日だけ（受け取り時刻は
    // 分からないのが普通）なので、時刻を推測せず日の頭に寄せる。
    occurredAt: `${shippedOn}T00:00:00+09:00`,
    payload: {
      shipped_on: shippedOn,
      date_basis: first.dateBasis,
      ledger_source: first.source,
      item_count: items.length,
      items,
      ...(issueRef ? { issue_ref: issueRef } : {}),
    },
  };
}

/**
 * 台帳の行 → gateway に渡す鍵。
 *
 * EC の顧客番号が本命で、まだ無い間は LINE の ID で書く（038 と同じ順序）。
 * 生値はここから gateway に渡るだけで、L0 の行には残らない（E5）。
 */
export function identifierForDelivery(row: DeliveryRecord): ObservedIdentifier | null {
  const shopify = (row.shopifyCustomerId ?? "").trim();
  if (shopify !== "") return { kind: "shopify_customer_id", value: shopify };
  const line = (row.lineUserId ?? "").trim();
  if (line !== "") return { kind: "line_messaging_uid", value: line };
  return null;
}

// ---------------------------------------------------------------------------
// 読む側（L1 の読み口）— subject 別の月別送付履歴
// ---------------------------------------------------------------------------

/** L0 から読む 1 行（PostgREST の返り値の最小形）。 */
export interface ShipmentEventRow {
  occurred_at?: string | null;
  schema_ok?: boolean | null;
  payload?: Record<string, unknown> | null;
}

/** その月に何を送ったか。 */
export interface ShipmentHistoryMonth {
  /** YYYY-MM（JST）。033 の period と同じ形なので突き合わせられる。 */
  period: string;
  /** その月の送付回数（銘柄数ではない）。 */
  shipments: number;
  /** 銘柄ごとの合算（参照の昇順・決定的）。 */
  items: ShipmentPayloadItem[];
  /** その月に送った号（重複排除・昇順）。号が無い月は空配列。 */
  issueRefs: string[];
}

/**
 * L0 の行 → 月別の送付履歴（純粋・決定的）。**新しい月が先頭**。
 *
 * ─ 何を数え、何を数えないか ─
 *   schema_ok = false の行は畳まない（上の isWellFormedShipmentPayload の理由）。
 *   月は payload の `shipped_on` から採る。occurred_at は同じ日を JST の 0 時に
 *   固定した値なので同じ月になるが、**正本は shipped_on の側**（台帳の暦日）。
 *   shipped_on が読めない行は occurred_at の JST 暦日に落ちる（無言で捨てない）。
 */
export function foldShipmentHistory(rows: ShipmentEventRow[]): ShipmentHistoryMonth[] {
  const byPeriod = new Map<
    string,
    { shipments: number; items: Map<string, ShipmentPayloadItem>; issues: Set<string> }
  >();

  for (const row of rows ?? []) {
    if (row?.schema_ok === false) continue;
    const payload = (row?.payload ?? {}) as Record<string, unknown>;
    const period = periodOfRow(row, payload);
    if (!period) continue;

    const bucket = byPeriod.get(period) ?? {
      shipments: 0,
      items: new Map<string, ShipmentPayloadItem>(),
      issues: new Set<string>(),
    };
    bucket.shipments += 1;

    const items = Array.isArray(payload.items) ? payload.items : [];
    for (const raw of items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const ref = typeof item.ref === "string" ? item.ref.trim() : "";
      if (ref === "") continue;
      const quantity =
        typeof item.quantity === "number" && Number.isFinite(item.quantity)
          ? Math.max(1, Math.trunc(item.quantity))
          : 1;
      const kind = isDeliveryItemKind(item.kind) ? item.kind : "unknown";
      const existing = bucket.items.get(ref);
      if (existing) {
        existing.quantity += quantity;
        // 分類は「分かった方向」にだけ動かす（unknown で上書きして分類を消さない・038 と同じ）。
        if (existing.kind === "unknown" && kind !== "unknown") existing.kind = kind;
      } else {
        bucket.items.set(ref, { ref, kind, quantity });
      }
    }

    const issueRef = typeof payload.issue_ref === "string" ? payload.issue_ref.trim() : "";
    if (issueRef !== "") bucket.issues.add(issueRef);

    byPeriod.set(period, bucket);
  }

  return Array.from(byPeriod.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([period, b]) => ({
      period,
      shipments: b.shipments,
      items: Array.from(b.items.values()).sort((x, y) => (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0)),
      issueRefs: Array.from(b.issues).sort(),
    }));
}

/** 読み口の上限（1 主体あたり。無制限に引かない）。 */
export const SHIPMENT_HISTORY_MAX_ROWS = 500;

export interface ReadShipmentHistoryOptions {
  /** 引く行数の上限（既定 500）。 */
  limit?: number;
}

/**
 * subject 別の月別送付履歴を読む。**決して throw しない**（読めなければ空で戻る）。
 *
 * ─ 連携済みの人をどう読むか ─
 *   1 人が複数の主体を持ちうる段（Stage 2 の canonical 解決）では、
 *   **呼ぶ側が同じ人の主体をすべて渡す**。ここで canonical を引き直さないのは、
 *   引き方の正本を `cdp_canonical_subject` / `resolveCanonicalUserRefs` の側に
 *   1 本で置いておくため（ここに 2 本目の解決を作らない）。
 */
export async function readShipmentHistory(
  supabase: SupabaseClient,
  subject: string | string[],
  opts: ReadShipmentHistoryOptions = {},
): Promise<ShipmentHistoryMonth[]> {
  const subjectIds = (Array.isArray(subject) ? subject : [subject])
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s !== "");
  if (subjectIds.length === 0) return [];

  const limit = Math.max(1, Math.trunc(opts.limit ?? SHIPMENT_HISTORY_MAX_ROWS));

  try {
    const { data, error } = await supabase
      .from(CUSTOMER_EVENTS_TABLE)
      .select("occurred_at,schema_ok,payload")
      .in("subject_id", subjectIds)
      .eq("event_type", SHIPMENT_SENT_EVENT_TYPE)
      .eq("schema_ok", true)
      .order("occurred_at", { ascending: false })
      .limit(limit);
    if (error) {
      console.warn(
        "[cdp/shipment] 送付履歴を読めなかった (non-blocking):",
        JSON.stringify({ reason: error.message }),
      );
      return [];
    }
    return foldShipmentHistory((data ?? []) as ShipmentEventRow[]);
  } catch (err) {
    console.warn(
      "[cdp/shipment] 送付履歴で想定外の失敗 (non-blocking):",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

const ITEM_KINDS: ReadonlySet<string> = new Set(["tea", "goods", "other", "unknown"]);

function isDeliveryItemKind(value: unknown): value is DeliveryItemKind {
  return typeof value === "string" && ITEM_KINDS.has(value);
}

/** 行が属する月（YYYY-MM）。shipped_on が正本、無ければ occurred_at の JST 暦日。 */
function periodOfRow(
  row: ShipmentEventRow,
  payload: Record<string, unknown>,
): string | null {
  const shippedOn = typeof payload.shipped_on === "string" ? payload.shipped_on.trim() : "";
  if (SHIPPED_ON_RE.test(shippedOn)) return shippedOn.slice(0, 7);

  const occurredAt = typeof row?.occurred_at === "string" ? row.occurred_at : "";
  if (occurredAt === "") return null;
  try {
    return toJstDate(occurredAt).slice(0, 7);
  } catch {
    return null;
  }
}
