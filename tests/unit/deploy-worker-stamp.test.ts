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

/**
 * 「デプロイ経路が全部この 1 実装を通る」を、**実際に実行される行**で確かめる。
 *
 * ## なぜ作り直したか（QA 指摘 2026-08-25）
 *
 * 旧版はファイル全体に `"deploy-worker.sh"` という**文字列が含まれるか**しか見て
 * いなかった。だから、たとえば「bare `wrangler deploy` を実行しつつ、コメントで
 * deploy-worker.sh に言及している」ファイルは合格してしまう。実際、この検査が
 * 全緑のまま `scripts/activate-selfapproval.sh` の `npx wrangler deploy`（本番へ
 * 上げる 5/8 ステップ）が刻印を素通りし続けていた — **検査の対象ファイルに
 * 入っていなかった**からである。
 *
 * これは再設計 §2-4 が指摘した失敗モードそのもの（「正本が無いまま、片側の
 * 都合で書いた検査が全緑を出し続ける」）。よって直し方を 2 つ変える。
 *
 *   1. **実 exec 行を assert する** — コメントではなく、コメントを除いた行が
 *      deploy-worker.sh を呼んでいることを見る
 *   2. **列挙をやめて全掃引にする** — 対象ファイルを手で並べる限り、新しい
 *      入口が増えたときに漏れる。リポジトリ全体を掃いて bare `wrangler deploy`
 *      を 1 件でも見つけたら落とす
 */

/**
 * 実行され得る行だけを残す。
 *
 * 落とすもの:
 *   - 行コメント（`#` / `//`）とブロックコメント（`/* ... *​/`）
 *   - **クォートされた文字列リテラルの中身**
 *
 * 最後のひとつが肝。`echo ">>> 本番 deploy（wrangler deploy）"` のような
 * **説明文**を「実行」と読み違えると、直しようのない誤検知が出て、検査ごと
 * 無視されるようになる（= 検査が死ぬ）。文字列の中身は実行されないので落とす。
 */
function executableLines(source: string): string[] {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlockComments
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*\/\/.*$/, "")
        .replace(/(^|\s)#.*$/, "")
        // 文字列リテラルの中身を抜く（クォートは残して構造は保つ）
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * コメントだけを落とした行。文字列リテラルは**残す**。
 *
 * `bash "$(dirname "${BASH_SOURCE[0]}")/deploy-worker.sh"` のように、呼び出し先の
 * パスがクォートの中にある形が普通にあるため、「呼んでいるか」を見る側は
 * 文字列を落としてはいけない。落としてよいのは「実行していないか」を見る側だけ。
 */
function nonCommentLines(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/^\s*\/\/.*$/, "").replace(/(^|\s)#(?![{])[^"']*$/, "").trim())
    .filter(Boolean);
}

/**
 * 「刻印を通さない `wrangler deploy`」か。
 *
 * `wrangler secret` / `wrangler versions` / `--version` 等は対象外。見るのは
 * **deploy サブコマンドの実行**だけ。
 */
function isBareWranglerDeploy(line: string): boolean {
  if (!/\bwrangler\s+deploy\b/.test(line)) return false;
  // deploy-worker.sh 自身が最後に呼ぶ 1 行だけは、これが刻印を渡す本体なので除外。
  if (line.includes("--tag") && line.includes("--message")) return false;
  // 刻印が取れなかったときのフォールバック（deploy-worker.sh 内・警告付き）も本体側。
  return true;
}

it("デプロイ経路が全部この 1 実装を通る（実 exec 行で確かめる）", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  /* package.json は実行される文字列そのものなので、部分一致ではなく
     「wrangler deploy を直接呼んでいないこと」まで見る。 */
  for (const name of ["deploy", "deploy:staging"]) {
    const cmd = pkg.scripts[name] ?? "";
    assertIncludes(cmd, "deploy-worker.sh", `package.json の ${name}`);
    assertTrue(
      !isBareWranglerDeploy(cmd),
      `package.json の ${name} が bare wrangler deploy を呼んでいる: ${cmd}`,
    );
  }

  /* deploy-prod.sh は「コメントに書いてある」ではなく「その行が呼んでいる」を見る。 */
  for (const rel of ["scripts/deploy-prod.sh", "scripts/activate-selfapproval.sh"]) {
    const lines = nonCommentLines(readFileSync(join(REPO_ROOT, rel), "utf8"));
    assertTrue(
      lines.some((l) => /\b(bash|sh|exec)\b.*deploy-worker\.sh/.test(l)),
      `${rel} の実行行に deploy-worker.sh の呼び出しが無い（コメントだけでは不可）`,
    );
  }

  const worker = readFileSync(SCRIPT, "utf8");
  assertIncludes(worker, "--tag", "deploy-worker.sh が tag を渡していない");
  assertIncludes(worker, "--message", "deploy-worker.sh が message を渡していない");
});

it("リポジトリ全体に bare `wrangler deploy` が 1 件も残っていない", () => {
  /* 対象ファイルを手で並べる方式をやめた理由は上の注記のとおり。
     `git ls-files` で追跡ファイルだけを掃く（node_modules・生成物は入らない）。 */
  const ls = spawnSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
  assertEqual(ls.status, 0, "git ls-files");

  const targets = ls.stdout
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => /\.(sh|ya?ml|json|ts|mjs|js)$/.test(f))
    /* このテスト自身と deploy-worker.sh は、判定文字列そのものを含むので除く。 */
    .filter((f) => f !== "tests/unit/deploy-worker-stamp.test.ts")
    .filter((f) => f !== "scripts/deploy-worker.sh");

  const offenders: string[] = [];
  for (const file of targets) {
    let source: string;
    try {
      source = readFileSync(join(REPO_ROOT, file), "utf8");
    } catch {
      continue; // シンボリックリンク・バイナリ等
    }
    if (!source.includes("wrangler")) continue;
    for (const [i, line] of executableLines(source).entries()) {
      if (isBareWranglerDeploy(line)) offenders.push(`${file}: ${line}`);
      void i;
    }
  }

  assertTrue(
    offenders.length === 0,
    "刻印を通さない wrangler deploy が残っている（scripts/deploy-worker.sh 経由にすること）:\n" +
      offenders.map((o) => `  - ${o}`).join("\n"),
  );
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
