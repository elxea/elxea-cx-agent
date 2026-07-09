/**
 * LINE 通数会計 / 送信ガード module（判定ロジック専用・実送信はしない）。
 *
 * 設計: 「Notion駆動 LINE配信 設計確定版 v1.0」§6/§8/§10
 *   https://app.notion.com/p/39870c9d064c81f7a593f2cb248ef076
 *
 * このモジュールの責務は「送ってよいか」を判定し、送信前予約（claim）を行うことだけ。
 * LINE の送信系 API（push/multicast/narrowcast/broadcast）は一切呼ばない。
 * 唯一の外部 I/O は consumption API の GET（読み取り専用・照合専用）と Supabase 台帳。
 *
 * 安全設計（Must-fix 反映）:
 *   1. 上限判定の権威 = Supabase 台帳のアトミックな claim（INSERT ... ON CONFLICT DO NOTHING）。
 *      claim 成功者のみ送信可。Notion ステータスは表示用に降格（排他制御にしない）。
 *   2. 行ループは直列 + 走行合計で残枠を都度減算（呼び出し側が 1 件ずつ直列で回す前提）。
 *   3. consumption API は fail-closed の照合専用。取得不能 = 送信不可（fail-open にしない）。
 *   4. push を含むチャネル全消費を同一台帳で会計（reply は無料なので記録しない）。
 *
 * fail-open アンチパターン（`segment-broadcast.ts:300` の `if (!res.ok) return 0;`）は踏襲しない。
 * 取得不能・エラーは常に「送信不可」に倒す。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../index";

// -------------------------------------------------------------------
// 定数
// -------------------------------------------------------------------

/** LINE 無料プラン（コミュニケーション）の月間上限（通）。設計 §2 で確定。 */
export const FREE_TIER_CAP = 200;

/**
 * 安全マージン（通）。残枠 = CAP − SAFETY_HEADROOM − 確定消費 で常に上限手前で止める。
 * 運用値は未確定（設計 §11）。ここでは保守的な既定値のみ置き、値は呼び出し側で上書き可能。
 * 大きくするほど安全側（送信を絞る）。Setaka の運用判断が入るまでの暫定既定。
 */
export const DEFAULT_SAFETY_HEADROOM = 10;

/** 台帳テーブル名（migration 019）。 */
export const LEDGER_TABLE = "line_message_ledger";

/**
 * LINE 当月消費の取得エンドポイント（GET のみ・読み取り専用・送信ではない）。
 * https://developers.line.biz/en/reference/messaging-api/#get-consumption
 */
export const LINE_CONSUMPTION_URL =
  "https://api.line.me/v2/bot/message/quota/consumption";

/** 会計対象月フォーマット（LINE 基準 JST の "YYYY-MM"）。 */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// -------------------------------------------------------------------
// 型
// -------------------------------------------------------------------

/** 消費の出所。台帳 CHECK 制約と一致させる。 */
export type LedgerSource = "broadcast" | "interactive" | "other";

/** 台帳への 1 行（= 1 claim）。 */
export interface LedgerEntry {
  /** 冪等キー。broadcast は Notion 配信ページ ID。interactive/other は衝突しない安定キー。 */
  notionPageId: string;
  /** 会計対象月（LINE 基準 JST "YYYY-MM"）。 */
  month: string;
  /** この行で消費する受信者数（1 受信者 = 1 通）。 */
  recipients: number;
  /** 消費の出所。 */
  source: LedgerSource;
}

/**
 * 台帳ストアのポート（DB 実装を差し替え可能にしてユニットテストを純粋に保つ）。
 * 実装は `createSupabaseLedgerStore`。テストはインメモリ fake を注入する。
 */
export interface LedgerStore {
  /**
   * (notion_page_id, month) をアトミックに予約する。
   * INSERT ... ON CONFLICT(notion_page_id, month) DO NOTHING 相当。
   * この呼び出しが実際に行を挿入したら `claimed: true`、
   * 既存で無挿入（＝二重 claim）なら `claimed: false`。
   */
  claim(entry: LedgerEntry): Promise<{ claimed: boolean }>;
  /** 指定月の確定消費（SUM(recipients)）。行が無ければ 0。 */
  confirmedConsumption(month: string): Promise<number>;
}

/** consumption API のスナップショット（照合専用）。 */
export interface ConsumptionSnapshot {
  /** 取得成功なら true。false のときは fail-closed で送信中止。 */
  ok: boolean;
  /** ok:true のときの当月消費（通）。 */
  totalUsage?: number;
}

