/**
 * Unit Tests -- cron-routing（T3 到達性 + 2026-08-22 完全オンデマンド化）
 *
 * 検証範囲:
 *   1. 分類（純粋関数）: 配信パターンだけが "delivery"、それ以外（同期 + 想定外の安全網）は "sync"。
 *   2. 登録トリガ（wrangler.toml）: 配信 cron が **登録されていない**こと。
 *      同時に、配信以外の定期処理（日次同期 0 18 / staging 計測 0 19）は **登録が生きている**こと。
 *   3. 実装ガード（src/index.ts）: cronKind==="delivery" 分岐が配信ランナーを呼ばない no-op であること。
 *
 * 2 と 3 が「cron で配信が発火しない」の二重防御。片方だけでは
 * 「toml を戻したら自動配信が復活する」ため、両方を機械で固定する。
 *
 * 使用方法:
 *   npx tsx tests/unit/cron-routing.test.ts
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  classifyCron,
  DELIVERY_CRON_PATTERN,
  SYNC_CRON_PATTERN,
  STATS_CRON_PATTERN,
  DORMANT_CRON_PATTERN,
} from "../../src/lib/cron-routing";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const readRepoFile = (rel: string) => readFileSync(resolve(REPO_ROOT, rel), "utf8");

/** wrangler.toml の指定セクションの crons 配列を読む（コメント行は無視）。 */
function cronsForSection(toml: string, section: string): string[] {
  const lines = toml.split("\n");
  const idx = lines.findIndex((l) => l.trim() === section);
  if (idx < 0) throw new Error(`セクションが見つからない: ${section}`);
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#") || line === "") continue;
    if (line.startsWith("[")) break; // 次のセクションに入った = crons 未定義
    const m = line.match(/^crons\s*=\s*(\[.*\])$/);
    if (m) return JSON.parse(m[1]) as string[];
  }
  throw new Error(`crons が見つからない: ${section}`);
}

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
function assertTrue(cond: boolean, label = "") {
  if (!cond) throw new Error(label || "expected true");
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

console.log("\n--- classifyCron ---");

it("配信パターン → delivery（登録されていても sync に誤爆させないための分類）", () => {
  assertEqual(classifyCron(DELIVERY_CRON_PATTERN), "delivery");
  assertEqual(classifyCron("*/15 * * * *"), "delivery");
});

it("同期パターン → sync（死蔵解消の核心）", () => {
  assertEqual(classifyCron(SYNC_CRON_PATTERN), "sync");
  assertEqual(classifyCron("0 18 * * *"), "sync");
});

it("計測パターン → stats（P0-7b の3種目）", () => {
  assertEqual(classifyCron(STATS_CRON_PATTERN), "stats");
  assertEqual(classifyCron("0 19 * * *"), "stats");
});

it("休眠パターン → dormant（ブロック3-B の4種目）", () => {
  assertEqual(classifyCron(DORMANT_CRON_PATTERN), "dormant");
  assertEqual(classifyCron("0 20 * * *"), "dormant");
});

it("想定外パターン → sync（安全網）", () => {
  assertEqual(classifyCron("0 21 1,15 * *"), "sync");
  assertEqual(classifyCron("unknown"), "sync");
  assertEqual(classifyCron(""), "sync");
});

it("4種のパターンは相互に異なる（両立の前提）", () => {
  const patterns = [
    DELIVERY_CRON_PATTERN,
    SYNC_CRON_PATTERN,
    STATS_CRON_PATTERN,
    DORMANT_CRON_PATTERN,
  ];
  assertEqual(new Set(patterns).size, patterns.length, "全パターン一意");
});

// ---------------------------------------------------------------------------
// 完全オンデマンド化（2026-08-22・Setaka 指示）
//   「cron tick で配信が発火しない」「配信以外の定期処理は生きている」を機械で固定する。
// ---------------------------------------------------------------------------
console.log("\n--- 登録トリガ: 配信だけを外し、他の定期処理は残す ---");

const WRANGLER = readRepoFile("wrangler.toml");

it("本番 [triggers] に配信 cron が登録されていない", () => {
  const crons = cronsForSection(WRANGLER, "[triggers]");
  assertTrue(
    !crons.includes(DELIVERY_CRON_PATTERN),
    `本番 crons に配信パターンが残っている: ${JSON.stringify(crons)}`,
  );
});

it("本番 [triggers] に日次同期 cron は残っている（配信以外は従来どおり動く）", () => {
  const crons = cronsForSection(WRANGLER, "[triggers]");
  assertTrue(
    crons.includes(SYNC_CRON_PATTERN),
    `本番 crons から日次同期が消えている: ${JSON.stringify(crons)}`,
  );
});

it("staging [env.staging.triggers] に配信 cron が登録されていない", () => {
  const crons = cronsForSection(WRANGLER, "[env.staging.triggers]");
  assertTrue(
    !crons.includes(DELIVERY_CRON_PATTERN),
    `staging crons に配信パターンが残っている: ${JSON.stringify(crons)}`,
  );
});

it("staging [env.staging.triggers] に同期 + 計測 cron は残っている", () => {
  // 計測 tick（0 19）には休眠検知・マルシェ活性化が同居しているため、
  // これが消えると「配信以外の定期処理」を巻き込んで殺したことになる。
  const crons = cronsForSection(WRANGLER, "[env.staging.triggers]");
  assertTrue(crons.includes(SYNC_CRON_PATTERN), `staging から同期が消えている: ${JSON.stringify(crons)}`);
  assertTrue(crons.includes(STATS_CRON_PATTERN), `staging から計測が消えている: ${JSON.stringify(crons)}`);
});

console.log("\n--- 実装ガード: scheduled の delivery 分岐は no-op ---");

const INDEX_SRC = readRepoFile("src/index.ts");

it("scheduled ハンドラの delivery 分岐が配信ランナーを呼ばない（no-op）", () => {
  // cronKind === "delivery" 分岐の本体を切り出し、配信ランナー呼び出しが無いことを確認する。
  const start = INDEX_SRC.indexOf('if (cronKind === "delivery")');
  assertTrue(start >= 0, "delivery 分岐が見つからない（分岐ごと消すと sync へ誤爆する）");
  const rest = INDEX_SRC.slice(start);
  const branchEnd = rest.indexOf('if (cronKind === "stats")');
  assertTrue(branchEnd > 0, "delivery 分岐の終端が特定できない");
  const branch = rest.slice(0, branchEnd);
  for (const banned of ["runOnDemandDelivery", "runDelivery", "pinDeliveryApproval"]) {
    assertTrue(
      !branch.includes(banned),
      `cron の delivery 分岐が ${banned} を呼んでいる（自動配信が復活している）`,
    );
  }
  assertTrue(branch.includes("return"), "delivery 分岐は return で抜けること（sync へ落とさない）");
});

it("配信ランナーはオンデマンド API からのみ呼ばれる（scheduled 内に呼び出しが無い）", () => {
  const schedIdx = INDEX_SRC.indexOf("scheduled: async (");
  assertTrue(schedIdx >= 0, "scheduled ハンドラが見つからない");
  const scheduledBody = INDEX_SRC.slice(schedIdx);
  assertTrue(
    !scheduledBody.includes("runOnDemandDelivery("),
    "scheduled ハンドラ内から配信ランナーが呼ばれている",
  );
  // 一方で HTTP 側（scheduled より前）には run API の呼び出しが存在すること。
  assertTrue(
    INDEX_SRC.slice(0, schedIdx).includes("runOnDemandDelivery(c.env)"),
    "オンデマンド API から配信ランナーが呼ばれていない",
  );
});

console.log("\n" + "=".repeat(60));
console.log("Cron Routing Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failedTests > 0 ? 1 : 0);
