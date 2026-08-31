/**
 * Unit — 取り消しの仕組み（migration 049）と、その監視値の是正（migration 050）を
 *        DB 抜きで固定する
 *
 * ここで固定するのは 3 つ。
 *
 *   (1) **049 が冪等であること。**
 *       049 は本番へ raw SQL で先に当たっており（2026-08-31）、ファイルは後から
 *       台帳（schema_migrations）を揃えるために置かれた。つまりこのファイルは
 *       「適用済みの本番でもう一度流されうる」前提で生きる。1 文でも非冪等な形が
 *       混ざると、その瞬間に「台帳を揃える」操作が本番を壊す操作に変わる。
 *       全文を文単位に割って、冪等な形の許可リストに入っていることを確かめる。
 *
 *   (2) **049 に本番固有のデータ是正（§B）が 1 行も入っていないこと。**
 *       本番適用時のトランザクションには ULID 直指定の是正 3 件が同居していた。
 *       それを migration に持ち込むと、新規構築 / staging で前提確認の DO ブロックが
 *       例外で止まる（対象行が無いため）。スキーマの版と、その環境固有の修理は
 *       別物として扱う。
 *
 *   (3) **050 が 049 の偽陽性だけを直していること。**
 *       cdp_retraction_summary() の subjects_without_live_edges は
 *       「live な鍵が無い主体」を数えていたが、関数コメントは
 *       「＝ 誰とも結ばれない主体」と言っている。誤った鍵を取り消して
 *       正しい人へ link で戻した主体（是正が正しく終わった姿）は、鍵は 0 本でも
 *       辿り着ける。旧定義はそれを迷子として数え、本番で恒常 1 を返していた。
 *       050 が (a) その 1 か所だけを直し (b) 他の 5 つの値の定義を変えていない
 *       ことを、SQL の本文から機械で確かめる。
 *       併せて、本番と同じ形のデータに対して 1 → 0 に戻り、かつ
 *       **鳴るべきときは鳴る**ことを、判定の模型で固定する。
 *
 * 実 DB での配線（トリガ・連結成分・消去）は tests/db/*.db.test.ts が見る。
 * ここは「実 DB を用意しなくても壊れたら分かる」層。
 *
 * 使用方法:
 *   npx tsx tests/unit/cdp-identity-retraction.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { INTROSPECTION, specKey, type ObjectSpec } from "../../scripts/migrate";

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
function assertDeep(a: unknown, b: unknown, label: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

// ---------------------------------------------------------------------------
// SQL を読むための最小の道具
//
// 正規表現で雑に切ると、関数本体（$$ ... $$）の中の `;` で文が割れ、
// 文字列リテラルの中の `--` がコメント扱いになる。どちらもこの 2 ファイルで
// 実際に起こる形なので、状態を持って走査する。
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = "src/db/migrations";
const FILE_049 = "049_cdp_identity_retraction.sql";
const FILE_050 = "050_cdp_retraction_summary_link_aware.sql";

function readMigration(file: string): string {
  return readFileSync(join(process.cwd(), MIGRATIONS_DIR, file), "utf8");
}

/**
 * `--` 行コメントを落とす。**文字列リテラルの中は落とさない**。
 *
 * $$ 引用（関数本体）の中は落とす — 本体にも説明の `--` が書かれており、
 * 049 と 050 の定義を突き合わせるときにコメントの差だけで「別物」になるのを避ける。
 * 本体の中でも文字列リテラルの追跡は続ける（'a--b' を壊さない）。
 */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  let inSingle = false;
  let dollarTag: string | null = null;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (dollarTag && !inSingle && rest.startsWith(dollarTag)) {
      out += dollarTag;
      i += dollarTag.length;
      dollarTag = null;
      continue;
    }
    if (inSingle) {
      if (sql[i] === "'" && sql[i + 1] === "'") {
        out += "''";
        i += 2;
        continue;
      }
      if (sql[i] === "'") inSingle = false;
      out += sql[i++];
      continue;
    }
    if (!dollarTag) {
      const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
      if (dollar) {
        dollarTag = dollar[0];
        out += dollarTag;
        i += dollarTag.length;
        continue;
      }
    }
    if (sql[i] === "'") {
      inSingle = true;
      out += sql[i++];
      continue;
    }
    if (rest.startsWith("--")) {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    out += sql[i++];
  }
  return out;
}

