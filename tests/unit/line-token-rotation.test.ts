/**
 * Unit Tests -- line-token-rotation の判定ロジック
 *
 * 何を守るテストか:
 *   LINE のチャネルアクセストークンは 30 日で失効する。更新スクリプトが
 *   「25 日目にちゃんと更新する / 24 日目までは絶対に何もしない / 401 を見たら即更新する /
 *   状態が分からないときは黙って進まない」を満たすことを、日付をこちらで固定して検証する。
 *
 * 何を呼んでいないか (重要):
 *   本体の scripts/line-token-rotation.sh は **一度も起動しない**。
 *   検証対象は副作用ゼロの判定ライブラリ scripts/lib/line-token-rotation-decide.sh だけで、
 *   ネットワーク・wrangler・.dev.vars・実トークンには一切触れない。
 *   （そのために判定を本体から切り出してある。）
 *
 * 使用方法:
 *   npx tsx tests/unit/line-token-rotation.test.ts
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const DECIDE_LIB = path.join(REPO_ROOT, "scripts/lib/line-token-rotation-decide.sh");
const MAIN_SCRIPT = path.join(REPO_ROOT, "scripts/line-token-rotation.sh");

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

// ---------------------------------------------------------------------------
// bash ヘルパ: 判定ライブラリだけを source して 1 コマンド実行する
// ---------------------------------------------------------------------------
type ShellResult = { stdout: string; status: number };

function runBash(snippet: string, env: Record<string, string> = {}): ShellResult {
  try {
    const stdout = execFileSync(
      "bash",
      ["-c", `set -euo pipefail; . "${DECIDE_LIB}"; ${snippet}`],
      { env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", status: e.status ?? -1 };
  }
}

type Decision = {
  decision: string;
  reason: string;
  daysSinceIssued: string;
  daysToExpiry: string;
  exitCode: number;
};

/**
 * 判定を 1 回走らせる。state に null を渡すと「状態ファイルが無い」ケースになる。
 * today は必ず明示する（実行日によってテスト結果が変わらないようにするため）。
 */
function decide(opts: {
  state: Record<string, unknown> | string | null;
  today: string;
  force?: boolean;
  probeStatus?: string;
}): Decision {
  const stateJson =
    opts.state === null
      ? ""
      : typeof opts.state === "string"
        ? opts.state
        : JSON.stringify(opts.state);

  const res = runBash("ltr_decide", {
    LTR_STATE_JSON: stateJson,
    LTR_TODAY: opts.today,
    LTR_FORCE: opts.force ? "1" : "0",
    LTR_PROBE_STATUS: opts.probeStatus ?? "",
  });

  const pick = (key: string) => {
    const m = res.stdout.match(new RegExp(`^${key}=(.*)$`, "m"));
    return m ? m[1] : "";
  };

  return {
    decision: pick("DECISION"),
    reason: pick("REASON"),
    daysSinceIssued: pick("DAYS_SINCE_ISSUED"),
    daysToExpiry: pick("DAYS_TO_EXPIRY"),
    exitCode: res.status,
  };
}

/** 30 日有効の標準的な状態ファイル（発行日 issued、失効日はその 30 日後）。 */
function stateIssuedOn(issued: string, expires: string) {
  return {
    env: "staging",
    secret_name: "LINE_CHANNEL_ACCESS_TOKEN_TEST",
    issued_at: issued,
    expires_at: expires,
    expires_in_seconds: 2592000,
    last_rotation_reason: "age-threshold",
    last_checked_at: issued,
    rotation_count: 1,
  };
}

// ===========================================================================
console.log("\n--- 前提: 検証対象のファイルが存在する ---");

it("判定ライブラリが存在する", () => {
  assertEqual(existsSync(DECIDE_LIB), true, DECIDE_LIB);
});

it("本体スクリプトが存在する（存在確認のみ・実行はしない）", () => {
  assertEqual(existsSync(MAIN_SCRIPT), true, MAIN_SCRIPT);
});

