/**
 * DB Round-trip Tests — roji 最初のアンケートの答えが、器に**本当に入る**か
 *
 * 「保存処理を呼んだ」ではなく「入れて、読み戻して、一致した」を見る。
 *   - 出来事の置き場（項目31）: flow_events に survey.answer が 聞いた契機つきで入る
 *   - 言葉の置き場（項目34〜41）: roji_words に 出所=survey_free_text で入り、項目39 が残る
 *   - 「消せる」: 本人が消したとき、アンケートで入った言葉も一緒に消える
 *
 * ─ 安全 ─
 *   - 接続先は **staging のみ**（project ref を HARD ASSERT。本番 ref なら接続せず中断）。
 *   - 書き込みは 1 本のトランザクション内で行い、**最後に必ず ROLLBACK** する。
 *     成功しても失敗しても DB には 1 行も残らない。
 *   - `--env prod` は **読み取り専用**（テーブル実在の確認のみ）。INSERT / UPDATE / DELETE を 1 度も行わない。
 *   - LINE API を一切呼ばない（配信・テスト送信はしない）。
 *
 * 使用:
 *   npx tsx tests/db/roji-survey.db.test.ts            # staging（往復込み・必ず ROLLBACK）
 *   npx tsx tests/db/roji-survey.db.test.ts --env prod # 本番（読み取りのみ）
 */

import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
dotenv.config({ path: ".dev.vars" });

const PROD_REF = "bquqzrbzdzjegdovxalu";
const STAGING_REF = "espeokdhutgztksdrpzt";

const env: "prod" | "staging" = process.argv.includes("--env")
  ? (process.argv[process.argv.indexOf("--env") + 1] as "prod" | "staging")
  : "staging";

let total = 0;
let passed = 0;
const failures: Array<{ name: string; error: string }> = [];

