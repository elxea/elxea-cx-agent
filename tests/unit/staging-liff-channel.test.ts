/**
 * Unit Tests -- wrangler.toml の staging LIFF が、どのチャネルを指しているか
 *
 * 何を守るテストか:
 *   **番号体系のずれを二度と作らない**（再設計 M-0 / F3）。
 *
 *   本番 OA @307tzhkw（Messaging 2008324925）と、旧本番 Login チャネル 2009473839 は
 *   **別プロバイダ**にあった。同じ人でも userId の番号体系が違うので、Login 由来の ID で
 *   台帳を引いても永久に見つからない。照会は成功し、答えも正しく返る — 噛み合って
 *   いないのは番号体系だけ、というのが「何をやっても連携できない」の正体だった
 *   （設計書 §0 / §3-3-1）。
 *
 *   M-0 で本番 OA と同一プロバイダに Login チャネルを新設した（本番 2011239425 /
 *   テスト 2011239440）。ところが cx-agent の staging には、旧チャネルの LIFF URL が
 *   そのまま残っていた。staging でどれだけ通しても、そこで踏んでいるのは
 *   **退役したプロバイダ**である。
 *
 *   web-app 側には同じ趣旨の恒久ガード（`checkChannelNamespace`）がある。こちら側にも
 *   置く。片側にしか無い検査は、もう一方が静かにずれたときに何も言わない。
 *
 * この検査が落とすもの:
 *   1. staging の LIFF が退役プロバイダ（2009473839）を指している
 *   2. staging の LIFF が **本番チャネル**（2011239425）を指している
 *      → staging から本番 OA 文脈の連携を踏ませることになり、
 *        DELIVERY_TARGET_ENV="test" で作った隔離が崩れる
 *   3. 本番 [vars] に LIFF_LINKAGE_URL が現れた
 *      → 本番での有効化は GA/昇格ゲートの判断であり、toml の編集で滑り込ませない
 *
 * 副作用ゼロ: wrangler.toml を読むだけ。ネットワークにも Cloudflare にも触らない。
 *
 * 使用方法:
 *   npx tsx tests/unit/staging-liff-channel.test.ts
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const WRANGLER = readFileSync(join(REPO_ROOT, "wrangler.toml"), "utf8");

/** 退役した旧本番 Login チャネル。本番 OA と別プロバイダ（2026-07-21 実測）。 */
const RETIRED_CHANNEL = "2009473839";
/** M-0 で新設した本番 Login チャネル。staging からは使わない。 */
const PROD_CHANNEL = "2011239425";
/** M-0 で新設したテストチャネル。staging はこちらだけを使う。 */
const TEST_CHANNEL = "2011239440";

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

function assertTrue(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

/**
 * 実効行だけを見る（`#` で始まる行を落とす）。
 *
 * コメントに旧チャネル ID が出てくるのは**正しい**（なぜ変えたかの記録）。
 * 設定値として残っているかどうかだけを検査する。
 */
function settingLines(): string[] {
  return WRANGLER.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** `KEY = "..."` の値を取り出す（実効行のみ・最初の 1 件）。 */
function settingValue(key: string): string | null {
  for (const line of settingLines()) {
    const m = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`).exec(line);
    if (m) return m[1];
  }
  return null;
}

console.log("\nwrangler.toml -- staging LIFF チャネル\n");

it("staging の LIFF はテストチャネル（2011239440）を指す", () => {
  const url = settingValue("LIFF_LINKAGE_URL");
  assertTrue(url !== null, "LIFF_LINKAGE_URL が [env.staging.vars] に無い");
  assertTrue(
    url!.startsWith(`https://liff.line.me/${TEST_CHANNEL}-`),
    `LIFF_LINKAGE_URL がテストチャネル ${TEST_CHANNEL} を指していない: ${url}`,
  );
});

it("退役した旧本番チャネル（2009473839）を設定値として残さない", () => {
  const offenders = settingLines().filter((l) => l.includes(RETIRED_CHANNEL));
  assertTrue(
    offenders.length === 0,
    "旧本番 Login チャネルが設定値に残っている（本番 OA と別プロバイダ・M-0 で退役）:\n" +
      offenders.map((o) => `  - ${o}`).join("\n"),
  );
});

it("staging から本番チャネル（2011239425）を指さない", () => {
  const offenders = settingLines().filter((l) => l.includes(PROD_CHANNEL));
  assertTrue(
    offenders.length === 0,
    "staging の設定値が本番 Login チャネルを指している（テスト OA の隔離が崩れる）:\n" +
      offenders.map((o) => `  - ${o}`).join("\n"),
  );
});

it("本番 [vars] に LIFF_LINKAGE_URL を置かない（未設定 = fail-safe）", () => {
  /* セクション見出しで区切って、`[vars]`（= 本番/default env）の中だけを見る。 */
  let section = "";
  const offenders: string[] = [];
  for (const line of settingLines()) {
    const head = /^\[([^\]]+)\]$/.exec(line);
    if (head) {
      section = head[1];
      continue;
    }
    if (section === "vars" && line.startsWith("LIFF_LINKAGE_URL")) offenders.push(line);
  }
  assertTrue(
    offenders.length === 0,
    "本番 [vars] に LIFF_LINKAGE_URL がある（本番での有効化は GA/昇格ゲートの判断）:\n" +
      offenders.map((o) => `  - ${o}`).join("\n"),
  );
});

console.log("\n" + "=".repeat(60));
console.log("Staging LIFF Channel Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failedTests > 0 ? 1 : 0);
