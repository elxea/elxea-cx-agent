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
  getUserRatings,
  latestRatingByProduct,
  allRatedProductNos,
  positiveRatedProductNos,
  PRODUCT_RATINGS_TABLE,
  PRODUCT_RATING_WEIGHT,
  type ProductRatingRow,
  type UserRatingRow,
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

// --- 読み取り helper（A-1 / A-2a 用）---

it("latestRatingByProduct: 追記式から銘柄ごとの最新評価を取る（後方＝新しい）", () => {
  const rows: UserRatingRow[] = [
    { product_no: "11301", rating: -1 },
    { product_no: "11301", rating: 1 }, // 再評価（新しい）→ 有効
    { product_no: "20101", rating: 1 },
    { product_no: "abc", rating: 1 }, // 5 桁でない → 無視
  ];
  const m = latestRatingByProduct(rows);
  assertEqual(m.get("11301"), 1, "最新=+1");
  assertEqual(m.get("20101"), 1, "20101");
  assertEqual(m.has("abc"), false, "非5桁除外");
});

it("allRatedProductNos: +1/-1 いずれも除外対象に含める", () => {
  const rows: UserRatingRow[] = [
    { product_no: "11301", rating: 1 },
    { product_no: "20101", rating: -1 },
  ];
  const nos = allRatedProductNos(rows).sort();
  assertEqual(nos.join(","), "11301,20101", "両方含む");
});

it("positiveRatedProductNos: +1 の銘柄だけ返す（-1 は含めない）", () => {
  const rows: UserRatingRow[] = [
    { product_no: "11301", rating: 1 },
    { product_no: "20101", rating: -1 },
    { product_no: "30101", rating: 1 },
  ];
  const nos = positiveRatedProductNos(rows).sort();
  assertEqual(nos.join(","), "11301,30101", "+1 のみ");
});

it("positiveRatedProductNos: 再評価で -1→+1 は positive に含まれる", () => {
  const rows: UserRatingRow[] = [
    { product_no: "11301", rating: -1 },
    { product_no: "11301", rating: 1 },
  ];
  assertEqual(positiveRatedProductNos(rows).join(","), "11301", "最新+1");
});

it("getUserRatings: 正常時に product_no/rating の配列を返す", async () => {
  const client = {
    from(table: string) {
      assertEqual(table, PRODUCT_RATINGS_TABLE, "table");
      return {
        select() {
          return {
            eq() {
              return {
                async order() {
                  return { data: [{ product_no: "11301", rating: 1 }], error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await getUserRatings(client as any, "U" + "a".repeat(32));
  assertEqual(rows.length, 1, "1 行");
  assertEqual(rows[0].product_no, "11301", "product_no");
  assertEqual(rows[0].rating, 1, "rating");
});

it("getUserRatings: 空 userRef / エラー時は空配列（fail-safe）", async () => {
  const emptyRef = await getUserRatings({} as never, "");
  assertEqual(emptyRef.length, 0, "空 userRef");
  const errClient = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                async order() {
                  return { data: null, error: { message: "relation does not exist" } };
                },
              };
            },
          };
        },
      };
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = await getUserRatings(errClient as any, "U" + "b".repeat(32));
  assertEqual(rows.length, 0, "error → 空");
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
