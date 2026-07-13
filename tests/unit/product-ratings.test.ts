/**
 * Unit Tests — product_ratings 器（P0-3）
 *
 * Supabase には触れない（fake クライアント注入）。検証範囲:
 *   - isValidRatingInput（rating/source/5桁 product_no の検証）
 *   - buildProductRatingRow の正規化（channel 既定）
 *   - ratingPersonaSignals（rating=1 は TAG_PERSONA_MAP 変換 / rating=-1 は空=減点なし）
 *   - recordProductRating の fail-safe（無効入力・insert 失敗でも throw しない）
 *   - PRODUCT_RATING_WEIGHT = 2（承認済み確定値）
 *
 * 使用: npx tsx tests/unit/product-ratings.test.ts
 */

import {
  isValidRatingInput,
  buildProductRatingRow,
  ratingPersonaSignals,
  recordProductRating,
  PRODUCT_RATINGS_TABLE,
  PRODUCT_RATING_WEIGHT,
  type ProductRatingRow,
} from "../../src/lib/product-ratings";

let total = 0;
let passed = 0;
const failures: string[] = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function it(name: string, fn: () => void | Promise<void>) {
  queue.push({ name, fn });
}
function assertEqual<T>(a: T, e: T, label = "") {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertTrue(v: boolean, label = "") {
  if (!v) throw new Error(`${label}: expected true`);
}
function assertFalse(v: boolean, label = "") {
  if (v) throw new Error(`${label}: expected false`);
}

function makeFakeSupabase(opts?: { failWith?: string; throwOnInsert?: boolean }) {
  const inserts: ProductRatingRow[] = [];
  const client = {
    from(table: string) {
      assertEqual(table, PRODUCT_RATINGS_TABLE, "table");
      return {
        async insert(row: ProductRatingRow) {
          if (opts?.throwOnInsert) throw new Error("network down");
          inserts.push(row);
          return { error: opts?.failWith ? { message: opts.failWith } : null };
        },
      };
    },
  };
  return { client, inserts };
}

it("PRODUCT_RATING_WEIGHT は承認済み確定値 2", () => {
  assertEqual(PRODUCT_RATING_WEIGHT, 2, "weight=2");
});

it("isValidRatingInput: 正当な入力を通す", () => {
  assertTrue(
    isValidRatingInput({ userRef: "U1", productNo: "40101", rating: 1, source: "tea_card" }),
    "valid",
  );
});

it("isValidRatingInput: 不正を弾く（rating/番号/source）", () => {
  assertFalse(isValidRatingInput({ userRef: "U1", productNo: "40101", rating: 0 as 1, source: "tea_card" }), "rating 0");
  assertFalse(isValidRatingInput({ userRef: "U1", productNo: "4010", rating: 1, source: "tea_card" }), "4桁");
  assertFalse(isValidRatingInput({ userRef: "", productNo: "40101", rating: 1, source: "tea_card" }), "空 user");
  // @ts-expect-error 不正 source
  assertFalse(isValidRatingInput({ userRef: "U1", productNo: "40101", rating: 1, source: "other" }), "不正 source");
});

it("buildProductRatingRow: channel 既定 line で正規化", () => {
  const row = buildProductRatingRow({ userRef: "U1", productNo: "40101", rating: -1, source: "tea_card" });
  assertEqual(row.channel, "line", "channel 既定");
  assertEqual(row.rating, -1, "rating");
  assertEqual(row.product_no, "40101", "product_no");
});

it("ratingPersonaSignals: rating=1 はタグを persona に変換（TAG_PERSONA_MAP 流用）", () => {
  const sig = ratingPersonaSignals(1, ["hojicha"]);
  assertEqual(sig.join(","), "serenity", "hojicha→serenity");
  const sig2 = ratingPersonaSignals(1, ["oolong", "flavored"]);
  assertTrue(sig2.includes("explorer") && sig2.includes("sensory"), "explorer+sensory");
});

it("ratingPersonaSignals: rating=-1 は空（減点も加点もしない）", () => {
  assertEqual(ratingPersonaSignals(-1, ["hojicha"]).length, 0, "-1 は空");
});

it("recordProductRating: 正常時に 1 行 insert（追記）", async () => {
  const { client, inserts } = makeFakeSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await recordProductRating(client as any, { userRef: "U1", productNo: "40101", rating: 1, source: "tea_card" });
  assertTrue(r.ok, "ok");
  assertEqual(inserts.length, 1, "1 行");
});

it("recordProductRating: 無効入力は記録せず ok=false（例外なし）", async () => {
  const { client, inserts } = makeFakeSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await recordProductRating(client as any, { userRef: "U1", productNo: "999", rating: 1, source: "tea_card" });
  assertFalse(r.ok, "ok=false");
  assertEqual(inserts.length, 0, "記録なし");
});

it("recordProductRating: insert 失敗/例外でも throw しない（fail-safe）", async () => {
  const fail = makeFakeSupabase({ failWith: "relation does not exist" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r1 = await recordProductRating(fail.client as any, { userRef: "U1", productNo: "40101", rating: 1, source: "tea_card" });
  assertFalse(r1.ok, "insert error → ok=false");
  const thr = makeFakeSupabase({ throwOnInsert: true });
  let threw = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await recordProductRating(thr.client as any, { userRef: "U1", productNo: "40101", rating: 1, source: "tea_card" });
  } catch {
    threw = true;
  }
  assertTrue(!threw, "例外を握りつぶす");
});

(async () => {
  for (const t of queue) {
    total++;
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failures.push(`${t.name}`);
      console.log(`  [FAIL] ${t.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("\n============================================================");
  console.log("product-ratings Test Results");
  console.log("============================================================");
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${total - passed}`);
  if (failures.length > 0) process.exit(1);
})();
