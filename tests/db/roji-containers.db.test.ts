/**
 * DB Round-trip Tests — roji カルテの器（migration 032 / 033）
 *
 * 実際の Postgres に接続して「器に入れて取り出せること」「消したときに定義どおりのものだけが残ること」
 * 「永久保持であること（自動削除がかからないこと）」を検証する。
 *
 * ─ 安全 ─
 *   - 既定の接続先は **staging のみ**。project ref を HARD ASSERT し、本番 ref なら接続せず中断する。
 *   - 書き込みは全て 1 本のトランザクション内で行い、**最後に必ず ROLLBACK する**。
 *     成功しても失敗しても、DB には 1 行も残らない。
 *   - `--env prod` は **読み取り専用の確認だけ**を行う（テーブル実在・行数・自動削除ジョブ不在）。
 *     本番に対して INSERT / UPDATE / DELETE を 1 度も実行しない。
 *
 * 使用:
 *   npx tsx tests/db/roji-containers.db.test.ts            # staging（round-trip 込み）
 *   npx tsx tests/db/roji-containers.db.test.ts --env prod # 本番（読み取りのみ）
 */

import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
dotenv.config({ path: ".dev.vars" });

const PROD_REF = "bquqzrbzdzjegdovxalu";
const STAGING_REF = "espeokdhutgztksdrpzt";

const NEW_TABLES = [
  "roji_word_persons",
  "roji_word_person_refs",
  "roji_words",
  "roji_edit_records",
  "roji_delivery_ledger",
  "roji_delivery_months",
];

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
/** 実行して「制約違反で落ちること」を期待する。落ちなければテスト失敗。 */
async function expectReject(client: pg.Client, sql: string, params: unknown[], label: string) {
  await client.query("SAVEPOINT sp_expect_reject");
  try {
    await client.query(sql, params);
    await client.query("ROLLBACK TO SAVEPOINT sp_expect_reject");
    throw new Error(`${label}: 拒否されるはずが通ってしまった`);
  } catch (e) {
    await client.query("ROLLBACK TO SAVEPOINT sp_expect_reject");
    if (e instanceof Error && e.message.includes("拒否されるはずが")) throw e;
  }
}

