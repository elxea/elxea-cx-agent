/**
 * Unit Tests -- migrate.ts baseline 判定ロジック
 *
 * 本番非可逆の中核（既存 DB を schema_migrations 台帳へ取り込む baseline 判定）を、DB 非接続で検証する。
 * カバー:
 *   - version パース（versionNumber / versionOf / specKey）
 *   - detectVersion（applied / absent / partial / no-sentinel）
 *   - computeBaselinePlan の **非連続適用集合**ハンドリング（high-water-mark を使っていないこと）
 *   - versionsToRegister（register 対象のみ抽出・partial/absent/no-sentinel は登録しない）
 *
 * 使用方法:
 *   npx tsx tests/unit/migrate.test.ts
 */

import {
  versionOf,
  versionNumber,
  specKey,
  detectVersion,
  computeBaselinePlan,
  versionsToRegister,
  listMigrationFiles,
  INTROSPECTION,
  type ObjectSpec,
} from "../../scripts/migrate";

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];

function it(testName: string, fn: () => void) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  [PASS] ${testName}`);
  } catch (err) {
    failedTests++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${testName}: ${msg}`);
    failures.push({ name: testName, error: msg });
  }
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(`${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(cond: boolean, label = "") {
  if (!cond) throw new Error(label || "assertion failed");
}
function assertArrayEqual(actual: string[], expected: string[], label = "") {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (a.length !== e.length || a.some((x, i) => x !== e[i])) {
    throw new Error(`${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** existsMap を specKey 群から組む小ヘルパ。 */
function mapOf(...presentKeys: string[]): Map<string, boolean> {
  return new Map(presentKeys.map((k) => [k, true]));
}
/** version 群の全 sentinel が実在する existsMap を作る。 */
function existsForVersions(versions: string[]): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const v of versions) for (const s of INTROSPECTION[v]?.specs ?? []) m.set(specKey(s), true);
  return m;
}

// ---------------------------------------------------------------------------

console.log("\n--- versionOf / versionNumber ---");

it("versionOf は .sql を除く", () => {
  assertEqual(versionOf("026_customer_linkage_source.sql"), "026_customer_linkage_source");
  assertEqual(versionOf("000_schema_migrations.sql"), "000_schema_migrations");
});

it("versionNumber は先頭数字を number 化", () => {
  assertEqual(versionNumber("000_schema_migrations"), 0);
  assertEqual(versionNumber("001_fix_vector_dimension"), 1);
  assertEqual(versionNumber("029_marche_activation_log"), 29);
});

it("versionNumber は数字先頭でないと NaN", () => {
  assert(Number.isNaN(versionNumber("foo_bar")), "non-numeric prefix should be NaN");
});

console.log("\n--- specKey ---");

it("specKey は kind ごとに一意キーを作る", () => {
  assertEqual(specKey({ kind: "table", table: "flow_events" }), "table:public.flow_events");
  assertEqual(specKey({ kind: "column", table: "sync_logs", column: "sync_type" }), "column:public.sync_logs.sync_type");
  assertEqual(specKey({ kind: "index", index: "knowledge_chunks_embedding_idx" }), "index:public.knowledge_chunks_embedding_idx");
  assertEqual(specKey({ kind: "function", func: "search_knowledge_hybrid" }), "function:public.search_knowledge_hybrid");
  assertEqual(specKey({ kind: "rls", table: "knowledge_chunks" }), "rls:public.knowledge_chunks");
});

console.log("\n--- detectVersion ---");

it("全 sentinel 実在 → applied", () => {
  const specs: ObjectSpec[] = [
    { kind: "table", table: "user_identity_map" },
    { kind: "column", table: "conversations", column: "channel" },
  ];
  const m = mapOf("table:public.user_identity_map", "column:public.conversations.channel");
  assertEqual(detectVersion(specs, m), "applied");
});

it("全 sentinel 不在 → absent", () => {
  const specs: ObjectSpec[] = [{ kind: "table", table: "flow_events" }];
  assertEqual(detectVersion(specs, new Map()), "absent");
});

it("一部だけ実在 → partial（要手動確認）", () => {
  const specs: ObjectSpec[] = [
    { kind: "table", table: "user_identity_map" },
    { kind: "column", table: "conversations", column: "channel" },
  ];
  const m = mapOf("table:public.user_identity_map"); // 片方だけ
  assertEqual(detectVersion(specs, m), "partial");
});

it("specs 空 → no-sentinel", () => {
  assertEqual(detectVersion([], new Map()), "no-sentinel");
});

it("012 / 027 は no-sentinel（冪等・正の sentinel 無し）", () => {
  assertEqual(INTROSPECTION["012_fix_hybrid_search"].specs.length, 0);
  assertEqual(INTROSPECTION["027_customer_linkage_cardinality"].specs.length, 0);
});

console.log("\n--- computeBaselinePlan: 非連続適用集合（high-water-mark ではない）---");

// 実運用の非連続集合を再現: ad-hoc runner が 016 単独 / 018 / 021-023 / 026・029・027・028 を別時期に適用。
// これらの sentinel だけ実在し、間の 017・019・020 等は不在、という「歯抜け」を組む。
const APPLIED_SUBSET = [
  "016_regression_tests",
  "018_recovery_missing_tables",
  "021_flow_events",
  "022_product_ratings",
  "023_line_message_ledger_aggregation_unit",
  "026_customer_linkage_source",
  "028_account_link_nonces",
  "029_marche_activation_log",
];
// 注: 018 の sentinel（customer_linkages / sync_logs / pending_follow_refs / sync_logs.sync_type）が実在すると
// 002・004・014 の sentinel も実在扱いになる（同一オブジェクトを作る migration のため）。これは意図どおり
// （オブジェクトが実在する = その version の効果が DB 上に在る = applied 判定が正しい）。

