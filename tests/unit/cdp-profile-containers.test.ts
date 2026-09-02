/**
 * Unit — 取り返せない 3 つの材料の器（B-1 / B-2 / B-3・migration 054）を DB 抜きで固定する
 *
 * ここで固定するのは 5 つ:
 *   ① 語彙が TS 側と SQL 側で **1 文字も違わない**（イベントの意向 / 6 つの窓 /
 *      触れ方 / 変更の種類）
 *   ② 新しい 4 つの出来事が登録簿に載っており、payload の形が読めること
 *   ③ 畳み手（cdp_l1_build_profile）に 4 つの枝がそろっていること
 *      — PROFILE_EVENT_TYPES と CASE の 1 対 1 という既存の約束を崩さない
 *   ④ 足した 3 列が **検算（E8'）の比較対象に入っている**
 *      — 入っていないと、新しい列だけが黙って検算の外に出る（051 が名指しした穴）
 *   ⑤ 第1段の姿勢が守られている（代表値を出さない / 6 分類が閉じている）
 *
 * 畳んだ結果そのもの（L1 に何が入るか）は tests/db/*.db.test.ts が実 DB で見る。
 * ここは「実 DB を用意しなくても、設計上の穴が開いたら落ちる」層。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  EVENT_INTEREST_MODES,
  CONTENT_WINDOWS,
  CONTENT_WINDOW_LABELS,
  WINDOW_MODES,
  ASSIGNMENT_CHANGE_ACTIONS,
  PROFILE_EVENT_TYPES,
  KNOWN_EVENT_TYPES,
  isEventInterestMode,
  isContentWindow,
  isWindowMode,
  isAssignmentChangeAction,
  isProfileEventType,
  isWellFormedPayload,
} from "../../src/lib/cdp/event-vocabulary";

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
function assertArrayEqual(a: readonly string[], b: readonly string[], label: string) {
  if (a.length !== b.length || a.some((x, i) => x !== b[i])) {
    throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

const MIG_DIR = join(process.cwd(), "src/db/migrations");
const M054 = "054_cdp_interest_window_change_containers.sql";
const SQL_054 = readFileSync(join(MIG_DIR, M054), "utf8");

/** migration ファイル名を番号の降順で返す（新しいものが先 = CREATE OR REPLACE の実物）。 */
function migrationsNewestFirst(): string[] {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => b.localeCompare(a, "en"));
}

/** その関数を **最後に定義している** migration の、その関数の本体を返す。 */
function latestFunctionBody(func: string): { file: string; body: string } {
  const head = new RegExp(`CREATE OR REPLACE FUNCTION\\s+${func}\\s*\\(`);
  for (const file of migrationsNewestFirst()) {
    const text = readFileSync(join(MIG_DIR, file), "utf8");
    const m = head.exec(text);
    if (!m) continue;
    const end = text.indexOf("$$ LANGUAGE", m.index);
    if (end < 0) throw new Error(`${func}: ${file} で本体の終わりが見つからない`);
    return { file, body: text.slice(m.index, end) };
  }
  throw new Error(`${func}: どの migration にも定義が無い`);
}

