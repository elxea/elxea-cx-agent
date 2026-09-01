/**
 * Unit — L1 の畳み直しが「列が増えたこと」に気づく形になっているか（migration 052）
 *
 * ─ なぜこのテストが要るか（実障害の記録）─
 *
 *   051 を本番へ当てた直後、手順どおり cdp_l1_recompute_all() を呼んでも
 *   {"recomputed":0,"still_pending":0} で 1 件も畳み直されなかった。
 *   既存 6 profile の新列は DEFAULT '{}' のまま残り、E8' の検算が
 *   in_agreement=false（checked=6 / mismatched=6）になった。
 *
 *   根因は、畳み直しの要否を **last_event_seq だけ**で判定していたこと。
 *   051 は列を足しただけで出来事を増やしていないので、条件を満たさなかった。
 *   「出来事が増えた」は見ていたが「解釈の形が変わった」を見ていなかった。
 *
 * ─ ここで機械に留めること ─
 *
 *   (1) 判定に「形が変わった」が入っていること（同じ穴を二度踏まない）
 *   (2) 候補の取り方が customer_events 起点だけでないこと（2 つ目の穴）
 *   (3) **subject_profile に足した列を、書き込み側が全部書いていること**
 *       — これが今回の型の失敗を最も広く捕まえる。列を足して書き忘れれば落ちる。
 *   (4) 形の版が「解釈」ではなく「保管側の情報」として扱われていること
 *       （E8' の比較対象に混ぜない）
 *
 * ⚠ 実 DB は使わない。plpgsql の実行検証は tests/db/*.db.test.ts と本番適用の役目。
 *   ここは「実 DB を用意しなくても、設計上の穴が開いたら落ちる」層。
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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

const MIG_DIR = join(process.cwd(), "src/db/migrations");

/** migration ファイル名を番号の降順で返す（新しいものが先）。 */
function migrationsNewestFirst(): string[] {
  return readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => b.localeCompare(a, "en"));
}

function readMigration(file: string): string {
  return readFileSync(join(MIG_DIR, file), "utf8");
}

/**
 * その関数を **最後に定義している** migration の、その関数の本体を返す。
 *
 * CREATE OR REPLACE なので「最後に当たったものが実物」。番号の大きい方から探す。
 */
function latestFunctionBody(func: string): { file: string; body: string } {
  const head = new RegExp(`CREATE OR REPLACE FUNCTION\\s+${func}\\s*\\(`);
  for (const file of migrationsNewestFirst()) {
    const text = readMigration(file);
    const m = head.exec(text);
    if (!m) continue;
    const from = m.index;
    // 本体の終わり = 次に来る "$$ LANGUAGE"。
    const end = text.indexOf("$$ LANGUAGE", from);
    if (end < 0) throw new Error(`${func}: ${file} で本体の終わりが見つからない`);
    return { file, body: text.slice(from, end) };
  }
  throw new Error(`${func}: どの migration にも定義が無い`);
}

const M052 = "052_cdp_l1_refold_on_shape_change.sql";
const SQL_052 = readMigration(M052);

console.log("\n=== 052 の形（当てられる SQL になっているか） ===");

it("052 が存在し、$$ が対応している", () => {
  const dollars = (SQL_052.match(/\$\$/g) ?? []).length;
  assertTrue(dollars > 0, "$$ が 1 つも無い");
  assertEqual(dollars % 2, 0, `$$ の数が奇数（${dollars}）`);
});

it("形の版は STABLE で宣言されている（IMMUTABLE と偽らない）", () => {
  // information_schema を読むので、同じ引数でも DDL の前後で値が変わる。
  // IMMUTABLE と宣言すると index や生成列から呼べてしまい、静かに壊れる。
  const m = /CREATE OR REPLACE FUNCTION cdp_l1_shape_fingerprint[\s\S]*?\$\$ LANGUAGE sql (\w+);/.exec(
    SQL_052,
  );
  assertTrue(m !== null, "cdp_l1_shape_fingerprint の宣言が読めない");
  assertEqual(m![1], "STABLE", "volatility");
});

it("形の版は subject_profile の列構成から自動で導く（手で上げる版番号にしない）", () => {
  // 手で上げる方式は「上げ忘れ」が 051 の障害を再生産する。
  const body = latestFunctionBody("cdp_l1_shape_fingerprint").body;
  assertTrue(body.includes("information_schema.columns"), "列構成を読んでいない");
  assertTrue(body.includes("subject_profile"), "subject_profile を見ていない");
  assertTrue(/ORDER BY column_name/.test(body), "列順で結果が揺れないようにしていない");
});

console.log("\n=== 根因の再発防止（051 の障害そのもの） ===");

