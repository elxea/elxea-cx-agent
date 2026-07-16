/**
 * 配信計測 fetch ジョブ（P0-7b・後付け不可の計測基盤）。
 *
 * 設計: 統合設計書 §B-5c / §C-5 実装ノート I-3
 *   https://app.notion.com/p/39c70c9d064c8129b802e99161b628a0
 *
 * 役割:
 *   line_message_ledger.aggregation_unit（migration 023 で付与）を起点に、配信後
 *   24h / 72h / 7d のスナップショットを LINE Insight API から取得し broadcast_stats（migration 024）へ upsert する。
 *   出口は「エージェント参照用のデータ蓄積」のみ（決定5: 人間向け定期レポート・新規 Slack/Notion 出口は作らない）。
 *
 * 純度の分離（message-ledger.ts と同じ設計）:
 *   - 純粋関数（dueSnapshots / isInsightFetchable / unfollowWindowBounds）… I/O なし・完全にユニットテスト可能。
 *   - 実 I/O（runBroadcastStatsFetch）… Supabase / LINE Insight。テストは fake / DI で純粋に保つ。
 *
 * ⚠ LINE 仕様（後付け不可・null 挙動 = line-insight.ts と同一制約の再掲）:
 *   (1) 照会は「当月＋前月」のみ（isInsightFetchable で範囲外を弾く）。
 *   (2) ユニーク20人未満は uniqueImpression/uniqueClick が null（現状 友だち約48人のため当面 null が正常）。
 *
 * 安全境界: 本ジョブは GET（LINE Insight）と Supabase 読み書きのみ。LINE 送信系 API は一切呼ばない
 *   （実 LINE 配信を一切発生させない）。fail-soft（insight 取得不能でも delivered/unfollow は記録）。
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../index";
import { createSupabaseClient } from "./supabase";
import { resolveDeliveryChannel } from "./delivery-channel";
import {
  createLineUnitStatsFetcher,
  insightDateRange,
  type UnitStatsFetcher,
} from "./line-insight";

/** broadcast_stats テーブル名（migration 024）。 */
export const BROADCAST_STATS_TABLE = "broadcast_stats";
/** 台帳テーブル名（migration 019 / 023）。 */
export const LEDGER_TABLE = "line_message_ledger";
/** 紐付けテーブル名（migration 002 / 020: unfollowed_at）。 */
export const LINKAGES_TABLE = "customer_linkages";

/** スナップショットの計測時点。 */
export type SnapshotWindow = "24h" | "72h" | "7d";

/** 各時点の「配信からの経過（ms）」。この時間を過ぎたら当該時点のスナップショットが due。 */
export const SNAPSHOT_WINDOW_MS: Record<SnapshotWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "72h": 72 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

/** スナップショット時点の評価順（早い順）。 */
export const SNAPSHOT_WINDOWS: SnapshotWindow[] = ["24h", "72h", "7d"];

/** 72h unfollow 結合の窓（ms）— H7 検証データ（配信時刻〜72h の unfollow 件数）。 */
export const UNFOLLOW_WINDOW_MS = 72 * 60 * 60 * 1000;

/** 台帳から集約した unit 1 本の配信メタ。 */
export interface UnitDelivery {
  aggregationUnit: string;
  /** ISO。unit の最初の台帳行 created_at（= 配信時刻の近似）。 */
  deliveredAt: string;
  /** SUM(recipients)（自前の台帳が権威。LINE Insight は delivered を返さない）。 */
  delivered: number;
  /** 配信元 Notion ページ ID（任意）。 */
  notionPageId: string | null;
}

// -------------------------------------------------------------------
// 純粋関数（I/O なし・完全にユニットテスト可能）
// -------------------------------------------------------------------

/**
 * ある unit について「今 due なスナップショット時点」を返す（純粋）。
 * 条件: 配信からの経過が当該時点の閾値以上（到来済み）かつ done（既記録）に無い。
 */