/** トップレベルの `;` で文に割る（$$ 引用と文字列リテラルの中では割らない）。 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let cur = "";
  let i = 0;
  let inSingle = false;
  let dollarTag: string | null = null;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (dollarTag) {
      if (rest.startsWith(dollarTag)) {
        cur += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      cur += sql[i++];
      continue;
    }
    if (inSingle) {
      if (sql[i] === "'" && sql[i + 1] === "'") {
        cur += "''";
        i += 2;
        continue;
      }
      if (sql[i] === "'") inSingle = false;
      cur += sql[i++];
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollar) {
      dollarTag = dollar[0];
      cur += dollarTag;
      i += dollarTag.length;
      continue;
    }
    if (sql[i] === "'") {
      inSingle = true;
      cur += sql[i++];
      continue;
    }
    if (sql[i] === ";") {
      const t = cur.trim();
      if (t) statements.push(t);
      cur = "";
      i++;
      continue;
    }
    cur += sql[i++];
  }
  const tail = cur.trim();
  if (tail) statements.push(tail);
  return statements;
}

/** 空白を 1 個に潰す（文の形の照合と、定義の同一性判定に使う）。 */
function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

const SQL_049 = readMigration(FILE_049);
const SQL_050 = readMigration(FILE_050);
const BODY_049 = stripSqlComments(SQL_049);
const BODY_050 = stripSqlComments(SQL_050);
const STMTS_049 = splitStatements(BODY_049);
const STMTS_050 = splitStatements(BODY_050);

console.log("\n=== 道具そのものの確認（切り方を間違えていたら以下が全部無意味になる）===");

it("$$ の中の `;` では文を割らない", () => {
  const s = splitStatements("CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql;\nSELECT 1;");
  assertEqual(s.length, 2, "関数本体の中の ; で割れている");
});

it("文字列リテラルの中の `--` はコメントにしない", () => {
  assertEqual(
    squash(stripSqlComments("SELECT 'a--b'; -- 落ちるコメント\nSELECT 2;")),
    "SELECT 'a--b'; SELECT 2;",
    "リテラルの中身が削られている",
  );
});

it("$$ の中の `--` 行コメントは落とす（本文の照合を安定させる）", () => {
  assertEqual(
    squash(stripSqlComments("AS $$\n SELECT 1; -- 説明\n$$")),
    "AS $$ SELECT 1; $$",
    "関数本体のコメントが残っている",
  );
});

console.log("\n=== 049 は全文が冪等である（適用済みの本番でもう一度流されうる）===");

/* 冪等な形の許可リスト。
 *
 * ここに無い形が 1 つでもあれば落とす。「たぶん大丈夫」を通さないための
 * 許可リスト方式であって、危険な形の拒否リストではない（拒否リストは
 * 見落とした形を黙って通す）。 */
const IDEMPOTENT_FORMS: Array<{ label: string; re: RegExp }> = [
  { label: "CREATE TABLE IF NOT EXISTS", re: /^CREATE TABLE IF NOT EXISTS /i },
  { label: "CREATE [UNIQUE] INDEX IF NOT EXISTS", re: /^CREATE (UNIQUE )?INDEX IF NOT EXISTS /i },
  { label: "CREATE OR REPLACE VIEW", re: /^CREATE OR REPLACE VIEW /i },
  { label: "CREATE OR REPLACE FUNCTION", re: /^CREATE OR REPLACE FUNCTION /i },
  { label: "COMMENT ON", re: /^COMMENT ON /i },
  { label: "DROP TRIGGER IF EXISTS", re: /^DROP TRIGGER IF EXISTS /i },
  // 直前に同名の DROP TRIGGER IF EXISTS があることは別のテストで確かめる。
  { label: "CREATE TRIGGER", re: /^CREATE TRIGGER /i },
  { label: "ENABLE ROW LEVEL SECURITY", re: /^ALTER TABLE \w+ +ENABLE ROW LEVEL SECURITY$/i },
  { label: "ALTER TABLE ... DROP CONSTRAINT IF EXISTS", re: /^ALTER TABLE \w+ +DROP CONSTRAINT IF EXISTS /i },
  // 直前に同名の DROP CONSTRAINT IF EXISTS があることは別のテストで確かめる。
  { label: "ALTER TABLE ... ADD CONSTRAINT", re: /^ALTER TABLE \w+ +ADD CONSTRAINT /i },
];

