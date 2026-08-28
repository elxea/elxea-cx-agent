/**
 * Unit Tests — scripts/ops/check-ratchet.mjs（撤去の進捗を CI に固定する仕組み）
 *
 * 何を守るテストか:
 *   ratchet は「壊れても緑のまま」という壊れ方をしうる。数え方が対象を見失って
 *   0 件と数え、上限だけが残り、以後どれだけ旧経路を増やしても CI は何も言わない —
 *   これが最悪の形で、しかも普通のテストでは気づけない（緑だから）。
 *
 *   よってここで検査するのは「実際のリポジトリで OK になること」ではなく、
 *   **落ちるべきときに落ちること** の側である:
 *
 *     1. 実測 > 上限（旧経路が増えた）→ 落ちる
 *     2. 実測 < 上限（減らしたのに上限が緩んだまま）→ 落ちる   ← 両方向検査の要点
 *     3. ratchets.json に無い id が実測にある → 落ちる
 *     4. 数え方（COUNTERS）が消えて上限だけ残っている → 落ちる
 *     5. 実測 == 上限 → 通る
 *
 *   1 だけを守る ratchet は、締め直しを忘れた瞬間に「黙って増やせる枠」を残す。
 *   2 があるから、撤去が進むたびに上限を下げる作業が強制される。
 *
 * 副作用ゼロ:
 *   検査は使い捨ての temp ディレクトリに作った偽リポジトリに対して実行する。
 *   このリポジトリの ratchets.json も src/ も一切触らない。
 *
 * 使用方法:
 *   npx tsx tests/unit/check-ratchet.test.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SCRIPT = join(REPO_ROOT, "scripts", "ops", "check-ratchet.mjs");

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
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assertIncludes(haystack: string, needle: string, label = "") {
  if (!haystack.includes(needle)) {
    throw new Error(
      `${label ? label + ": " : ""}output に "${needle}" が含まれない\n--- output ---\n${haystack}`,
    );
  }
}

/**
 * 偽リポジトリを temp に組み立てる。
 *
 * COUNTERS が数えるのは実在のソースなので、5 つの counter すべてが 0 にならない
 * 最小のソースを置く（0 だと「数え方が壊れた」として落ちる仕様のため、
 * それ自体は別のテストで確かめる）。
 */
function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-fixture-"));
  mkdirSync(join(dir, "src", "lib"), { recursive: true });

  writeFileSync(
    join(dir, "src", "lib", "sample.ts"),
    [
      // identity-merge-functions = 1
      "export async function mergeLineUserIntoShopify() { return 1; }",
      // identity-ledger-tables = 1 種
      'export const q = () => db.from("customer_linkages").select("*");',
      // firestore-person-namespaces = 1 種
      "export const path = `users/line:${'x'}`;",
      // persona-writers = 1（定義元を別ファイルに置いて -1 が効くようにする）
      "import { PURCHASE_SIGNAL_WEIGHT } from './purchase-signals';",
      "export const w = PURCHASE_SIGNAL_WEIGHT;",
      // raw-identity-key-legacy = 1
      "export const row = { line_user_id: 'U0' };",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(dir, "src", "lib", "purchase-signals.ts"),
    "export const PURCHASE_SIGNAL_WEIGHT = 3;\n",
    "utf8",
  );
  return dir;
}

const EXPECTED_FIXTURE_COUNTS: Record<string, number> = {
  "identity-merge-functions": 1,
  "identity-ledger-tables": 1,
  "firestore-person-namespaces": 1,
  "persona-writers": 1,
  "raw-identity-key-legacy": 1,
};

function writeRatchets(dir: string, maxes: Record<string, number>) {
  const ratchets: Record<string, unknown> = {};
  for (const [id, max] of Object.entries(maxes)) {
    ratchets[id] = { max, source: "fixture", why: "fixture" };
  }
  writeFileSync(
    join(dir, "ratchets.json"),
    JSON.stringify({ $comment: ["fixture"], ratchets }, null, 2),
    "utf8",
  );
}