it("本スクリプトは bash 構文として正しい（-n の構文検査のみ・実行しない）", () => {
  // bash -n はパースするだけでコマンドを 1 つも実行しない。
  const res = runBash(`bash -n "${MAIN_SCRIPT}" && echo SYNTAX_OK`);
  assertEqual(res.stdout.trim().endsWith("SYNTAX_OK"), true, res.stdout);
});

// ===========================================================================
console.log("\n--- 日数計算（暦をまたいでも正しいか） ---");

const days = (y: number, m: number, d: number) =>
  Number(runBash(`ltr_days_from_ymd ${y} ${m} ${d}`).stdout.trim());

it("1970-01-01 は 0 日目", () => {
  assertEqual(days(1970, 1, 1), 0);
});

it("1970-01-02 は 1 日目", () => {
  assertEqual(days(1970, 1, 2), 1);
});

it("2000-03-01 は 11017 日目（既知の基準値）", () => {
  assertEqual(days(2000, 3, 1), 11017);
});

it("閏日 2024-02-29 の翌日は 2024-03-01（差が 1 日）", () => {
  assertEqual(days(2024, 3, 1) - days(2024, 2, 29), 1);
});

it("2026-08-10 から 2026-09-09 はちょうど 30 日", () => {
  assertEqual(days(2026, 9, 9) - days(2026, 8, 10), 30);
});

it("年をまたいでも日数が合う（2026-12-20 → 2027-01-14 は 25 日）", () => {
  assertEqual(days(2027, 1, 14) - days(2026, 12, 20), 25);
});

it("先頭 0 付きの月日が 8 進数として誤解釈されない（09 月 08 日）", () => {
  const viaString = Number(runBash(`ltr_date_to_days 2026-09-08`).stdout.trim());
  assertEqual(viaString, days(2026, 9, 8));
});

it("日付として成立しない文字列は失敗する（黙って 0 日目にしない）", () => {
  assertEqual(runBash(`ltr_date_to_days "not-a-date"`).status !== 0, true);
  assertEqual(runBash(`ltr_date_to_days "2026-13-01"`).status !== 0, true);
});

it("ltr_add_days が月末・年末をまたいで正しい日付を返す", () => {
  assertEqual(runBash(`ltr_add_days 2026-08-10 30`).stdout.trim(), "2026-09-09");
  assertEqual(runBash(`ltr_add_days 2026-12-20 30`).stdout.trim(), "2027-01-19");
  assertEqual(runBash(`ltr_add_days 2024-02-01 29`).stdout.trim(), "2024-03-01"); // 閏年
});

// ===========================================================================
console.log("\n--- SKIP 判定（25 日未経過なら絶対に更新しない） ---");

const S = stateIssuedOn("2026-08-10", "2026-09-09");

it("発行当日は SKIP（0 日経過）", () => {
  const r = decide({ state: S, today: "2026-08-10" });
  assertEqual(r.decision, "SKIP");
  assertEqual(r.reason, "not-due");
  assertEqual(r.daysSinceIssued, "0");
  assertEqual(r.exitCode, 0);
});

it("10 日経過は SKIP", () => {
  const r = decide({ state: S, today: "2026-08-20" });
  assertEqual(r.decision, "SKIP");
  assertEqual(r.daysSinceIssued, "10");
  assertEqual(r.daysToExpiry, "20");
});

it("境界: 24 日経過はまだ SKIP", () => {
  const r = decide({ state: S, today: "2026-09-03" });
  assertEqual(r.decision, "SKIP");
  assertEqual(r.daysSinceIssued, "24");
});

// ===========================================================================
console.log("\n--- ROTATE 判定（25 日目に必ず更新へ倒れる） ---");