it("049 の全文が冪等な形の許可リストに収まっている", () => {
  assertTrue(STMTS_049.length > 0, "049 から 1 文も読めていない（切り方が壊れている）");
  const offenders = STMTS_049.map(squash).filter((s) => !IDEMPOTENT_FORMS.some((f) => f.re.test(s)));
  assertEqual(
    offenders.length,
    0,
    `冪等でない形が混ざっている: ${offenders.map((s) => s.slice(0, 120)).join(" || ")}`,
  );
});

it("049 の CREATE TRIGGER には必ず同名の DROP TRIGGER IF EXISTS が先行する", () => {
  const squashed = STMTS_049.map(squash);
  const created = squashed
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => /^CREATE TRIGGER /i.test(s));
  assertTrue(created.length >= 2, "トリガの作成が 2 本未満（取り消し台帳 2 つに追記専用ガードが要る）");
  for (const { s, i } of created) {
    const name = /^CREATE TRIGGER (\w+)/i.exec(s)?.[1] ?? "";
    const dropped = squashed
      .slice(0, i)
      .some((p) => new RegExp(`^DROP TRIGGER IF EXISTS ${name}\\b`, "i").test(p));
    assertTrue(dropped, `CREATE TRIGGER ${name} の前に DROP TRIGGER IF EXISTS が無い（再実行で落ちる）`);
  }
});

it("049 の ADD CONSTRAINT には必ず同名の DROP CONSTRAINT IF EXISTS が先行する", () => {
  const squashed = STMTS_049.map(squash);
  const added = squashed
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => /^ALTER TABLE \w+ +ADD CONSTRAINT /i.test(s));
  assertTrue(added.length >= 1, "basis の語彙を張り替える ADD CONSTRAINT が無い");
  for (const { s, i } of added) {
    const name = /^ALTER TABLE \w+ +ADD CONSTRAINT (\w+)/i.exec(s)?.[1] ?? "";
    const dropped = squashed
      .slice(0, i)
      .some((p) => new RegExp(`^ALTER TABLE \\w+ +DROP CONSTRAINT IF EXISTS ${name}\\b`, "i").test(p));
    assertTrue(dropped, `ADD CONSTRAINT ${name} の前に DROP CONSTRAINT IF EXISTS が無い（再実行で落ちる）`);
  }
});

it("049 は基本の 4 オブジェクトを IF NOT EXISTS で作る（新規環境でも同じ結果になる）", () => {
  const squashed = STMTS_049.map(squash);
  for (const t of ["identity_edge_retractions", "subject_link_retractions"]) {
    assertTrue(
      squashed.some((s) => new RegExp(`^CREATE TABLE IF NOT EXISTS ${t}\\b`, "i").test(s)),
      `${t} が CREATE TABLE IF NOT EXISTS で作られていない`,
    );
    assertTrue(
      squashed.some((s) => new RegExp(`^CREATE UNIQUE INDEX IF NOT EXISTS ${t}_uniq\\b`, "i").test(s)),
      `${t}_uniq が CREATE UNIQUE INDEX IF NOT EXISTS で作られていない`,
    );
  }
  for (const v of ["identity_edges_live", "subject_links_live"]) {
    assertTrue(
      squashed.some((s) => new RegExp(`^CREATE OR REPLACE VIEW ${v}\\b`, "i").test(s)),
      `${v} が CREATE OR REPLACE VIEW で作られていない`,
    );
  }
});

console.log("\n=== 049 は本番固有のデータ是正（§B）を持ち込んでいない ===");

/* §B は本番の 8 行に対する ULID 直指定の修理であって、スキーマの版ではない。
 * migration に混ざると新規構築 / staging で前提確認の DO ブロックが例外で止まる。 */