function resolveConn(): { url?: string; password?: string } {
  return env === "staging"
    ? { url: process.env.SUPABASE_URL_STAGING, password: process.env.SUPABASE_DB_PASSWORD_STAGING }
    : { url: process.env.SUPABASE_URL, password: process.env.SUPABASE_DB_PASSWORD };
}

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
    console.log("\n=== 器が実在すること ===");
    for (const t of NEW_TABLES) {
      await it(`テーブル ${t} が存在する`, async () => {
        const { rows } = await client.query(`SELECT to_regclass($1) AS reg`, [`public.${t}`]);
        assertTrue(rows[0].reg !== null, `${t} が無い`);
      });
    }

    await it("すべての新設テーブルで RLS が有効になっている", async () => {
      const { rows } = await client.query(
        `SELECT relname, relrowsecurity FROM pg_class
         WHERE relname = ANY($1) AND relnamespace = 'public'::regnamespace`,
        [NEW_TABLES],
      );
      assertEqual(rows.length, NEW_TABLES.length, "テーブル数");
      for (const r of rows) assertTrue(r.relrowsecurity === true, `${r.relname} の RLS が無効`);
    });

    console.log("\n=== 永久保持であること（自動削除がかからないこと）===");

    await it("新設テーブルを対象にする pg_cron の自動削除ジョブが 1 本も無い", async () => {
      const { rows: hasCron } = await client.query(`SELECT to_regclass('cron.job') AS reg`);
      if (hasCron[0].reg === null) {
        console.log("     （pg_cron 未導入のため対象ジョブは存在し得ない）");
        return;
      }
      const { rows } = await client.query(
        `SELECT jobname, command FROM cron.job
         WHERE command ILIKE '%roji_%' OR jobname ILIKE '%roji%'`,
      );
      assertEqual(rows.length, 0, `新設テーブルを触る cron ジョブがある: ${JSON.stringify(rows)}`);
    });

    // 【既知の未解消・本タスク(07)の範囲外】2026-08-08 時点で staging はこの検査に落ちる。
    //   migration 031（削除ジョブの解除）は **本番にだけ適用済み**で、staging は未適用のため
    //   cleanup-old-conversations / -feedback / -unanswered の 3 本が残っている。
    //   本番は PASS する。staging を揃える作業は retention タスク側の担当。
    //   検査を緩めない（緩めると「揃っていない」という事実が見えなくなるため）。
    await it("会話・感想・未回答クエリの 90 日削除ジョブが解除されたままである", async () => {
      const { rows: hasCron } = await client.query(`SELECT to_regclass('cron.job') AS reg`);
      if (hasCron[0].reg === null) return;
      const { rows } = await client.query(
        `SELECT jobname FROM cron.job WHERE jobname IN
         ('cleanup-old-conversations','cleanup-old-feedback','cleanup-old-unanswered')`,
      );
      assertEqual(rows.length, 0, `削除ジョブが復活している: ${rows.map((r) => r.jobname).join(", ")}`);
    });

    if (env === "prod") {
      console.log("\n=== 本番は読み取りのみ。round-trip は staging で実施する ===");
      for (const t of NEW_TABLES) {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
        console.log(`     ${t}: ${rows[0].n} 行`);
      }
    } else {
      console.log("\n=== 器に入れて取り出せること（全て 1 本の tx。最後に ROLLBACK）===");
      await client.query("BEGIN");

      const seqA = (await client.query(`INSERT INTO roji_word_persons DEFAULT VALUES RETURNING person_seq`))
        .rows[0].person_seq as string;
      await client.query(
        `INSERT INTO roji_word_person_refs (person_seq, subject_kind, subject_id) VALUES ($1,'shopify',$2)`,
        [seqA, "TEST-CUST-0001"],
      );

      const RAW = "  これは、テストの言葉。\n改行も  誤字もそのまま。 ";

      await it("言葉を入れて、一字一句そのまま取り出せる", async () => {
        const ins = await client.query(
          `INSERT INTO roji_words (body, occurred_at, person_seq, source, about_kind, about_ref, context_slug)
           VALUES ($1, now(), $2, 'feedback_note', 'issue', 'issue-001', 'after_next_month_line')
           RETURNING id`,
          [RAW, seqA],
        );
        const { rows } = await client.query(`SELECT body FROM roji_words WHERE id = $1`, [ins.rows[0].id]);
        assertEqual(rows[0].body, RAW, "原文が変わっている");
      });

      await it("分類が空でも保存できる（保存を止めない）", async () => {
        const { rows } = await client.query(
          `INSERT INTO roji_words (body, occurred_at, person_seq, source)
           VALUES ('分類なしの言葉', now(), $1, 'change_reason')
           RETURNING axis_window, axis_about, axis_use`,
          [seqA],
        );
        assertEqual(rows[0].axis_window.length, 0, "軸1 の既定が空でない");
        assertEqual(rows[0].axis_about.length, 0, "軸2 の既定が空でない");
        assertEqual(rows[0].axis_use.length, 0, "軸3 の既定が空でない");
      });

      await it("原文は書き換えられない（要約への差し替え・誤字の修正を拒否する）", async () => {
        const id = (
          await client.query(
            `INSERT INTO roji_words (body, occurred_at, person_seq, source)
             VALUES ('原文', now(), $1, 'feedback_note') RETURNING id`,
            [seqA],
          )
        ).rows[0].id;
        await expectReject(client, `UPDATE roji_words SET body = $2 WHERE id = $1`, [id, "書き換え"], "原文の書き換え");
        // 要約は別の欄に書ける（原文は無傷）。
        await client.query(`UPDATE roji_words SET summary = $2 WHERE id = $1`, [id, "要約"]);
        const { rows } = await client.query(`SELECT body, summary FROM roji_words WHERE id = $1`, [id]);
        assertEqual(rows[0].body, "原文", "原文が変わった");
        assertEqual(rows[0].summary, "要約", "要約が入っていない");
      });

      await it("匿名の言葉に「誰の」を付けようとすると拒否される", async () => {
        await expectReject(
          client,
          `INSERT INTO roji_words (body, occurred_at, person_seq, source)
           VALUES ('場の言葉', now(), $1, 'event_floor')`,
          [seqA],
          "匿名の言葉に person_seq",
        );
      });

      await it("匿名以外の言葉を「誰の」無しで入れようとすると拒否される（消せなくなるため）", async () => {
        await expectReject(
          client,
          `INSERT INTO roji_words (body, occurred_at, source) VALUES ('身元不明', now(), 'feedback_note')`,
          [],
          "person_seq 無しの非匿名",
        );
      });

      await it("棚に上げるときは理由の 1 行が要る", async () => {
        await expectReject(
          client,
          `INSERT INTO roji_words (body, occurred_at, person_seq, source, shelved)
           VALUES ('棚', now(), $1, 'feedback_note', true)`,
          [seqA],
          "理由なしの棚上げ",
        );
        await client.query(
          `INSERT INTO roji_words (body, occurred_at, person_seq, source, shelved, shelved_at, shelf_reason)
           VALUES ('棚', now(), $1, 'feedback_note', true, now(), '設計の判断に引用したい')`,
          [seqA],
        );
      });

      await it("台帳は 1人1月1行（同じ人・同じ月の 2 行目は拒否される）", async () => {
        await client.query(
          `INSERT INTO roji_delivery_ledger (shopify_customer_id, period) VALUES ('TEST-CUST-0001','2026-09')`,
        );
        await expectReject(
          client,
          `INSERT INTO roji_delivery_ledger (shopify_customer_id, period) VALUES ('TEST-CUST-0001','2026-09')`,
          [],
          "1人1月2行目",
        );
      });

      await it("月を締めるとき「その月の1行」が空欄なら拒否される", async () => {
        await expectReject(
          client,
          `UPDATE roji_delivery_ledger SET closed_at = now()
           WHERE shopify_customer_id='TEST-CUST-0001' AND period='2026-09'`,
          [],
          "空欄のまま締め",
        );
        await client.query(
          `UPDATE roji_delivery_ledger SET closed_at = now(), monthly_note = '反応なし'
           WHERE shopify_customer_id='TEST-CUST-0001' AND period='2026-09'`,
        );
      });

      await it("台帳に入れた内容がそのまま取り出せる", async () => {
        await client.query(
          `UPDATE roji_delivery_ledger
           SET teas = $1::jsonb, issue_ref = 'issue-001',
               issue_materials = $2::jsonb, estimate_snapshot = $3::jsonb,
               candidates_not_chosen = $4::jsonb, preview_opened = true, preview_first_opened_at = now()
           WHERE shopify_customer_id='TEST-CUST-0001' AND period='2026-09'`,
          [
            JSON.stringify(["tea-a", "tea-b"]),
            JSON.stringify([{ ref: "art-1", position: 1 }]),
            JSON.stringify({ windowAffinity: { tea: 3 } }),
            JSON.stringify([{ ref: "tea-z", reason: "recent_duplicate" }]),
          ],
        );
        const { rows } = await client.query(
          `SELECT teas, issue_materials, estimate_snapshot, candidates_not_chosen, preview_opened
           FROM roji_delivery_ledger WHERE shopify_customer_id='TEST-CUST-0001' AND period='2026-09'`,
        );
        assertEqual(JSON.stringify(rows[0].teas), JSON.stringify(["tea-a", "tea-b"]), "お茶の参照");
        assertEqual(rows[0].issue_materials[0].ref, "art-1", "素材と順番");
        assertEqual(rows[0].estimate_snapshot.windowAffinity.tea, 3, "推定のスナップショット");
        assertEqual(rows[0].candidates_not_chosen[0].reason, "recent_duplicate", "外した理由");
        assertEqual(rows[0].preview_opened, true, "見たけれど直さなかった");
      });

      console.log("\n=== 消したとき、定義どおりのものだけが残ること ===");

      await it("消す前に、消えるもの・残るものを両方置く", async () => {
        // 匿名の場の言葉（残る）
        await client.query(
          `INSERT INTO roji_words (body, occurred_at, source) VALUES ('場に置かれた言葉', now(), 'event_floor')`,
        );
        // 本人の控え（消える）。場の言葉とは別レコードで、結ぶ鍵を持たない。
        await client.query(
          `INSERT INTO roji_words (body, occurred_at, person_seq, source)
           VALUES ('場に置かれた言葉', now(), $1, 'event_own_copy')`,
          [seqA],
        );
        // 編集の記録（骨として残る）
        const editId = (
          await client.query(
            `INSERT INTO roji_edit_records (edited_period, editor_ref, revision_amount, revision_kinds)
             VALUES ('2026-09','editor-1', 12, ARRAY['tone','order']) RETURNING id`,
          )
        ).rows[0].id;
        await client.query(
          `UPDATE roji_delivery_ledger SET edit_record_id = $1
           WHERE shopify_customer_id='TEST-CUST-0001' AND period='2026-09'`,
          [editId],
        );
        // 月の締め記録（消えない）
        await client.query(
          `INSERT INTO roji_delivery_months (period, closed_at, member_count, row_count)
           VALUES ('2026-09', now(), 1, 1)`,
        );
      });

      await it("本人が記録を消すと、本人に紐づく言葉と台帳の行が消える", async () => {
        const res = await client.query(`SELECT roji_erase_person('shopify','TEST-CUST-0001') AS r`);
        const r = res.rows[0].r as { words_deleted: number; ledger_rows_deleted: number; person_deleted: number };
        assertTrue(r.words_deleted > 0, "言葉が 1 件も消えていない");
        assertEqual(r.ledger_rows_deleted, 1, "台帳の行が消えていない");
        assertEqual(r.person_deleted, 1, "連番が消えていない");

        const left = await client.query(`SELECT count(*)::int AS n FROM roji_words WHERE person_seq = $1`, [seqA]);
        assertEqual(left.rows[0].n, 0, "本人に紐づく言葉が残っている");
        const refs = await client.query(
          `SELECT count(*)::int AS n FROM roji_word_person_refs WHERE subject_id = 'TEST-CUST-0001'`,
        );
        assertEqual(refs.rows[0].n, 0, "連番と ID の対応が残っている（痕跡を残さない）");
        const ledger = await client.query(
          `SELECT count(*)::int AS n FROM roji_delivery_ledger WHERE shopify_customer_id='TEST-CUST-0001'`,
        );
        assertEqual(ledger.rows[0].n, 0, "台帳の行が残っている");
      });

      await it("消したあとも、イベント当日の匿名の言葉は残る", async () => {
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM roji_words WHERE source='event_floor' AND body='場に置かれた言葉'`,
        );
        assertEqual(rows[0].n, 1, "匿名の言葉まで消えている");
      });

      await it("消したあとも、編集の記録は骨として残る（誰に向けて編んだかは切り離されている）", async () => {
        const { rows } = await client.query(
          `SELECT id, edited_period, revision_amount FROM roji_edit_records WHERE editor_ref='editor-1'`,
        );
        assertEqual(rows.length, 1, "編集の記録が消えている");
        assertEqual(rows[0].edited_period, "2026-09", "編んだ月が失われている");
        // 個人への参照は構造上そもそも持てない（列が無い）ことを確認する。
        const { rows: cols } = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_name='roji_edit_records' AND table_schema='public'`,
        );
        const names = cols.map((c) => c.column_name as string);
        assertTrue(
          !names.some((n) => /shopify|customer|line_user|person|subject|issue/.test(n)),
          `編集の記録に個人へ辿れる列がある: ${names.join(", ")}`,
        );
      });

      await it("消したあとも、月の締め記録は残る（個人の記録ではないため）", async () => {
        const { rows } = await client.query(
          `SELECT member_count, row_count FROM roji_delivery_months WHERE period='2026-09'`,
        );
        assertEqual(rows.length, 1, "月の締め記録が消えている");
      });

      await it("LINE の ID から消しても、同じ人の台帳が消し残らない（migration 034 の回帰）", async () => {
        // 合流済みの人 = LINE と EC の両方の ref を持つ人。
        // 033 の実装では LINE 側から消すと台帳が残った（= 「消せる」の約束が破れる）。
        const seq = (await client.query(`INSERT INTO roji_word_persons DEFAULT VALUES RETURNING person_seq`))
          .rows[0].person_seq as string;
        await client.query(
          `INSERT INTO roji_word_person_refs (person_seq, subject_kind, subject_id)
           VALUES ($1,'line','TEST-LINE-0002'), ($1,'shopify','TEST-CUST-0002')`,
          [seq],
        );
        await client.query(
          `INSERT INTO roji_words (body, occurred_at, person_seq, source)
           VALUES ('合流済みの人の言葉', now(), $1, 'feedback_note')`,
          [seq],
        );
        await client.query(
          `INSERT INTO roji_delivery_ledger (shopify_customer_id, period) VALUES ('TEST-CUST-0002','2026-10')`,
        );

        const res = await client.query(`SELECT roji_erase_person('line','TEST-LINE-0002') AS r`);
        const r = res.rows[0].r as { words_deleted: number; ledger_rows_deleted: number };
        assertEqual(r.words_deleted, 1, "言葉が消えていない");
        assertEqual(r.ledger_rows_deleted, 1, "LINE 経由で消したのに台帳が消えていない");

        const left = await client.query(
          `SELECT count(*)::int AS n FROM roji_delivery_ledger WHERE shopify_customer_id='TEST-CUST-0002'`,
        );
        assertEqual(left.rows[0].n, 0, "台帳の行が消し残っている");
      });

      await it("言葉を 1 件も置いていない人でも、EC の ID から台帳を消せる", async () => {
        await client.query(
          `INSERT INTO roji_delivery_ledger (shopify_customer_id, period) VALUES ('TEST-CUST-0003','2026-10')`,
        );
        const res = await client.query(`SELECT roji_erase_person('shopify','TEST-CUST-0003') AS r`);
        const r = res.rows[0].r as { ledger_rows_deleted: number };
        assertEqual(r.ledger_rows_deleted, 1, "ref が無い人の台帳が消えていない");
      });

      await it("同じ人が再登録しても、消した記録は復活しない", async () => {
        // 同じ EC 顧客番号で新しい連番を作り直す = 空から始まる。
        const seqB = (await client.query(`INSERT INTO roji_word_persons DEFAULT VALUES RETURNING person_seq`))
          .rows[0].person_seq as string;
        await client.query(
          `INSERT INTO roji_word_person_refs (person_seq, subject_kind, subject_id) VALUES ($1,'shopify',$2)`,
          [seqB, "TEST-CUST-0001"],
        );
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM roji_words WHERE person_seq = $1`, [seqB]);
        assertEqual(rows[0].n, 0, "再登録で以前の記録が戻っている");
      });

      await client.query("ROLLBACK");
      console.log("\n[OK] ROLLBACK 完了。テストデータは 1 行も残っていません。");

      await it("ROLLBACK 後、テストデータが 1 行も残っていない", async () => {
        const { rows } = await client.query(
          `SELECT (SELECT count(*)::int FROM roji_word_person_refs WHERE subject_id LIKE 'TEST-%') AS refs,
                  (SELECT count(*)::int FROM roji_delivery_ledger WHERE shopify_customer_id LIKE 'TEST-%') AS ledger,
                  (SELECT count(*)::int FROM roji_edit_records WHERE editor_ref = 'editor-1') AS edits,
                  (SELECT count(*)::int FROM roji_delivery_months WHERE period = '2026-09') AS months,
                  (SELECT count(*)::int FROM roji_words WHERE body = '場に置かれた言葉') AS words`,
        );
        const r = rows[0];
        assertEqual(r.refs + r.ledger + r.edits + r.months + r.words, 0, `残留がある: ${JSON.stringify(r)}`);
      });
    }
  } finally {
    await client.end();
  }

  console.log(`\n=== 結果: ${passed}/${total} PASS (env=${env}) ===`);
  if (failures.length > 0) {
    console.error("\n失敗:");
    for (const f of failures) console.error(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