it("境界: 25 日経過で ROTATE（age-threshold）", () => {
  const r = decide({ state: S, today: "2026-09-04" });
  assertEqual(r.decision, "ROTATE");
  assertEqual(r.reason, "age-threshold");
  assertEqual(r.daysSinceIssued, "25");
  assertEqual(r.exitCode, 0);
});

it("失効日を過ぎていても ROTATE（残日数が負でも止まらない）", () => {
  const r = decide({ state: S, today: "2026-09-20" });
  assertEqual(r.decision, "ROTATE");
  assertEqual(r.daysToExpiry, "-11");
});

it("年をまたぐ 25 日経過でも ROTATE", () => {
  const r = decide({
    state: stateIssuedOn("2026-12-20", "2027-01-19"),
    today: "2027-01-14",
  });
  assertEqual(r.decision, "ROTATE");
  assertEqual(r.reason, "age-threshold");
  assertEqual(r.daysSinceIssued, "25");
});

it("失効間近は age が 25 日未満でも ROTATE（安全網として near-expiry が効く）", () => {
  // LINE が有効期間を 30 日より短く返したケースを模す: 10 日で失効する状態。
  const shortLived = stateIssuedOn("2026-08-10", "2026-08-20");
  const r = decide({ state: shortLived, today: "2026-08-16" });
  assertEqual(r.decision, "ROTATE");
  assertEqual(r.reason, "near-expiry");
  assertEqual(r.daysSinceIssued, "6"); // 25 日には遠いのに更新している
  assertEqual(r.daysToExpiry, "4");
});

it("平常運転の 25 日目は near-expiry ではなく age-threshold と報告される", () => {
  // 既定値は 25 + 5 = 30 で有効期間とちょうど一致する。判定順を誤ると 25 日目が毎回
  // near-expiry になり、「主ルールで回っている」のか「失効直前に滑り込んだ」のかが
  // ログから区別できなくなる。この 1 件がその退行を止める。
  const r = decide({ state: S, today: "2026-09-04" });
  assertEqual(r.decision, "ROTATE");
  assertEqual(r.reason, "age-threshold");
  assertEqual(r.daysToExpiry, "5"); // 残り 5 日 = near-expiry の閾値ちょうど
});

it("expires_at が無い状態ファイルでも age 判定は生きている", () => {
  const noExpiry = { issued_at: "2026-08-10", env: "staging" };
  assertEqual(decide({ state: noExpiry, today: "2026-09-03" }).decision, "SKIP");
  const r = decide({ state: noExpiry, today: "2026-09-04" });
  assertEqual(r.decision, "ROTATE");
  assertEqual(r.reason, "age-threshold");
  assertEqual(r.daysToExpiry, "-");
});

// ===========================================================================
console.log("\n--- 401 即時更新パス ---");

it("bot/info が 401 なら、発行当日でも即 ROTATE", () => {
  const r = decide({ state: S, today: "2026-08-10", probeStatus: "401" });
  assertEqual(r.decision, "ROTATE");
  assertEqual(r.reason, "unauthorized-401");
  assertEqual(r.exitCode, 0);
});

it("401 は状態ファイルが無くても ROTATE できる（状態欠落の ERROR より優先）", () => {
  const r = decide({ state: null, today: "2026-08-10", probeStatus: "401" });
  assertEqual(r.decision, "ROTATE");
  assertEqual(r.reason, "unauthorized-401");
  assertEqual(r.exitCode, 0);
});

it("200 は更新理由にならない（暦の判定へ落ちる）", () => {
  const r = decide({ state: S, today: "2026-08-20", probeStatus: "200" });
  assertEqual(r.decision, "SKIP");
  assertEqual(r.reason, "not-due");
});

it("500 など 401 以外の失敗では更新しない（LINE 側の一時障害で無駄に発行しない）", () => {
  const r = decide({ state: S, today: "2026-08-20", probeStatus: "500" });
  assertEqual(r.decision, "SKIP");
  assertEqual(r.reason, "not-due");
});

