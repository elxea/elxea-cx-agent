/**
 * Unit Tests — roji カルテの器（migration 032 / 033 ＋ Firestore カルテ型）
 *
 * DB に接続しない静的検証。狙いは「作ってはいけないものを、あとから誰かが足せない」ようにすること。
 * 定義文書（rojiカルテの項目 — 最終形の定義 / https://www.notion.so/3b570c9d064c81669025cdbe1064b12c）
 * の第4章「持たないと決めたもの」と、確定原則の禁じ手を機械チェックする。
 *
 * 検証範囲:
 *   - 禁じ手の列（星・点数・NPS・満足度・ランキング・バッジ・連続記録・滞在時間・開封率等）が無い
 *   - PII（氏名・メール・住所・電話）の列が無い ＝ PII 最小化
 *   - 言葉の置き場は名前を持たず内部の連番のみ
 *   - 編集の記録（骨）が個人への参照を 1 つも持たない
 *   - 匿名の言葉は「誰の」を持たない／本人に紐づく言葉は必ず「誰の」を持つ（CHECK の実在）
 *   - 出所 10 種が揃っている
 *   - 分類は 3 軸ちょうど（良し悪しの軸が無い）
 *   - 新設 migration が破壊的操作（DROP / 型変更 / DELETE / 自動削除ジョブ）を含まない ＝ 永久保持
 *   - カルテの追加項目が本カルテと未連携カルテの両方に同じ形で付いている（型レベル）
 *
 * 使用: npx tsx tests/unit/roji-containers.test.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CustomerProfile, LineUserProfile, RojiKarteFields } from "../../src/lib/firestore";

const MIG_DIR = "src/db/migrations";
const SQL_032 = readFileSync(join(MIG_DIR, "032_roji_words.sql"), "utf8");
const SQL_033 = readFileSync(join(MIG_DIR, "033_roji_delivery_ledger.sql"), "utf8");
const BOTH = `${SQL_032}\n${SQL_033}`;

let total = 0;
let passed = 0;
const failures: Array<{ name: string; error: string }> = [];

function it(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failures.push({ name, error: e instanceof Error ? e.message : String(e) });
    console.log(`  [FAIL] ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assertTrue(v: boolean, label: string) {
  if (!v) throw new Error(label);
}

/**
 * SQL から「列名として現れているトークン」だけを抜く。
 * CREATE TABLE の本体行のうち、行頭が識別子で始まるものを列定義とみなす。
 * コメント（-- 以降）は落とす（説明文に禁止語が出てきても誤検知しないため）。
 */
