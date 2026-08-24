/**
 * Unit Tests -- scripts/deploy-worker.sh（本番に載ったコミットの刻印）
 *
 * 何を守るテストか:
 *   「本番に載っているのはどのコミットか」を Cloudflare 側だけで確定できる状態を保つ。
 *   2026-08-25 の調査時点では、cx-agent の最新 version は Tag も Message も空で、
 *   時刻の近さから推測するしかなかった。その 1 点のせいで「11 commit 遅れたコードを
 *   本番だと思って調べる」という遠回りが実際に起きている（再設計 M-9）。
 *
 *   `wrangler deploy` は tag / message を渡さない限り何も残さない。よって
 *   「渡している」ことを機械で縛る。
 *
 * 副作用ゼロ:
 *   - Cloudflare にもネットワークにも触らない（DEPLOY_STAMP_PRINT_ONLY=1 で
 *     wrangler を呼ばず、決まった引数だけを出させる）。
 *   - このリポジトリの working tree も触らない（すべて os.tmpdir() 配下）。
 *
 * 使用方法:
 *   npx tsx tests/unit/deploy-worker-stamp.test.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SCRIPT = join(REPO_ROOT, "scripts", "deploy-worker.sh");

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
function assertTrue(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

// ─ git ヘルパ（ユーザの ~/.gitconfig に依存させない）─
const GIT_BASE_ARGS = [
  "-c", "user.name=deploy-stamp-test",
  "-c", "user.email=deploy-stamp-test@example.invalid",
  "-c", "commit.gpgsign=false",
  "-c", "core.hooksPath=/dev/null",
];

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", [...GIT_BASE_ARGS, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

/** 刻印だけを取り出す（wrangler は呼ばれない）。 */
function stamp(cwd: string): { code: number | null; tag: string; message: string; output: string } {
  const r = spawnSync("bash", [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DEPLOY_STAMP_PRINT_ONLY: "1" },
  });
  const output = `${r.stdout}\n${r.stderr}`;
  const read = (key: string) =>
    (r.stdout.split("\n").find((l) => l.startsWith(`${key}=`)) ?? "").slice(key.length + 1);
  return { code: r.status, tag: read("tag"), message: read("message"), output };
}

/** 使い捨ての git リポジトリ（1 コミット済み・clean）。 */
function makeRepo(subject = "feat: 何かを直す"): { dir: string; sha: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "deploy-worker-stamp-"));
  spawnSync("git", [...GIT_BASE_ARGS, "init", dir], { encoding: "utf8" });
  git(dir, "symbolic-ref", "HEAD", "refs/heads/master");
  writeFileSync(join(dir, "app.txt"), "v1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", subject);
  return { dir, sha: git(dir, "rev-parse", "HEAD"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

console.log("\n--- deploy-worker.sh（version の刻印）---");

it("clean な HEAD → tag は短 SHA、message は完全 SHA で始まる", () => {
  const repo = makeRepo();
  try {
    const s = stamp(repo.dir);
    assertEqual(s.code, 0, "exit code");
    assertEqual(s.tag, repo.sha.slice(0, 12), "tag");
    assertTrue(
      s.message.startsWith(repo.sha),
      `message が完全 SHA で始まらない: ${s.message}`,
    );
  } finally {
    repo.cleanup();
  }
});

it("message にブランチ名とコミット件名が入る（人が読んで分かる）", () => {
  const repo = makeRepo("fix: 消していないのに消したと言う経路を塞ぐ");
  try {
    const s = stamp(repo.dir);
    assertIncludes(s.message, "master", "message のブランチ名");
    assertIncludes(s.message, "fix: 消していない", "message のコミット件名");
  } finally {
    repo.cleanup();
  }
});

it("未コミット差分があれば -dirty が付く（SHA だけを名乗らせない）", () => {
  const repo = makeRepo();
  try {
    writeFileSync(join(repo.dir, "app.txt"), "手元でいじった\n");
    const s = stamp(repo.dir);
    assertEqual(s.tag, `${repo.sha.slice(0, 12)}-dirty`, "tag");
    assertIncludes(s.message, "-dirty", "message");
  } finally {
    repo.cleanup();
  }
});

it("上限を超えても切り詰めてデプロイを止めない（先頭の SHA は残る）", () => {
  /* Cloudflare 側の長さ上限で落ちると、刻印のためにデプロイが失敗することになる。
     刻印は付加情報であって、デプロイの可否を決める条件ではない。 */
  const repo = makeRepo(`feat: ${"あ".repeat(300)}`);
  try {
    const s = stamp(repo.dir);
    assertEqual(s.code, 0, "exit code");
    assertTrue(s.tag.length <= 25, `tag が長すぎる (${s.tag.length})`);
    assertTrue(s.message.length <= 100, `message が長すぎる (${s.message.length})`);
    assertTrue(s.message.startsWith(repo.sha), "切り詰めで SHA が消えている");
  } finally {
    repo.cleanup();
  }
});

it("git が無い場所でも exit 0（刻印無しで進む）", () => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-worker-nogit-"));
  try {
    const r = spawnSync("bash", [SCRIPT], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, DEPLOY_STAMP_PRINT_ONLY: "1", GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    assertEqual(r.status, 0, "exit code");
    assertEqual(
      `${r.stdout}`.includes("tag=\n") || `${r.stdout}`.includes("tag="),
      true,
      "tag 行が出ていない",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("デプロイ経路が全部この 1 実装を通る（bare wrangler deploy を残さない）", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assertIncludes(pkg.scripts.deploy, "deploy-worker.sh", "package.json の deploy");
  assertIncludes(pkg.scripts["deploy:staging"], "deploy-worker.sh", "package.json の deploy:staging");

  const prodSh = readFileSync(join(REPO_ROOT, "scripts", "deploy-prod.sh"), "utf8");
  assertIncludes(prodSh, "deploy-worker.sh", "deploy-prod.sh の STEP 3");
  assertTrue(
    !/^\s*pnpm exec wrangler deploy\s*$/m.test(prodSh),
    "deploy-prod.sh に bare `pnpm exec wrangler deploy` が残っている",
  );

  const ci = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8");
  assertTrue(
    !/run:\s*pnpm exec wrangler deploy/.test(ci),
    "ci.yml に bare `wrangler deploy` が残っている",
  );

  const worker = readFileSync(SCRIPT, "utf8");
  assertIncludes(worker, "--tag", "deploy-worker.sh が tag を渡していない");
  assertIncludes(worker, "--message", "deploy-worker.sh が message を渡していない");
});

console.log("\n" + "=".repeat(60));
console.log("Deploy Worker Stamp Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failedTests > 0 ? 1 : 0);
