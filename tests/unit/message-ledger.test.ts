/**
 * Unit Tests -- message-ledger（通数会計 / 送信ガード）
 *
 * 判定ロジック（純粋 + fake 注入）のみを検証する。実 Supabase / 実 LINE API には触れない。
 * consumption API・台帳 DB は fake を注入するため、このテストはネットワーク I/O を一切行わない。
 *
 * 使用方法:
 *   npx tsx tests/unit/message-ledger.test.ts
 */

// ---------------------------------------------------------------------------
// async 対応テストハーネス（外部依存なし）
// ---------------------------------------------------------------------------

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function describe(suiteName: string, fn: () => void) {
  queue.push({ name: `--- ${suiteName} ---`, fn: () => {} });
  fn();
}

function it(testName: string, fn: () => void | Promise<void>) {
  queue.push({ name: testName, fn });
}

function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertTrue(value: boolean, label = "") {
  if (!value) throw new Error(`${label ? label + ": " : ""}expected true`);
}

// ---------------------------------------------------------------------------
// テスト対象
// ---------------------------------------------------------------------------

import {
  guardAndClaim,
  computeRemaining,
  currentLineMonth,
  FREE_TIER_CAP,
  DEFAULT_SAFETY_HEADROOM,
  type LedgerStore,
  type LedgerEntry,
  type ConsumptionFetcher,
  type GuardDecision,
} from "../../src/lib/message-ledger";

// ---------------------------------------------------------------------------
// fake 実装（UNIQUE(notion_page_id, month) + SUM(recipients WHERE month) を忠実に再現）
// ---------------------------------------------------------------------------

function makeFakeStore(seed: LedgerEntry[] = []): LedgerStore & {
  rows: LedgerEntry[];
} {
  const rows: LedgerEntry[] = seed.map((r) => ({ ...r }));
  return {
    rows,
    async claim(entry) {
      const exists = rows.some(
        (r) => r.notionPageId === entry.notionPageId && r.month === entry.month,
      );
      if (exists) return { claimed: false };
      rows.push({ ...entry });
      return { claimed: true };
    },
    async confirmedConsumption(month) {
      return rows
        .filter((r) => r.month === month)
        .reduce((s, r) => s + r.recipients, 0);
    },
  };
}

const consumptionOk = (totalUsage: number): ConsumptionFetcher => async () => ({
  ok: true,
  totalUsage,
});
const consumptionFail: ConsumptionFetcher = async () => ({ ok: false });

const MONTH = "2026-07";
function entry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    notionPageId: "page-A",
    month: MONTH,
    recipients: 10,
    source: "broadcast",
    ...over,
  };
}

function assertReject(d: GuardDecision, reason: string, label = "") {
  assertTrue(!d.ok, `${label}: expected reject, got ok`);
  if (!d.ok) assertEqual(d.reason, reason as typeof d.reason, `${label} reason`);
}

// ---------------------------------------------------------------------------
// computeRemaining（純粋）
// ---------------------------------------------------------------------------

describe("computeRemaining", () => {
  it("残枠 = CAP − headroom − 確定消費（台帳が主）", () => {
    assertEqual(computeRemaining(200, 10, 50, 0), 140);
  });

  it("consumption API がより厳しければ API 側を採用（照合で絞る方向のみ）", () => {
    // 台帳=140 だが API 消費 100 → API 残枠 90 が採用される
    assertEqual(computeRemaining(200, 10, 50, 100), 90);
  });

  it("consumption API が緩くても台帳の厳しさは維持（緩める方向には使わない）", () => {
    // 台帳消費 180 → 台帳残枠 10、API 消費 0 → API 残枠 190 でも min=10
    assertEqual(computeRemaining(200, 10, 180, 0), 10);
  });

  it("超過時は負値になり得る（呼び出し側で recipients>remaining を弾く）", () => {
    assertEqual(computeRemaining(200, 10, 195, 195), -5);
  });
});

// ---------------------------------------------------------------------------
// currentLineMonth（JST 境界）
// ---------------------------------------------------------------------------

describe("currentLineMonth", () => {
  it("JST 月内（UTC 14:00 = JST 23:00）は当月", () => {
    assertEqual(currentLineMonth(new Date("2026-07-31T14:00:00Z")), "2026-07");
  });

  it("UTC 15:00（= JST 翌日 00:00）で翌月に繰り上がる", () => {
    assertEqual(currentLineMonth(new Date("2026-07-31T15:00:00Z")), "2026-08");
  });

  it("年跨ぎ（UTC 12-31 16:00 = JST 01-01 01:00）で翌年 01 月", () => {
    assertEqual(currentLineMonth(new Date("2026-12-31T16:00:00Z")), "2027-01");
  });
});

