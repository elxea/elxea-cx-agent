/**
 * Unit Tests -- dormant-reengagement（休眠検知＋静かな一通・ブロック3-B）
 *
 * 純粋関数（isDormant / selectDormantCandidates / parsePositiveInt / parseLastActive /
 * jstDate / dormantAggregationUnit）と、runDormantReengagementWith のオーケストレーション
 * （fake port を DI + 固定 now）を検証する。実 Supabase / Firestore / LINE には一切触れない。
 *
 * 使用方法:
 *   npx tsx tests/unit/dormant-reengagement.test.ts
 */

import {
  isDormant,
  parsePositiveInt,
  parseLastActive,
  selectDormantCandidates,
  jstDate,
  dormantAggregationUnit,
  runDormantReengagementWith,
  maskUserRef,
  DAY_MS,
  type LineUserActivity,
  type DormantReengagementDeps,
  type DecisionRecord,
} from "../../src/lib/dormant-reengagement";
import { isValidAggregationUnit } from "../../src/lib/aggregation-unit";

let total = 0;
let passed = 0;
let failed = 0;
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

const NOW = new Date("2026-07-16T00:00:00Z");
const U = (hex: string) => `U${hex.padEnd(32, "0")}`;

/** 「daysAgo 日前」の ISO を作る。 */
function daysAgoIso(days: number, now: Date = NOW): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

// ===================================================================
// 純粋関数
// ===================================================================

it("isDormant: 境界（ちょうど60日経過）は休眠 true", () => {
  const la = new Date(NOW.getTime() - 60 * DAY_MS);
  assertEqual(isDormant(la, NOW, 60), true, "60日ちょうど");
});

it("isDormant: 60日未満（59.9日）は休眠でない", () => {
  const la = new Date(NOW.getTime() - 59 * DAY_MS - 1000);
  assertEqual(isDormant(la, NOW, 60), false, "59日+");
});

it("isDormant: 61日は休眠", () => {
  assertEqual(isDormant(new Date(NOW.getTime() - 61 * DAY_MS), NOW, 60), true);
});

it("isDormant: lastActiveAt が null は休眠でない（判定材料なし）", () => {
  assertEqual(isDormant(null, NOW, 60), false);
});

it("isDormant: 未来日時（時計ズレ）は休眠でない", () => {
  assertEqual(isDormant(new Date(NOW.getTime() + 5 * DAY_MS), NOW, 60), false);
});

it("parsePositiveInt: 不正・0以下は fallback、正の整数は採用", () => {
  assertEqual(parsePositiveInt(undefined, 60), 60, "undefined");
  assertEqual(parsePositiveInt("", 60), 60, "empty");
  assertEqual(parsePositiveInt("0", 60), 60, "zero");
  assertEqual(parsePositiveInt("-5", 60), 60, "negative");
  assertEqual(parsePositiveInt("1.5", 60), 60, "float");
  assertEqual(parsePositiveInt("abc", 60), 60, "nan");
  assertEqual(parsePositiveInt("90", 60), 90, "valid");
  assertEqual(parsePositiveInt(" 30 ", 60), 30, "trim");
});

it("parseLastActive: 空・不正は null、ISO は Date", () => {
  assertEqual(parseLastActive(null), null, "null");
  assertEqual(parseLastActive(""), null, "empty");
  assertEqual(parseLastActive("not-a-date"), null, "garbage");
  const d = parseLastActive("2026-01-01T00:00:00Z");
  assertTrue(d instanceof Date && !Number.isNaN(d.getTime()), "iso");
});

it("jstDate: JST 暦日 YYYY-MM-DD（UTC 15:00 は翌日 JST）", () => {
  assertEqual(jstDate(new Date("2026-07-16T15:00:00Z")), "2026-07-17", "跨ぎ");
  assertEqual(jstDate(new Date("2026-07-16T00:00:00Z")), "2026-07-16", "同日");
});

