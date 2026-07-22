/**
 * flow_events — タップ/フローイベント記録（P0-1 / P0-2）。
 *
 * 設計: 統合設計書 §B-5a / §C-5 実装ノート I-4
 *   https://app.notion.com/p/39c70c9d064c8129b802e99161b628a0
 *
 * 役割: 選択式フロー（リッチメニュー・tea-menu・診断）のタップを Supabase flow_events に記録する。
 *   これらのインターセプタは会話保存より前に return するため、記録しないと棚卸しの H1〜H5・H8・H9 が
 *   永久に検証できない（棚卸し表B）。
 *
 * 3 原則（設計 §B-5 判断）:
 *   (1) 本文なし — user_ref と選択値 slug・番号のみ。PII を構造的に入れない。
 *   (2) fire-and-forget — 書き込みは waitUntil / void で投げっぱなし。ユーザー応答を一切ブロックしない。
 *   (3) 失敗は握りつぶす — logFlowEvent は決して throw しない（応答優先）。
 *
 * PII 二重ガード: value/step は slug 形式（英数字・_・- のみ・短い）でなければ **記録時に落とす**
 *   （自由文が誤って渡っても構造的に入らない）。product_no は数字のみ。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** flow_events テーブル名（migration 021）。 */
export const FLOW_EVENTS_TABLE = "flow_events";

/**
 * 実装対象のイベント名（設計 §B-5a の全12種）。
 * 型で縛ることで綴り違い・未定義イベントの混入を防ぐ。
 */
export type FlowEventName =
  | "menu.tap"
  | "welcome.tap"
  | "welcome.source"
  | "tea.list_view"
  | "tea.card_view"
  | "tea.item_view"
  | "tea.number_miss"
  | "diag.start"
  | "diag.answer"
  | "diag.invalid"
  | "diag.result"
  | "consult.entry"
  | "optout.request"
  | "optout.confirm"
  // 連携ファネル（ブロック4・売上重大1対応）: 招待ボタン提示 → 連携完了。
  //   link.invite_shown: 未連携ユーザーの連携文脈で便益+ボタンを出したとき（metadata.surface = trigger|menu4）。
  //   link.completed:    連携成功時（metadata.source = liff | account_link）。
  //   link.unlinked:     お客さま自身が連携を解除したとき（LINE 必須義務の解除導線・ファネルの対）。
  | "link.invite_shown"
  | "link.completed"
  | "link.unlinked"
  // 計測（treatment 記録・設計 v2.1 #1 最優先・spec §6-3「どの版を見せたか」）:
  //   next_cup_shown: rate-good 後に「次の一杯」を実際に見せたとき。
  //     product_no = 見せた銘柄（5桁）／ value = 版（"karte" = 個別化が baseline と別の銘柄を選んだ /
  //     "baseline" = カルテが結果を変えなかった or 空カルテ）。metadata に ratedNo / baselineNo / affinity。
  //   これを残さないと「どの版を見せたか」が後から遡れない消えるデータになり効果測定できない。
  | "next_cup_shown";

/** 記録する 1 イベントの入力。 */
export interface FlowEventInput {
  eventName: FlowEventName;
  /** conversations.user_id と同一規約（LINE userId / web session）。 */
  userRef: string;
  /** I-4: 現状 'line' のみ。省略時 'line'。 */
  channel?: "line";
  /** q1/q2/q3・page1〜3 等の段（slug）。 */
  step?: string;
  /** 選択値 slug（自由文禁止）。 */
  value?: string;
  /** 5桁番号（tea.* / rating.* のみ）。 */
  productNo?: string;
  /** 追加属性（自由文キー禁止）。 */
  metadata?: Record<string, unknown>;
}

/** flow_events の 1 行（DB カラム名）。 */
export interface FlowEventRow {
  event_name: string;
  user_ref: string;
  channel: string;
  step: string | null;
  value: string | null;
  product_no: string | null;
  metadata: Record<string, unknown> | null;
}

/** slug 許容パターン: 英数字・_・- のみ・1〜40 文字（自由文/氏名/メールを構造的に排除）。 */
const SLUG_RE = /^[A-Za-z0-9_.\-]{1,40}$/;
/** 5桁の商品番号。 */
const PRODUCT_NO_RE = /^\d{5}$/;