// ---------------------------------------------------------------------------
// guardAndClaim — 正常系
// ---------------------------------------------------------------------------

describe("guardAndClaim: 正常系", () => {
  it("枠内なら claim 成功し送信可を返す", async () => {
    const store = makeFakeStore();
    const d = await guardAndClaim(store, consumptionOk(0), entry({ recipients: 5 }));
    assertTrue(d.ok, "should be ok");
    if (d.ok) {
      // 200 − 10 − 0 = 190、送信後 190 − 5 = 185
      assertEqual(d.remainingBefore, 190, "remainingBefore");
      assertEqual(d.remainingAfter, 185, "remainingAfter");
    }
    assertEqual(store.rows.length, 1, "1 行 claim されている");
  });

  it("push（source=interactive）も同一台帳に会計できる", async () => {
    const store = makeFakeStore();
    const d = await guardAndClaim(
      store,
      consumptionOk(0),
      entry({ notionPageId: "line-event-123", source: "interactive", recipients: 1 }),
    );
    assertTrue(d.ok, "interactive も claim 可");
    assertEqual(store.rows[0].source, "interactive", "source 記録");
  });
});

// ---------------------------------------------------------------------------
// 要件: 上限接近 / 超過で送信不可
// ---------------------------------------------------------------------------

describe("guardAndClaim: 上限接近/超過", () => {
  it("上限接近で残枠を超える recipients を弾く", async () => {
    // 確定消費 185 → 残枠 200−10−185 = 5。recipients 10 は不可。
    const store = makeFakeStore([entry({ notionPageId: "seed", recipients: 185 })]);
    const d = await guardAndClaim(store, consumptionOk(185), entry({ recipients: 10 }));
    assertReject(d, "cap_exceeded", "near-cap");
    if (!d.ok) assertEqual(d.remaining, 5, "残枠 5");
    assertEqual(store.rows.length, 1, "claim されていない（seed のみ）");
  });

  it("上限接近でも残枠ちょうどは送信可", async () => {
    const store = makeFakeStore([entry({ notionPageId: "seed", recipients: 185 })]);
    const d = await guardAndClaim(store, consumptionOk(185), entry({ recipients: 5 }));
    assertTrue(d.ok, "残枠ちょうど=5 に recipients=5 は可");
  });

  it("既に上限超過（負の残枠）なら 1 通でも不可", async () => {
    const store = makeFakeStore([entry({ notionPageId: "seed", recipients: 195 })]);
    const d = await guardAndClaim(store, consumptionOk(195), entry({ recipients: 1 }));
    assertReject(d, "cap_exceeded", "over-cap");
  });

  it("全員配信で友だち数が枠超（例 300 人）を弾く＝課金事故を防ぐ", async () => {
    const store = makeFakeStore();
    const d = await guardAndClaim(store, consumptionOk(0), entry({ recipients: 300 }));
    assertReject(d, "cap_exceeded", "broadcast-over");
    assertEqual(store.rows.length, 0, "超過配信は claim しない");
  });
});

// ---------------------------------------------------------------------------
// 要件: 月替わりリセット
// ---------------------------------------------------------------------------

describe("guardAndClaim: 月替わりリセット", () => {
  it("先月が満枠でも当月は残枠フルで送信可", async () => {
    // 2026-07 は満枠（190 消費）。2026-08 は 0。
    const store = makeFakeStore([
      entry({ notionPageId: "jul", month: "2026-07", recipients: 190 }),
    ]);
    const julReject = await guardAndClaim(
      store,
      consumptionOk(0),
      entry({ notionPageId: "jul-2", month: "2026-07", recipients: 20 }),
    );
    assertReject(julReject, "cap_exceeded", "先月は満杯");

    const augOk = await guardAndClaim(
      store,
      consumptionOk(0), // consumption API は当月値=0
      entry({ notionPageId: "aug-1", month: "2026-08", recipients: 100 }),
    );
    assertTrue(augOk.ok, "当月はリセットされ送信可");
  });
});

// ---------------------------------------------------------------------------
// 要件: 同一 notion_page_id の二重 claim 拒否
// ---------------------------------------------------------------------------