it("049 に行を書き換える文が 1 つも無い", () => {
  const squashed = STMTS_049.map(squash);
  const writes = squashed.filter((s) => /^(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/i.test(s));
  assertEqual(writes.length, 0, `データを書く文がある: ${writes.map((s) => s.slice(0, 100)).join(" || ")}`);
});

it("049 に主体の ULID が直書きされていない（本番固有の指定を版に埋めない）", () => {
  // Crockford Base32 26 桁。コメントも含めた全文を見る（説明として書くのも許さない）。
  const hits = SQL_049.match(/\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/g) ?? [];
  assertEqual(hits.length, 0, `ULID らしき直書きがある: ${hits.join(", ")}`);
});

it("049 にトランザクション制御が無い（migrate.ts が 1 文ずつ tx で包む）", () => {
  const squashed = STMTS_049.map(squash);
  const tx = squashed.filter((s) => /^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/i.test(s));
  assertEqual(tx.length, 0, `トランザクション制御が残っている: ${tx.join(" || ")}`);
});

console.log("\n=== 049 は「消去と検算」を _live に付け替えていない ===");

/* 取り消した行にも生値が残る。消去がここを _live で読むと、
 * 「消せます」の約束が取り消しのせいで破れる。 */
it("049 は消去経路の 3 関数を作り直していない", () => {
  const squashed = STMTS_049.map(squash);
  for (const f of ["roji_person_key_map", "roji_resolve_identity", "roji_erasure_residue"]) {
    assertTrue(
      !squashed.some((s) => new RegExp(`^CREATE OR REPLACE FUNCTION ${f}\\b`, "i").test(s)),
      `消去経路の ${f} を 049 が作り直している（取り消した行の生値を消し損ねる）`,
    );
  }
});

it("049 は解決の 4 関数だけを _live に付け替えている", () => {
  const squashed = STMTS_049.map(squash);
  const replaced = squashed
    .filter((s) => /^CREATE OR REPLACE FUNCTION /i.test(s))
    .map((s) => /^CREATE OR REPLACE FUNCTION (\w+)/i.exec(s)?.[1] ?? "");
  assertDeep(
    replaced,
    [
      "cdp_subject_component",
      "cdp_canonical_identifiers",
      "cdp_subject_links_j4_guard",
      "cdp_l1_derive_delivery_identity",
      "cdp_retraction_summary",
    ],
    "作り直す関数の顔ぶれが変わっている",
  );
  const bodyOf = (name: string) =>
    squashed.find((s) => new RegExp(`^CREATE OR REPLACE FUNCTION ${name}\\b`, "i").test(s)) ?? "";
  assertTrue(bodyOf("cdp_subject_component").includes("subject_links_live"), "連結成分が取り消された link を辿っている");
  assertTrue(bodyOf("cdp_canonical_identifiers").includes("identity_edges_live"), "解決が取り消された観測を引いている");
  assertTrue(bodyOf("cdp_subject_links_j4_guard").includes("identity_edges_live"), "J-4 が取り消された観測で誤判定する");
  assertTrue(
    bodyOf("cdp_l1_derive_delivery_identity").includes("identity_edges_live"),
    "配信の宛先が取り消された LINE 観測から作られる",
  );
});

console.log("\n=== migrate.ts の INTROSPECTION（実在検知 → register の材料）===");

/* 049 は本番へ raw SQL で先に当たっている。台帳へ後追い登録する唯一の経路が
 * `--baseline` なので、sentinel が実物とずれていると本番が pending のまま残るか、
 * 逆に当たっていない環境を applied と誤登録する。実物の SQL と突き合わせる。 */
it("049 の sentinel は 049 が新しく作るものだけで構成されている", () => {
  const intro = INTROSPECTION["049_cdp_identity_retraction"];
  assertTrue(intro !== undefined, "049 の INTROSPECTION が無い（baseline で登録できない）");
  assertTrue(intro.idempotent, "049 は冪等なので idempotent: true でなければならない");
  assertTrue(intro.specs.length > 0, "049 は新しい表と関数を作るので no-sentinel にしてはいけない");
  const nameOf = (s: ObjectSpec): string =>
    s.kind === "index" ? s.index : s.kind === "function" ? s.func : s.table;
  for (const s of intro.specs) {
    assertTrue(
      new RegExp(`\\b${nameOf(s)}\\b`).test(BODY_049),
      `sentinel ${specKey(s)} が 049 の本文に出てこない（実物とずれている）`,
    );
  }
});

it("049 の sentinel に「049 が作り直しただけの関数」を混ぜていない", () => {
  const intro = INTROSPECTION["049_cdp_identity_retraction"];
  const funcs = intro.specs.filter((s) => s.kind === "function").map((s) => (s as { func: string }).func);
  for (const preexisting of [
    "cdp_subject_component",
    "cdp_canonical_identifiers",
    "cdp_subject_links_j4_guard",
    "cdp_l1_derive_delivery_identity",
    "cdp_append_only_guard",
  ]) {
    assertTrue(
      !funcs.includes(preexisting),
      `${preexisting} は 043 / 046 が作った関数。実在しても 049 が当たった証拠にならない`,
    );
  }
  assertTrue(funcs.includes("cdp_retraction_summary"), "049 が新しく作る関数が sentinel に入っていない");
});

it("050 は no-sentinel（関数 1 本の作り直しなので実在では判定できない）", () => {
  const intro = INTROSPECTION["050_cdp_retraction_summary_link_aware"];
  assertTrue(intro !== undefined, "050 の INTROSPECTION が無い（migrate.ts の網羅性検査が落ちる）");
  assertEqual(intro.specs.length, 0, "050 に sentinel を付けると 049 だけで applied 判定されてしまう");
  assertTrue(intro.idempotent, "050 は CREATE OR REPLACE 1 本なので冪等");
});

console.log("\n=== 050 は 049 の 1 か所だけを直している ===");

it("050 は読み取り専用の関数 1 本の作り直しだけ（表も行も触らない）", () => {
  const squashed = STMTS_050.map(squash);
  assertEqual(squashed.length, 2, `050 の文数が 2 でない: ${squashed.map((s) => s.slice(0, 60)).join(" || ")}`);
  assertTrue(
    /^CREATE OR REPLACE FUNCTION cdp_retraction_summary\(\)/i.test(squashed[0]),
    "1 文目が cdp_retraction_summary の作り直しでない",
  );
  assertTrue(/^COMMENT ON FUNCTION cdp_retraction_summary\(\)/i.test(squashed[1]), "2 文目が COMMENT でない");
  assertTrue(/LANGUAGE sql STABLE/i.test(squashed[0]), "読み取り専用（STABLE）でなくなっている");
});

/** cdp_retraction_summary の jsonb_build_object から「キー → 式」を取り出す。 */
function retractionSummaryEntries(body: string): Map<string, string> {
  const fn = splitStatements(body).find((s) =>
    /^CREATE OR REPLACE FUNCTION cdp_retraction_summary\(\)/i.test(squash(s)),
  );
  if (!fn) throw new Error("cdp_retraction_summary の定義が見つからない");
  const entries = new Map<string, string>();
  // "'key', ( ... )" を、括弧の対応を数えながら 1 件ずつ取る。
  const re = /'([a-z_]+)',\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fn)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < fn.length && depth > 0) {
      if (fn[i] === "(") depth++;
      else if (fn[i] === ")") depth--;
      i++;
    }
    entries.set(m[1], squash(fn.slice(re.lastIndex, i - 1)));
  }
  return entries;
}

