/**
 * Unit Tests -- broadcast-stats（配信計測 fetch ジョブ・P0-7b）
 *
 * 純粋関数（dueSnapshots / isInsightFetchable / unfollowWindowBounds / aggregateLedgerRows）と、
 * runBroadcastStatsFetch のオーケストレーション（fake Supabase + fake fetch + 固定 now を DI）を検証する。
 * 実 Supabase / 実 LINE API には一切触れない。
 *
 * 使用方法:
 *   npx tsx tests/unit/broadcast-stats.test.ts
 */

import {
  dueSnapshots,
  isInsightFetchable,
  unfollowWindowBounds,
  aggregateLedgerRows,
  runBroadcastStatsFetch,
  UNFOLLOW_WINDOW_MS,
  type SnapshotWindow,
} from "../../src/lib/broadcast-stats";
import type { UnitEventStats } from "../../src/lib/line-insight";
import type { Env } from "../../src/index";
import type { SupabaseClient } from "@supabase/supabase-js";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function it(name: string, fn: () => void | Promise<void>) {
  queue.push({ name, fn });
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assertTrue(v: boolean, label = "") {
  if (!v) throw new Error(`${label ? label + ": " : ""}expected true`);
}

const HOUR = 60 * 60 * 1000;

// ===================================================================
// 純粋関数
// ===================================================================

it("dueSnapshots: 経過に応じて到来済みの時点だけ返す", () => {
  const now = new Date("2026-08-10T00:00:00Z");
  const empty = new Set<SnapshotWindow>();
  // 25h 経過 → 24h のみ
  assertEqual(
    JSON.stringify(
      dueSnapshots(new Date(now.getTime() - 25 * HOUR), now, empty),
    ),
    JSON.stringify(["24h"]),
    "25h",
  );
  // 80h 経過 → 24h,72h
  assertEqual(
    JSON.stringify(
      dueSnapshots(new Date(now.getTime() - 80 * HOUR), now, empty),
    ),
    JSON.stringify(["24h", "72h"]),
    "80h",
  );
  // 8日経過 → 全部
  assertEqual(
    JSON.stringify(
      dueSnapshots(new Date(now.getTime() - 8 * 24 * HOUR), now, empty),
    ),
    JSON.stringify(["24h", "72h", "7d"]),
    "8d",
  );
  // 1h 経過 → なし
  assertEqual(
    JSON.stringify(dueSnapshots(new Date(now.getTime() - HOUR), now, empty)),
    JSON.stringify([]),
    "1h",
  );
});

it("dueSnapshots: done 済みは除外する（冪等）", () => {
  const now = new Date("2026-08-10T00:00:00Z");
  const done = new Set<SnapshotWindow>(["24h"]);
  assertEqual(
    JSON.stringify(
      dueSnapshots(new Date(now.getTime() - 8 * 24 * HOUR), now, done),
    ),
    JSON.stringify(["72h", "7d"]),
  );
});

it("isInsightFetchable: 当月=OK / 前月=OK / 2ヶ月前=NG", () => {
  const now = new Date("2026-08-10T00:00:00Z");
  assertEqual(isInsightFetchable(new Date("2026-08-01T00:00:00Z"), now), true, "当月");
  assertEqual(isInsightFetchable(new Date("2026-07-15T00:00:00Z"), now), true, "前月");
  assertEqual(isInsightFetchable(new Date("2026-06-30T00:00:00Z"), now), false, "2ヶ月前");
});

it("unfollowWindowBounds: to = from + 72h", () => {
  const d = new Date("2026-08-07T10:00:00Z");
  const { fromIso, toIso } = unfollowWindowBounds(d);
  assertEqual(fromIso, d.toISOString(), "from");
  assertEqual(
    toIso,
    new Date(d.getTime() + UNFOLLOW_WINDOW_MS).toISOString(),
    "to",
  );
});

it("aggregateLedgerRows: unit 単位に min(created_at)/sum(recipients) 集約", () => {
  const rows = [
    { aggregation_unit: "s20260807_ser", created_at: "2026-08-07T10:00:00Z", recipients: 20, notion_page_id: null },
    { aggregation_unit: "s20260807_ser", created_at: "2026-08-07T09:00:00Z", recipients: 10, notion_page_id: "pg1" },
    { aggregation_unit: null, created_at: "2026-08-07T09:00:00Z", recipients: 5, notion_page_id: null },
  ];
  const agg = aggregateLedgerRows(rows);
  assertEqual(agg.length, 1, "unit 数");
  assertEqual(agg[0].deliveredAt, "2026-08-07T09:00:00Z", "min created_at");
  assertEqual(agg[0].delivered, 30, "sum recipients");
  assertEqual(agg[0].notionPageId, "pg1", "notion page（最初の非 null）");
});

// ===================================================================
// fake Supabase（本ジョブが使うチェーンだけを忠実に再現）
// ===================================================================

interface FakeStore {
  tableMissing: boolean; // broadcast_stats preflight 失敗を模す
  doneWindowsError: boolean; // preflight は素通りだが後続 select が error（staging PGRST205 実挙動の再現）
  ledgerRows: Array<{
    aggregation_unit: string | null;
    created_at: string | null;
    recipients: number | null;
    notion_page_id: string | null;
  }>;
  doneRows: Array<{ aggregation_unit: string; snapshot_window: SnapshotWindow }>;
  unfollowTimes: string[]; // customer_linkages.unfollowed_at の ISO 群
  upserted: Array<Record<string, unknown>>;
}

class FakeQuery {
  op: "select" | "upsert" = "select";
  headCount = false;
  filters: Array<[string, string, unknown]> = [];
  upsertRow: Record<string, unknown> | null = null;
  constructor(
    private table: string,
    private store: FakeStore,
  ) {}
  select(_cols: string, opts?: { head?: boolean; count?: string }) {
    this.op = "select";
    this.headCount = !!opts?.head;
    return this;
  }
  upsert(row: Record<string, unknown>, _opts?: unknown) {
    this.op = "upsert";
    this.upsertRow = row;
    return this;
  }
  not(col: string, _op: string, val: unknown) {
    this.filters.push(["not", col, val]);
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push(["gte", col, val]);
    return this;
  }
  lte(col: string, val: unknown) {
    this.filters.push(["lte", col, val]);
    return this;
  }
  then(
    resolve: (v: { data?: unknown; error: unknown; count?: number }) => unknown,
    reject?: (e: unknown) => unknown,
  ) {
    return Promise.resolve(this.resolveResult()).then(resolve, reject);
  }
  private resolveResult(): { data?: unknown; error: unknown; count?: number } {
    if (this.table === "broadcast_stats") {
      if (this.op === "upsert") {
        this.store.upserted.push(this.upsertRow!);
        return { error: null };
      }
      if (this.headCount) {
        // preflight
        return this.store.tableMissing
          ? { error: { message: "relation does not exist", code: "42P01" }, count: 0 }
          : { error: null, count: this.store.upserted.length };
      }
      // loadDoneWindows
      if (this.store.doneWindowsError) {
        return {
          data: null,
          error: { message: "Could not find the table in the schema cache", code: "PGRST205" },
        };
      }
      return { data: this.store.doneRows, error: null };
    }
    if (this.table === "line_message_ledger") {
      return { data: this.store.ledgerRows, error: null };
    }
    if (this.table === "customer_linkages") {
      const gte = this.filters.find((f) => f[0] === "gte")?.[2] as string;
      const lte = this.filters.find((f) => f[0] === "lte")?.[2] as string;
      const count = this.store.unfollowTimes.filter(
        (t) => t >= gte && t <= lte,
      ).length;
      return { error: null, count };
    }
    return { data: [], error: null };
  }
}

function makeFakeSupabase(store: FakeStore): SupabaseClient {
  return {
    from(table: string) {
      return new FakeQuery(table, store) as unknown as ReturnType<
        SupabaseClient["from"]
      >;
    },
  } as unknown as SupabaseClient;
}

function baseStore(over: Partial<FakeStore> = {}): FakeStore {
  return {
    tableMissing: false,
    doneWindowsError: false,
    ledgerRows: [],
    doneRows: [],
    unfollowTimes: [],
    upserted: [],
    ...over,
  };
}

const FAKE_ENV = {} as Env;
function fakeFetch(stats: UnitEventStats) {
  let calls = 0;
  const fn = async () => {
    calls++;
    return stats;
  };
  return { fn, calls: () => calls };
}

// ===================================================================
// runBroadcastStatsFetch
// ===================================================================

it("preflight 失敗（テーブル不在）→ ok:false・書き込みゼロ", async () => {
  const store = baseStore({ tableMissing: true });
  const f = fakeFetch({ ok: true, uniqueImpression: 40, uniqueClick: 5 });
  const r = await runBroadcastStatsFetch(FAKE_ENV, {
    supabase: makeFakeSupabase(store),
    fetchUnitStats: f.fn,
    now: new Date("2026-08-20T00:00:00Z"),
  });
  assertEqual(r.ok, false, "ok false");
  assertTrue(!!r.reason && r.reason.includes("broadcast_stats"), "reason にテーブル名");
  assertEqual(store.upserted.length, 0, "書き込みゼロ");
  assertEqual(f.calls(), 0, "insight 呼び出しゼロ");
});

it("fail-soft: 後続 select が error でも throw せず ok:false（staging PGRST205 実挙動）", async () => {
  const store = baseStore({ doneWindowsError: true, ledgerRows: [] });
  const f = fakeFetch({ ok: true, uniqueImpression: 40, uniqueClick: 5 });
  let threw = false;
  let r;
  try {
    r = await runBroadcastStatsFetch(FAKE_ENV, {
      supabase: makeFakeSupabase(store),
      fetchUnitStats: f.fn,
      now: new Date("2026-08-20T00:00:00Z"),
    });
  } catch {
    threw = true;
  }
  assertEqual(threw, false, "throw しない");
  assertEqual(r!.ok, false, "ok false");
  assertTrue(!!r!.reason && r!.reason.includes("fail-soft"), "reason に fail-soft");
  assertEqual(store.upserted.length, 0, "書き込みゼロ");
});

it("対象0件（unit 付き配信なし）→ ok:true・0件正常終了", async () => {
  const store = baseStore({ ledgerRows: [] });
  const f = fakeFetch({ ok: true, uniqueImpression: null, uniqueClick: null });
  const r = await runBroadcastStatsFetch(FAKE_ENV, {
    supabase: makeFakeSupabase(store),
    fetchUnitStats: f.fn,
    now: new Date("2026-08-20T00:00:00Z"),
  });
  assertEqual(r.ok, true, "ok");
  assertEqual(r.unitsScanned, 0, "units 0");
  assertEqual(r.snapshotsWritten, 0, "snapshots 0");
});

it("happy: 8日前配信 → 24h/72h/7d の3スナップショットを upsert", async () => {
  const now = new Date("2026-08-20T00:00:00Z");
  const deliveredAt = new Date(now.getTime() - 8 * 24 * HOUR).toISOString();
  const store = baseStore({
    ledgerRows: [
      { aggregation_unit: "s20260812_ser", created_at: deliveredAt, recipients: 30, notion_page_id: "pg1" },
    ],
    unfollowTimes: [
      // 配信〜72h 内に2件、範囲外に1件
      new Date(new Date(deliveredAt).getTime() + 10 * HOUR).toISOString(),
      new Date(new Date(deliveredAt).getTime() + 40 * HOUR).toISOString(),
      new Date(new Date(deliveredAt).getTime() + 100 * HOUR).toISOString(),
    ],
  });
  const f = fakeFetch({ ok: true, uniqueImpression: 40, uniqueClick: 12 });
  const r = await runBroadcastStatsFetch(FAKE_ENV, {
    supabase: makeFakeSupabase(store),
    fetchUnitStats: f.fn,
    now,
  });
  assertEqual(r.ok, true, "ok");
  assertEqual(r.unitsScanned, 1, "units 1");
  assertEqual(r.snapshotsWritten, 3, "3 snapshots");
  assertEqual(store.upserted.length, 3, "upsert 3 行");
  const windows = store.upserted.map((u) => u.snapshot_window).sort();
  assertEqual(JSON.stringify(windows), JSON.stringify(["24h", "72h", "7d"].sort()), "3時点");
  const row0 = store.upserted[0];
  assertEqual(row0.delivered, 30, "delivered");
  assertEqual(row0.unique_impression, 40, "impression");
  assertEqual(row0.unique_click, 12, "click");
  assertEqual(row0.unfollow_within_72h, 2, "unfollow 72h 内 2件");
  assertEqual(row0.aggregation_unit, "s20260812_ser", "unit");
  assertEqual(row0.notion_page_id, "pg1", "notion page");
});

it("null 統計（20人未満）→ null のまま記録・delivered/unfollow は残る", async () => {
  const now = new Date("2026-08-20T00:00:00Z");
  const deliveredAt = new Date(now.getTime() - 8 * 24 * HOUR).toISOString();
  const store = baseStore({
    ledgerRows: [
      { aggregation_unit: "s20260812_all", created_at: deliveredAt, recipients: 12, notion_page_id: null },
    ],
  });
  const f = fakeFetch({ ok: true, uniqueImpression: null, uniqueClick: null });
  const r = await runBroadcastStatsFetch(FAKE_ENV, {
    supabase: makeFakeSupabase(store),
    fetchUnitStats: f.fn,
    now,
  });
  assertEqual(r.ok, true);
  assertEqual(store.upserted.length, 3, "3 行");
  assertEqual(store.upserted[0].unique_impression, null, "impression null");
  assertEqual(store.upserted[0].delivered, 12, "delivered は記録");
  assertEqual(store.upserted[0].unfollow_within_72h, 0, "unfollow 0");
});

it("冪等: 24h done 済み → 72h/7d のみ書く", async () => {
  const now = new Date("2026-08-20T00:00:00Z");
  const deliveredAt = new Date(now.getTime() - 8 * 24 * HOUR).toISOString();
  const store = baseStore({
    ledgerRows: [
      { aggregation_unit: "s20260812_exp", created_at: deliveredAt, recipients: 25, notion_page_id: null },
    ],
    doneRows: [{ aggregation_unit: "s20260812_exp", snapshot_window: "24h" }],
  });
  const f = fakeFetch({ ok: true, uniqueImpression: 40, uniqueClick: 5 });
  const r = await runBroadcastStatsFetch(FAKE_ENV, {
    supabase: makeFakeSupabase(store),
    fetchUnitStats: f.fn,
    now,
  });
  assertEqual(r.snapshotsWritten, 2, "2 snapshots");
  const windows = store.upserted.map((u) => u.snapshot_window).sort();
  assertEqual(JSON.stringify(windows), JSON.stringify(["72h", "7d"].sort()));
});

it("range 外（2ヶ月以上前）は insight を呼ばず null 記録（delivered は残す）", async () => {
  const now = new Date("2026-08-20T00:00:00Z");
  // 3ヶ月前の配信（当月＋前月の範囲外）
  const deliveredAt = new Date("2026-05-10T00:00:00Z").toISOString();
  const store = baseStore({
    ledgerRows: [
      { aggregation_unit: "s20260510_ser", created_at: deliveredAt, recipients: 30, notion_page_id: null },
    ],
  });
  const f = fakeFetch({ ok: true, uniqueImpression: 40, uniqueClick: 5 });
  const r = await runBroadcastStatsFetch(FAKE_ENV, {
    supabase: makeFakeSupabase(store),
    fetchUnitStats: f.fn,
    now,
  });
  assertEqual(r.ok, true);
  assertEqual(f.calls(), 0, "insight 呼び出しゼロ（range 外）");
  assertEqual(store.upserted[0].unique_impression, null, "impression null");
  assertEqual(store.upserted[0].delivered, 30, "delivered は記録");
  assertTrue(
    r.details.every((d) => d.insightFetched === false),
    "insightFetched=false",
  );
});

// ===================================================================
// runner
// ===================================================================
(async () => {
  console.log("\n--- broadcast-stats ---");
  for (const t of queue) {
    totalTests++;
    try {
      await t.fn();
      passedTests++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failedTests++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${t.name}: ${msg}`);
      failures.push({ name: t.name, error: msg });
    }
  }
  console.log("\n" + "=".repeat(60));
  console.log("broadcast-stats Unit Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failedTests > 0 ? 1 : 0);
})();
