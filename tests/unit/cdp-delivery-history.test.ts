/**
 * Unit — 送った記録の台帳の読み口（A-0 / migration 053）を DB 抜きで固定する
 *
 * ─ なぜこの層が要るか ─
 *
 *   この口の出力は、A-1「先月への返事」の材料になる。正本はその 1 行を
 *   「唯一の約束の唯一の観測できる証明」と呼んでいる。材料が半端に読まれると、
 *   **送ったものを送っていないと言う** / **送っていないものを送ったと言う** の
 *   どちらかが、静かに起きる。だから「読めない形は found:false に倒す」を
 *   実 DB 抜きで留める。
 *
 * ここで固定するのは 3 つ:
 *   ① 返ってきた形の読み取り（壊れた形・欠けた形を通さない）
 *   ② 月数の丸め（口と SQL で同じ規則）
 *   ③ 053 の SQL が「読むだけ・人を指す値を返さない・2 つの台帳を畳まない」であること
 *
 * plpgsql の実行検証は本番適用と tests/db/*.db.test.ts の役目。HTTP の口の挙動は
 * tests/hermetic/flow26-cdp-delivery-readout.test.ts が見る。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  readDeliveryHistoryResult,
  boundMonths,
  DELIVERY_HISTORY_DEFAULT_MONTHS,
  DELIVERY_HISTORY_MAX_MONTHS,
} from "../../src/lib/cdp/delivery-history";

let total = 0;
let passed = 0;
const failures: string[] = [];

function it(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  [FAIL] ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assertTrue(v: boolean, label: string) {
  if (!v) throw new Error(label);
}
function assertEqual<T>(a: T, b: T, label: string) {
  if (a !== b) throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const SQL_053 = readFileSync(
  join(process.cwd(), "src/db/migrations/053_cdp_delivery_readout.sql"),
  "utf8",
);

/** SQL 側が返す形の最小の見本。 */
function payload() {
  return {
    found: true,
    months: 12,
    keys: { shopify_customer_id: 1, line_messaging_uid: 0 },
    periods: [
      {
        period: "2026-09",
        assigned: {
          issue_ref: "issue-2026-09",
          teas: [{ product_no: "11301", name: "やぶきたの上煎茶" }],
          basis: "assignment",
        },
        delivered: [
          {
            item_ref: "gid://shopify/Product/1111",
            item_name: "やぶきたの上煎茶",
            item_kind: "tea",
            quantity: 2,
            delivered_on: "2026-09-05",
            date_basis: "fulfilled",
            source: "shopify_order",
          },
        ],
      },
    ],
  };
}

console.log("\n=== ① 返ってきた形の読み取り ===");

it("正しい形を型に読む", () => {
  const r = readDeliveryHistoryResult(payload());
  assertEqual(r.found, true, "found");
  assertEqual(r.periods.length, 1, "月数");
  assertEqual(r.periods[0].period, "2026-09", "period");
  assertEqual(r.periods[0].assigned?.issueRef, "issue-2026-09", "号");
  assertEqual(r.periods[0].assigned?.teas[0].productNo, "11301", "銘柄番号");
  assertEqual(r.periods[0].delivered[0].quantity, 2, "数量");
  assertEqual(r.periods[0].delivered[0].dateBasis, "fulfilled", "日付の出所");
  assertEqual(r.keys?.shopifyCustomerId, 1, "鍵の件数");
});

it("found が false なら理由を持って空で戻る", () => {
  const r = readDeliveryHistoryResult({ found: false, reason: "subject_not_found" });
  assertEqual(r.found, false, "found");
  assertEqual(r.reason, "subject_not_found", "reason");
  assertEqual(r.periods.length, 0, "periods");
});

it("形が壊れていれば found:false に倒す（中途半端に読まない）", () => {
  for (const bad of [null, undefined, 42, "x", [], { found: true }]) {
    const r = readDeliveryHistoryResult(bad);
    assertEqual(r.found, false, `壊れた形が通った: ${JSON.stringify(bad)}`);
  }
});

it("出所タグが語彙どおりでない行は落とす（既定値で埋めない）", () => {
  // 「どこから来た記録か分からないもの」を既定値で埋めると、出所タグを付けている
  // 意味（どれを本人に見せてよいか / 直させてよいか）が消える。
  const p = payload();
  p.periods[0].delivered.push({
    item_ref: "gid://shopify/Product/2222",
    item_name: null as unknown as string,
    item_kind: "tea",
    quantity: 1,
    delivered_on: "2026-09-06",
    date_basis: "guessed", // ← 語彙に無い
    source: "shopify_order",
  });
  const r = readDeliveryHistoryResult(p);
  assertEqual(r.periods[0].delivered.length, 1, "語彙外の出所を持つ行が残っている");
});

it("日付の形が違う行は落とす", () => {
  const p = payload();
  p.periods[0].delivered[0].delivered_on = "2026/09/05";
  const r = readDeliveryHistoryResult(p);
  assertEqual(r.periods[0].delivered.length, 0, "日付の形が違う行が残っている");
});

it("銘柄番号が空の割当は落とすが、月そのものは残す", () => {
  // 号だけ決まっていて銘柄がまだ、という月は実在しうる。月ごと落とすと
  // 「その月は何も無かった」になり、号の存在が消える。
  const p = payload();
  p.periods[0].assigned.teas = [{ product_no: "", name: "x" }];
  const r = readDeliveryHistoryResult(p);
  assertEqual(r.periods.length, 1, "月が落ちている");
  assertEqual(r.periods[0].assigned?.teas.length, 0, "空の銘柄番号が残っている");
  assertEqual(r.periods[0].assigned?.issueRef, "issue-2026-09", "号が落ちている");
});

