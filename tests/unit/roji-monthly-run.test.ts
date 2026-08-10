/**
 * Unit Tests — roji 月次処理の骨格（S1）
 *
 * 設計正本: roji出し分けの仕組み 設計書（S1シンプル版）
 *   https://www.notion.so/3b870c9d064c8191b807c59c1c2a6e74  第4章
 * Setaka 回答（2026-08-11）: Q1 = 月末23:59 JST締め・翌月1日に計算 / Q2 = 対象はカルテがある人全員
 *
 * 検証範囲（設計の約束を機械で固定する）:
 *   - 締め月の導出: JST の前月・年跨ぎ・月末23:59 / 翌月0:00 の境界・形式検査
 *   - 対象者抽出: カルテがある人全員を処理する（絞り込まない）・鍵が無ければその月ごと止める
 *   - 冪等: 同月 2 回目は既存行をスキップし、UPDATE を 1 度も呼ばない
 *   - 台帳書込の形: 項目43/48/49/50 に何が入るか・monthly_note と closed_at は触らない
 *   - 月の締め記録: 全員スキップでも書く / 既に締まっていれば二重に書かない / 件数の食い違い検知
 *   - 送信を呼ばない: 送信系モジュールを import していないことをソースで機械チェック
 *
 * ネットワーク非接触（すべて fake ポート）。使用: npx tsx tests/unit/roji-monthly-run.test.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  runMonthlyAssignment,
  type LedgerWrite,
  type MonthRecord,
  type MonthlyPorts,
  type MonthlySubject,
} from "../../src/lib/roji/monthly/monthly-run";
import { derivePeriod, isValidPeriod, assertValidPeriod } from "../../src/lib/roji/monthly/period";
import type { Candidate, LedgerRow, RojiKarte } from "../../src/lib/roji/assignment/types";
import type { TeaItem } from "../../src/lib/tea-menu";

let total = 0;
let passed = 0;
const failures: string[] = [];

function describe(name: string, fn: () => void) {
  console.log(`\n--- ${name} ---`);
  fn();
}
function it(name: string, fn: () => void | Promise<void>) {
  total++;
  const done = () => {
    passed++;
    console.log(`  [PASS] ${name}`);
  };
  const fail = (err: unknown) => {
    failures.push(name);
    console.log(`  [FAIL] ${name}: ${err instanceof Error ? err.message : String(err)}`);
  };
  try {
    const r = fn();
    if (r instanceof Promise) {
      pending.push(r.then(done, fail));
    } else {
      done();
    }
  } catch (err) {
    fail(err);
  }
}
const pending: Promise<void>[] = [];
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}
function assertEqual<T>(a: T, e: T, label = "") {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

// ---------------------------------------------------------------------------
// フィクスチャ
// ---------------------------------------------------------------------------

const EMPTY_KARTE: RojiKarte = { persona: null, tasteProfile: null };

/** 番号だけ違うお茶を n 本（S1 は 6 本選ぶので既定は余裕を持たせる）。 */
function teaCandidates(count = 8): Candidate[] {
  const out: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    const tea: TeaItem = {
      id: `page-${i}`,
      number: String(11301 + i * 100),
      name: `茶${i}`,
      category: i % 2 === 0 ? "緑茶" : "紅茶",
      flavorProfiles: [],
      descShort: "",
      howToBrew: "",
      temp: "",
      time: "",
      water: "",
      enjoy: "",
      story: "",
    };
    out.push({ kind: "tea", tea });
  }
  return out;
}