describe("guardAndClaim: 二重 claim 拒否", () => {
  it("同一ページの 2 回目は already_claimed で拒否（冪等・二重送信防止）", async () => {
    const store = makeFakeStore();
    const first = await guardAndClaim(store, consumptionOk(0), entry({ recipients: 5 }));
    assertTrue(first.ok, "1 回目は成功");

    const second = await guardAndClaim(store, consumptionOk(0), entry({ recipients: 5 }));
    assertReject(second, "already_claimed", "2 回目");
    assertEqual(store.rows.length, 1, "台帳は 1 行のまま（二重計上しない）");
  });
});

// ---------------------------------------------------------------------------
// 要件: consumption API エラー時 fail-closed
// ---------------------------------------------------------------------------

describe("guardAndClaim: consumption fail-closed", () => {
  it("consumption 取得失敗なら枠が空いていても送信不可", async () => {
    const store = makeFakeStore(); // 台帳は空 = 枠フル
    const d = await guardAndClaim(store, consumptionFail, entry({ recipients: 1 }));
    assertReject(d, "consumption_unavailable", "fail-closed");
    assertEqual(store.rows.length, 0, "取得失敗時は claim しない");
  });
});

// ---------------------------------------------------------------------------
// 要件: 走行合計で複数行の合計超過を弾く
// ---------------------------------------------------------------------------

describe("guardAndClaim: 走行合計（直列）", () => {
  it("直列 claim で合計が枠を超えた行を弾く", async () => {
    // CAP 200 / headroom 10 → 実効 190。100 → 可、次の 100 は走行合計で不可。
    const store = makeFakeStore();

    const a = await guardAndClaim(store, consumptionOk(0), entry({ notionPageId: "A", recipients: 100 }));
    assertTrue(a.ok, "A(100) 可");
    if (a.ok) assertEqual(a.remainingAfter, 90, "A 後の残枠 90");

    const b = await guardAndClaim(store, consumptionOk(0), entry({ notionPageId: "B", recipients: 100 }));
    assertReject(b, "cap_exceeded", "B(100) は走行合計で不可");
    if (!b.ok) assertEqual(b.remaining, 90, "B 判定時の残枠 90");

    // 残枠 90 に収まる C(90) は通る
    const c = await guardAndClaim(store, consumptionOk(0), entry({ notionPageId: "C", recipients: 90 }));
    assertTrue(c.ok, "C(90) 可");
    assertEqual(store.rows.length, 2, "claim されたのは A と C の 2 行");
  });
});

// ---------------------------------------------------------------------------
// 入力検証（fail-closed）
// ---------------------------------------------------------------------------

describe("guardAndClaim: 入力検証", () => {
  it("recipients 0 は invalid_request", async () => {
    const store = makeFakeStore();
    const d = await guardAndClaim(store, consumptionOk(0), entry({ recipients: 0 }));
    assertReject(d, "invalid_request", "0 通");
  });

  it("不正な month は invalid_request", async () => {
    const store = makeFakeStore();
    const d = await guardAndClaim(store, consumptionOk(0), entry({ month: "2026/07" }));
    assertReject(d, "invalid_request", "月形式");
  });

  it("空 notionPageId は invalid_request", async () => {
    const store = makeFakeStore();
    const d = await guardAndClaim(store, consumptionOk(0), entry({ notionPageId: "" }));
    assertReject(d, "invalid_request", "空キー");
  });

  it("consumption を呼ぶ前に入力検証で弾く（invalid は consumption 不問）", async () => {
    const store = makeFakeStore();
    // consumptionFail でも invalid_request が優先される
    const d = await guardAndClaim(store, consumptionFail, entry({ recipients: -1 }));
    assertReject(d, "invalid_request", "負数");
  });
});

// ---------------------------------------------------------------------------
// 定数の健全性
// ---------------------------------------------------------------------------

describe("定数", () => {
  it("FREE_TIER_CAP は 200", () => assertEqual(FREE_TIER_CAP, 200));
  it("DEFAULT_SAFETY_HEADROOM は正の値", () =>
    assertTrue(DEFAULT_SAFETY_HEADROOM > 0, "headroom>0"));
});

// ---------------------------------------------------------------------------
// ランナー（直列 await）
// ---------------------------------------------------------------------------

(async () => {
  for (const t of queue) {
    if (t.name.startsWith("--- ")) {
      console.log(`\n${t.name}`);
      continue;
    }
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
  console.log("message-ledger Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failedTests > 0 ? 1 : 0);
})();
