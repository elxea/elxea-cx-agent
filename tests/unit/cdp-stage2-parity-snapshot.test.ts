/**
 * Unit — 観測を残す約束を「実ファイルの字面」で固定する（migration 048）
 *
 * ここで固定するのは **SQL の意味ではなく、SQL が書いてある内容** である。
 * plpgsql の意味（本当に冪等か・生成列が本当に効くか）は実 DB でしか言えないので
 * tests/db/cdp-stage2-parity-snapshot.db.test.ts が見る。ここが守るのは
 * 「実 DB を用意しなくても、約束が消えたら分かる」層:
 *
 *   1. 1 日 1 行である（snapshot_date が一意）
 *   2. 同じ日の再実行は行を増やさない（ON CONFLICT ... DO UPDATE）
 *   3. **グリーンの定義は 1 か所** で、比べる相手が 0 人の日を含まない
 *   4. 分母に「新側の件数」を混ぜていない（0 件の日の落とし穴が復活しない）
 *   5. 突合の判定を 048 に書き写していない（定義が 2 つに割れていない）
 *   6. 過ぎた日は書き換えられず、削除もできない
 *   7. 連続営業日の数え方が土日を除き、**観測が無い営業日で切れる**
 *   8. 新しい cron を増やしていない（Cloudflare の 5 本上限）
 *   9. migrate.ts が 048 を実在確認できる（sentinel 登録漏れが無い）
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INTROSPECTION, listMigrationFiles, versionOf, versionNumber } from "../../scripts/migrate";

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

const VERSION = "048_cdp_stage2_parity_snapshots";
const SQL_PATH = join(process.cwd(), "src/db/migrations", `${VERSION}.sql`);
const SQL = readFileSync(SQL_PATH, "utf8");

/** 空白の揺れを潰して字面を見る（改行・連続空白を 1 個の空白に）。 */
const FLAT = SQL.replace(/\s+/g, " ");

/** 書き手の関数本体だけを切り出す（他所の字面と混ざらないように）。 */
function functionBody(name: string): string {
  const start = FLAT.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
  assertTrue(start >= 0, `${name} が 048 に無い`);
  const rest = FLAT.slice(start);
  const end = rest.indexOf("$$ LANGUAGE");
  return end >= 0 ? rest.slice(0, end) : rest;
}

console.log("\n=== 048 が置かれていること ===");

it("048 は 047 の次の番号として足されている（適用済みを書き換えていない）", () => {
  const versions = listMigrationFiles().map(versionOf);
  const idx = versions.indexOf(VERSION);
  assertTrue(idx >= 0, "048 が migrations に無い");
  assertEqual(versions[idx - 1], "047_cdp_stage2_legacy_backfill", "048 の 1 つ前が 047 ではない");
  /* 旧版はここで「048 が最後の version であること」を確かめていた。それは
   * **意図（適用済みを書き換えず、次の番号として足した）ではなく時点**を固定して
   * しまう検査で、次の migration が足された瞬間に必ず落ちる（049 で実際に落ちた）。
   * 意図のほうを直接言い直す: 番号は単調増加で、後から番号が割り込まれていない。 */
  const numbers = versions.map(versionNumber);
  assertTrue(
    numbers.every((n, i) => i === 0 || n > numbers[i - 1]),
    `version の番号が単調増加していない（割り込み or 重複）: ${versions.join(", ")}`,
  );
});

it("migrate.ts が 048 を実在確認できる（sentinel 登録漏れが無い）", () => {
  const entry = INTROSPECTION[VERSION];
  assertTrue(entry !== undefined, "INTROSPECTION に 048 が無い");
  assertTrue(entry.idempotent, "048 が冪等として登録されていない");
  const keys = entry.specs.map((s) =>
    s.kind === "function" ? `function:${s.func}` : s.kind === "table" ? `table:${s.table}` : s.kind,
  );
  for (const need of [
    "table:cdp_stage2_parity_snapshots",
    "function:cdp_stage2_parity_snapshot",
    "function:cdp_stage2_parity_streak",
    "function:cdp_is_business_day",
  ]) {
    assertTrue(keys.includes(need), `sentinel に ${need} が無い`);
  }
});

console.log("\n=== 1 日 1 行 / 同じ日の再実行で増えない ===");

it("snapshot_date が一意（PRIMARY KEY）", () => {
  assertTrue(
    /PRIMARY KEY \(snapshot_date\)/.test(FLAT),
    "snapshot_date の一意制約が無い（同じ日が 2 行立ちうる = 連続日数が狂う）",
  );
});

it("書き手は同じ日を上書きする（ON CONFLICT ... DO UPDATE）", () => {
  const body = functionBody("cdp_stage2_parity_snapshot");
  assertTrue(
    /ON CONFLICT \(snapshot_date\) DO UPDATE/.test(body),
    "同じ日に 2 回走ると 2 行目が増える（冪等でない）",
  );
});