export function dueSnapshots(
  deliveredAt: Date,
  now: Date,
  done: ReadonlySet<SnapshotWindow>,
): SnapshotWindow[] {
  const elapsed = now.getTime() - deliveredAt.getTime();
  return SNAPSHOT_WINDOWS.filter(
    (w) => elapsed >= SNAPSHOT_WINDOW_MS[w] && !done.has(w),
  );
}

/**
 * LINE Insight が照会可能か（当月＋前月のみ）を判定する（純粋）。
 * from（配信月）が now の前月より前なら取得不能 → insight はスキップ（値 null 記録）。
 * 通常運用では due 上限が 7d のため常に true。migration 直後に古い unit を拾う等の
 * 例外ケースで range 外の insight 400 を未然に避ける保険。
 * 月境界は暦月で判定（JST の日跨ぎ1日ズレは fail-soft に吸収されるため許容）。
 */
export function isInsightFetchable(deliveredAt: Date, now: Date): boolean {
  const monthsBack =
    (now.getUTCFullYear() - deliveredAt.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - deliveredAt.getUTCMonth());
  return monthsBack >= 0 && monthsBack <= 1;
}

/** 72h unfollow 結合の窓境界（ISO）を返す（純粋）。[配信時刻, 配信時刻+72h]。 */
export function unfollowWindowBounds(deliveredAt: Date): {
  fromIso: string;
  toIso: string;
} {
  return {
    fromIso: deliveredAt.toISOString(),
    toIso: new Date(deliveredAt.getTime() + UNFOLLOW_WINDOW_MS).toISOString(),
  };
}

/**
 * 台帳行（unit 付き）を unit 単位に集約する（純粋）。
 * deliveredAt = min(created_at)、delivered = sum(recipients)、notionPageId = 最初の非 null。
 */
export function aggregateLedgerRows(
  rows: ReadonlyArray<{
    aggregation_unit: string | null;
    created_at: string | null;
    recipients: number | null;
    notion_page_id: string | null;
  }>,
): UnitDelivery[] {
  const map = new Map<string, UnitDelivery>();
  for (const r of rows) {
    const unit = r.aggregation_unit;
    if (!unit) continue;
    const createdAt = r.created_at ?? new Date().toISOString();
    const recipients = typeof r.recipients === "number" ? r.recipients : 0;
    const existing = map.get(unit);
    if (!existing) {
      map.set(unit, {
        aggregationUnit: unit,
        deliveredAt: createdAt,
        delivered: recipients,
        notionPageId: r.notion_page_id ?? null,
      });
    } else {
      if (createdAt < existing.deliveredAt) existing.deliveredAt = createdAt;
      existing.delivered += recipients;
      if (!existing.notionPageId && r.notion_page_id) {
        existing.notionPageId = r.notion_page_id;
      }
    }
  }
  return [...map.values()];
}

// -------------------------------------------------------------------
// I/O 実装（実 Supabase / LINE Insight・runtime のみ）
// -------------------------------------------------------------------

/** ジョブの依存（テストは fake を注入）。 */
export interface BroadcastStatsDeps {
  supabase: SupabaseClient;
  fetchUnitStats: UnitStatsFetcher;
  now: Date;
}

/** ジョブ結果（証跡用の要約。PII・トークンは含めない）。 */
export interface BroadcastStatsResult {
  ok: boolean;
  /** preflight 失敗等の理由（ok:false のとき）。 */
  reason?: string;
  unitsScanned: number;
  snapshotsWritten: number;
  details: Array<{
    unit: string;
    window: SnapshotWindow;
    delivered: number;
    uniqueImpression: number | null;
    uniqueClick: number | null;
    unfollowWithin72h: number | null;
    insightFetched: boolean;
  }>;
}

/**
 * broadcast_stats テーブルの存在を確認する（preflight）。
 * 不在（migration 024 未適用）なら理由を返す。存在すれば null。
 * message-ledger.checkLedgerTables と同じく head select で軽量確認。
 */
export async function checkBroadcastStatsTable(
  supabase: SupabaseClient,
): Promise<string | null> {
  const { error } = await supabase
    .from(BROADCAST_STATS_TABLE)
    .select("*", { head: true, count: "exact" });
  if (error) {
    return `required table "${BROADCAST_STATS_TABLE}" is not accessible: ${error.message}${error.code ? ` (code: ${error.code})` : ""}`;
  }
  return null;
}