function columnNames(sql: string): string[] {
  const out: string[] = [];
  let inTable = false;
  // CREATE TABLE ... ( ... ) のカッコの深さを数える。
  // source ... CHECK (source IN ( ... )) のような入れ子で早期終了しないため。
  let depth = 0;
  for (const raw of sql.split("\n")) {
    const line = raw.replace(/--.*$/, "").trim();
    if (!inTable) {
      if (/^CREATE TABLE/i.test(line)) {
        inTable = true;
        depth = (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
      }
      continue;
    }
    // 列定義は「深さ 1（テーブル本体の直下）」の行だけ。入れ子の中は列ではない。
    if (depth === 1 && line !== "") {
      const m = line.match(/^([a-z_][a-z0-9_]*)\s+[a-z]/i);
      if (m) {
        const token = m[1].toLowerCase();
        if (!["constraint", "primary", "unique", "check", "foreign", "references"].includes(token)) {
          out.push(token);
        }
      }
    }
    depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
    if (depth <= 0) inTable = false;
  }
  return out;
}

const COLS_032 = columnNames(SQL_032);
const COLS_033 = columnNames(SQL_033);
const ALL_COLS = [...COLS_032, ...COLS_033];

console.log("\n=== roji 器: 禁じ手の列が無いこと ===");

// 確定原則の禁じ手。「行き着く先の姿でも作らない」ので、部分一致で弾く。
const FORBIDDEN_SUBSTRINGS = [
  "score",
  "rating",
  "star",
  "nps",
  "satisfaction",
  "rank",
  "badge",
  "streak",
  "level",
  "achievement",
  "percentile",
  "dwell",
  "duration",
  "open_rate",
  "click_rate",
  "ctr",
  "pageview",
  "page_view",
  "sentiment",
  "quality",
];

it("星・点数・ランキング・連続記録・滞在時間・開封率などの列を 1 つも持たない", () => {
  const hits = ALL_COLS.filter((c) => FORBIDDEN_SUBSTRINGS.some((f) => c.includes(f)));
  assertTrue(hits.length === 0, `禁じ手の列が見つかった: ${hits.join(", ")}`);
});

console.log("\n=== roji 器: PII 最小化 ===");

const PII_SUBSTRINGS = [
  "address",
  "postal",
  "zip",
  "phone",
  "tel",
  "email",
  "display_name",
  "full_name",
  "first_name",
  "last_name",
  "birth",
];

it("住所・電話・メール・氏名の列を 1 つも持たない（EC 側が正本・見に行く）", () => {
  const hits = ALL_COLS.filter((c) => PII_SUBSTRINGS.some((f) => c.includes(f)));
  assertTrue(hits.length === 0, `PII の列が見つかった: ${hits.join(", ")}`);
});

it("言葉の置き場（roji_words）は名前を持たず、内部の連番のみを持つ", () => {
  const wordsBlock = SQL_032.slice(SQL_032.indexOf("CREATE TABLE IF NOT EXISTS roji_words"));
  const cols = columnNames(wordsBlock);
  assertTrue(cols.includes("person_seq"), "person_seq が無い");
  const identifiers = cols.filter((c) => /line_user|shopify|customer_id|user_id|name|mail/.test(c));
  assertTrue(identifiers.length === 0, `本人を直接指す列が見つかった: ${identifiers.join(", ")}`);
});

it("編集の記録（roji_edit_records・骨）は個人への参照を 1 つも持たない", () => {
  const start = SQL_033.indexOf("CREATE TABLE IF NOT EXISTS roji_edit_records");
  const block = SQL_033.slice(start, SQL_033.indexOf("CREATE INDEX", start));
  const cols = columnNames(block);
  const personal = cols.filter((c) => /shopify|customer|line_user|person_seq|subject/.test(c));
  assertTrue(personal.length === 0, `個人に辿り着ける列が見つかった: ${personal.join(", ")}`);
  // 号の識別子も持たない（roji は 1人ずつに編むため、号がそのまま個人を指しかねない）。
  assertTrue(!cols.includes("issue_ref"), "号の識別子（issue_ref）を持ってはいけない");
});

console.log("\n=== roji 器: 匿名性の構造的な担保 ===");

it("匿名の言葉（event_floor）は「誰の」を持たないことが CHECK で強制されている", () => {
  assertTrue(
    /roji_words_floor_is_anonymous[\s\S]*?CHECK\s*\(source <> 'event_floor' OR person_seq IS NULL\)/.test(SQL_032),
    "roji_words_floor_is_anonymous の CHECK が無い",
  );
});

it("匿名以外の言葉は必ず「誰の」を持つ（＝本人が消せる）ことが CHECK で強制されている", () => {
  assertTrue(
    /roji_words_non_floor_has_person[\s\S]*?CHECK\s*\(source = 'event_floor' OR person_seq IS NOT NULL\)/.test(SQL_032),
    "roji_words_non_floor_has_person の CHECK が無い",
  );
});

it("場の言葉と本人の控えを結ぶ鍵（相互参照の列）を作っていない", () => {
  const wordsBlock = SQL_032.slice(SQL_032.indexOf("CREATE TABLE IF NOT EXISTS roji_words"));
  const cols = columnNames(wordsBlock);
  const pairing = cols.filter((c) => /paired|counterpart|mirror_of|copy_of|origin_word/.test(c));
  assertTrue(pairing.length === 0, `場と控えを結ぶ列が見つかった: ${pairing.join(", ")}`);
});

console.log("\n=== roji 器: 言葉の置き場の定義への忠実さ ===");

it("出所は定義文書の 10 種がすべて揃っている", () => {
  const expected = [
    "feedback_note",
    "concierge_utterance",
    "change_reason",
    "event_homework",
    "event_floor",
    "event_afterword",
    "cancellation_note",
    "rehearsal_interview",
    "survey_free_text",
    "event_own_copy",
  ];
  for (const s of expected) {
    assertTrue(SQL_032.includes(`'${s}'`), `出所 ${s} が無い`);
  }
});

it("分類はちょうど 3 軸（良し悪しの軸を置かない）", () => {
  const axes = COLS_032.filter((c) => c.startsWith("axis_"));
  assertTrue(axes.length === 3, `軸が 3 本ではない: ${axes.join(", ")}`);
  assertTrue(
    axes.includes("axis_window") && axes.includes("axis_about") && axes.includes("axis_use"),
    `軸の名前が期待と違う: ${axes.join(", ")}`,
  );
});

it("原文（body）は NOT NULL で、書き換えを拒否するトリガがある", () => {
  assertTrue(/body text NOT NULL/.test(SQL_032), "body が NOT NULL でない");
  assertTrue(/CREATE TRIGGER roji_words_body_immutable/.test(SQL_032), "原文不変トリガが無い");
});

it("要約は原文と別の欄に持つ（原文を上書きしない）", () => {
  assertTrue(COLS_032.includes("summary"), "summary 列が無い");
});

it("言葉 1 件ごとの引用の許可・消去対象の印・棚の写しを持たない", () => {
  const wordsBlock = SQL_032.slice(SQL_032.indexOf("CREATE TABLE IF NOT EXISTS roji_words"));
  const cols = columnNames(wordsBlock);
  const bad = cols.filter((c) => /consent|quote_allow|erasable|deletable|shelf_copy|repeat_count/.test(c));
  assertTrue(bad.length === 0, `持たないと決めた列が見つかった: ${bad.join(", ")}`);
  // 棚は「この行に印を付けるだけ」。
  assertTrue(cols.includes("shelved"), "棚の印（shelved）が無い");
});

console.log("\n=== roji 器: 台帳の定義への忠実さ ===");

it("台帳は 1人1月1行（UNIQUE 制約がある）", () => {
  assertTrue(
    /UNIQUE \(shopify_customer_id, period\)/.test(SQL_033),
    "1人1月1行の UNIQUE が無い",
  );
});

it("月を締めたら「その月の1行」は空欄にできない（CHECK がある）", () => {
  assertTrue(
    /roji_delivery_ledger_note_required_on_close[\s\S]*?closed_at IS NULL OR btrim\(coalesce\(monthly_note, ''\)\) <> ''/.test(
      SQL_033,
    ),
    "空欄を許さない CHECK が無い",
  );
});

it("月の締め記録（項目66）が人ではなく月の単位で存在する", () => {
  assertTrue(/CREATE TABLE IF NOT EXISTS roji_delivery_months/.test(SQL_033), "月の締め記録が無い");
  assertTrue(/period text PRIMARY KEY/.test(SQL_033), "月が主キーでない");
  assertTrue(/member_count integer NOT NULL/.test(SQL_033), "対象会員数が無い");
  assertTrue(/row_count integer NOT NULL/.test(SQL_033), "台帳の行数が無い");
});

console.log("\n=== roji 器: 永久保持と非破壊 ===");

it("新設 migration に自動削除（pg_cron / cleanup ジョブ）を 1 つも足していない", () => {
  assertTrue(!/cron\.schedule/i.test(BOTH), "cron.schedule が含まれている（永久保持に反する）");
  assertTrue(!/cleanup/i.test(BOTH.replace(/--.*$/gm, "")), "cleanup ジョブが含まれている");
});

it("新設 migration に破壊的操作（DROP TABLE / DROP COLUMN / 型変更 / DELETE / UPDATE）が無い", () => {
  const sql = BOTH.replace(/--.*$/gm, "");
  assertTrue(!/DROP\s+TABLE/i.test(sql), "DROP TABLE がある");
  assertTrue(!/DROP\s+COLUMN/i.test(sql), "DROP COLUMN がある");
  assertTrue(!/ALTER\s+COLUMN/i.test(sql), "ALTER COLUMN（型変更）がある");
  assertTrue(!/TRUNCATE/i.test(sql), "TRUNCATE がある");
  // DELETE は roji_erase_person（本人が記録を消す処理）の中だけに存在してよい。
  const deleteLines = sql.split("\n").filter((l) => /\bDELETE FROM\b/i.test(l));
  const eraseStart = sql.indexOf("CREATE OR REPLACE FUNCTION roji_erase_person");
  const eraseEnd = sql.indexOf("$$ LANGUAGE plpgsql;", eraseStart);
  for (const l of deleteLines) {
    assertTrue(
      eraseStart >= 0 && sql.indexOf(l, eraseStart) > eraseStart && sql.indexOf(l, eraseStart) < eraseEnd,
      `roji_erase_person の外に DELETE がある: ${l.trim()}`,
    );
  }
  assertTrue(!/\bUPDATE\s+[a-z_]+\s+SET\b/i.test(sql), "既存データを書き換える UPDATE がある");
});

it("すべての新設テーブルで RLS が有効化されている", () => {
  const tables = [
    "roji_word_persons",
    "roji_word_person_refs",
    "roji_words",
    "roji_edit_records",
    "roji_delivery_ledger",
    "roji_delivery_months",
  ];
  for (const t of tables) {
    assertTrue(
      new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`).test(BOTH),
      `${t} の RLS 有効化が無い`,
    );
  }
});

console.log("\n=== roji カルテ: 本カルテと未連携カルテの両方に同じ形で付いていること ===");

// 型レベルの検査。CustomerProfile / LineUserProfile のどちらかに RojiKarteFields が
// 付いていなければ、tsc（npm run typecheck）がこの代入で落ちる。
const _karteBothSides: [RojiKarteFields, RojiKarteFields] = [
  {} as CustomerProfile,
  {} as LineUserProfile,
];
void _karteBothSides;

it("RojiKarteFields が CustomerProfile と LineUserProfile の両方に交差している（型レベル）", () => {
  // 実行時には型が消えるため、ここでは「両方に代入できる形で書かれている」ことを
  // 型検査に委ねる。ソース上の交差指定そのものも念のため文字列で確認する。
  const src = readFileSync(join("src/lib/firestore.ts"), "utf8");
  assertTrue(
    /export type CustomerProfile = RojiKarteFields &/.test(src),
    "CustomerProfile に RojiKarteFields が交差していない",
  );
  assertTrue(
    /export type LineUserProfile = RojiKarteFields &/.test(src),
    "LineUserProfile に RojiKarteFields が交差していない",
  );
});

it("カルテの追加項目（6/12/13/14/18/19/20）がすべて定義されている", () => {
  const src = readFileSync(join("src/lib/firestore.ts"), "utf8");
  const required = [
    "safety?", // 項目6
    "windowAffinity?", // 項目12
    "teaRequests?", // 項目13
    "eventInterest?", // 項目14
    "quoteConsent?", // 項目18
    "estimateLine?", // 項目19
    "estimateCorrection?", // 項目20
  ];
  for (const f of required) {
    assertTrue(src.includes(f), `カルテの項目 ${f} が無い`);
  }
});

it("カルテに LINE 側の識別子・合流の状態を写していない（正本は別名表）", () => {
  const src = readFileSync(join("src/lib/firestore.ts"), "utf8");
  const start = src.indexOf("export type RojiKarteFields");
  const end = src.indexOf("export type CustomerProfile", start);
  const block = src.slice(start, end);
  assertTrue(!/lineUserId/.test(block), "RojiKarteFields に LINE 側の識別子がある");
  assertTrue(!/linkageState|mergeState|合流の状態/.test(block), "RojiKarteFields に合流の状態がある");
});

it("カルテの追加項目に星・点数・ランキングの類が無い", () => {
  const src = readFileSync(join("src/lib/firestore.ts"), "utf8");
  const start = src.indexOf("// roji カルテの追加項目");
  const end = src.indexOf("export type CustomerProfile", start);
  const block = src.slice(start, end).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  for (const f of ["score", "rating", "star", "rank", "badge", "streak", "level"]) {
    assertTrue(!new RegExp(`\\b${f}\\??:`, "i").test(block), `カルテに禁じ手の項目 ${f} がある`);
  }
});

console.log(`\n=== 結果: ${passed}/${total} PASS ===`);
if (failures.length > 0) {
  console.error("\n失敗:");
  for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