async function it(name: string, fn: () => Promise<void>) {
  total++;
  try {
    await fn();
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
function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function resolveConn(): { url?: string; password?: string } {
  return env === "staging"
    ? { url: process.env.SUPABASE_URL_STAGING, password: process.env.SUPABASE_DB_PASSWORD_STAGING }
    : { url: process.env.SUPABASE_URL, password: process.env.SUPABASE_DB_PASSWORD };
}

/** テスト用の架空の LINE userId（実在しない値・本番でも使わない）。 */
const FAKE_LINE_ID = "Utest-roji-survey-0000000000000000";
/** ひとことの原文（一字一句そのまま残ることを確かめるため、わざと改行と記号を入れる）。 */
const FAKE_BODY = "夜に飲むと、ちょっとだけ\nほどける気がします。";

async function main() {
  const { url, password } = resolveConn();
  if (!url || !password) {
    console.error(`[FATAL] ${env} の接続情報が未設定。中断。`);
    process.exit(1);
  }
  const projectRef = new URL(url).hostname.split(".")[0];
  if (env === "staging" && projectRef !== STAGING_REF) {
    console.error(`[ABORT] staging 指定だが ref='${projectRef}'。接続せず中断。`);
    process.exit(1);
  }
  if (env === "prod" && projectRef !== PROD_REF) {
    console.error(`[ABORT] prod 指定だが ref='${projectRef}'。接続せず中断。`);
    process.exit(1);
  }
  console.log(`[OK] PROJECT REF ASSERT: ${projectRef} (env=${env})`);

  const client = new pg.Client({
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    database: "postgres",
    user: "postgres",
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  await client.connect();

  try {
    console.log("\n=== アンケートが使う器が実在すること ===");
    for (const t of ["flow_events", "roji_words", "roji_word_persons", "roji_word_person_refs"]) {
      await it(`テーブル ${t} が存在する`, async () => {
        const { rows } = await client.query(`SELECT to_regclass($1) AS reg`, [`public.${t}`]);
        assertTrue(rows[0].reg !== null, `${t} が無い`);
      });
    }

    await it("出所に「アンケートの自由記述」(survey_free_text) が定義されている", async () => {
      const { rows } = await client.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = 'public.roji_words'::regclass AND contype = 'c'`,
      );
      const defs = rows.map((r) => String(r.def)).join("\n");
      assertTrue(defs.includes("survey_free_text"), "出所9 が器に無い");
    });

    if (env === "prod") {
      console.log("\n（本番は読み取りのみ。書き込みの往復は staging で行う）");
    } else {
      console.log("\n=== 往復（1本のトランザクション内・最後に必ず ROLLBACK）===");
      await client.query("BEGIN");

      let personSeq = 0;

      await it("項目31: 押した記号と聞いた契機が flow_events に入り、読み戻せる", async () => {
        for (const [step, value] of [
          ["q1", "late_night"],
          ["q2", "music"],
          ["q2", "farm"],
        ] as const) {
          await client.query(
            `INSERT INTO flow_events (event_name, user_ref, channel, step, value, metadata)
             VALUES ('survey.answer', $1, 'line', $2, $3, $4::jsonb)`,
            [FAKE_LINE_ID, step, value, JSON.stringify({ occasion: "survey" })],
          );
        }
        const { rows } = await client.query(
          `SELECT step, value, metadata->>'occasion' AS occasion
           FROM flow_events WHERE user_ref = $1 AND event_name = 'survey.answer'
           ORDER BY id`,
          [FAKE_LINE_ID],
        );
        assertEqual(rows.length, 3, "入った件数");
        assertEqual(rows[0].step, "q1", "段");
        assertEqual(rows[0].value, "late_night", "押した記号");
        assertEqual(rows[0].occasion, "survey", "聞いた契機（アンケート）");
        assertEqual(rows[2].value, "farm", "押し足した2つ目も残る");
      });

      await it("項目36: 言葉の置き場は名前を持たず、内部の連番だけで紐づく", async () => {
        const { rows: p } = await client.query(
          `INSERT INTO roji_word_persons DEFAULT VALUES RETURNING person_seq`,
        );
        personSeq = Number(p[0].person_seq);
        await client.query(
          `INSERT INTO roji_word_person_refs (person_seq, subject_kind, subject_id)
           VALUES ($1, 'line', $2)`,
          [personSeq, FAKE_LINE_ID],
        );
        const { rows } = await client.query(
          `SELECT person_seq FROM roji_word_person_refs WHERE subject_kind='line' AND subject_id=$1`,
          [FAKE_LINE_ID],
        );
        assertEqual(Number(rows[0].person_seq), personSeq, "連番の逆引き");
      });

      await it("項目34・37・39・40: ひとことが原文のまま入り、読み戻して一致する", async () => {
        await client.query(
          `INSERT INTO roji_words (body, occurred_at, person_seq, source, context_slug)
           VALUES ($1, now(), $2, 'survey_free_text', 'fix_none')`,
          [FAKE_BODY, personSeq],
        );
        const { rows } = await client.query(
          `SELECT body, source, context_slug, about_kind, about_ref, axis_window, axis_about, axis_use, summary
           FROM roji_words WHERE person_seq = $1`,
          [personSeq],
        );
        assertEqual(rows.length, 1, "1件1レコード");
        assertEqual(rows[0].body, FAKE_BODY, "項目34 原文が一字一句そのまま（改行も）");
        assertEqual(rows[0].source, "survey_free_text", "項目37 出所");
        assertEqual(rows[0].context_slug, "fix_none", "項目39 直前に押したもの");
        assertEqual(rows[0].about_kind, null, "項目38 は空（号も記事もまだ無い）");
        assertEqual(JSON.stringify(rows[0].axis_window), "[]", "項目40 は空で始まる");
        assertEqual(JSON.stringify(rows[0].axis_use), "[]", "項目40 は空で始まる");
        assertEqual(rows[0].summary, null, "要約は原文を上書きしない");
      });

      await it("原文は書き換えられない（要約への差し替えを器が拒否する）", async () => {
        await client.query("SAVEPOINT sp1");
        let rejected = false;
        try {
          await client.query(`UPDATE roji_words SET body = '要約' WHERE person_seq = $1`, [personSeq]);
        } catch {
          rejected = true;
        }
        await client.query("ROLLBACK TO SAVEPOINT sp1");
        assertTrue(rejected, "原文が書き換えられてしまった");
      });

      await it("「消せる」: 本人が消すと、アンケートで入った言葉も一緒に消える", async () => {
        const { rows } = await client.query(`SELECT roji_erase_person('line', $1) AS r`, [FAKE_LINE_ID]);
        const r = rows[0].r as { words_deleted: number; person_deleted: number };
        assertEqual(Number(r.words_deleted), 1, "消えた言葉の件数");
        const { rows: left } = await client.query(
          `SELECT count(*)::int AS n FROM roji_words WHERE person_seq = $1`,
          [personSeq],
        );
        assertEqual(left[0].n, 0, "言葉が残っている");
        const { rows: refs } = await client.query(
          `SELECT count(*)::int AS n FROM roji_word_person_refs WHERE subject_id = $1`,
          [FAKE_LINE_ID],
        );
        assertEqual(refs[0].n, 0, "連番の対応が残っている");
      });

      await client.query("ROLLBACK");
      console.log("  [OK] ROLLBACK 完了（DB に 1 行も残していない）");

      await it("後始末の検算: 書いた行が 1 つも残っていない", async () => {
        const { rows: ev } = await client.query(
          `SELECT count(*)::int AS n FROM flow_events WHERE user_ref = $1`,
          [FAKE_LINE_ID],
        );
        assertEqual(ev[0].n, 0, "flow_events に残骸がある");
        const { rows: refs } = await client.query(
          `SELECT count(*)::int AS n FROM roji_word_person_refs WHERE subject_id = $1`,
          [FAKE_LINE_ID],
        );
        assertEqual(refs[0].n, 0, "roji_word_person_refs に残骸がある");
      });
    }
  } finally {
    await client.end();
  }

  console.log(`\n=== ${passed}/${total} passed (env=${env}) ===`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

void main();