it("401 以外の失敗でも、期日が来ていれば通常どおり ROTATE する", () => {
  const r = decide({ state: S, today: "2026-09-04", probeStatus: "500" });
  assertEqual(r.decision, "ROTATE");
  assertEqual(r.reason, "age-threshold");
});

// ===========================================================================
console.log("\n--- --force ---");

it("--force は期日前でも ROTATE（初回ブートストラップ用）", () => {
  const r = decide({ state: S, today: "2026-08-10", force: true });
  assertEqual(r.decision, "ROTATE");
  assertEqual(r.reason, "force");
});

it("--force は状態ファイルが無くても ROTATE できる", () => {
  const r = decide({ state: null, today: "2026-08-10", force: true });
  assertEqual(r.decision, "ROTATE");
  assertEqual(r.reason, "force");
  assertEqual(r.exitCode, 0);
});

// ===========================================================================
console.log("\n--- fail-loud（分からないときに黙って進まない） ---");

it("状態ファイルが無い → ERROR / 終了コード 2", () => {
  const r = decide({ state: null, today: "2026-08-10" });
  assertEqual(r.decision, "ERROR");
  assertEqual(r.reason, "state-missing");
  assertEqual(r.exitCode, 2);
});

it("状態ファイルが JSON として壊れている → ERROR / 終了コード 2", () => {
  const r = decide({ state: "{ this is not json", today: "2026-08-10" });
  assertEqual(r.decision, "ERROR");
  assertEqual(r.reason, "state-unparseable");
  assertEqual(r.exitCode, 2);
});

it("issued_at が欠けている → ERROR / 終了コード 2", () => {
  const r = decide({ state: { env: "staging" }, today: "2026-08-10" });
  assertEqual(r.decision, "ERROR");
  assertEqual(r.reason, "state-issued-at-invalid");
  assertEqual(r.exitCode, 2);
});

it("issued_at が日付でない → ERROR / 終了コード 2", () => {
  const r = decide({ state: { issued_at: "2026/08/10" }, today: "2026-08-10" });
  assertEqual(r.decision, "ERROR");
  assertEqual(r.reason, "state-issued-at-invalid");
  assertEqual(r.exitCode, 2);
});

it("発行日が未来（時計のずれ / 状態ファイル取り違え）→ ERROR / 終了コード 2", () => {
  const r = decide({ state: S, today: "2026-08-01" });
  assertEqual(r.decision, "ERROR");
  assertEqual(r.reason, "state-issued-in-future");
  assertEqual(r.exitCode, 2);
});

it("基準日そのものが不正 → ERROR / 終了コード 2", () => {
  const r = decide({ state: S, today: "yesterday" });
  assertEqual(r.decision, "ERROR");
  assertEqual(r.reason, "today-invalid");
  assertEqual(r.exitCode, 2);
});

// ===========================================================================
console.log("\n--- しきい値の可変性 ---");

it("LTR_ROTATE_AFTER_DAYS を変えると判定日が動く（20 日運用にもできる）", () => {
  const res = runBash("ltr_decide", {
    LTR_STATE_JSON: JSON.stringify(S),
    LTR_TODAY: "2026-08-30", // 20 日経過
    LTR_FORCE: "0",
    LTR_PROBE_STATUS: "",
    LTR_ROTATE_AFTER_DAYS: "20",
  });
  assertEqual(/^DECISION=ROTATE$/m.test(res.stdout), true, res.stdout);
  assertEqual(/^REASON=age-threshold$/m.test(res.stdout), true, res.stdout);
});

// ===========================================================================
console.log("\n--- 秘密が出力に混ざらない ---");