it("dormantAggregationUnit: LINE 制約（半角英数字_・30字以内）を満たす", () => {
  const unit = dormantAggregationUnit(new Date("2026-07-16T00:00:00Z"));
  assertEqual(unit, "d20260716_dorm", "形式");
  assertTrue(isValidAggregationUnit(unit), "LINE 制約");
});

it("maskUserRef: 先頭8文字+... で PII をマスク", () => {
  // U("abcdef") = "U" + "abcdef".padEnd(32,"0") → 先頭8文字は "Uabcdef0"。
  assertEqual(maskUserRef(U("abcdef")), "Uabcdef0...", "mask");
  assertEqual(maskUserRef("short"), "********", "短い値は伏せる");
});

// ===================================================================
// selectDormantCandidates
// ===================================================================

const USERS: LineUserActivity[] = [
  { lineUserId: U("a1"), lastActiveAt: daysAgoIso(100) }, // 深い休眠
  { lineUserId: U("a2"), lastActiveAt: daysAgoIso(70) }, // 休眠
  { lineUserId: U("a3"), lastActiveAt: daysAgoIso(30) }, // 活動中
  { lineUserId: U("a4"), lastActiveAt: null }, // 材料なし → 除外
  { lineUserId: U("a5"), lastActiveAt: daysAgoIso(65) }, // 休眠
];

it("selectDormantCandidates: 休眠のみ・古い順・null は除外", () => {
  const c = selectDormantCandidates(USERS, new Set(), NOW, 60, 20);
  assertEqual(c.length, 3, "3人が休眠");
  assertEqual(c[0].lineUserId, U("a1"), "最古が先頭");
  assertEqual(c[1].lineUserId, U("a2"), "次に古い");
  assertEqual(c[2].lineUserId, U("a5"), "その次");
});

it("selectDormantCandidates: 90日以内に送信済み（recentlySent）は除外（再送ガード）", () => {
  const c = selectDormantCandidates(USERS, new Set([U("a1")]), NOW, 60, 20);
  assertEqual(c.length, 2, "a1 は除外");
  assertTrue(!c.some((x) => x.lineUserId === U("a1")), "a1 が含まれない");
});

it("selectDormantCandidates: 上限クリップ（cap=1 なら最古1人だけ）", () => {
  const c = selectDormantCandidates(USERS, new Set(), NOW, 60, 1);
  assertEqual(c.length, 1, "cap=1");
  assertEqual(c[0].lineUserId, U("a1"), "最古を優先");
});

// ===================================================================
// runDormantReengagementWith（オーケストレーション）
// ===================================================================

/** fake deps を組む。sends を記録し、実 I/O には触れない。 */
function makeDeps(
  over: Partial<DormantReengagementDeps> & {
    users?: LineUserActivity[];
    recentlySent?: Set<string>;
    claimOk?: boolean;
  } = {},
) {
  const recorded: DecisionRecord[] = [];
  const sends: Array<{ lineUserId: string; body: string; unit: string }> = [];
  const marked: Array<{ lineUserId: string; decisionDate: string }> = [];
  const claims: string[] = [];

  const deps: DormantReengagementDeps = {
    now: NOW,
    sendEnabled: over.sendEnabled ?? false,
    thresholdDays: over.thresholdDays ?? 60,
    perRunCap: over.perRunCap ?? 20,
    loadLineUsers: over.loadLineUsers ?? (async () => over.users ?? USERS),
    loadRecentlySent:
      over.loadRecentlySent ?? (async () => over.recentlySent ?? new Set()),
    recordDecision:
      over.recordDecision ??
      (async (input) => {
        recorded.push(input);
      }),
    claimBudget:
      over.claimBudget ??
      (async (lineUserId) => {
        claims.push(lineUserId);
        return over.claimOk === false
          ? { ok: false, reason: "cap_exceeded" }
          : { ok: true };
      }),
    sendMessage:
      over.sendMessage ??
      (async (lineUserId, body, unit) => {
        sends.push({ lineUserId, body, unit });
      }),
    markSent:
      over.markSent ??
      (async (lineUserId, decisionDate) => {
        marked.push({ lineUserId, decisionDate });
      }),
  };
  return { deps, recorded, sends, marked, claims };
}