it("並びは新しい月が先頭（SQL 側の並びに頼らない）", () => {
  const p = payload();
  p.periods = [
    { ...p.periods[0], period: "2026-08" },
    { ...p.periods[0], period: "2026-10" },
    { ...p.periods[0], period: "2026-09" },
  ];
  const r = readDeliveryHistoryResult(p);
  assertEqual(
    r.periods.map((x) => x.period).join(","),
    "2026-10,2026-09,2026-08",
    "並び",
  );
});

console.log("\n=== ② 月数の丸め ===");

it("既定・下限・上限に丸める", () => {
  assertEqual(boundMonths(undefined), DELIVERY_HISTORY_DEFAULT_MONTHS, "既定");
  assertEqual(boundMonths(0), 1, "下限");
  assertEqual(boundMonths(-5), 1, "負数");
  assertEqual(boundMonths(999), DELIVERY_HISTORY_MAX_MONTHS, "上限");
  assertEqual(boundMonths(6), 6, "範囲内");
  assertEqual(boundMonths(Number.NaN), DELIVERY_HISTORY_DEFAULT_MONTHS, "NaN");
});

it("SQL 側の丸めと同じ数字を使っている", () => {
  const m = /least\(greatest\(coalesce\(p_months,\s*(\d+)\),\s*(\d+)\),\s*(\d+)\)/.exec(SQL_053);
  assertTrue(m !== null, "SQL 側の丸めが読み取れない");
  assertEqual(Number(m![1]), DELIVERY_HISTORY_DEFAULT_MONTHS, "既定");
  assertEqual(Number(m![2]), 1, "下限");
  assertEqual(Number(m![3]), DELIVERY_HISTORY_MAX_MONTHS, "上限");
});

console.log("\n=== ③ 053 の SQL の性質 ===");

it("読むだけ（書き込みを 1 つも含まない）", () => {
  // 前提確認の DO ブロックと関数定義しか無いこと。読み口が主体を発行したり
  // 出来事を積んだりすると、「見ただけで記録が変わる」経路が生まれる。
  for (const re of [
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+\w+\s+SET\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bCREATE\s+TABLE\b/i,
    /\bALTER\s+TABLE\b/i,
    /\bDROP\b/i,
  ]) {
    assertTrue(!re.test(SQL_053), `書き込み/DDL が含まれている: ${re}`);
  }
});

it("関数は STABLE で宣言されている", () => {
  const m = /CREATE OR REPLACE FUNCTION cdp_delivery_history_for_identifier[\s\S]*?\$\$ LANGUAGE plpgsql (\w+);/.exec(
    SQL_053,
  );
  assertTrue(m !== null, "宣言が読み取れない");
  assertEqual(m![1], "STABLE", "volatility");
});

it("人を指す値を返り値に載せていない", () => {
  // 返り値を組み立てているのは jsonb_build_object の並び。ここに人の鍵が
  // 現れないこと（`keys` は **件数** なので array_length しか使っていない）。
  // 最後の RETURN が成功時の返り値（前段の RETURN は found:false の門番）。
  const returns = SQL_053.slice(SQL_053.lastIndexOf("RETURN jsonb_build_object("));
  for (const forbidden of [
    "'subject_id'",
    "t.shopify_customer_id",
    "t.line_user_id",
    "'note'",
    "t.note",
    "estimate_snapshot",
    "monthly_note",
    "candidates_not_chosen",
  ]) {
    assertTrue(!returns.includes(forbidden), `返り値に ${forbidden} が載っている`);
  }
  assertTrue(returns.includes("array_length(v_shopify, 1)"), "鍵は件数で返していない");
});

it("2 つの台帳を 1 つの配列に畳んでいない", () => {
  // 決めたこと(033) と 届いたこと(038) はずれることがある事実である（038 冒頭）。
  // 畳むと「届いていないものを届いたと言う」経路が生まれる。
  assertTrue(SQL_053.includes("'assigned'"), "assigned キーが無い");
  assertTrue(SQL_053.includes("'delivered'"), "delivered キーが無い");
  assertTrue(
    /FULL OUTER JOIN/.test(SQL_053),
    "片方だけの月を落としている（決めたが届いていない / 割当の行が無い月が消える）",
  );
});

it("1 月 1 行に確定させている（同じ月が 2 行にならない）", () => {
  assertTrue(
    /DISTINCT ON \(r\.period\)/.test(SQL_053),
    "割当を 1 月 1 行に畳んでいない（顧客番号が 2 つある人で月が重複する）",
  );
});

it("email_hash では引かない（SEC-1）", () => {
  assertTrue(
    SQL_053.includes("identifier_kind_not_resolvable"),
    "email_hash を拒む枝が無い",
  );
});

it("消去済みの主体には返さない", () => {
  assertTrue(
    SQL_053.includes("retired_at IS NULL") && SQL_053.includes("subject_retired"),
    "消去済みの主体を外す枝が無い（消した人の記録が読める）",
  );
});

it("取り消された観測を辿らない（live ビューを使う）", () => {
  assertTrue(SQL_053.includes("identity_edges_live"), "identity_edges_live を使っていない");
  assertTrue(
    !/\bFROM\s+identity_edges\b(?!_live)/.test(SQL_053),
    "取り消し前の生の表を直に引いている",
  );
});

it("前提の migration を確かめている", () => {
  for (const n of ["033", "038", "049", "043"]) {
    assertTrue(
      new RegExp(`RAISE EXCEPTION[\\s\\S]{0,160}${n}`).test(SQL_053),
      `${n} の前提確認が無い`,
    );
  }
});

console.log(`\n=== cdp-delivery-history.test: ${passed}/${total} passed, ${failures.length} failed ===`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