function run(dir: string, args: string[] = ["--check"]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

console.log("check-ratchet.mjs unit tests\n");

it("--update は実測値を書き、その直後の --check は通る", () => {
  const dir = makeFixture();
  try {
    const upd = run(dir, ["--update"]);
    assertEqual(upd.status, 0, "--update の exit code");

    const written = JSON.parse(readFileSync(join(dir, "ratchets.json"), "utf8"));
    for (const [id, expected] of Object.entries(EXPECTED_FIXTURE_COUNTS)) {
      assertEqual(written.ratchets[id]?.max, expected, `${id} の実測`);
    }

    const chk = run(dir);
    assertEqual(chk.status, 0, "--check の exit code");
    assertIncludes(chk.out, "OK");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("実測 > 上限（旧経路が増えた）で落ちる", () => {
  const dir = makeFixture();
  try {
    writeRatchets(dir, { ...EXPECTED_FIXTURE_COUNTS, "persona-writers": 0 });
    const r = run(dir);
    assertEqual(r.status, 1, "exit code");
    assertIncludes(r.out, "旧経路が増えています");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("実測 < 上限（締め直し忘れ）でも落ちる — 両方向検査の要点", () => {
  const dir = makeFixture();
  try {
    writeRatchets(dir, { ...EXPECTED_FIXTURE_COUNTS, "identity-merge-functions": 5 });
    const r = run(dir);
    assertEqual(r.status, 1, "exit code");
    assertIncludes(r.out, "上限が実測より緩んでいます");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("ratchets.json に無い id が実測にあると落ちる", () => {
  const dir = makeFixture();
  try {
    const partial = { ...EXPECTED_FIXTURE_COUNTS };
    delete partial["raw-identity-key-legacy"];
    writeRatchets(dir, partial);
    const r = run(dir);
    assertEqual(r.status, 1, "exit code");
    assertIncludes(r.out, "ratchets.json にありません");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("数え方が無いのに上限だけ残っていると落ちる（上限の形骸化を止める）", () => {
  const dir = makeFixture();
  try {
    writeRatchets(dir, { ...EXPECTED_FIXTURE_COUNTS, "counter-that-was-deleted": 3 });
    const r = run(dir);
    assertEqual(r.status, 1, "exit code");
    assertIncludes(r.out, "数え方 (COUNTERS) がありません");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("数え方が対象を見失って 0 件になったら、緑ではなく落ちる", () => {
  // 対象を 1 つも含まない空のソースだけを置く。
  const dir = mkdtempSync(join(tmpdir(), "ratchet-empty-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "empty.ts"), "export const nothing = 1;\n", "utf8");
    writeRatchets(dir, EXPECTED_FIXTURE_COUNTS);
    const r = run(dir);
    assertEqual(r.status, 1, "exit code");
    assertIncludes(r.out, "実測が 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("src/db/migrations は数えない（追記専用の履歴なので永久に減らない上限になる）", () => {
  const dir = makeFixture();
  try {
    mkdirSync(join(dir, "src", "db", "migrations"), { recursive: true });
    // migrations 配下に「旧経路の形」をした .ts を置いても実測は増えない。
    writeFileSync(
      join(dir, "src", "db", "migrations", "099_legacy.ts"),
      "export const row = { line_user_id: 'U9' };\n",
      "utf8",
    );
    writeRatchets(dir, EXPECTED_FIXTURE_COUNTS);
    const r = run(dir);
    assertEqual(r.status, 0, "migrations は無視されるので通る");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("実リポジトリの ratchets.json が実測と一致している", () => {
  const r = run(REPO_ROOT);
  assertEqual(r.status, 0, `本体の --check が緑\n${r.out}`);
});

console.log("\n" + "=".repeat(60));
console.log("check-ratchet Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failedTests > 0 ? 1 : 0);

// dirname は import の形を他テストと揃えるためだけに読み込んでいる（未使用回避）。
void dirname;