it("判定の出力は 4 行の KEY=VALUE のみ（トークンを載せる余地がない）", () => {
  const res = runBash("ltr_decide", {
    LTR_STATE_JSON: JSON.stringify({ ...S, access_token: "SHOULD-NEVER-BE-PRINTED" }),
    LTR_TODAY: "2026-09-04",
    LTR_FORCE: "0",
    LTR_PROBE_STATUS: "",
  });
  const lines = res.stdout.trim().split("\n");
  assertEqual(lines.length, 4, res.stdout);
  assertEqual(res.stdout.includes("SHOULD-NEVER-BE-PRINTED"), false, res.stdout);
  for (const line of lines) {
    assertEqual(/^[A-Z_]+=[-A-Za-z0-9]*$/.test(line), true, `想定外の出力行: ${line}`);
  }
});

it("状態ファイルの雛形にトークンらしき項目が無い", () => {
  const example = path.join(REPO_ROOT, "scripts/line-token-state.json.example");
  assertEqual(existsSync(example), true, example);
  const parsed = runBash(`jq -r 'keys | join(",")' "${example}"`).stdout.trim();
  for (const banned of ["access_token", "token", "secret", "channel_secret"]) {
    assertEqual(
      parsed.split(",").some((k) => k === banned),
      false,
      `雛形に ${banned} が含まれています: ${parsed}`,
    );
  }
});

// ===========================================================================
console.log("\n--- 検証工程の送り方（URL エンコード漏れの再発防止） ---");

// 背景: 発行されるトークンは base64 系で '+' を含む。x-www-form-urlencoded では
// '+' は空白として解釈されるため、素の `--data` で送ると LINE 側には別の文字列が
// 届き、正しいトークンでも verify が必ず HTTP 400 になっていた
// (Issue: line-rot-verify-400 / ローテーションが構造的に完了できない)。
const MAIN_SRC = readFileSync(MAIN_SCRIPT, "utf8");

it("verify 工程は --data-urlencode で送る（素の --data に戻っていない）", () => {
  assertEqual(
    /--data-urlencode\s+"access_token@/.test(MAIN_SRC),
    true,
    "verify の送信が --data-urlencode ではありません",
  );
  assertEqual(
    MAIN_SRC.includes("printf 'access_token=%s'"),
    false,
    "verify ボディを自前で 'access_token=' 連結しています（'+' が壊れる旧実装）",
  );
});