it("ゲートOFF（既定）: 送信ゼロ・候補は全員 dry-run 記録", async () => {
  const { deps, recorded, sends, marked } = makeDeps({ sendEnabled: false });
  const r = await runDormantReengagementWith(deps);
  assertEqual(r.ok, true, "ok");
  assertEqual(r.sendEnabled, false, "sendEnabled=false");
  assertEqual(r.scanned, 5, "走査 5 人");
  assertEqual(r.candidates, 3, "候補 3 人");
  assertEqual(r.sent, 0, "送信ゼロ（送信封鎖の核心）");
  assertEqual(r.dryRun, 3, "dry-run 3 件");
  assertEqual(sends.length, 0, "LINE 送信は 1 回も呼ばれない");
  assertEqual(marked.length, 0, "sent 記録なし");
  assertEqual(recorded.length, 3, "決定は 3 件記録");
  assertTrue(recorded.every((x) => x.dryRun === true), "全て dry_run=true で記録");
  assertTrue(
    recorded.every((x) => x.bodyPreview.length > 0),
    "送るはずだった本文を記録",
  );
});

it("ゲートON: 予算OKなら送信・sent 記録される", async () => {
  const { deps, sends, marked, claims } = makeDeps({
    sendEnabled: true,
    claimOk: true,
  });
  const r = await runDormantReengagementWith(deps);
  assertEqual(r.sent, 3, "3 件送信");
  assertEqual(r.dryRun, 0, "dry-run なし");
  assertEqual(sends.length, 3, "push 3 回");
  assertEqual(marked.length, 3, "sent 記録 3 回");
  assertEqual(claims.length, 3, "予算 claim 3 回");
});

it("ゲートON・台帳/予算で claim 失敗: 送信されず budget_blocked（重複防止・上限）", async () => {
  const { deps, sends, marked } = makeDeps({ sendEnabled: true, claimOk: false });
  const r = await runDormantReengagementWith(deps);
  assertEqual(r.sent, 0, "送信ゼロ");
  assertEqual(r.budgetBlocked, 3, "全件 budget_blocked");
  assertEqual(sends.length, 0, "push は呼ばれない（台帳 claim 失敗で送らない）");
  assertEqual(marked.length, 0, "sent 記録なし");
});

it("上限クリップ: cap=2 なら候補は2人まで（残りは処理しない）", async () => {
  const { deps, recorded } = makeDeps({ sendEnabled: false, perRunCap: 2 });
  const r = await runDormantReengagementWith(deps);
  assertEqual(r.candidates, 2, "cap=2 に丸め");
  assertEqual(r.dryRun, 2, "2 件のみ dry-run");
  assertEqual(recorded.length, 2, "2 件のみ記録");
});

it("recentlySent 由来の再送ガード: 送信済みは候補から外れる", async () => {
  const { deps } = makeDeps({
    sendEnabled: false,
    recentlySent: new Set([U("a1"), U("a2")]),
  });
  const r = await runDormantReengagementWith(deps);
  assertEqual(r.candidates, 1, "a1/a2 を除き a5 のみ");
});

it("候補ごとの例外は握って継続（1件失敗で全体を止めない）", async () => {
  let calls = 0;
  const { deps } = makeDeps({
    sendEnabled: false,
    recordDecision: async () => {
      calls++;
      if (calls === 1) throw new Error("simulated DB error");
    },
  });
  const r = await runDormantReengagementWith(deps);
  assertEqual(r.ok, true, "全体は ok");
  assertEqual(r.details.filter((d) => d.action === "error").length, 1, "1件 error");
  assertEqual(r.dryRun, 2, "残り2件は dry-run 継続");
});

// ===================================================================
// runner
// ===================================================================
(async () => {
  console.log("\n--- dormant-reengagement ---");
  for (const t of queue) {
    total++;
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${t.name}: ${msg}`);
      failures.push({ name: t.name, error: msg });
    }
  }
  console.log("\n" + "=".repeat(60));
  console.log("dormant-reengagement Unit Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