/** その場で状態を持つ fake ポート（Supabase / Firestore / Notion に触らない）。 */
function fakePorts(opts: {
  subjects: MonthlySubject[];
  candidates?: Candidate[];
  /** 実行前から台帳にある行（冪等の検証用）。key = `${id}|${period}` */
  existing?: Set<string>;
  recentLedger?: Record<string, LedgerRow[]>;
  closedMonths?: Set<string>;
}) {
  const rows = new Set<string>(opts.existing ?? []);
  const inserted: LedgerWrite[] = [];
  const months: MonthRecord[] = [];
  const closed = new Set<string>(opts.closedMonths ?? []);
  const calls: string[] = [];

  const ports: MonthlyPorts = {
    async listSubjects(period) {
      calls.push(`listSubjects:${period}`);
      return opts.subjects;
    },
    async loadCandidates() {
      calls.push("loadCandidates");
      return opts.candidates ?? teaCandidates();
    },
    async loadRecentLedger(id) {
      calls.push(`loadRecentLedger:${id}`);
      return opts.recentLedger?.[id] ?? [];
    },
    async hasLedgerRow(id, period) {
      return rows.has(`${id}|${period}`);
    },
    async insertLedgerRow(row) {
      calls.push(`insertLedgerRow:${row.shopifyCustomerId}`);
      rows.add(`${row.shopifyCustomerId}|${row.period}`);
      inserted.push(row);
    },
    async countLedgerRows(period) {
      let n = 0;
      for (const key of rows) if (key.endsWith(`|${period}`)) n++;
      return n;
    },
    async isMonthClosed(period) {
      return closed.has(period);
    },
    async insertMonthRecord(record) {
      calls.push(`insertMonthRecord:${record.period}`);
      closed.add(record.period);
      months.push(record);
    },
  };

  return { ports, inserted, months, calls, rows };
}

const NOW = new Date("2026-09-01T00:30:00.000Z");

// ---------------------------------------------------------------------------
// 締め月の導出（Q1）
// ---------------------------------------------------------------------------

describe("derivePeriod — 月末23:59 JST締め・翌月1日に計算（Q1）", () => {
  it("翌月1日 朝（JST）に走らせると、前月が締め対象", () => {
    // 2026-09-01 09:00 JST = 2026-09-01 00:00 UTC
    assertEqual(derivePeriod(new Date("2026-09-01T00:00:00.000Z")), "2026-08", "9/1朝 → 8月分");
  });

  it("月末 23:59 JST は、まだ締まっていない（当月を対象にしない）", () => {
    // 2026-08-31 23:59 JST = 2026-08-31 14:59 UTC → JST 暦では 8 月 → 前月 = 7 月
    assertEqual(derivePeriod(new Date("2026-08-31T14:59:00.000Z")), "2026-07", "月末は前月のまま");
  });

  it("翌月 00:00 JST を跨いだ瞬間から当月分が締め対象になる", () => {
    // 2026-09-01 00:00 JST = 2026-08-31 15:00 UTC
    assertEqual(derivePeriod(new Date("2026-08-31T15:00:00.000Z")), "2026-08", "跨いだら8月分");
  });

  it("1月に走らせると前年12月（年跨ぎ）", () => {
    assertEqual(derivePeriod(new Date("2027-01-01T00:00:00.000Z")), "2026-12", "年跨ぎ");
  });

  it("UTC ではまだ前月でも JST で月が変わっていれば JST に従う", () => {
    // 2026-08-31 15:30 UTC = 2026-09-01 00:30 JST
    assertEqual(derivePeriod(new Date("2026-08-31T15:30:00.000Z")), "2026-08", "JST基準");
  });

  it("形式検査: 13月・1桁月・空は弾く", () => {
    assert(isValidPeriod("2026-08"), "正常形");
    assert(!isValidPeriod("2026-13"), "13月");
    assert(!isValidPeriod("2026-8"), "1桁月");
    assert(!isValidPeriod(""), "空");
    let threw = false;
    try {
      assertValidPeriod("2026/08");
    } catch {
      threw = true;
    }
    assert(threw, "形式外は例外");
  });
});

// ---------------------------------------------------------------------------
// 対象者抽出（Q2）
// ---------------------------------------------------------------------------

