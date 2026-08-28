/**
 * Unit — L0 の読み口の「引数の読み方」だけを DB 抜きで固定する（CDP 統合 Stage 3）
 *
 * ここで固定するのは 2 つだけ。どちらも壊れても例外が出ず、**静かに間違った答えを
 * 返す**類のものなので、実 DB を用意しなくても落ちる場所に置いておく:
 *
 *   jstDayBounds … 日の境界。045 の `AT TIME ZONE 'Asia/Tokyo'` と 1 秒でもずれると、
 *                  E8' の突合が毎日「食い違い」を報告し続ける（そして食い違いの
 *                  本体は境界のずれなので、いくら引き直しても直らない）。
 *   intParam / dateParam
 *                … 運用ジョブ専用の口なので、数は丸めて動かし続け、日付だけは
 *                  丸めずに 400 にする。この非対称を明示的に固定する。
 *
 * SQL の中身（突合の判定・canonical 解決・件数の数え方）は
 * tests/db/cdp-stage3-l0-readout.db.test.ts が実 DB で見る。
 */

import { intParam, dateParam, jstDayBounds } from "../../src/routes/cdp-export";

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
function assertEqual<T>(a: T, b: T, label: string) {
  if (a !== b) throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log("\n=== 日の境界（045 の AT TIME ZONE 'Asia/Tokyo' と一致すること）===");

it("JST の 1 日は UTC の前日 15:00 から始まる", () => {
  const b = jstDayBounds("2026-08-29");
  assertEqual(b.startUtc, "2026-08-28T15:00:00.000Z", "始まりがずれている");
  assertEqual(b.endUtc, "2026-08-29T15:00:00.000Z", "終わりがずれている");
});

it("区間は半開（終わりは次の日の始まりと同じ値）", () => {
  const d1 = jstDayBounds("2026-08-29");
  const d2 = jstDayBounds("2026-08-30");
  assertEqual(d1.endUtc, d2.startUtc, "隙間か重なりがある（1 件が 0 日または 2 日に数えられる）");
});

it("月・年をまたいでも壊れない", () => {
  assertEqual(jstDayBounds("2027-01-01").startUtc, "2026-12-31T15:00:00.000Z", "年またぎがずれている");
  assertEqual(jstDayBounds("2026-03-01").startUtc, "2026-02-28T15:00:00.000Z", "月またぎがずれている");
});

console.log("\n=== 引数の読み方（数は丸める / 日付は丸めない）===");

it("intParam: 読めない値は既定へ倒す（ジョブを引数の綴りで止めない）", () => {
  assertEqual(intParam(undefined, 500, 1, 1000), 500, "未指定で既定にならない");
  assertEqual(intParam("", 500, 1, 1000), 500, "空文字で既定にならない");
  assertEqual(intParam("abc", 500, 1, 1000), 500, "数でない値で既定にならない");
  assertEqual(intParam("12.5", 500, 1, 1000), 500, "整数でない値で既定にならない");
});

it("intParam: 範囲外は丸める（上限を超えて L0 を一気に吐かせない）", () => {
  assertEqual(intParam("5000", 500, 1, 1000), 1000, "上限で丸まっていない");
  assertEqual(intParam("0", 500, 1, 1000), 1, "下限で丸まっていない");
  assertEqual(intParam("-3", 0, 0), 0, "負の水位が通っている");
  assertEqual(intParam("250", 500, 1, 1000), 250, "範囲内の値が書き換わっている");
});

it("dateParam: 未指定は null（SQL 側の既定に委ねる）", () => {
  assertEqual(dateParam(undefined), null, "未指定が null でない");
  assertEqual(dateParam(""), null, "空文字が null でない");
});

it("dateParam: 形が違えば undefined（= 呼び出し側が 400 にする。黙って丸めない）", () => {
  assertEqual(dateParam("2026-8-29"), undefined, "0 埋めなしを受けている");
  assertEqual(dateParam("20260829"), undefined, "区切りなしを受けている");
  assertEqual(dateParam("2026-13-01"), undefined, "存在しない月を受けている");
  assertEqual(dateParam("yesterday"), undefined, "語を受けている");
});

it("dateParam: 正しい形はそのまま通す", () => {
  assertEqual(dateParam("2026-08-29"), "2026-08-29", "正しい日付が通らない");
});

console.log(`\n=== cdp-export.test: ${passed}/${total} passed, ${failures.length} failed ===`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