/** 台帳から unit 付き行を全取得して集約する。 */
async function loadUnitDeliveries(
  supabase: SupabaseClient,
): Promise<UnitDelivery[]> {
  const { data, error } = await supabase
    .from(LEDGER_TABLE)
    .select("aggregation_unit, created_at, recipients, notion_page_id")
    .not("aggregation_unit", "is", null);
  if (error) {
    throw new Error(`${LEDGER_TABLE} 取得失敗: ${error.message}`);
  }
  return aggregateLedgerRows(data ?? []);
}

/** 既に記録済みの (unit, window) を Map<unit, Set<window>> で返す。 */
async function loadDoneWindows(
  supabase: SupabaseClient,
): Promise<Map<string, Set<SnapshotWindow>>> {
  const { data, error } = await supabase
    .from(BROADCAST_STATS_TABLE)
    .select("aggregation_unit, snapshot_window");
  if (error) {
    throw new Error(`${BROADCAST_STATS_TABLE} 取得失敗: ${error.message}`);
  }
  const map = new Map<string, Set<SnapshotWindow>>();
  for (const row of (data ?? []) as Array<{
    aggregation_unit: string;
    snapshot_window: SnapshotWindow;
  }>) {
    const set = map.get(row.aggregation_unit) ?? new Set<SnapshotWindow>();
    set.add(row.snapshot_window);
    map.set(row.aggregation_unit, set);
  }
  return map;
}

/**
 * 配信時刻〜72h の unfollow 件数を customer_linkages.unfollowed_at から算出する（H7）。
 * 取得失敗は null（fail-soft・ジョブは止めない）。
 */
async function countUnfollowWithin72h(
  supabase: SupabaseClient,
  deliveredAt: Date,
): Promise<number | null> {
  const { fromIso, toIso } = unfollowWindowBounds(deliveredAt);
  const { count, error } = await supabase
    .from(LINKAGES_TABLE)
    .select("*", { head: true, count: "exact" })
    .gte("unfollowed_at", fromIso)
    .lte("unfollowed_at", toIso);
  if (error) {
    console.warn(
      `[broadcast-stats] unfollow 件数取得失敗（fail-soft・null 記録）: ${error.message}`,
    );
    return null;
  }
  return count ?? 0;
}

/** broadcast_stats へ 1 スナップショットを upsert（onConflict: aggregation_unit,snapshot_window）。 */
async function upsertSnapshot(
  supabase: SupabaseClient,
  row: {
    aggregation_unit: string;
    notion_page_id: string | null;
    snapshot_window: SnapshotWindow;
    fetched_at: string;
    delivered: number;
    unique_impression: number | null;
    unique_click: number | null;
    unfollow_within_72h: number | null;
  },
): Promise<void> {
  const { error } = await supabase
    .from(BROADCAST_STATS_TABLE)
    .upsert(row, { onConflict: "aggregation_unit,snapshot_window" });
  if (error) {
    throw new Error(`broadcast_stats upsert 失敗（unit=${row.aggregation_unit} window=${row.snapshot_window}）: ${error.message}`);
  }
}

/**
 * 配信計測 fetch ジョブ本体。
 *
 * 手順:
 *   0. preflight（broadcast_stats 不在ならスキップ・fail-soft で理由を返す）。
 *   1. 台帳から unit 付き配信を集約 + 既記録スナップショットを取得。
 *   2. unit ごとに due なスナップショット時点を算出。
 *   3. 各 due 時点で insight（照会可能な範囲のみ）+ unfollow を取得し upsert。
 *
 * deps 省略時は env から実 Supabase / 実 LINE Insight（配信 OA のトークン）を組み立てる。
 * 配信 OA のトークンは resolveDeliveryChannel（DELIVERY_TARGET_ENV）で解決する
 * （staging は test OA @426vlcyb。unit は OA 単位で紐づくため送信 OA と一致させる）。
 */