const ENTRIES_049 = retractionSummaryEntries(BODY_049);
const ENTRIES_050 = retractionSummaryEntries(BODY_050);

it("050 は 049 と同じ 6 つの値を返す（監視値の顔ぶれを変えない）", () => {
  assertDeep([...ENTRIES_050.keys()], [...ENTRIES_049.keys()], "返す値の顔ぶれか並びが変わっている");
  assertEqual(ENTRIES_050.size, 6, "監視値の数が 6 でない");
});

it("050 で変わったのは subjects_without_live_edges の 1 か所だけ", () => {
  const changed = [...ENTRIES_050.keys()].filter((k) => ENTRIES_050.get(k) !== ENTRIES_049.get(k));
  assertDeep(changed, ["subjects_without_live_edges"], "1 か所だけの是正になっていない");
});

it("049 の subjects_without_live_edges は live な link を見ていない（直す対象の姿）", () => {
  const expr = ENTRIES_049.get("subjects_without_live_edges") ?? "";
  assertTrue(expr.includes("identity_edges_live"), "049 が live な鍵を見ていない（前提が崩れている）");
  assertTrue(
    !expr.includes("subject_links_live"),
    "049 が既に link を見ている（この場合 050 は不要 = どちらかが取り違えられている）",
  );
});

it("050 は「live な鍵も live な link も無い」を数える", () => {
  const expr = ENTRIES_050.get("subjects_without_live_edges") ?? "";
  assertTrue(/s\.retired_at IS NULL/i.test(expr), "retired な主体を除いていない");
  assertTrue(
    /NOT EXISTS \(\s*SELECT 1 FROM identity_edges_live e WHERE e\.subject_id = s\.subject_id\s*\)/i.test(expr),
    "live な鍵の不在条件の形が変わっている",
  );
  assertTrue(
    /NOT EXISTS \(\s*SELECT 1 FROM subject_links_live l WHERE l\.subject_a = s\.subject_id OR l\.subject_b = s\.subject_id\s*\)/i.test(
      expr,
    ),
    "live な link の不在条件が無い、または相関の列が違う（無向辺なので a / b の両方を見る）",
  );
  assertTrue(/\bAND\b/i.test(expr), "2 つの条件が AND で結ばれていない");
});