describe("対象者抽出 — カルテがある人全員（Q2・絞り込まない）", () => {
  it("渡された対象者を全員処理し、1 人 1 行だけ書く", async () => {
    const subjects: MonthlySubject[] = [
      { shopifyCustomerId: "1001", karte: EMPTY_KARTE },
      { shopifyCustomerId: "1002", karte: EMPTY_KARTE },
      { shopifyCustomerId: "1003", karte: EMPTY_KARTE },
    ];
    const f = fakePorts({ subjects });
    const res = await runMonthlyAssignment("2026-08", f.ports, { now: NOW });

    assertEqual(res.memberCount, 3, "member_count = 対象者数");
    assertEqual(res.assigned.length, 3, "全員に行を作る");
    assertEqual(f.inserted.length, 3, "INSERT は 1 人 1 回");
    assertEqual(res.rowCount, 3, "row_count");
    assertEqual(res.countMismatch, false, "食い違いなし");
  });

  it("カルテが空の人も対象から外さない（点が全部 0 でも行を作る）", async () => {
    const f = fakePorts({ subjects: [{ shopifyCustomerId: "2001", karte: EMPTY_KARTE }] });
    const res = await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    assertEqual(res.assigned.length, 1, "空カルテでも書く");
    assertEqual(f.inserted[0].estimateSnapshot.reasonKey, "not_enough_signal", "理由記号");
  });

  it("対象者 0 人でも落ちず、月の締め記録だけ書く", async () => {
    const f = fakePorts({ subjects: [] });
    const res = await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    assertEqual(res.memberCount, 0, "0 人");
    assertEqual(res.monthRecord, "written", "締め記録は書く");
    assertEqual(f.months.length, 1, "月の行は 1 件");
  });

  it("EC 上の顧客番号が無い対象者はその月ごと止める（推測で鍵を作らない）", async () => {
    const f = fakePorts({ subjects: [{ shopifyCustomerId: "  ", karte: EMPTY_KARTE }] });
    let threw = false;
    try {
      await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    } catch {
      threw = true;
    }
    assert(threw, "例外で止まる");
    assertEqual(f.months.length, 0, "止まった月の締め記録は書かない");
  });
});

// ---------------------------------------------------------------------------
// 冪等（設計 4-2）
// ---------------------------------------------------------------------------

describe("冪等 — 同月 2 回目は既存行をスキップ（凍結原則）", () => {
  it("同じ月を 2 回実行しても、2 回目は 1 行も書かない", async () => {
    const subjects: MonthlySubject[] = [
      { shopifyCustomerId: "1001", karte: EMPTY_KARTE },
      { shopifyCustomerId: "1002", karte: EMPTY_KARTE },
    ];
    const f = fakePorts({ subjects });
    const first = await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    const second = await runMonthlyAssignment("2026-08", f.ports, { now: NOW });

    assertEqual(first.assigned.length, 2, "1 回目は 2 人");
    assertEqual(second.assigned.length, 0, "2 回目は 0 人");
    assertEqual(second.skipped.length, 2, "2 回目は全員スキップ");
    assertEqual(second.skipped[0].reason, "already_assigned", "スキップ理由");
    assertEqual(f.inserted.length, 2, "INSERT の総回数は増えない");
  });

  it("既存行がある人は割当計算そのものを行わない（上書きの余地を作らない）", async () => {
    const f = fakePorts({
      subjects: [{ shopifyCustomerId: "1001", karte: EMPTY_KARTE }],
      existing: new Set(["1001|2026-08"]),
    });
    await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    assert(!f.calls.includes("loadRecentLedger:1001"), "スキップ時は台帳も読まない");
    assertEqual(f.inserted.length, 0, "INSERT なし");
  });

  it("全員スキップでも月の締め記録は書く（0 人の月と未実行の月を見分ける）", async () => {
    const f = fakePorts({
      subjects: [{ shopifyCustomerId: "1001", karte: EMPTY_KARTE }],
      existing: new Set(["1001|2026-08"]),
    });
    const res = await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    assertEqual(res.monthRecord, "written", "締め記録を書く");
    assertEqual(res.rowCount, 1, "既存行は row_count に数える");
    assertEqual(res.countMismatch, false, "再実行で食い違わない");
  });

  it("既に締めた月は締め記録を二重に書かない", async () => {
    const f = fakePorts({
      subjects: [{ shopifyCustomerId: "1001", karte: EMPTY_KARTE }],
      closedMonths: new Set(["2026-08"]),
    });
    const res = await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    assertEqual(res.monthRecord, "already_closed", "既に締まっている");
    assertEqual(f.months.length, 0, "月の行を足さない");
  });

  it("別の月は独立して書ける（冪等キーは (顧客番号, 年月)）", async () => {
    const f = fakePorts({
      subjects: [{ shopifyCustomerId: "1001", karte: EMPTY_KARTE }],
      existing: new Set(["1001|2026-07"]),
    });
    const res = await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    assertEqual(res.assigned.length, 1, "8 月分は新しく書く");
  });
});