export async function runBroadcastStatsFetch(
  env: Env,
  overrides?: Partial<BroadcastStatsDeps>,
): Promise<BroadcastStatsResult> {
  const supabase = overrides?.supabase ?? createSupabaseClient(env);
  const now = overrides?.now ?? new Date();

  // 配信 OA のトークンで insight を引く（未指定時のみ・fail-closed の resolve を fail-soft で包む）。
  let fetchUnitStats = overrides?.fetchUnitStats;
  if (!fetchUnitStats) {
    try {
      const channel = resolveDeliveryChannel(env);
      fetchUnitStats = createLineUnitStatsFetcher(channel.accessToken);
    } catch (err) {
      return {
        ok: false,
        reason: `配信チャネル解決失敗（insight トークン未設定）: ${err instanceof Error ? err.message : String(err)}`,
        unitsScanned: 0,
        snapshotsWritten: 0,
        details: [],
      };
    }
  }

  // 以降の DB/insight I/O は全体を try/catch で fail-soft に包む。
  //   理由: preflight（head select）は PostgREST 実挙動ではテーブル不在を error 化しないことがあり
  //   （staging 実測 2026-07-16: head select は素通り→後続 select が PGRST205 で throw）、
  //   cron 経路（index.ts は .catch を持たない）で未処理 reject になる。ここで一括して
  //   「例外 → ok:false（理由付き・書き込みは進んだ分だけ報告）」に倒し、ジョブは決して throw しない。
  const details: BroadcastStatsResult["details"] = [];
  let snapshotsWritten = 0;
  let unitsScanned = 0;

  try {
    // 0. preflight（不在を早期に検知できたときだけ即返す・fast-path）。
    const preflight = await checkBroadcastStatsTable(supabase);
    if (preflight) {
      return {
        ok: false,
        reason: `preflight 失敗（migration 024 未適用の可能性）: ${preflight}`,
        unitsScanned: 0,
        snapshotsWritten: 0,
        details: [],
      };
    }

    // 1. 集約 + 既記録
    const [deliveries, done] = await Promise.all([
      loadUnitDeliveries(supabase),
      loadDoneWindows(supabase),
    ]);
    unitsScanned = deliveries.length;

    // 2-3. unit ごとに due スナップショットを埋める
    for (const d of deliveries) {
      const deliveredAt = new Date(d.deliveredAt);
      const doneSet = done.get(d.aggregationUnit) ?? new Set<SnapshotWindow>();
      const due = dueSnapshots(deliveredAt, now, doneSet);
      if (due.length === 0) continue;

      const unfollow = await countUnfollowWithin72h(supabase, deliveredAt);

      for (const window of due) {
        let uniqueImpression: number | null = null;
        let uniqueClick: number | null = null;
        let insightFetched = false;

        if (isInsightFetchable(deliveredAt, now)) {
          const { from, to } = insightDateRange(deliveredAt, now);
          const stats = await fetchUnitStats(d.aggregationUnit, from, to);
          insightFetched = stats.ok;
          uniqueImpression = stats.uniqueImpression;
          uniqueClick = stats.uniqueClick;
        }

        await upsertSnapshot(supabase, {
          aggregation_unit: d.aggregationUnit,
          notion_page_id: d.notionPageId,
          snapshot_window: window,
          fetched_at: now.toISOString(),
          delivered: d.delivered,
          unique_impression: uniqueImpression,
          unique_click: uniqueClick,
          unfollow_within_72h: unfollow,
        });
        snapshotsWritten++;
        details.push({
          unit: d.aggregationUnit,
          window,
          delivered: d.delivered,
          uniqueImpression,
          uniqueClick,
          unfollowWithin72h: unfollow,
          insightFetched,
        });
      }
    }

    return { ok: true, unitsScanned, snapshotsWritten, details };
  } catch (err) {
    // fail-soft: テーブル不在（migration 未適用）・一時的な DB エラー等は throw せず ok:false に倒す。
    return {
      ok: false,
      reason: `fetch ジョブ実行時エラー（fail-soft・書き込みは進んだ分のみ）: ${err instanceof Error ? err.message : String(err)}`,
      unitsScanned,
      snapshotsWritten,
      details,
    };
  }
}