it("050 は multi_shopify_components の計上単位（成分ごと）を変えていない", () => {
  const expr = ENTRIES_050.get("multi_shopify_components") ?? "";
  assertTrue(expr.includes("cdp_subject_component"), "成分単位の計上でなくなっている");
  assertTrue(expr.includes("SELECT DISTINCT"), "成分を重複排除していない（主体数だけ重複計上する）");
});

console.log("\n=== 本番と同じ形のデータで 1 → 0 に戻る（判定の模型）===");

/* ここは SQL そのものではなく **判定の意味**を固定する層である。
 * 上の 050 のテストが「SQL に 2 つの NOT EXISTS が正しい相関で入っていること」を
 * 押さえているので、この模型はその 2 条件をそのまま写している。
 *
 * データの形は 2026-08-31 の本番（subjects 8 / edges 8 / links 4 + 是正 2 本）と
 * 同型にしてある。**ULID は合成値**である（本番の主体 ID は公開リポジトリに置かない。
 * 判定に効くのは「retired か」「live な鍵があるか」「live な link があるか」だけで、
 * 値そのものは効かない）。 */

interface Fixture {
  subjects: Array<{ id: string; retired: boolean }>;
  edges: Array<{ seq: number; subject: string }>;
  links: Array<{ seq: number; a: string; b: string }>;
  edgeRetractions: number[];
  linkRetractions: number[];
}

/** 049 の定義（live な鍵だけを見る）。 */
function countOld(f: Fixture): number {
  const liveEdge = new Set(
    f.edges.filter((e) => !f.edgeRetractions.includes(e.seq)).map((e) => e.subject),
  );
  return f.subjects.filter((s) => !s.retired && !liveEdge.has(s.id)).length;
}

/** 050 の定義（live な鍵も live な link も無い主体だけを数える）。 */
function countNew(f: Fixture): number {
  const liveEdge = new Set(
    f.edges.filter((e) => !f.edgeRetractions.includes(e.seq)).map((e) => e.subject),
  );
  const linked = new Set<string>();
  for (const l of f.links) {
    if (f.linkRetractions.includes(l.seq)) continue;
    linked.add(l.a);
    linked.add(l.b);
  }
  return f.subjects.filter((s) => !s.retired && !liveEdge.has(s.id) && !linked.has(s.id)).length;
}

