/**
 * Unit — 顧客プロファイル 第1段 ② ③ ④ を DB 抜きで固定する
 *
 * ここで固定するのは 4 つ:
 *   ② 味の 3 軸の語彙が、TS 側と migration 051 の SQL で **1 文字も違わない**こと
 *   ③ 出所タグの採用順（declared > observed > inferred / 同順位は新しいほう）
 *   ④ 30 銘柄の渋み採点と、既存 2 軸 → 3 軸で分離度がどれだけ上がるか
 *   ①⑤ 新しい出来事の payload の形（5 段階 / 旧 ±1 / 場面 / 軸の申告）
 *
 * 畳み方そのもの（L1 に何が入るか）は tests/db/*.db.test.ts が実 DB で見る。
 * ここは「実 DB を用意しなくても壊れたら分かる」層。
 *
 * ⚠ ④ の数字をここに直書きしている理由: 設計 §7 択一 #3 の確定
 *   （「シミュレーションしてから決める」→ 既存 2 軸 + 渋みの 3 軸）は、この数字を
 *   根拠にした判断である。数字が変わったら判断の前提が変わるので、黙って変わらせない。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TASTE_AXES,
  TASTE_AXIS_POLES,
  TASTE_AXIS_LABELS,
  PROVENANCE_KINDS,
  PROVENANCE_RANK,
  preferProvenance,
  isTasteAxis,
  isTastePole,
  isTasteScore,
  ASTRINGENCY_INPUTS,
  EXISTING_AXES,
  scoreAllAstringency,
  astringencyBand,
  separationByTwoAxes,
  separationByThreeAxes,
  astringencyVsBody,
} from "../../src/lib/cdp/taste-axes";
import {
  PROFILE_EVENT_TYPES,
  KNOWN_EVENT_TYPES,
  PURCHASE_SCENES,
  RATING_ASPECTS,
  isProfileEventType,
  isWellFormedPayload,
} from "../../src/lib/cdp/event-vocabulary";

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
function assertDeep(a: unknown, b: unknown, label: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

// パスの起点は cwd（他の unit テストと同じ作法。npm script はリポジトリ直下で走る）。
const MIGRATION_051 = readFileSync(
  join(process.cwd(), "src/db/migrations/051_cdp_stage1_taste_scene_provenance.sql"),
  "utf8",
);

console.log("\n=== ② 味の 3 軸の語彙（TS と SQL がずれていない） ===");

it("軸は 3 本。渋みが 1 本目（設計 §7 #3 の確定 = 既存 2 軸 + 渋み）", () => {
  assertDeep([...TASTE_AXES], ["astringency", "body", "aroma"], "TASTE_AXES");
});

it("migration 051 の cdp_taste_axes が TS と同じ並び", () => {
  // SQL 側: ARRAY['astringency', 'body', 'aroma']::text[]
  const m = /cdp_taste_axes\(\)[\s\S]*?ARRAY\[([^\]]*)\]/.exec(MIGRATION_051);
  assertTrue(m !== null, "cdp_taste_axes の ARRAY を SQL から読めない");
  const sqlAxes = m![1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .filter((s) => s.length > 0);
  assertDeep(sqlAxes, [...TASTE_AXES], "SQL 側の軸の並び");
});

it("migration 051 の cdp_taste_poles が TS と同じ極", () => {
  for (const axis of TASTE_AXES) {
    const poles = TASTE_AXIS_POLES[axis];
    for (const pole of poles) {
      assertTrue(
        MIGRATION_051.includes(`'${pole}'`),
        `SQL に極 '${pole}'（軸 ${axis}）が無い`,
      );
    }
  }
});

it("極の語彙は各軸 2 つで、軸をまたいで重複しない", () => {
  const all: string[] = [];
  for (const axis of TASTE_AXES) {
    assertEqual(TASTE_AXIS_POLES[axis].length, 2, `${axis} の極の数`);
    all.push(...TASTE_AXIS_POLES[axis]);
  }
  assertEqual(new Set(all).size, all.length, "極の名前が軸をまたいで重複している");
});

it("お客さんに見せる言葉に「良い / 悪い」の語が入っていない（設計 §3）", () => {
  const banned = ["良い", "悪い", "おいしい", "まずい", "上手", "下手"];
  for (const axis of TASTE_AXES) {
    const l = TASTE_AXIS_LABELS[axis];
    for (const word of banned) {
      assertTrue(
        !`${l.axis}${l.low}${l.high}`.includes(word),
        `${axis} のラベルに評価語 '${word}' が入っている`,
      );
    }
  }
});

it("目盛りは 1-5 の整数だけ（Notion の既存 2 軸と同じ形）", () => {
  assertTrue(isTasteScore(1) && isTasteScore(5), "1 と 5 は有効");
  assertTrue(!isTasteScore(0) && !isTasteScore(6), "0 と 6 は無効");
  assertTrue(!isTasteScore(3.5), "小数は無効");
});

it("軸・極の判定が語彙外を拒む", () => {
  assertTrue(isTasteAxis("astringency"), "astringency は軸");
  assertTrue(!isTasteAxis("sweetness"), "sweetness は軸ではない");
  assertTrue(isTastePole("astringency", "firm"), "astringency/firm は有効");
  assertTrue(!isTastePole("astringency", "full"), "軸をまたいだ極は無効");
});

console.log("\n=== ③ 出所タグ（設計 §4 R3 の採用順） ===");

it("出所は 3 種で、declared > observed > inferred の順", () => {
  assertDeep([...PROVENANCE_KINDS], ["declared", "observed", "inferred"], "PROVENANCE_KINDS");
  assertTrue(
    PROVENANCE_RANK.declared > PROVENANCE_RANK.observed &&
      PROVENANCE_RANK.observed > PROVENANCE_RANK.inferred,
    "採用順",
  );
});

it("強いほうが勝つ（新しくても推定は本人の言葉に勝てない）", () => {
  const declaredOld = { kind: "declared" as const, at: "2026-01-01T00:00:00Z" };
  const inferredNew = { kind: "inferred" as const, at: "2026-09-01T00:00:00Z" };
  assertDeep(preferProvenance(declaredOld, inferredNew), declaredOld, "古い declared が勝つ");
  assertDeep(preferProvenance(inferredNew, declaredOld), declaredOld, "順序を変えても同じ");
});

it("同じ強さなら新しいほうが勝つ", () => {
  const a = { kind: "observed" as const, at: "2026-01-01T00:00:00Z" };
  const b = { kind: "observed" as const, at: "2026-09-01T00:00:00Z" };
  assertDeep(preferProvenance(a, b), b, "新しいほう");
});

it("migration 051 の cdp_provenance_rank が TS と同じ点数", () => {
  for (const kind of PROVENANCE_KINDS) {
    assertTrue(
      new RegExp(`WHEN '${kind}' THEN ${PROVENANCE_RANK[kind]}`).test(MIGRATION_051),
      `SQL の ${kind} の点が TS（${PROVENANCE_RANK[kind]}）と違う`,
    );
  }
});

console.log("\n=== ④ 30 銘柄の渋み採点と分離度シミュレーション ===");

it("母集団は販売中 30 銘柄（Notion Tea Menu List / 2026-09-01 実測）", () => {
  assertEqual(ASTRINGENCY_INPUTS.length, 30, "採点の母集団");
  assertEqual(EXISTING_AXES.length, 30, "既存 2 軸の母集団");
});

it("2 つの表が同じ 30 銘柄を指している（片方だけ増えない）", () => {
  const a = ASTRINGENCY_INPUTS.map((t) => t.productNo).sort();
  const b = EXISTING_AXES.map((t) => t.productNo).sort();
  assertDeep(a, b, "銘柄番号の集合");
  assertEqual(new Set(a).size, 30, "銘柄番号が重複していない");
});

it("既存 2 軸の分布が Phase 0 監査（2026-07-17）と一致する", () => {
  // docs/personalization-phase0-inventory.md: aroma rich 22 / dry 8、body light 18 / full 12。
  // 独立に取った 2 回の実測が一致することを、ここで機械に留める。
  const rich = EXISTING_AXES.filter((t) => t.aroma === "rich").length;
  const light = EXISTING_AXES.filter((t) => t.body === "light").length;
  assertEqual(rich, 22, "aroma=rich の件数");
  assertEqual(EXISTING_AXES.length - rich, 8, "aroma=dry の件数");
  assertEqual(light, 18, "body=light の件数");
  assertEqual(EXISTING_AXES.length - light, 12, "body=full の件数");
});

it("採点はすべて 1-5 に収まり、出所は例外なく inferred（試飲していない）", () => {
  for (const t of scoreAllAstringency()) {
    assertTrue(isTasteScore(t.score), `${t.productNo} の点が目盛りの外: ${t.score}`);
    assertEqual(t.basis, "inferred", `${t.productNo} の出所`);
  }
});

it("採点は決定的（同じ入力なら何度計算しても同じ）", () => {
  assertDeep(scoreAllAstringency(), scoreAllAstringency(), "2 回の採点");
});

it("いまの 2 軸では 4 セルにしか分かれない（最大 11 件・平均 7.5 件）", () => {
  const r = separationByTwoAxes();
  assertEqual(r.population, 30, "母集団");
  assertEqual(r.cellsPossible, 4, "あり得るセル");
  assertEqual(r.cellsOccupied, 4, "埋まったセル");
  assertEqual(r.largestCell, 11, "いちばん混んでいるセル");
  assertDeep(
    r.cells,
    { "dry/full": 1, "dry/light": 7, "rich/full": 11, "rich/light": 11 },
    "セルごとの件数",
  );
});

it("渋みを足すと 10 セルに分かれ、最大セルが 11 → 8 に下がる", () => {
  const r = separationByThreeAxes();
  assertEqual(r.population, 30, "母集団");
  assertEqual(r.cellsPossible, 12, "あり得るセル");
  assertEqual(r.cellsOccupied, 10, "埋まったセル");
  assertEqual(r.largestCell, 8, "いちばん混んでいるセル");
});

it("渋みは味わい(body)の言い換えではない（両極が 3 段すべてを持つ）", () => {
  // 言い換えなら、body の片方の極に渋みの 1 段だけが集まる。
  const x = astringencyVsBody();
  for (const body of ["full", "light"] as const) {
    for (const band of ["soft", "mid", "firm"] as const) {
      assertTrue(
        x[body][band] > 0,
        `body=${body} に渋み ${band} が 1 件も無い（= 渋みが body の言い換えになっている）`,
      );
    }
  }
});

it("渋みの採点に既存 2 軸を入力として使っていない（独立性の担保）", () => {
  // 入力の型に aroma / body / flavorProfile が無いこと。あれば渋みは既存軸の関数になる。
  const keys = Object.keys(ASTRINGENCY_INPUTS[0]).sort();
  assertDeep(
    keys,
    ["category", "cultivar", "detailTags", "harvest", "name", "preparation", "productNo"],
    "採点の入力",
  );
});

it("band の境目（2 は soft / 3 は mid / 4 は firm）", () => {
  assertEqual(astringencyBand(1), "soft", "1");
  assertEqual(astringencyBand(2), "soft", "2");
  assertEqual(astringencyBand(3), "mid", "3");
  assertEqual(astringencyBand(4), "firm", "4");
  assertEqual(astringencyBand(5), "firm", "5");
});

console.log("\n=== ①⑤ 新しい出来事の語彙と payload の形 ===");

it("3 つの出来事が登録簿にあり、L1 を動かす側に入っている", () => {
  for (const t of ["rating.submitted", "taste.declared", "purchase.recipient_declared"]) {
    assertTrue(KNOWN_EVENT_TYPES.has(t), `${t} が登録簿に無い`);
    assertTrue(isProfileEventType(t), `${t} が L1 を動かす側に入っていない`);
  }
});

it("rating.submitted は 5 段階を受ける（設計 §7 #4 の確定 = (c)）", () => {
  assertTrue(
    isWellFormedPayload("rating.submitted", { product_no: "10101", score: 5 }),
    "score=5",
  );
  assertTrue(
    isWellFormedPayload("rating.submitted", { product_no: "10101", score: 1 }),
    "score=1",
  );
  assertTrue(
    !isWellFormedPayload("rating.submitted", { product_no: "10101", score: 0 }),
    "score=0 は目盛りの外",
  );
  assertTrue(
    !isWellFormedPayload("rating.submitted", { product_no: "10101", score: 6 }),
    "score=6 は目盛りの外",
  );
  assertTrue(
    !isWellFormedPayload("rating.submitted", { product_no: "10101", score: 3.5 }),
    "小数は受けない",
  );
});

it("旧来の ±1 タップも読める形として残る（動いている経路を落とさない）", () => {
  // src/lib/product-ratings.ts の recordProductRating が積んでいる形そのもの。
  assertTrue(
    isWellFormedPayload("rating.submitted", {
      product_no: "10101",
      rating: 1,
      rating_source: "tea_card",
    }),
    "rating=+1",
  );
  assertTrue(
    isWellFormedPayload("rating.submitted", {
      product_no: "10101",
      rating: -1,
      rating_source: "tea_card",
    }),
    "rating=-1",
  );
  assertTrue(
    !isWellFormedPayload("rating.submitted", { product_no: "10101", rating: 0 }),
    "rating=0 は語彙に無い",
  );
});

it("銘柄番号が無い・形が違う評価は読めない形として印が付く", () => {
  assertTrue(!isWellFormedPayload("rating.submitted", { score: 4 }), "product_no 無し");
  assertTrue(
    !isWellFormedPayload("rating.submitted", { product_no: "101", score: 4 }),
    "5 桁でない",
  );
  assertTrue(
    !isWellFormedPayload("rating.submitted", { product_no: "10101" }),
    "score も rating も無い",
  );
});

it("任意の項目は、あるなら語彙どおりでなければならない", () => {
  for (const aspect of RATING_ASPECTS) {
    assertTrue(
      isWellFormedPayload("rating.submitted", { product_no: "10101", score: 2, aspect }),
      `aspect=${aspect}`,
    );
  }
  assertTrue(
    !isWellFormedPayload("rating.submitted", {
      product_no: "10101",
      score: 2,
      aspect: "price",
    }),
    "語彙に無い aspect",
  );
  assertTrue(
    !isWellFormedPayload("rating.submitted", {
      product_no: "10101",
      score: 2,
      delivery_ref: "",
    }),
    "空の delivery_ref",
  );
});

it("taste.declared は軸と極が語彙どおりのときだけ読める", () => {
  assertTrue(
    isWellFormedPayload("taste.declared", { axis: "astringency", pole: "firm" }),
    "astringency/firm",
  );
  assertTrue(
    !isWellFormedPayload("taste.declared", { axis: "astringency", pole: "full" }),
    "軸をまたいだ極",
  );
  assertTrue(
    !isWellFormedPayload("taste.declared", { axis: "sweetness", pole: "firm" }),
    "語彙に無い軸",
  );
});

it("purchase.recipient_declared は self / gift の 2 値だけ", () => {
  assertDeep([...PURCHASE_SCENES], ["self", "gift"], "PURCHASE_SCENES");
  for (const scene of PURCHASE_SCENES) {
    assertTrue(isWellFormedPayload("purchase.recipient_declared", { scene }), scene);
  }
  assertTrue(
    !isWellFormedPayload("purchase.recipient_declared", { scene: "both" }),
    "語彙に無い場面",
  );
});

it("L1 を動かす出来事の一覧に、第1段の 3 つが漏れなく入っている", () => {
  const added = ["rating.submitted", "taste.declared", "purchase.recipient_declared"];
  for (const t of added) {
    assertTrue(
      (PROFILE_EVENT_TYPES as readonly string[]).includes(t),
      `${t} が PROFILE_EVENT_TYPES に無い`,
    );
    // 畳み手（SQL）にも枝があること。片方だけ足すと、口はあるのに畳まれない。
    assertTrue(MIGRATION_051.includes(`WHEN '${t}' THEN`), `migration 051 に ${t} の枝が無い`);
  }
});

it("migration 051 が L1 の 3 列を検算の対象に入れている", () => {
  // 比較対象に入れ忘れると、その列だけ黙って検算の外に出る。
  const parity = MIGRATION_051.slice(MIGRATION_051.indexOf("cdp_l1_recompute_parity"));
  for (const col of ["taste", "scene", "provenance"]) {
    assertTrue(
      new RegExp(`'${col}',\\s*\\n?\\s*r\\.${col}`).test(parity),
      `検算の比較対象に ${col} が無い`,
    );
  }
});

console.log(`\n=== cdp-taste-axes.test: ${passed}/${total} passed, ${failures.length} failed ===`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