it("非連続集合を version ごとに独立判定する（間の 017 を applied にしない）", () => {
  const allVersions = Object.keys(INTROSPECTION);
  const existsMap = existsForVersions(APPLIED_SUBSET);
  const plan = computeBaselinePlan(allVersions, new Set(), existsMap);
  const byV = new Map(plan.map((d) => [d.version, d]));

  // 適用サブセットは applied → register
  for (const v of APPLIED_SUBSET) {
    assertEqual(byV.get(v)!.detected, "applied", `${v} detected`);
    assertEqual(byV.get(v)!.action, "register", `${v} action`);
  }
  // 016 は applied だが 017 は sentinel 不在 → absent（high-water-mark なら 016<=x を全部埋めてしまう）
  assertEqual(byV.get("017_enable_rls")!.detected, "absent", "017 must NOT be inferred from 016");
  assertEqual(byV.get("017_enable_rls")!.action, "leave-absent", "017 action");
  // 019 / 020 も不在（021-023 が applied でも間を埋めない）
  assertEqual(byV.get("019_line_message_ledger")!.detected, "absent", "019");
  assertEqual(byV.get("020_line_delivery_optout")!.detected, "absent", "020");
  // 025 も不在
  assertEqual(byV.get("025_dormant_reengagement_log")!.detected, "absent", "025");
});

it("012/027(no-sentinel) は leave-idempotent（登録しない・--apply が冪等再適用）", () => {
  const plan = computeBaselinePlan(["012_fix_hybrid_search", "027_customer_linkage_cardinality"], new Set(), new Map());
  assertEqual(plan[0].action, "leave-idempotent");
  assertEqual(plan[1].action, "leave-idempotent");
});

it("既登録 version は skip-registered（再登録しない）", () => {
  const existsMap = existsForVersions(["021_flow_events"]);
  const plan = computeBaselinePlan(["021_flow_events"], new Set(["021_flow_events"]), existsMap);
  assertEqual(plan[0].detected, "applied");
  assertEqual(plan[0].action, "skip-registered");
});

it("partial は登録しない（leave-partial）", () => {
  // 006 の sentinel を片方だけ実在させる
  const existsMap = mapOf("table:public.user_identity_map"); // conversations.channel は不在
  const plan = computeBaselinePlan(["006_channel_adapter"], new Set(), existsMap);
  assertEqual(plan[0].detected, "partial");
  assertEqual(plan[0].action, "leave-partial");
});

console.log("\n--- versionsToRegister ---");

// 018（recovery）が走った DB では 002/004/014 の物理オブジェクト（テーブル・index・カラム）も
// 実在する（018 が IF NOT EXISTS で作り直すため）。物理的に忠実な existsMap を組むために、
// これら「オブジェクトを共有する version」も実在集合に含める。→ これらも applied=register になるのが正。
const APPLIED_PHYSICAL = [
  ...APPLIED_SUBSET,
  "002_customer_linkage_table",
  "004_unanswered_queries",
  "014_pending_follow_refs",
];

it("register だけを抽出（partial/absent/no-sentinel/skip は除外）", () => {
  const allVersions = Object.keys(INTROSPECTION);
  const existsMap = existsForVersions(APPLIED_PHYSICAL);
  const plan = computeBaselinePlan(allVersions, new Set(), existsMap);
  const toReg = versionsToRegister(plan);
  // 実在集合はすべて register される
  for (const v of APPLIED_PHYSICAL) assert(toReg.includes(v), `${v} should be registered`);
  // 017/019/020/025 は含まれない（歯抜けを埋めない = high-water-mark ではない）
  for (const v of ["017_enable_rls", "019_line_message_ledger", "020_line_delivery_optout", "025_dormant_reengagement_log"]) {
    assert(!toReg.includes(v), `${v} should NOT be registered`);
  }
  // no-sentinel の 012/027 は含まれない
  for (const v of ["012_fix_hybrid_search", "027_customer_linkage_cardinality"]) {
    assert(!toReg.includes(v), `${v} (no-sentinel) should NOT be registered`);
  }
});

it("空 DB（何も実在しない）では register 0 件（no-sentinel/absent のみ）", () => {
  const allVersions = Object.keys(INTROSPECTION);
  const plan = computeBaselinePlan(allVersions, new Set(), new Map());
  assertArrayEqual(versionsToRegister(plan), [], "empty DB → nothing to register");
});

console.log("\n--- INTROSPECTION の網羅性（実ファイルと突合）---");

it("全 migration ファイルが INTROSPECTION に定義されている", () => {
  // listMigrationFiles は実ディレクトリを読む（純粋な fs read・DB 非接続）。
  const versions = listMigrationFiles().map(versionOf);
  const missing = versions.filter((v) => !(v in INTROSPECTION));
  assertEqual(missing.length, 0, `INTROSPECTION 未定義: ${missing.join(", ")}`);
});

it("INTROSPECTION に実在しない version を定義していない", () => {
  const versions = new Set(listMigrationFiles().map(versionOf));
  const extra = Object.keys(INTROSPECTION).filter((v) => !versions.has(v));
  assertEqual(extra.length, 0, `INTROSPECTION 余剰: ${extra.join(", ")}`);
});

// ---------------------------------------------------------------------------

console.log(`\n=== migrate.test: ${passedTests}/${totalTests} passed, ${failedTests} failed ===`);
if (failedTests > 0) {
  for (const f of failures) console.log(`  FAIL: ${f.name} — ${f.error}`);
  process.exit(1);
}