// ---------------------------------------------------------------------------
// 台帳書込の形
// ---------------------------------------------------------------------------

describe("台帳書込 — 項目43/48/49/50 の形と、触らない列", () => {
  it("teas（項目43）・candidates_not_chosen（項目49）・estimate_snapshot（項目48）が入る", async () => {
    const f = fakePorts({ subjects: [{ shopifyCustomerId: "1001", karte: EMPTY_KARTE }] });
    await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    const row = f.inserted[0];

    assertEqual(row.period, "2026-08", "period");
    assertEqual(row.teas.length, 6, "S1 は 6 本");
    assert(row.teas.every((t) => typeof t.number === "string"), "銘柄番号を持つ");
    assert(row.candidatesNotChosen.length > 0, "選ばなかった候補が理由付きで入る");
    assert(
      row.candidatesNotChosen.every((c) => typeof c.ref === "string" && typeof c.reason === "string"),
      "{ref, reason} の形",
    );
    assertEqual(row.estimateSnapshot.engine, "S1", "どのエンジンで決めたか");
    assert(row.estimateSnapshot.breakdown.length > 0, "点の内訳を凍結する");
  });

  it("monthly_note / closed_at は書かない（行を作る時点では未記入でよい・締めは人の確認後）", async () => {
    const f = fakePorts({ subjects: [{ shopifyCustomerId: "1001", karte: EMPTY_KARTE }] });
    await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    const row = f.inserted[0] as unknown as Record<string, unknown>;
    assert(!("monthlyNote" in row), "monthly_note を書かない");
    assert(!("closedAt" in row), "closed_at を立てない（CHECK 制約に触れない）");
  });

  it("読みものは issue_materials（項目50）に順番付きで入る", async () => {
    const candidates: Candidate[] = [
      ...teaCandidates(),
      {
        kind: "article",
        article: {
          id: "art-1",
          title: "記事",
          url: "https://elxea.com/ja/blogs/journal/art-1",
          excerpt: "",
          thumbnailUrl: "",
          persona: null,
          targetLayer: null,
          tags: [],
          publishedAt: "2026-07-01",
        },
      },
    ];
    const f = fakePorts({ subjects: [{ shopifyCustomerId: "1001", karte: EMPTY_KARTE }], candidates });
    await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    const materials = f.inserted[0].issueMaterials;
    assertEqual(materials.length, 1, "読みもの 1 本");
    assertEqual(materials[0].ref, "art-1", "参照は page id");
    assertEqual(materials[0].position, 1, "position は 1 始まり");
  });

  it("直近 3 か月に送ったお茶は選ばれない（重複回避が台帳の読み出しに繋がっている）", async () => {
    const recent: LedgerRow[] = [{ period: "2026-07", teas: [{ number: "11301" }] }];
    const f = fakePorts({
      subjects: [{ shopifyCustomerId: "1001", karte: EMPTY_KARTE }],
      recentLedger: { "1001": recent },
    });
    await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    const numbers = f.inserted[0].teas.map((t) => t.number);
    assert(!numbers.includes("11301"), "直近に送ったお茶は入らない");
  });

  it("候補が足りない月は shortage が可視化される（黙って埋めない）", async () => {
    const f = fakePorts({
      subjects: [{ shopifyCustomerId: "1001", karte: EMPTY_KARTE }],
      candidates: teaCandidates(3),
    });
    const res = await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    assertEqual(res.shortages.length, 1, "候補不足が 1 件");
    assertEqual(res.shortages[0].shortage.code, "candidate_shortage", "記号");
    assertEqual(f.inserted[0].estimateSnapshot.shortage?.delivered, 3, "凍結値にも残る");
  });
});