/**
 * slug 以外（自由文等）は null に落とす（純粋・PII ガード）。
 * value/step は列挙 slug のみを許可し、想定外の文字列は記録しない。
 */
export function sanitizeSlug(v: string | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return SLUG_RE.test(t) ? t : null;
}

/** 5桁番号以外は null に落とす（純粋）。 */
export function sanitizeProductNo(v: string | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return PRODUCT_NO_RE.test(t) ? t : null;
}

/**
 * 入力を DB 行へ正規化する（純粋・完全にテスト可能）。
 * PII ガード（slug/番号の検証）をここで一括適用する。
 */
export function buildFlowEventRow(input: FlowEventInput): FlowEventRow {
  return {
    event_name: input.eventName,
    user_ref: input.userRef,
    channel: input.channel ?? "line",
    step: sanitizeSlug(input.step),
    value: sanitizeSlug(input.value),
    product_no: sanitizeProductNo(input.productNo),
    metadata: input.metadata ?? null,
  };
}

/**
 * flow_events に 1 件記録する（fire-and-forget・決して throw しない）。
 *
 * 呼び出し側は `void logFlowEvent(...)` または `ctx.waitUntil(logFlowEvent(...))` で投げっぱなしにする。
 * user_ref が空・不正なイベント名等は記録せず静かに戻る（応答を止めない）。
 */
export async function logFlowEvent(
  supabase: SupabaseClient,
  input: FlowEventInput,
): Promise<void> {
  try {
    if (!input.userRef || typeof input.userRef !== "string") return;
    const row = buildFlowEventRow(input);
    const { error } = await supabase.from(FLOW_EVENTS_TABLE).insert(row);
    if (error) {
      // 握りつぶす（応答優先）。テーブル未適用・RLS 等でも会話を止めない。
      console.warn("[flow-events] insert failed (non-blocking):", error.message);
    }
  } catch (err) {
    console.warn(
      "[flow-events] unexpected error (non-blocking):",
      err instanceof Error ? err.message : err,
    );
  }
}

/** 直近の next_cup_shown（見せた「次の一杯」）。UX② マイカルテ「だから」カードの根拠に使う。 */
export interface LatestNextCupShown {
  /** 見せた銘柄の 5 桁番号（product_no）。 */
  productNo: string | null;
  /** 版（"karte" = 個別化で別銘柄 / "baseline"）。生の affinity 数値は含めない（人間語に留める）。 */
  value: string | null;
}

/**
 * 直近の next_cup_shown イベントを 1 件だけ読む（read-only・fail-safe）。
 *
 * UX② マイカルテの「だから（なぜこの一杯か）」カードで、実際に最後に見せた「次の一杯」を
 * 根拠として引くために使う。**書き込みは一切しない**。metadata の affinity 等の生スコアは
 * 返さない（productNo と版だけを返し、表示側は人間語のみで語る）。
 *
 * 失敗・0 件・テーブル未適用はいずれも null（呼び出し側は根拠なしで graceful に組む）。
 */
export async function getLatestNextCupShown(
  supabase: SupabaseClient,
  userRef: string,
): Promise<LatestNextCupShown | null> {
  try {
    if (!userRef) return null;
    const { data, error } = await supabase
      .from(FLOW_EVENTS_TABLE)
      .select("product_no, value")
      .eq("user_ref", userRef)
      .eq("event_name", "next_cup_shown")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      console.warn("[flow-events] latest next_cup_shown read failed (non-blocking):", error.message);
      return null;
    }
    const row = (data ?? [])[0] as { product_no?: unknown; value?: unknown } | undefined;
    if (!row) return null;
    const productNo = sanitizeProductNo(
      typeof row.product_no === "string" ? row.product_no : undefined,
    );
    const value = sanitizeSlug(typeof row.value === "string" ? row.value : undefined);
    return { productNo, value };
  } catch (err) {
    console.warn(
      "[flow-events] latest next_cup_shown unexpected error (non-blocking):",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