// 合成 ULID（26 桁 Crockford Base32・順序だけ本番と同じ並びにしてある）。
const S = {
  lineTalk: "01AAAAAAAAAAAAAAAAAAAAAAA1", // LINE トーク側（line_messaging_uid）
  shopA: "01AAAAAAAAAAAAAAAAAAAAAAA2", // shopify_customer_id = C1
  webW1: "01BBBBBBBBBBBBBBBBBBBBBBB1", // web_session_id = W1
  lineLogin: "01BBBBBBBBBBBBBBBBBBBBBBB2", // line_login_uid（値は lineTalk と同一）
  shopB: "01BBBBBBBBBBBBBBBBBBBBBBB3", // shopify_customer_id = C2
  gidOrphan: "01CCCCCCCCCCCCCCCCCCCCCCC1", // 誤った kind で立った孤立主体
  anonOk: "01DDDDDDDDDDDDDDDDDDDDDDD1", // 正常な匿名来訪者
  webW3: "01EEEEEEEEEEEEEEEEEEEEEEE1", // web_session_id = W3
};

/** 是正前の本番（edges 8 / links 4 / 取り消し 0）。 */
function prodBefore(): Fixture {
  return {
    subjects: Object.values(S).map((id) => ({ id, retired: false })),
    edges: [
      { seq: 1, subject: S.lineTalk },
      { seq: 2, subject: S.shopA },
      { seq: 3, subject: S.webW1 },
      { seq: 4, subject: S.lineLogin },
      { seq: 5, subject: S.shopB },
      { seq: 6, subject: S.gidOrphan },
      { seq: 7, subject: S.anonOk },
      { seq: 8, subject: S.webW3 },
    ],
    links: [
      { seq: 1, a: S.lineTalk, b: S.shopA },
      { seq: 3, a: S.webW1, b: S.lineLogin },
      { seq: 4, a: S.lineTalk, b: S.shopB },
      { seq: 6, a: S.lineLogin, b: S.webW3 },
    ],
    edgeRetractions: [],
    linkRetractions: [],
  };
}

/** B-1（誤った kind の観測を取り消す）だけを当てた姿。 */
function withB1(): Fixture {
  const f = prodBefore();
  f.edgeRetractions = [6];
  return f;
}

/** B-1 + B-2（正しい人へ戻す link）+ B-3（割れた LINE を結ぶ link）= 本番の現在。 */
function prodAfter(): Fixture {
  const f = withB1();
  f.links.push({ seq: 9, a: S.shopA, b: S.gidOrphan }); // B-2 identifier_correction
  f.links.push({ seq: 10, a: S.lineTalk, b: S.lineLogin }); // B-3 line_uid_identity
  return f;
}

it("是正前はどちらの定義でも 0（是正が偽陽性を作ったことの確認）", () => {
  assertEqual(countOld(prodBefore()), 0, "是正前に旧定義が鳴っている");
  assertEqual(countNew(prodBefore()), 0, "是正前に新定義が鳴っている");
});

it("本番の現在（B-1+B-2+B-3 適用後）で旧定義は 1 を返す（偽陽性の再現）", () => {
  assertEqual(countOld(prodAfter()), 1, "偽陽性が再現しない（前提が変わっている）");
});

it("本番の現在で新定義は 0 に戻る（関数コメントの意図どおり）", () => {
  assertEqual(countNew(prodAfter()), 0, "是正済みの主体を新定義がまだ迷子と数えている");
});

it("取り消しただけで戻さなければ新定義も 1 を返す（鳴るべきときは鳴る）", () => {
  assertEqual(countNew(withB1()), 1, "本物の迷子を見逃している（警報が死んでいる）");
  assertEqual(countOld(withB1()), 1, "旧定義の挙動が変わっている");
});

it("戻した link 自体が取り消されたら、また鳴る", () => {
  const f = prodAfter();
  f.linkRetractions = [9]; // B-2 の link を取り消す
  assertEqual(countNew(f), 1, "取り消された link で救済してしまっている（_live を見ていない）");
});

it("退役した主体は数えない（消した人は迷子ではない）", () => {
  const f = withB1();
  f.subjects = f.subjects.map((s) => (s.id === S.gidOrphan ? { ...s, retired: true } : s));
  assertEqual(countNew(f), 0, "退役した主体を数えている");
  assertEqual(countOld(f), 0, "旧定義でも退役は除くはず");
});

// ---------------------------------------------------------------------------

console.log(`\n${passed}/${total} passed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
