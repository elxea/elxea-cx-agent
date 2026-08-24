/**
 * Unit Tests -- scripts/deploy-preflight.sh（本番デプロイ直前ゲート）
 *
 * 何を守るテストか:
 *   古いローカル master のまま `pnpm deploy` を撃って、本番へ入っていた修正を巻き戻す事故を
 *   機械で止める。ゲートが「通すべきときに通り、止めるべきときに止まる」ことを、
 *   使い捨ての git リポジトリ（bare remote + clone）を temp に作って実際に実行して検証する。
 *
 * 副作用ゼロ:
 *   - 本物のリモート・ネットワーク・Cloudflare には一切触らない（remote はローカルの bare repo）。
 *   - このリポジトリの working tree も触らない（すべて os.tmpdir() 配下）。
 *
 * 使用方法:
 *   npx tsx tests/unit/deploy-preflight.test.ts
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const SCRIPT = join(REPO_ROOT, "scripts", "deploy-preflight.sh");

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
    throw new Error(`${label ? label + ": " : ""}output に "${needle}" が含まれない\n--- output ---\n${haystack}`);
  }
}

// ─ git ヘルパ（ユーザの ~/.gitconfig に依存させない: identity と hooks を毎回明示する）─
const GIT_BASE_ARGS = [
  "-c", "user.name=preflight-test",
  "-c", "user.email=preflight-test@example.invalid",
  "-c", "commit.gpgsign=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "protocol.file.allow=always",
];

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", [...GIT_BASE_ARGS, ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout.trim();
}

/** preflight を実行して exit code と出力（stdout+stderr）を返す。 */
function runPreflight(cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, output: `${r.stdout}\n${r.stderr}` };
}

/**
 * 使い捨てフィクスチャ: bare remote（既定ブランチ master）+ その clone を作る。
 * clone の HEAD == origin/master・working tree clean の状態から始まる。
 */
function makeFixture(): { dir: string; remote: string; clone: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "deploy-preflight-"));
  const remote = join(dir, "remote.git");
  const seed = join(dir, "seed");
  const clone = join(dir, "clone");

  spawnSync("git", [...GIT_BASE_ARGS, "init", "--bare", remote], { encoding: "utf8" });
  // 既定ブランチ名を git のバージョン差（init.defaultBranch 有無）に依存させない。
  spawnSync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/master"], { encoding: "utf8" });

  spawnSync("git", [...GIT_BASE_ARGS, "init", seed], { encoding: "utf8" });
  git(seed, "symbolic-ref", "HEAD", "refs/heads/master");
  writeFileSync(join(seed, "app.txt"), "v1\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "v1");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "master");

  spawnSync("git", [...GIT_BASE_ARGS, "clone", remote, clone], { encoding: "utf8" });

  return {
    dir,
    remote,
    clone,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** remote 側だけを 1 コミット進める（= 手元の clone が「古い master」になる）。 */
function advanceRemote(fx: { dir: string; remote: string }) {
  const pusher = join(fx.dir, "pusher");
  spawnSync("git", [...GIT_BASE_ARGS, "clone", fx.remote, pusher], { encoding: "utf8" });
  writeFileSync(join(pusher, "app.txt"), "v2 — 本番に入っている修正\n");
  git(pusher, "add", "-A");
  git(pusher, "commit", "-m", "fix: 本番に入っている修正");
  git(pusher, "push", "origin", "master");
}

console.log("\n--- deploy-preflight.sh ---");

it("ケース1: HEAD == origin/master かつ clean → 通過（exit 0）", () => {
  const fx = makeFixture();
  try {
    const { code, output } = runPreflight(fx.clone);
    assertEqual(code, 0, "exit code");
    assertIncludes(output, "preflight PASSED");
    assertIncludes(output, "[OK] working tree clean");
  } finally {
    fx.cleanup();
  }
});

it("ケース2: HEAD が origin/master より古い → 中止（exit 1・巻き戻すコミットを表示）", () => {
  const fx = makeFixture();
  try {
    advanceRemote(fx);
    const { code, output } = runPreflight(fx.clone);
    assertEqual(code, 1, "exit code");
    assertIncludes(output, "[ABORT]");
    assertIncludes(output, "origin/master の最新と一致しない");
    // 「本番に載らなくなるコミット」が具体的に見えること（事故の再現に必要な情報）。
    assertIncludes(output, "fix: 本番に入っている修正");
  } finally {
    fx.cleanup();
  }
});

it("ケース3: 不一致 + DEPLOY_ALLOW_NON_DEFAULT=1 → 警告付きで通過（exit 0）", () => {
  const fx = makeFixture();
  try {
    advanceRemote(fx);
    const { code, output } = runPreflight(fx.clone, { DEPLOY_ALLOW_NON_DEFAULT: "1" });
    assertEqual(code, 0, "exit code");
    assertIncludes(output, "[WARN]");
    assertIncludes(output, "明示 override で続行");
    // override でも差分サマリは必ず出す（黙って古いものを載せない）。
    assertIncludes(output, "fix: 本番に入っている修正");
  } finally {
    fx.cleanup();
  }
});

it("ケース4: 未コミット差分あり → 中止（exit 1）", () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.clone, "app.txt"), "作業途中\n");
    const { code, output } = runPreflight(fx.clone);
    assertEqual(code, 1, "exit code");
    assertIncludes(output, "未コミット差分");
  } finally {
    fx.cleanup();
  }
});