// ---------------------------------------------------------------------------
// 月の締め記録
// ---------------------------------------------------------------------------

describe("月の締め記録 — member_count と row_count", () => {
  it("締め記録には対象者数と実行後の台帳行数が入る", async () => {
    const f = fakePorts({
      subjects: [
        { shopifyCustomerId: "1001", karte: EMPTY_KARTE },
        { shopifyCustomerId: "1002", karte: EMPTY_KARTE },
      ],
    });
    await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    assertEqual(f.months[0].memberCount, 2, "member_count");
    assertEqual(f.months[0].rowCount, 2, "row_count");
    assertEqual(f.months[0].closedAt.toISOString(), NOW.toISOString(), "時刻は呼び出し側から渡す");
  });

  it("その月に他所由来の行が混ざっていれば食い違いとして検知する（N3 の見張り）", async () => {
    const f = fakePorts({
      subjects: [{ shopifyCustomerId: "1001", karte: EMPTY_KARTE }],
      existing: new Set(["9999|2026-08"]),
    });
    const res = await runMonthlyAssignment("2026-08", f.ports, { now: NOW });
    assertEqual(res.memberCount, 1, "対象者 1 人");
    assertEqual(res.rowCount, 2, "台帳は 2 行");
    assertEqual(res.countMismatch, true, "食い違いを検知");
  });
});

// ---------------------------------------------------------------------------
// 送信を呼ばない（構造で担保する）
// ---------------------------------------------------------------------------

describe("送信は一切呼ばない — 送信系を import していないことをソースで固定", () => {
  const FORBIDDEN = [
    "delivery-orchestrator",
    "delivery-runtime",
    "delivery-audience",
    "delivery-approval",
    "segment-broadcast",
    "line-messages",
    "broadcast-templates",
  ];

  it("monthly-run.ts / period.ts が送信系モジュールを import していない", () => {
    for (const file of ["monthly-run.ts", "period.ts"]) {
      const src = readFileSync(resolve(process.cwd(), "src/lib/roji/monthly", file), "utf8");
      const imports = src.match(/^\s*import[\s\S]*?from\s+"[^"]+";/gm) ?? [];
      const joined = imports.join("\n");
      for (const bad of FORBIDDEN) {
        assert(!joined.includes(bad), `${file} が ${bad} を import している`);
      }
      // `./line` を単体で掴んでいないか（"line-token" 等の別物と区別するため境界付きで見る）。
      assert(!/from\s+"[^"]*\/line";/.test(joined), `${file} が line クライアントを import している`);
    }
  });

  it("手動実行スクリプトも送信系を import していない", () => {
    const src = readFileSync(resolve(process.cwd(), "scripts/roji-monthly-run.ts"), "utf8");
    const imports = (src.match(/^\s*import[\s\S]*?from\s+"[^"]+";/gm) ?? []).join("\n");
    for (const bad of FORBIDDEN) {
      assert(!imports.includes(bad), `scripts/roji-monthly-run.ts が ${bad} を import している`);
    }
    assert(!/from\s+"[^"]*\/line";/.test(imports), "line クライアントを import している");
  });
});

// ---------------------------------------------------------------------------

await Promise.all(pending);

console.log("\n============================================================");
console.log("roji monthly run (S1 skeleton) Test Results");
console.log("============================================================");
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${total - passed}`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