it("書き手は観測日を引数に取らない（過去の日を作り直せない）", () => {
  assertTrue(
    /CREATE OR REPLACE FUNCTION cdp_stage2_parity_snapshot\(\)/.test(FLAT),
    "書き手が引数を取っている（呼び出し側が観測日を決められてしまう）",
  );
});

console.log("\n=== グリーンの定義は 1 か所・0 件の日を含まない ===");

it("is_green は生成列で、compared_count > 0 を含む", () => {
  const m = /is_green\s+boolean\s+GENERATED ALWAYS AS \(([^)]*compared_count > 0)\) STORED/.exec(
    FLAT,
  );
  assertTrue(m !== null, "is_green が「in_agreement AND compared_count > 0」の生成列になっていない");
  assertTrue(
    /in_agreement AND compared_count > 0/.test(m![1]),
    `グリーンの式が変わっている: ${m?.[1]}`,
  );
});

it("グリーンの式は表に 1 つだけ（読み口が別定義を持たない）", () => {
  const occurrences = FLAT.split("GENERATED ALWAYS AS").length - 1;
  assertEqual(occurrences, 1, "生成列が複数ある（グリーンの定義が割れている）");
});

it("compared_count は必須（NOT NULL）で負を取らない", () => {
  assertTrue(
    /compared_count\s+bigint\s+NOT NULL CHECK \(compared_count >= 0\)/.test(FLAT),
    "compared_count が NOT NULL / CHECK になっていない",
  );
});

it("分母は旧台帳 2 冊だけを数える（新側の件数を混ぜない）", () => {
  const body = functionBody("cdp_stage2_parity_snapshot");
  const cmp = /v_cmp := ([\s\S]*?);/.exec(body);
  assertTrue(cmp !== null, "compared_count の組み立てが見つからない");
  const expr = cmp![1];
  assertTrue(expr.includes("linked_ledger_rows"), "旧台帳 customer_linkages を数えていない");
  assertTrue(expr.includes("identity_map_linked_rows"), "旧台帳 user_identity_map を数えていない");
  // ここに新側を足すと、旧が 0 件の日でも分母が立ち、0 件の日の落とし穴が復活する。
  assertTrue(!expr.includes("links_total"), "分母に links_total（新側）が混ざっている");
  assertTrue(
    !expr.includes("delivery_identity_rows"),
    "分母に delivery_identity_rows（派生）が混ざっている",
  );
});

console.log("\n=== 判定を 048 に書き写していない ===");

it("書き手は 044 の関数を呼ぶ（突合の SQL を写さない）", () => {
  const body = functionBody("cdp_stage2_parity_snapshot");
  assertTrue(/v_raw := cdp_stage2_parity\(\)/.test(body), "cdp_stage2_parity() を呼んでいない");
  for (const table of ["customer_linkages", "user_identity_map", "identity_edges", "subject_links"]) {
    assertTrue(
      !body.includes(table),
      `書き手が ${table} を直接引いている（判定の定義が 2 か所に割れる）`,
    );
  }
});

it("in_agreement は写すだけで、条件を組み直していない", () => {
  const body = functionBody("cdp_stage2_parity_snapshot");
  assertTrue(
    /v_agree := coalesce\(\(v_raw ->> 'in_agreement'\)::boolean, false\)/.test(body),
    "in_agreement を 044 の戻りから写していない（判定を作り直している）",
  );
});

console.log("\n=== 追記専用（過ぎた日は不変・削除不可）===");

it("DELETE は常に禁止", () => {
  const body = functionBody("cdp_parity_snapshot_guard");
  assertTrue(
    /TG_OP = 'DELETE'[\s\S]*?RAISE EXCEPTION/.test(body),
    "DELETE を止めていない（観測の履歴が消せる）",
  );
});

it("UPDATE は「今日の行」だけ（過ぎた日は書き換えられない）", () => {
  const body = functionBody("cdp_parity_snapshot_guard");
  assertTrue(
    /OLD\.snapshot_date <> v_today[\s\S]*?RAISE EXCEPTION/.test(body),
    "過ぎた日の書き換えを止めていない",
  );
  assertTrue(
    /NEW\.snapshot_date IS DISTINCT FROM OLD\.snapshot_date[\s\S]*?RAISE EXCEPTION/.test(body),
    "snapshot_date の付け替えを止めていない",
  );
});

it("ガードが表に付いている（BEFORE UPDATE OR DELETE）", () => {
  assertTrue(
    /CREATE TRIGGER cdp_stage2_parity_snapshots_append_only BEFORE UPDATE OR DELETE ON cdp_stage2_parity_snapshots/.test(
      FLAT,
    ),
    "追記専用のトリガが表に付いていない",
  );
});