it("畳み直しの要否判定に「形が変わった」が入っている", () => {
  // これが 051 で欠けていた条件。無いと、列を足しても誰も畳み直されない。
  const { file, body } = latestFunctionBody("cdp_l1_recompute_all");
  assertTrue(
    /shape_fingerprint\s+IS DISTINCT FROM/.test(body),
    `cdp_l1_recompute_all（${file}）の判定に shape_fingerprint の比較が無い`,
  );
});

it("判定が last_event_seq だけに依存していない", () => {
  const { body } = latestFunctionBody("cdp_l1_recompute_all");
  const hasSeq = /last_event_seq\s*<\s*/.test(body);
  const hasShape = /shape_fingerprint/.test(body);
  assertTrue(hasSeq, "出来事が増えた条件が消えている（後退）");
  assertTrue(hasShape, "形が変わった条件が無い");
});

it("候補が customer_events 起点だけでない（出来事ゼロの行を取りこぼさない）", () => {
  // 046 は customer_events を GROUP BY した集合しか候補にせず、
  // 出来事が 1 件も無い profile 行は永久に畳み直されなかった（2 つ目の穴）。
  const { body } = latestFunctionBody("cdp_l1_recompute_all");
  assertTrue(/\bUNION\b/.test(body), "候補の和集合を取っていない");
  assertTrue(
    /FROM\s+subject_profile\s+p/.test(body),
    "subject_profile 側を候補に入れていない",
  );
});

it("候補が 1 人 1 行に畳まれている（同じ人を二度数えない）", () => {
  /**
   * 自己批判で見つけた欠陥の再発防止。
   *
   * 出来事のある人と L1 のある人を素の UNION で足すと、**両方に居る人**が
   *   (id, max_seq) と (id, NULL)
   * の 2 行になる。すると同じ人を 2 回畳み直し、still_pending も二重に数える。
   * 運用者はその数を見て「まだ移行が終わっていない」と誤読する。
   *
   * 候補は 2 か所（回す側 / 数え直す側）にあり、**両方**が畳まれている必要がある。
   * 片方だけ直すと、回す数と数える数が食い違って余計に分かりにくくなる。
   */
  const { body } = latestFunctionBody("cdp_l1_recompute_all");
  const bare = (body.match(/^\s*UNION\s*$/gm) ?? []).length;
  assertEqual(bare, 0, "素の UNION が残っている（同じ人が 2 行になる）");

  const unionAll = (body.match(/UNION ALL/g) ?? []).length;
  const grouped = (body.match(/GROUP BY u\.subject_id/g) ?? []).length;
  assertEqual(unionAll, 2, "UNION ALL の数（回す側 + 数え直す側の 2 か所）");
  assertEqual(grouped, 2, "1 人 1 行へ畳む GROUP BY の数（2 か所とも要る）");
});

it("残件の内訳に「形が古いせい」の数が出る", () => {
  // 「出来事が増えた」は次の tick で追いつくが、「形が古い」は移行が終わっていない印。
  // 1 つの数に畳むと区別できない。
  const { body } = latestFunctionBody("cdp_l1_recompute_all");
  assertTrue(body.includes("still_pending_shape"), "内訳が返り値に無い");
});

console.log("\n=== 列を足して書き忘れたら落ちる（今回の型の失敗を広く捕まえる） ===");

/** 全 migration から、subject_profile に足された列名を集める。 */
function columnsAddedToSubjectProfile(): string[] {
  const found = new Set<string>();
  for (const file of migrationsNewestFirst()) {
    const text = readMigration(file);
    // ALTER TABLE subject_profile ... ; の 1 文を取り出して ADD COLUMN を拾う。
    const re = /ALTER TABLE\s+subject_profile\b([\s\S]*?);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const stmt = m[1];
      const colRe = /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?([a-z_][a-z0-9_]*)/g;
      let c: RegExpExecArray | null;
      while ((c = colRe.exec(stmt)) !== null) found.add(c[1]);
    }
  }
  return [...found].sort();
}

/** 最新の cdp_l1_recompute_subject が INSERT する列名。 */
function columnsWrittenByRecomputeSubject(): string[] {
  const { body } = latestFunctionBody("cdp_l1_recompute_subject");
  const m = /INSERT INTO subject_profile\s*\(([\s\S]*?)\)\s*VALUES/.exec(body);
  if (!m) throw new Error("cdp_l1_recompute_subject の INSERT 列リストが読めない");
  return m[1]
    .split(",")
    .map((s) => s.replace(/--[^\n]*/g, "").trim())
    .filter((s) => /^[a-z_][a-z0-9_]*$/.test(s))
    .sort();
}

