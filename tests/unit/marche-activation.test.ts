/**
 * Unit Tests — マルシェ入口「番号未送信」活性化ナッジ（spec drift #1）の純粋関数。
 *
 * 外部依存なし（Supabase / Firestore / LINE には触れない）。判定ロジックだけを機械検証する。
 * 検証範囲:
 *   - isMarcheSource（入口の完全一致判定）
 *   - isPastActivationThreshold（下限しきい値・境界・未来・material 無しの fail-safe）
 *   - isWithinActivationWindow（上限窓・境界・material 無し）
 *   - selectActivationCandidates（source/card/dedup/閾値/窓 の合成フィルタ・createdAt 昇順・cap）
 *   - marcheActivationAggregationUnit（LINE unit 命名規約・半角英数字/_・30字以内）
 *
 * 使用: npx tsx tests/unit/marche-activation.test.ts
 */

import {
  isMarcheSource,
  isPastActivationThreshold,
  isWithinActivationWindow,
  selectActivationCandidates,
  parsePositiveInt,
  marcheActivationAggregationUnit,
  parseCreatedAt,
  DAY_MS,
  type MarcheUser,
} from "../../src/lib/marche-activation";
import { isValidAggregationUnit } from "../../src/lib/aggregation-unit";

let total = 0;
let passed = 0;
const failures: string[] = [];
function it(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${name}: ${msg}`);
    failures.push(`${name}: ${msg}`);
  }
}
function assertEqual<T>(a: T, e: T, label = "") {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertTrue(v: boolean, label = "") {
  if (!v) throw new Error(`${label}: expected true`);
}
function assertArrayEqual(a: string[], e: string[], label = "") {
  if (a.length !== e.length || a.some((x, i) => x !== e[i])) {
    throw new Error(`${label}: expected [${e.join(",")}], got [${a.join(",")}]`);
  }
}

const NOW = new Date("2026-07-19T00:00:00Z");
const daysAgo = (d: number): string => new Date(NOW.getTime() - d * DAY_MS).toISOString();
const mUser = (id: string, createdDaysAgo: number, source = "marche"): MarcheUser => ({
  lineUserId: id,
  createdAt: daysAgo(createdDaysAgo),
  source,
});

// --- isMarcheSource ---------------------------------------------------------

it("isMarcheSource: marche のみ true・他入口/欠落は false", () => {
  assertEqual(isMarcheSource("marche"), true, "marche");
  assertEqual(isMarcheSource("online"), false, "online");
  assertEqual(isMarcheSource("other"), false, "other");
  assertEqual(isMarcheSource("pkg_sencha"), false, "pkg_*");
  assertEqual(isMarcheSource(null), false, "null");
  assertEqual(isMarcheSource(undefined), false, "undefined");
});

// --- isPastActivationThreshold（下限）---------------------------------------

it("isPastActivationThreshold: 閾値超過 true / 未満 false / 境界 true(>=) / 未来 false / material 無し false", () => {
  assertEqual(isPastActivationThreshold(parseCreatedAt(daysAgo(2)), NOW, 1), true, "2日前>1日");
  assertEqual(isPastActivationThreshold(parseCreatedAt(daysAgo(0.5)), NOW, 1), false, "12h前<1日");
  assertEqual(isPastActivationThreshold(parseCreatedAt(daysAgo(1)), NOW, 1), true, "ちょうど1日(>=)");
  // 未来日時（時計ズレ）→ false。
  assertEqual(
    isPastActivationThreshold(new Date(NOW.getTime() + DAY_MS), NOW, 1),
    false,
    "未来",
  );
  // material 無し（createdAt 欠落・不正）→ false（送らない・fail-safe）。
  assertEqual(isPastActivationThreshold(null, NOW, 1), false, "null");
  assertEqual(isPastActivationThreshold(parseCreatedAt("not-a-date"), NOW, 1), false, "不正日付");
});

// --- isWithinActivationWindow（上限）---------------------------------------

it("isWithinActivationWindow: 窓内 true / 窓外 false / 境界 true(<=) / material 無し false", () => {
  assertEqual(isWithinActivationWindow(parseCreatedAt(daysAgo(10)), NOW, 14), true, "10日前<14日");
  assertEqual(isWithinActivationWindow(parseCreatedAt(daysAgo(15)), NOW, 14), false, "15日前>14日");
  assertEqual(isWithinActivationWindow(parseCreatedAt(daysAgo(14)), NOW, 14), true, "ちょうど14日(<=)");
  assertEqual(isWithinActivationWindow(null, NOW, 14), false, "null");
});

// --- selectActivationCandidates（合成フィルタ）------------------------------

it("selectActivationCandidates: source=marche・card 未到達・未 dedup・閾値内窓内のみ残す", () => {
  const target = mUser("Ua", 3);
  const online = mUser("Ub", 3, "online"); // 別入口 → 除外
  const carded = mUser("Uc", 3); // カード到達 → 除外
  const nudged = mUser("Ud", 3); // 既ナッジ → 除外
  const fresh = mUser("Ue", 0.5); // 閾値未満 → 除外
  const stale = mUser("Uf", 20); // 窓外 → 除外
  const users = [target, online, carded, nudged, fresh, stale];

  const got = selectActivationCandidates(
    users,
    new Set(["Uc"]), // usersWithCard
    new Set(["Ud"]), // alreadyNudged
    NOW,
    1,
    14,
    20,
  );
  assertArrayEqual(got.map((x) => x.lineUserId), ["Ua"], "対象は Ua のみ");
});

it("selectActivationCandidates: createdAt 昇順（古い順）で並び、cap で先頭から切る", () => {
  const users = [mUser("Uold", 10), mUser("Umid", 5), mUser("Unew", 2)];
  const all = selectActivationCandidates(users, new Set(), new Set(), NOW, 1, 14, 20);
  assertArrayEqual(all.map((x) => x.lineUserId), ["Uold", "Umid", "Unew"], "古い順");

  const capped = selectActivationCandidates(users, new Set(), new Set(), NOW, 1, 14, 2);
  assertArrayEqual(capped.map((x) => x.lineUserId), ["Uold", "Umid"], "cap=2 で先頭 2 件");
});

it("selectActivationCandidates: 空 lineUserId / createdAt 欠落は落とす（fail-safe）", () => {
  const users: MarcheUser[] = [
    { lineUserId: "", createdAt: daysAgo(3), source: "marche" },
    { lineUserId: "Uz", createdAt: null, source: "marche" },
  ];
  const got = selectActivationCandidates(users, new Set(), new Set(), NOW, 1, 14, 20);
  assertEqual(got.length, 0, "空 id / createdAt 欠落は候補にしない");
});

// --- parsePositiveInt -------------------------------------------------------

it("parsePositiveInt: 正整数のみ採用・不正/0/負/空は fallback", () => {
  assertEqual(parsePositiveInt("3", 1), 3, "正整数");
  assertEqual(parsePositiveInt("0", 1), 1, "0 は fallback");
  assertEqual(parsePositiveInt("-2", 1), 1, "負は fallback");
  assertEqual(parsePositiveInt("abc", 7), 7, "非数は fallback");
  assertEqual(parsePositiveInt(undefined, 14), 14, "未設定は fallback");
  assertEqual(parsePositiveInt("  ", 14), 14, "空白は fallback");
});

// --- aggregation unit -------------------------------------------------------

it("marcheActivationAggregationUnit: 半角英数字/_・30字以内の LINE unit 規約を満たす", () => {
  const unit = marcheActivationAggregationUnit(NOW);
  assertTrue(unit.startsWith("d"), "d 始まり");
  assertTrue(unit.endsWith("_mact"), "_mact 終わり");
  assertTrue(isValidAggregationUnit(unit), `unit 命名規約 (${unit})`);
});

console.log(`\nmarche-activation.test: ${passed}/${total} passed`);
if (failures.length > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