/** consumption 取得関数（GET のみ・読み取り専用）。 */
export type ConsumptionFetcher = () => Promise<ConsumptionSnapshot>;

/** ガードのオプション。 */
export interface GuardOptions {
  /** 安全マージン（既定 DEFAULT_SAFETY_HEADROOM）。 */
  safetyHeadroom?: number;
  /** 上限（既定 FREE_TIER_CAP）。テスト用に上書き可能。 */
  cap?: number;
}

/** ガード判定結果。 */
export type GuardDecision =
  | { ok: true; remainingBefore: number; remainingAfter: number }
  | {
      ok: false;
      reason:
        | "invalid_request"
        | "consumption_unavailable"
        | "cap_exceeded"
        | "already_claimed";
      remaining?: number;
      detail?: string;
    };

/** claim（書き込み）失敗を表す明示エラー。呼び出し側で送信不可に倒すため throw する。 */
export class LedgerClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerClaimError";
  }
}

/** 台帳読み取り失敗を表す明示エラー。 */
export class LedgerReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerReadError";
  }
}

// -------------------------------------------------------------------
// 純粋関数（I/O なし・完全にユニットテスト可能）
// -------------------------------------------------------------------

/**
 * 会計対象月を LINE 基準（JST）の "YYYY-MM" で返す。
 * 月次リセットは JST 境界に統一する（設計 §6）。
 */
export function currentLineMonth(date: Date = new Date()): string {
  // JST = UTC+9。UTC ミリ秒に 9h 足してから UTC 部品を読むと JST の壁時計になる。
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * 残枠を計算する（純粋）。
 * 主判定は台帳の確定消費。consumption API は「照合専用」で、
 * より厳しい方向（残枠を減らす方向）にのみ効かせる（緩める方向には使わない）。
 */
export function computeRemaining(
  cap: number,
  safetyHeadroom: number,
  ledgerConfirmed: number,
  apiUsage: number,
): number {
  const ledgerRemaining = cap - safetyHeadroom - ledgerConfirmed;
  const apiRemaining = cap - safetyHeadroom - apiUsage;
  return Math.min(ledgerRemaining, apiRemaining);
}

// -------------------------------------------------------------------
// ガード + claim（送信可否の唯一の判定点）
// -------------------------------------------------------------------

/**
 * 送信前ガード + claim。順序が安全性の要（すべて fail-closed）:
 *   1. 入力検証（不正は送信不可）
 *   2. consumption API 照合（取得不能は送信不可）
 *   3. 走行合計で残枠判定（台帳確定消費が主・API は厳しい方向のみ）
 *   4. アトミック claim（真の排他 / 二重 claim 拒否）
 *
 * cap 判定を claim より前に置くことで、使えない枠を予約しない。
 * 呼び出し側は 1 件ずつ直列で回すこと（走行合計が成立する前提）。月境界の停止（±数分）は
 * オーケストレータ側の責務（本モジュールは判定のみ）。
 *
 * このモジュールは実送信を一切行わない。ok:true は「claim 済み＝送ってよい」を意味するのみ。
 */
export async function guardAndClaim(
  store: LedgerStore,
  consumptionFetcher: ConsumptionFetcher,
  entry: LedgerEntry,
  options: GuardOptions = {},
): Promise<GuardDecision> {
  const cap = options.cap ?? FREE_TIER_CAP;
  const headroom = options.safetyHeadroom ?? DEFAULT_SAFETY_HEADROOM;

  // 1. 入力検証（fail-closed）。recipients は 1 以上（0 通の送信は無意味なので呼び出し側で弾く）。
  if (
    typeof entry.notionPageId !== "string" ||
    entry.notionPageId.length === 0 ||
    !MONTH_RE.test(entry.month) ||
    !Number.isInteger(entry.recipients) ||
    entry.recipients < 1
  ) {
    return {
      ok: false,
      reason: "invalid_request",
      detail:
        "notionPageId 非空 / month=YYYY-MM(JST) / recipients は 1 以上の整数が必須",
    };
  }

  // 2. consumption API 照合（GET のみ・照合専用・fail-closed）。
  const snapshot = await consumptionFetcher();
  if (!snapshot.ok || typeof snapshot.totalUsage !== "number") {
    return {
      ok: false,
      reason: "consumption_unavailable",
      detail: "consumption API 取得不能のため送信中止（fail-closed）",
    };
  }

  // 3. 走行合計（主判定 = 台帳確定消費、API は厳しい方向のみ効く）。
  const confirmed = await store.confirmedConsumption(entry.month);
  const remainingBefore = computeRemaining(
    cap,
    headroom,
    confirmed,
    snapshot.totalUsage,
  );
  if (entry.recipients > remainingBefore) {
    return { ok: false, reason: "cap_exceeded", remaining: remainingBefore };
  }

  // 4. アトミック claim（真の排他 / 冪等）。挿入できた者だけが送信可。
  const { claimed } = await store.claim(entry);
  if (!claimed) {
    return { ok: false, reason: "already_claimed" };
  }

  return {
    ok: true,
    remainingBefore,
    remainingAfter: remainingBefore - entry.recipients,
  };
}

// -------------------------------------------------------------------
// アダプタ（実 I/O・runtime のみ・ユニットテストは fake を注入）
// -------------------------------------------------------------------

/**
 * Supabase 実装の LedgerStore。
 * claim は upsert + ignoreDuplicates で `INSERT ... ON CONFLICT DO NOTHING` を生成し、
 * `.select()` の返却行数で「今回挿入したか（claim 勝者か）」を判定する。
 * DB エラーは握りつぶさず throw（呼び出し側が送信不可に倒すため）。
 *
 * 注: claim の返却行数セマンティクス（conflict 時に空配列が返る）は PostgREST の挙動に依存する。
 *     ユニットテストは fake で純粋ロジックを検証し、この実挙動は staging 統合テスト（elxea-qa）で確認する。
 */
export function createSupabaseLedgerStore(supabase: SupabaseClient): LedgerStore {
  return {
    async claim(entry: LedgerEntry): Promise<{ claimed: boolean }> {
      const { data, error } = await supabase
        .from(LEDGER_TABLE)
        .upsert(
          {
            month: entry.month,
            source: entry.source,
            recipients: entry.recipients,
            notion_page_id: entry.notionPageId,
          },
          { onConflict: "notion_page_id,month", ignoreDuplicates: true },
        )
        .select("id");
      if (error) {
        throw new LedgerClaimError(`ledger claim failed: ${error.message}`);
      }
      return { claimed: (data?.length ?? 0) > 0 };
    },

    async confirmedConsumption(month: string): Promise<number> {
      const { data, error } = await supabase
        .from(LEDGER_TABLE)
        .select("recipients")
        .eq("month", month);
      if (error) {
        throw new LedgerReadError(`ledger read failed: ${error.message}`);
      }
      return (data ?? []).reduce(
        (sum: number, row: { recipients: number | null }) =>
          sum + (row.recipients ?? 0),
        0,
      );
    },
  };
}

/**
 * LINE consumption API の ConsumptionFetcher（GET のみ・読み取り専用・fail-closed）。
 * 非 2xx・不正 body・ネットワーク例外はすべて `{ ok: false }` に倒す。
 * `segment-broadcast.ts:300` の `if (!res.ok) return 0;`（fail-open）は踏襲しない。
 */
export function createLineConsumptionFetcher(env: Env): ConsumptionFetcher {
  return async (): Promise<ConsumptionSnapshot> => {
    try {
      const res = await fetch(LINE_CONSUMPTION_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
        },
      });
      if (!res.ok) return { ok: false };
      const data = (await res.json()) as { totalUsage?: unknown };
      if (typeof data.totalUsage !== "number") return { ok: false };
      return { ok: true, totalUsage: data.totalUsage };
    } catch {
      return { ok: false };
    }
  };
}