it("verify のトークンは argv ではなくファイル経由（ps から見えない）", () => {
  // `name@file` 形式であること = 値そのものがコマンドラインに載らない
  assertEqual(/--data-urlencode\s+"access_token@\$TMPDIR_WORK\//.test(MAIN_SRC), true);
});

/**
 * 実測による再発防止: ローカルの HTTP サーバへ 2 通りの送り方で POST し、
 * 受信側が復号したトークンが元の値と一致するかを見る。
 * LINE へは一切繋がず、秘密も使わない（'+' を含むダミー値のみ）。
 */
function decodedTokenViaCurl(curlArgs: (bodyFile: string) => string[], token: string): string {
  const workDir = mkdtempSync(path.join(tmpdir(), "ltr-encode-test-"));
  const bodyFile = path.join(workDir, "token");
  const portFile = path.join(workDir, "port");
  const serverFile = path.join(workDir, "server.mjs");

  // 受信側: x-www-form-urlencoded として解釈し、access_token の値をそのまま返す。
  writeFileSync(
    serverFile,
    `import http from "node:http";
import { writeFileSync } from "node:fs";
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const value = new URLSearchParams(raw).get("access_token") ?? "";
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(value);
  });
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(process.argv[2], String(server.address().port));
});
`,
  );

  const child = spawn(process.execPath, [serverFile, portFile], { stdio: "ignore" });
  try {
    let port = "";
    for (let i = 0; i < 100 && !port; i++) {
      if (existsSync(portFile)) port = readFileSync(portFile, "utf8").trim();
      if (!port) execFileSync("sleep", ["0.05"]);
    }
    if (!port) throw new Error("ローカルサーバが起動しませんでした");

    writeFileSync(bodyFile, token, { mode: 0o600 });
    return execFileSync(
      "curl",
      [
        "-s",
        "-X",
        "POST",
        "-H",
        "Content-Type: application/x-www-form-urlencoded",
        ...curlArgs(bodyFile),
        `http://127.0.0.1:${port}/v2/oauth/verify`,
      ],
      { encoding: "utf8" },
    );
  } finally {
    child.kill();
    rmSync(workDir, { recursive: true, force: true });
  }
}

// LINE のトークンと同じ性質（'+' '/' '=' を含む）のダミー値。秘密ではない。
const PLUS_TOKEN = "aa+bb/cc+dd==";

it("旧実装の送り方だとトークンが壊れて届く（'+' が空白になる）", () => {
  const received = decodedTokenViaCurl(
    (bodyFile) => {
      const withPrefix = `${bodyFile}.prefixed`;
      writeFileSync(withPrefix, `access_token=${PLUS_TOKEN}`, { mode: 0o600 });
      return ["--data", `@${withPrefix}`];
    },
    PLUS_TOKEN,
  );
  assertEqual(received === PLUS_TOKEN, false, `壊れずに届いてしまった: ${received}`);
  assertEqual(received, "aa bb/cc dd==");
});

it("現行実装の送り方ならトークンがそのまま届く", () => {
  const received = decodedTokenViaCurl(
    (bodyFile) => ["--data-urlencode", `access_token@${bodyFile}`],
    PLUS_TOKEN,
  );
  assertEqual(received, PLUS_TOKEN);
});

// ===========================================================================
console.log("\n--- 更新先（Cloudflare だけでなく Vercel も）---");

// prod のトークンは Cloudflare Worker と Web アプリ (Vercel) の 2 箇所で消費される。
// 更新先が片方だけだと、もう片方が 30 日で無言に失効する。
it("prod は Vercel の production を更新対象にする", () => {
  assertEqual(/VERCEL_TARGET_ENV="production"/.test(MAIN_SRC), true);
  assertEqual(/vercel env add "\$TARGET_SECRET" "\$VERCEL_TARGET_ENV"/.test(MAIN_SRC), true);
});

it("staging は Vercel を更新しない（検証用トークンを本番 Web アプリに入れない）", () => {
  assertEqual(/VERCEL_TARGET_ENV=""/.test(MAIN_SRC), true);
});

it("Vercel へ渡す値は標準入力（argv にトークンを載せない）", () => {
  assertEqual(
    /printf '%s' "\$NEW_TOKEN"\s*\\\n\s*\| vercel env add/.test(MAIN_SRC),
    true,
    "vercel へ標準入力で渡していません",
  );
});

it("Vercel を更新できない環境ならトークン発行前に落ちる（片方だけ更新しない）", () => {
  // 前提チェック節（＝発行 API を実際に叩く行より前）に vercel の可用性チェックがあること。
  // 冒頭のコメントにも同じ URL が出るので、curl の実行行そのものを目印にする。
  const preflightIndex = MAIN_SRC.indexOf("command -v vercel");
  const issueIndex = MAIN_SRC.indexOf('-X POST "$LINE_API_BASE/v2/oauth/accessToken"');
  assertEqual(preflightIndex > 0, true, "vercel の前提チェックがありません");
  assertEqual(
    preflightIndex < issueIndex,
    true,
    "vercel の前提チェックがトークン発行より後ろにあります",
  );
});

it("--skip-vercel / 環境変数で意図的にだけ飛ばせる", () => {
  assertEqual(MAIN_SRC.includes("--skip-vercel"), true);
  assertEqual(MAIN_SRC.includes("LINE_TOKEN_ROTATION_SKIP_VERCEL"), true);
});

it("Vercel は再デプロイまで新しい値を読まないことを警告する", () => {
  assertEqual(/再デプロイするまで新しい値を読みません/.test(MAIN_SRC), true);
});

// ===========================================================================
console.log(
  `\n=== ${passedTests}/${totalTests} passed` +
    (failedTests > 0 ? `, ${failedTests} FAILED ===` : " ==="),
);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