/** `SELECT ARRAY['a', 'b']::text[];` を返す SQL 関数から、リテラルの並びを抜く。 */
function sqlArrayLiterals(func: string): string[] {
  const { body } = latestFunctionBody(func);
  const m = /ARRAY\[([^\]]*)\]/.exec(body);
  if (!m) throw new Error(`${func}: ARRAY[...] を読み取れない（形が変わった？）`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

console.log("\n=== ① 語彙が 2 か所で食い違っていない（TS ↔ SQL） ===");

it("参加の意向が TS と SQL で同一・同順", () => {
  assertArrayEqual(sqlArrayLiterals("cdp_event_interest_modes"), EVENT_INTEREST_MODES, "modes");
});

it("6 つの窓が TS と SQL で同一・同順", () => {
  assertArrayEqual(sqlArrayLiterals("cdp_content_windows"), CONTENT_WINDOWS, "windows");
});

it("窓への触れ方が TS と SQL で同一・同順", () => {
  assertArrayEqual(sqlArrayLiterals("cdp_window_modes"), WINDOW_MODES, "modes");
});

it("変更の種類が TS と SQL で同一・同順", () => {
  assertArrayEqual(
    sqlArrayLiterals("cdp_assignment_change_actions"),
    ASSIGNMENT_CHANGE_ACTIONS,
    "actions",
  );
});

it("窓は正本の 6 つ（お茶・文学・アート・音楽・農・科学）である", () => {
  // 正本 序章3「複数の窓（お茶・文学・アート・音楽・農・科学）」。数も並びも
  // ここで留める。**暫定であること自体は変わらない**（アンケート 2 問目で見直す）が、
  // 見直しは設計判断としてこのテストごと直すべきもので、黙って増減してよい値ではない。
  assertEqual(CONTENT_WINDOWS.length, 6, "窓の数");
  assertArrayEqual(
    CONTENT_WINDOWS.map((w) => CONTENT_WINDOW_LABELS[w]),
    ["お茶", "文学", "アート", "音楽", "農", "科学"],
    "窓の日本語名",
  );
});

it("判定関数が語彙の外を通さない", () => {
  assertTrue(isEventInterestMode("not_now"), "not_now は語彙にある");
  assertTrue(!isEventInterestMode("maybe"), "maybe は語彙に無い");
  assertTrue(isContentWindow("farming"), "farming は語彙にある");
  assertTrue(!isContentWindow("food"), "food は語彙に無い");
  assertTrue(isWindowMode("saved"), "saved は語彙にある");
  assertTrue(!isWindowMode("like"), "like は語彙に無い");
  assertTrue(isAssignmentChangeAction("replace"), "replace は語彙にある");
  assertTrue(!isAssignmentChangeAction("swap"), "swap は語彙に無い");
});

console.log("\n=== ② 新しい 4 つの出来事と、payload の形 ===");

const NEW_EVENTS = [
  "event.interest_declared",
  "event.attended",
  "window.entered",
  "assignment.changed",
] as const;

it("4 つとも L1 を動かす出来事として登録されている", () => {
  for (const t of NEW_EVENTS) {
    assertTrue(isProfileEventType(t), `${t} が PROFILE_EVENT_TYPES に無い`);
    assertTrue(KNOWN_EVENT_TYPES.has(t), `${t} が既知の語彙に無い`);
    assertTrue(
      (PROFILE_EVENT_TYPES as readonly string[]).includes(t),
      `${t} が PROFILE_EVENT_TYPES の配列に無い`,
    );
  }
});

it("B-1 参加の意向: 語彙どおりの mode だけを通す", () => {
  assertTrue(
    isWellFormedPayload("event.interest_declared", { mode: "onsite" }),
    "onsite が通らない",
  );
  assertTrue(
    isWellFormedPayload("event.interest_declared", { mode: "not_now" }),
    "not_now が通らない（降りる意思も材料である）",
  );
  assertTrue(
    !isWellFormedPayload("event.interest_declared", { mode: "maybe" }),
    "語彙外の mode が通ってしまう",
  );
  assertTrue(!isWellFormedPayload("event.interest_declared", {}), "空が通ってしまう");
});

it("B-1 出た回: 回の参照が要る", () => {
  assertTrue(isWellFormedPayload("event.attended", { event_ref: "ev-2026-10" }), "参照が通らない");
  assertTrue(!isWellFormedPayload("event.attended", { event_ref: "  " }), "空白だけが通ってしまう");
  assertTrue(!isWellFormedPayload("event.attended", {}), "参照なしが通ってしまう");
});

it("B-2 窓: 窓・参照・触れ方の 3 つがそろって初めて通る", () => {
  const ok = { window: "music", ref: "article-42", mode: "listen" };
  assertTrue(isWellFormedPayload("window.entered", ok), "正しい形が通らない");
  assertTrue(
    !isWellFormedPayload("window.entered", { ...ok, window: "food" }),
    "語彙外の窓が通ってしまう",
  );
  assertTrue(
    !isWellFormedPayload("window.entered", { ...ok, mode: "like" }),
    "語彙外の触れ方が通ってしまう",
  );
  assertTrue(
    !isWellFormedPayload("window.entered", { window: "music", mode: "listen" }),
    "参照なしが通ってしまう（A-2 の検算ができなくなる）",
  );
});

it("B-3 変更: 対象の月と、中身のある変更が要る", () => {
  const ok = {
    period: "2026-10",
    changes: [{ action: "replace", ref: "11301", replaced_ref: "40201" }],
  };
  assertTrue(isWellFormedPayload("assignment.changed", ok), "正しい形が通らない");
  assertTrue(
    !isWellFormedPayload("assignment.changed", { ...ok, period: "2026-10-01" }),
    "日付が YYYY-MM として通ってしまう",
  );
  assertTrue(
    !isWellFormedPayload("assignment.changed", { period: "2026-10", changes: [] }),
    "空の changes が通ってしまう（何も変えていない『変えた』が積まれる）",
  );
  assertTrue(
    !isWellFormedPayload("assignment.changed", {
      period: "2026-10",
      changes: [{ action: "swap", ref: "11301" }],
    }),
    "語彙外の action が通ってしまう",
  );
  assertTrue(
    !isWellFormedPayload("assignment.changed", {
      period: "2026-10",
      changes: [{ action: "add" }],
    }),
    "参照なしの変更が通ってしまう",
  );
});

console.log("\n=== ③ 畳み手に 4 つの枝がそろっている（PROFILE_EVENT_TYPES と 1 対 1） ===");

it("cdp_l1_build_profile が 4 つの出来事を畳む枝を持っている", () => {
  const { file, body } = latestFunctionBody("cdp_l1_build_profile");
  for (const t of NEW_EVENTS) {
    assertTrue(
      body.includes(`WHEN '${t}' THEN`),
      `${file} に ${t} を畳む枝が無い（積んでも解釈に入らない）`,
    );
  }
});

it("L1 を動かす出来事すべてに、畳み手の枝がある（1 対 1 の約束）", () => {
  // 語彙に足したのに畳み手に足し忘れる、が起きない。既存 12 個も含めて見る。
  const { body } = latestFunctionBody("cdp_l1_build_profile");
  const missing = PROFILE_EVENT_TYPES.filter((t) => !body.includes(`WHEN '${t}' THEN`));
  assertEqual(missing.length, 0, `畳み手に枝が無い出来事: ${JSON.stringify(missing)}`);
});

console.log("\n=== ④ 足した 3 列が検算（E8'）の比較対象に入っている ===");

const NEW_COLUMNS = ["event_interest", "window_leaning", "assignment_changes"] as const;

it("cdp_l1_build_profile が 3 列とも導出値として返す", () => {
  const { body } = latestFunctionBody("cdp_l1_build_profile");
  for (const c of NEW_COLUMNS) {
    assertTrue(body.includes(`'${c}',`), `導出値に ${c} が無い`);
  }
});

it("cdp_l1_recompute_parity が 3 列とも比べている", () => {
  // 051 が明記した穴: 比較対象に足さないと「新しい列だけが黙って検算の外に出る」。
  // 書き込み側の網羅は tests/unit/cdp-l1-refold.test.ts が全 ADD COLUMN で見ているが、
  // **検算側の網羅はどこも見ていなかった**。ここで留める。
  const { file, body } = latestFunctionBody("cdp_l1_recompute_parity");
  for (const c of NEW_COLUMNS) {
    assertTrue(body.includes(`r.${c}`), `${file} が ${c} を比べていない`);
  }
});

it("形の版は相変わらず検算の外にある（054 で混ぜていない）", () => {
  // 052 が置いた線引き（版は保管側の情報であって解釈ではない）を後退させない。
  const build = latestFunctionBody("cdp_l1_build_profile").body;
  const parity = latestFunctionBody("cdp_l1_recompute_parity").body;
  assertTrue(!build.includes("shape_fingerprint"), "畳み手が形の版を返している");
  assertTrue(!parity.includes("shape_fingerprint"), "検算が形の版を比べている");
});

console.log("\n=== ⑤ 第1段の姿勢（材料だけ・推論しない） ===");

it("窓に代表値（primary）を置いていない", () => {
  // A-2（記事への目印付け）が終わるまで材料は 0 件で入る。0 件のうちから
  // primary を出す枝があると、1 タップで「文学の人」が決まる。
  const { body } = latestFunctionBody("cdp_l1_build_profile");
  const m = /'window_leaning',\s*jsonb_build_object\(([\s\S]*?)\n {4}\)/.exec(body);
  assertTrue(m !== null, "window_leaning の組み立てが読み取れない（形が変わった？）");
  assertTrue(!m![1].includes("primary"), "window_leaning に primary が入っている");
});

it("窓の数え始めが 6 つとも 0 で埋まる（キーの集合が人によって変わらない）", () => {
  const zero = latestFunctionBody("cdp_window_zero").body;
  assertTrue(zero.includes("cdp_content_windows()"), "語彙から作っていない（列挙を写している）");
  assertTrue(zero.includes("jsonb_object_agg"), "0 埋めの入れ物を作っていない");
});

it("窓の出所は observed のみ（本人に聞かない）", () => {
  // 正本 第4章「後から集計できる形にする（聞かない）」。declared に上がる枝を作らない。
  const { body } = latestFunctionBody("cdp_l1_build_profile");
  const branch = /WHEN 'window\.entered' THEN([\s\S]*?)(?=\n {6}\/\*\*|\n {6}WHEN |\n {6}ELSE)/.exec(
    body,
  );
  assertTrue(branch !== null, "window.entered の枝が読み取れない");
  assertTrue(
    branch![1].includes("'window_leaning', 'observed'"),
    "窓の出所が observed になっていない",
  );
  assertTrue(
    !branch![1].includes("'window_leaning', 'declared'"),
    "窓に declared へ上がる枝がある（聞かない、が破れている）",
  );
});

console.log("\n=== 054 の形（当てられる SQL になっているか） ===");

it("054 の $$ が対応している", () => {
  const dollars = (SQL_054.match(/\$\$/g) ?? []).length;
  assertTrue(dollars > 0, "$$ が 1 つも無い");
  assertEqual(dollars % 2, 0, `$$ の数が奇数（${dollars}）`);
});

it("054 が 051 / 052 適用済みを前提として確かめている", () => {
  assertTrue(SQL_054.includes("cdp_provenance_put") && /RAISE EXCEPTION[\s\S]{0,120}051/.test(SQL_054), "051 の前提確認が無い");
  assertTrue(
    SQL_054.includes("cdp_l1_shape_fingerprint") && /RAISE EXCEPTION[\s\S]{0,140}052/.test(SQL_054),
    "052 の前提確認が無い",
  );
});

it("054 が既存 profile を全件畳み直す（一回性の是正）", () => {
  assertTrue(
    /FOREACH\s+v_id\s+IN ARRAY/.test(SQL_054) && SQL_054.includes("cdp_l1_recompute_subject(v_id)"),
    "既存 profile の強制畳み直しが無い",
  );
  assertTrue(
    /array_agg\(p\.subject_id/.test(SQL_054),
    "先に id を確定させずに同じ表を舐めている（足元が崩れる）",
  );
});

it("054 が末尾で自己検査し、取り残しと「空のまま」の両方で失敗する", () => {
  const tail = SQL_054.slice(SQL_054.lastIndexOf("-- 7."));
  assertTrue(tail.includes("shape_fingerprint IS DISTINCT FROM"), "形の版の取り残しを数えていない");
  // 051 の障害の本体は「版は刻んだが中身は空」だった。版だけ見る自己検査は足りない。
  for (const c of NEW_COLUMNS) {
    assertTrue(tail.includes(`p.${c} = '{}'::jsonb`), `${c} が空のまま残っていないかを見ていない`);
  }
  assertEqual((tail.match(/RAISE EXCEPTION/g) ?? []).length, 2, "失敗させる枝の数（版 + 空の 2 つ）");
});

it("054 は追加のみ（列の削除・型変更・出来事の書き換えをしない）", () => {
  assertTrue(!/DROP\s+(TABLE|COLUMN)/i.test(SQL_054), "DROP TABLE / DROP COLUMN がある");
  assertTrue(!/ALTER\s+COLUMN/i.test(SQL_054), "ALTER COLUMN がある");
  assertTrue(!/\bUPDATE\s+customer_events\b/i.test(SQL_054), "L0 を書き換えている");
  assertTrue(!/\bDELETE\s+FROM\s+customer_events\b/i.test(SQL_054), "L0 を消している");
});

console.log(`\n=== cdp-profile-containers.test: ${passed}/${total} passed, ${failures.length} failed ===`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