it("ケース5: 未追跡ファイルも dirty 扱い → 中止（exit 1）", () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.clone, "_scratch_tmp.ts"), "// 消し忘れ\n");
    const { code } = runPreflight(fx.clone);
    assertEqual(code, 1, "exit code");
  } finally {
    fx.cleanup();
  }
});

it("ケース6: dirty は DEPLOY_ALLOW_NON_DEFAULT では解除できない（exit 1 のまま）", () => {
  const fx = makeFixture();
  try {
    writeFileSync(join(fx.clone, "app.txt"), "作業途中\n");
    const { code, output } = runPreflight(fx.clone, { DEPLOY_ALLOW_NON_DEFAULT: "1" });
    assertEqual(code, 1, "exit code");
    assertIncludes(output, "DEPLOY_ALLOW_NON_DEFAULT では解除できない");
  } finally {
    fx.cleanup();
  }
});

it("ケース7: override は明示的な真値のみ有効（0 や空文字では通さない）", () => {
  const fx = makeFixture();
  try {
    advanceRemote(fx);
    assertEqual(runPreflight(fx.clone, { DEPLOY_ALLOW_NON_DEFAULT: "0" }).code, 1, "'0' で通ってはいけない");
    assertEqual(runPreflight(fx.clone, { DEPLOY_ALLOW_NON_DEFAULT: "" }).code, 1, "空文字で通ってはいけない");
    assertEqual(runPreflight(fx.clone, { DEPLOY_ALLOW_NON_DEFAULT: "true" }).code, 0, "'true' は許可");
  } finally {
    fx.cleanup();
  }
});

it("ケース8: HEAD が origin/master から分岐（ahead かつ behind）→ 中止（exit 1）", () => {
  const fx = makeFixture();
  try {
    advanceRemote(fx);
    writeFileSync(join(fx.clone, "local.txt"), "手元だけの変更\n");
    git(fx.clone, "add", "-A");
    git(fx.clone, "commit", "-m", "local only");
    const { code, output } = runPreflight(fx.clone);
    assertEqual(code, 1, "exit code");
    assertIncludes(output, "[ABORT]");
  } finally {
    fx.cleanup();
  }
});

it("ゲートが本番デプロイ経路に配線されている（package.json / deploy-prod.sh）", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assertIncludes(pkg.scripts.deploy, "deploy-preflight.sh", "package.json の deploy");
  assertIncludes(pkg.scripts.deploy, "wrangler deploy", "package.json の deploy");
  // staging はゲート対象外（feature ブランチからの検証デプロイが正常運用のため）。
  assertEqual(
    pkg.scripts["deploy:staging"].includes("deploy-preflight.sh"),
    false,
    "staging にはゲートを入れない",
  );
  const prodSh = readFileSync(join(REPO_ROOT, "scripts", "deploy-prod.sh"), "utf8");
  assertIncludes(prodSh, "./scripts/deploy-preflight.sh", "deploy-prod.sh の preflight");
});

console.log("\n" + "=".repeat(60));
console.log("Deploy Preflight Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failedTests > 0 ? 1 : 0);