it("subject_profile に足した列は、書き込み側が全部書いている", () => {
  // 051 の失敗は「列を足したのに畳み直しが走らない」だったが、同じ型の失敗に
  // 「列を足したのに書き込み側が書かない」がある。どちらも列が DEFAULT のまま残る。
  const added = columnsAddedToSubjectProfile();
  assertTrue(added.length > 0, "ADD COLUMN を 1 つも拾えていない（検査が空回り）");

  const written = new Set(columnsWrittenByRecomputeSubject());
  const missing = added.filter((c) => !written.has(c));
  assertEqual(
    missing.length,
    0,
    `書き込み側が書いていない列がある: ${JSON.stringify(missing)}（足した列: ${JSON.stringify(added)}）`,
  );
});

it("051 で足した 3 列と 052 で足した 1 列が、確かに検査対象に入っている", () => {
  // 上の検査が「空の集合を通した」だけにならないことの確認。
  const added = columnsAddedToSubjectProfile();
  for (const c of ["taste", "scene", "provenance", "shape_fingerprint"]) {
    assertTrue(added.includes(c), `${c} が ADD COLUMN の抽出に入っていない`);
  }
});

console.log("\n=== 形の版は「解釈」ではなく「保管側の情報」 ===");

it("形の版は畳み方（build_profile）の返り値に入っていない", () => {
  // 入れると E8' の検算が「解釈が合っているか」ではなく「版が同じか」も見ることになり、
  // 意味が濁る。
  const { body } = latestFunctionBody("cdp_l1_build_profile");
  assertTrue(
    !body.includes("shape_fingerprint"),
    "cdp_l1_build_profile が形の版を返している",
  );
});

it("形の版は E8' の比較対象に入っていない", () => {
  const { body } = latestFunctionBody("cdp_l1_recompute_parity");
  assertTrue(
    !body.includes("shape_fingerprint"),
    "cdp_l1_recompute_parity が形の版を比べている",
  );
});

console.log("\n=== 当てたのに直っていない、を残さない ===");

it("052 が既存 profile を全件畳み直す（一回性の是正）", () => {
  assertTrue(
    /FOREACH\s+v_id\s+IN ARRAY/.test(SQL_052) &&
      SQL_052.includes("cdp_l1_recompute_subject(v_id)"),
    "既存 profile の強制畳み直しが無い",
  );
  // 走査中に対象が消えることへの備え（代表でなくなった行は DELETE される）。
  assertTrue(
    /array_agg\(p\.subject_id/.test(SQL_052),
    "先に id を確定させずに同じ表を舐めている（足元が崩れる）",
  );
});

it("052 が末尾で自己検査し、取り残しがあれば失敗する", () => {
  // 051 の障害は「適用は成功・中身は未是正」だった。運用者が parity を叩くまで
  // 気づけない状態を作らない。
  const tail = SQL_052.slice(SQL_052.lastIndexOf("-- 5."));
  assertTrue(tail.includes("shape_fingerprint IS DISTINCT FROM"), "取り残しを数えていない");
  assertTrue(/RAISE EXCEPTION/.test(tail), "取り残しがあっても失敗しない");
});

it("052 が 051 適用済みを前提として確かめている", () => {
  // 052 の是正は「051 の取り残し」を埋めるもの。順序を取り違えたまま進ませない。
  assertTrue(
    SQL_052.includes("column_name = 'taste'") && /RAISE EXCEPTION[\s\S]{0,120}051/.test(SQL_052),
    "051 の前提確認が無い",
  );
});

it("第1段の実装が古い migration 番号を指していない", () => {
  // QA 1 周目 F-1 の再発防止をここでも維持する（052 を対象に追加）。
  const stage1Files = [
    "src/lib/cdp/taste-axes.ts",
    "src/lib/cdp/event-vocabulary.ts",
    "src/lib/cdp/profile-intake.ts",
    "src/db/migrations/051_cdp_stage1_taste_scene_provenance.sql",
    "src/db/migrations/052_cdp_l1_refold_on_shape_change.sql",
    "docs/cdp-taste-axes-astringency-2026-09.md",
  ];
  for (const rel of stage1Files) {
    const text = readFileSync(join(process.cwd(), rel), "utf8");
    const hits = text
      .split("\n")
      .filter((l) => /(migration|--only)\s*0?48\b|\b048_cdp_stage1/.test(l));
    assertEqual(hits.length, 0, `${rel} が古い番号 048 を指している: ${JSON.stringify(hits)}`);
  }
});

console.log(`\n=== cdp-l1-refold.test: ${passed}/${total} passed, ${failures.length} failed ===`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