// -------------------------------------------------------------------
// preflight（distribution 機能専用・fail-closed）
// -------------------------------------------------------------------

/**
 * distribution（LINE 配信）機能に必須のテーブル。
 * knowledge.ts:82 の `checkRequiredTables` と同じパターン。ただし knowledge-sync の
 * REQUIRED_SYNC_TABLES には追加しない（別機能の cron を巻き込み、台帳未適用で
 * 既存 sync を壊すため。配信機能のオーケストレータ〔後続 T8/T9〕がこれを呼ぶ）。
 */
export const REQUIRED_LEDGER_TABLES = [LEDGER_TABLE] as const;

/**
 * 起動時 preflight: 台帳テーブルの存在を確認する。
 * 不在なら理由（テーブル名・エラー）を返す。存在すれば null。
 * Supabase JS は不在テーブルへの select を throw せず error で返すため、head select で軽量確認する。
 */
export async function checkLedgerTables(
  supabase: SupabaseClient,
): Promise<string | null> {
  for (const table of REQUIRED_LEDGER_TABLES) {
    const { error } = await supabase
      .from(table)
      .select("*", { head: true, count: "exact" });
    if (error) {
      return `required table "${table}" is not accessible: ${error.message}${error.code ? ` (code: ${error.code})` : ""}`;
    }
  }
  return null;
}