it("RLS が有効（017 の方針どおり service_role のみ）", () => {
  assertTrue(
    /ALTER TABLE cdp_stage2_parity_snapshots ENABLE ROW LEVEL SECURITY/.test(FLAT),
    "RLS が有効化されていない",
  );
});

it("書き手は匿名の呼び出しから閉じてある", () => {
  assertTrue(
    /REVOKE ALL ON FUNCTION cdp_stage2_parity_snapshot\(\) FROM PUBLIC/.test(FLAT),
    "書き込む RPC が PUBLIC に開いている（anon 鍵は公開値）",
  );
  assertTrue(
    /GRANT EXECUTE ON FUNCTION cdp_stage2_parity_snapshot\(\) TO service_role/.test(FLAT),
    "service_role に実行権が無い（日次 tick が呼べなくなる）",
  );
});

console.log("\n=== 連続営業日の数え方 ===");

it("営業日は月〜金（土日を除く）", () => {
  assertTrue(
    /CREATE OR REPLACE FUNCTION cdp_is_business_day\(p_date date\) RETURNS boolean AS \$\$ SELECT extract\(isodow FROM p_date\) BETWEEN 1 AND 5;/.test(
      FLAT,
    ),
    "営業日の定義が「ISO の月〜金」になっていない",
  );
});

it("読み口は生成列を読む（自前でグリーンを組み直さない）", () => {
  const body = functionBody("cdp_stage2_parity_streak");
  assertTrue(/v_row\.is_green/.test(body), "読み口が is_green を読んでいない");
  assertTrue(
    !/in_agreement AND compared_count > 0/.test(body),
    "読み口がグリーンの式を組み直している（定義が 2 か所になる）",
  );
});

it("観測が無い営業日は連続を切る（見ていない日を緑とみなさない）", () => {
  const body = functionBody("cdp_stage2_parity_streak");
  assertTrue(/'missing'/.test(body), "観測が無い日の扱いが無い");
  assertTrue(
    /IF v_status = 'green' THEN v_streak := v_streak \+ 1; ELSE v_counting := false;/.test(body),
    "green 以外（missing / mismatch / nothing_compared）で連続が切れる形になっていない",
  );
});

it("0 件だった日は理由が分かる名前で切れる", () => {
  const body = functionBody("cdp_stage2_parity_streak");
  assertTrue(
    /WHEN v_row\.compared_count = 0 THEN 'nothing_compared'/.test(body),
    "0 件の日が mismatch と同じ名前で数えられている（原因を取り違える）",
  );
});

it("観測が直近の営業日に届いていなければ目標を満たしたと言わない", () => {
  const body = functionBody("cdp_stage2_parity_streak");
  assertTrue(
    /'meets_target', \(v_streak >= p_target AND NOT v_is_stale\)/.test(body),
    "古い観測で meets_target が立ちうる",
  );
});

it("祝日を除いていないことを戻り自身が明示する", () => {
  const body = functionBody("cdp_stage2_parity_streak");
  assertTrue(
    /'holidays_excluded', false/.test(body),
    "祝日の扱いが戻りに書かれていない（読み手が取り違える）",
  );
  assertTrue(/'days', v_days/.test(body), "営業日ごとの内訳を返していない（祝日の数え直しができない）");
});

console.log("\n=== 新しい cron を増やしていない ===");

it("wrangler.toml の本番 crons は 1 本のまま（Cloudflare の 5 本上限）", () => {
  const toml = readFileSync(join(process.cwd(), "wrangler.toml"), "utf8");
  const m = /\[triggers\]\s*\ncrons = \[([^\]]*)\]/.exec(toml);
  assertTrue(m !== null, "top-level [triggers] が読めない");
  const patterns = m![1].split(",").map((s) => s.trim()).filter(Boolean);
  assertEqual(patterns.length, 1, `本番 cron が増えている: ${m?.[1]}`);
  assertEqual(patterns[0], '"0 18 * * *"', "本番 cron のパターンが変わっている");
});

it("観測は既存の日次 tick から呼ばれている（新しい入口を作っていない）", () => {
  const index = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");
  const sync = /const runDailySync = \(\) =>([\s\S]*?)\n    \];?\n?/.exec(index);
  assertTrue(index.includes("runStage2Parity(env)"), "日次 tick が観測を呼んでいない");
  assertTrue(sync === null || sync[1].includes("runStage2Parity(env)"), "観測が日次 tick の外に出た");
});

console.log(`\n=== 結果: ${passed}/${total} PASS ===`);
if (failures.length > 0) {
  console.error("\n失敗:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
