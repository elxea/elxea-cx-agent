/**
 * DB Round-trip Tests — 「消せます」を全経路で本当に通す（migration 036）
 *
 * 検証すること（仕様の正本 = 図2「本人が記録を消したとき何が消えて何が残るか」）
 *   https://www.notion.so/3b570c9d064c81669025cdbe1064b12c
 *
 *   1. 各置き場に記録がある人を作って消すと、「消える」とされたものが **1 つも残らない**
 *   2. 「残る」とされた 3 つが、**本人に辿り着けない形で**残っている
 *   3. 未連携のまま消した人 / 連携済みで消した人 / 両方の記録を持つ人
 *   4. どの ID から消しても結果が同じ（対称性）
 *   5. 別人（世帯の別 LINE でない他人）を巻き込まない
 *   6. 「削除済み 1 件」という痕跡を残さない（消した後に増えた行が 1 行も無い）
 *   7. 匿名の言葉と手元の控えを結ぶ鍵を作らない（同じ本文でも控えだけ消え、場の言葉は残る）
 *   8. 戻ってきても以前の記録は戻らない
 *
 * ─ 安全 ─
 *   - 接続先は **staging のみ**。project ref を HARD ASSERT し、本番 ref なら接続せず中断する。
 *   - 書き込みは全て 1 本のトランザクション内。**最後に必ず ROLLBACK** する。1 行も残らない。
 *   - テストデータは全て 'TEST-ERASE-' / 'UTEST-ERASE-' 接頭辞の合成 ID。実顧客に一切触れない。
 *   - `--env prod` は受け付けない（消去のテストを本番で走らせない）。
 *
 * 使用:
 *   npx tsx tests/db/roji-erasure.db.test.ts
 */

import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
dotenv.config({ path: ".dev.vars" });

const PROD_REF = "bquqzrbzdzjegdovxalu";
const STAGING_REF = "espeokdhutgztksdrpzt";

if (process.argv.includes("--env") && process.argv[process.argv.indexOf("--env") + 1] !== "staging") {
  console.error("[ABORT] 本テストは staging 専用（消去を実行するため）。--env staging 以外は受け付けない。");
  process.exit(1);
}

/** 合成 ID。実顧客と衝突しない接頭辞を必ず使う。 */
const P1_LINE = "UTEST-ERASE-P1-line";
const P1_SHOP = "TEST-ERASE-P1-shop";
const P2_LINE = "UTEST-ERASE-P2-line"; // 未連携のまま消える人
const P3_LINE_A = "UTEST-ERASE-P3-lineA"; // 世帯共有: 同じ EC 顧客にぶら下がる 2 本目の LINE
const P3_SHOP = "TEST-ERASE-P3-shop";
const OTHER_LINE = "UTEST-ERASE-OTHER-line"; // 巻き込まれてはいけない別人
const OTHER_SHOP = "TEST-ERASE-OTHER-shop";

/** 同じ本文。場の言葉（匿名）と手元の控え（本人）に同一文字列を置き、突合の鍵が無いことを見る。 */
const SHARED_BODY = "TEST-ERASE 同じ本文の言葉";

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

/** 人に紐づく全表 × その人の ID での残存件数を 1 本のクエリで数える（テスト側の独立実装）。 */
const RESIDUE_SQL = `
SELECT
  (SELECT count(*)::int FROM conversations            WHERE user_id  = ANY($2)) AS conversations,
  (SELECT count(*)::int FROM message_feedback         WHERE user_id  = ANY($2)) AS message_feedback,
  (SELECT count(*)::int FROM unanswered_queries       WHERE user_id  = ANY($2)) AS unanswered_queries,
  (SELECT count(*)::int FROM tasting_note_survey      WHERE user_id  = ANY($2) OR session_id = ANY($2)) AS tasting_note_survey,
  (SELECT count(*)::int FROM flow_events              WHERE user_ref = ANY($2)) AS flow_events,
  (SELECT count(*)::int FROM product_ratings          WHERE user_ref = ANY($2)) AS product_ratings,
  (SELECT count(*)::int FROM pending_follow_refs      WHERE line_user_id = ANY($2)) AS pending_follow_refs,
  (SELECT count(*)::int FROM dormant_reengagement_log WHERE line_user_id = ANY($2)) AS dormant_reengagement_log,
  (SELECT count(*)::int FROM marche_activation_log    WHERE line_user_id = ANY($2)) AS marche_activation_log,
  (SELECT count(*)::int FROM account_link_nonces      WHERE shopify_customer_id = ANY($1)) AS account_link_nonces,
  (SELECT count(*)::int FROM customer_profiles        WHERE line_user_id = ANY($2) OR shopify_customer_id = ANY($1)) AS customer_profiles,
  (SELECT count(*)::int FROM customer_linkages        WHERE line_user_id = ANY($2) OR shopify_customer_id = ANY($1)) AS customer_linkages,
  (SELECT count(*)::int FROM user_identity_map        WHERE line_user_id = ANY($2) OR line_login_user_id = ANY($2)
                                                          OR shopify_customer_id = ANY($1)) AS user_identity_map,
  (SELECT count(*)::int FROM roji_delivery_ledger     WHERE shopify_customer_id = ANY($1)) AS roji_delivery_ledger,
  (SELECT count(*)::int FROM roji_word_person_refs    WHERE (subject_kind='shopify' AND subject_id = ANY($1))
                                                          OR (subject_kind='line'    AND subject_id = ANY($2))) AS roji_word_person_refs,
  (SELECT count(*)::int FROM roji_words w WHERE w.person_seq IN (
      SELECT person_seq FROM roji_word_person_refs
       WHERE (subject_kind='shopify' AND subject_id = ANY($1))
          OR (subject_kind='line'    AND subject_id = ANY($2)))) AS roji_words_person_linked
`;

type Residue = Record<string, number>;

async function residue(client: pg.Client, shopify: string[], line: string[]): Promise<Residue> {
  const { rows } = await client.query(RESIDUE_SQL, [shopify, line]);
  return rows[0] as Residue;
}
function totalOf(r: Residue): number {
  return Object.values(r).reduce((a, b) => a + b, 0);
}
function nonZero(r: Residue): string[] {
  return Object.entries(r)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k}=${v}`);
}

/** その人の全置き場に 1 件ずつ記録を作る。 */
async function seedPerson(
  client: pg.Client,
  opts: { line?: string; shopify?: string; withLedger?: boolean; ownCopyBody?: string },
): Promise<{ personSeq?: string }> {
  const { line, shopify, withLedger } = opts;
  // 控えの本文は人ごとに変える。消していない別人の控えを、消した人の控えと取り違えないため。
  const ownCopyBody = opts.ownCopyBody ?? `TEST-ERASE 控え ${line ?? shopify}`;
  let personSeq: string | undefined;

  if (line) {
    await client.query(
      `INSERT INTO conversations (user_id, channel, role, content) VALUES ($1,'line','user','TEST-ERASE 会話の生の文章')`,
      [line],
    );
    await client.query(
      `INSERT INTO message_feedback (user_id, channel, message_content, rating, comment)
       VALUES ($1,'line','TEST-ERASE 対象メッセージ',1,'TEST-ERASE 感想に添えた一言')`,
      [line],
    );
    await client.query(
      `INSERT INTO unanswered_queries (user_id, channel, query_text, max_similarity, result_count)
       VALUES ($1,'line','TEST-ERASE 未回答の問い',0.1,0)`,
      [line],
    );
    await client.query(
      `INSERT INTO tasting_note_survey (session_id, user_id, csat, would_use_again, improvement_suggestion, round)
       VALUES ($1,$1,5,'yes','TEST-ERASE 改善の提案',1)`,
      [line],
    );
    await client.query(
      `INSERT INTO flow_events (event_name, user_ref, channel, step, value) VALUES ('survey.q1',$1,'line','q1','a')`,
      [line],
    );
    await client.query(
      `INSERT INTO product_ratings (user_ref, channel, product_no, rating, source) VALUES ($1,'line','P-1',1,'tea_card')`,
      [line],
    );
    await client.query(
      `INSERT INTO pending_follow_refs (line_user_id, ref, expires_at) VALUES ($1,'TEST-ERASE-ref', now() + interval '1 day')`,
      [line],
    );
    await client.query(
      `INSERT INTO dormant_reengagement_log (line_user_id, decision_date, sent, dry_run, body_preview)
       VALUES ($1, current_date, false, true, 'TEST-ERASE 送信下書きの本文')`,
      [line],
    );
    await client.query(
      `INSERT INTO marche_activation_log (line_user_id, decision_date, sent, dry_run, body_preview)
       VALUES ($1, current_date, false, true, 'TEST-ERASE 送信下書きの本文')`,
      [line],
    );
    await client.query(
      `INSERT INTO customer_profiles (line_user_id, shopify_customer_id, email, display_name)
       VALUES ($1,$2,'test-erase@example.invalid','TEST-ERASE')`,
      [line, shopify ?? null],
    );
  }

  if (shopify) {
    await client.query(
      `INSERT INTO account_link_nonces (nonce, shopify_customer_id, expires_at)
       VALUES ($1,$2, now() + interval '1 day')`,
      [`TEST-ERASE-nonce-${shopify}`, shopify],
    );
    if (withLedger) {
      await client.query(
        `INSERT INTO roji_delivery_ledger (shopify_customer_id, period) VALUES ($1,'2026-09')`,
        [shopify],
      );
    }
  }

  if (line || shopify) {
    await client.query(`INSERT INTO customer_linkages (line_user_id, shopify_customer_id, source)
                        VALUES ($1,$2,'test')`, [line ?? `${shopify}-nolinetest`, shopify ?? null]);
    await client.query(`INSERT INTO user_identity_map (unified_user_id, line_user_id, shopify_customer_id)
                        VALUES ($1,$2,$3)`, [`TEST-ERASE-u-${line ?? shopify}`, line ?? null, shopify ?? null]);

    // 言葉の置き場: 本人に紐づく言葉（消える）＋ 手元の控え（消える）
    personSeq = (
      await client.query(`INSERT INTO roji_word_persons DEFAULT VALUES RETURNING person_seq`)
    ).rows[0].person_seq as string;
    if (line) {
      await client.query(
        `INSERT INTO roji_word_person_refs (person_seq, subject_kind, subject_id) VALUES ($1,'line',$2)`,
        [personSeq, line],
      );
    }
    if (shopify) {
      await client.query(
        `INSERT INTO roji_word_person_refs (person_seq, subject_kind, subject_id) VALUES ($1,'shopify',$2)`,
        [personSeq, shopify],
      );
    }
    await client.query(
      `INSERT INTO roji_words (body, occurred_at, person_seq, source)
       VALUES ('TEST-ERASE 変更理由の一言', now(), $1, 'change_reason')`,
      [personSeq],
    );
    // 出所10: 自分が置いた言葉の控え。場の言葉と**同じ本文**にする。
    await client.query(
      `INSERT INTO roji_words (body, occurred_at, person_seq, source)
       VALUES ($2, now(), $1, 'event_own_copy')`,
      [personSeq, ownCopyBody],
    );
  }

  return { personSeq };
}

async function main() {
  const url = process.env.SUPABASE_URL_STAGING;
  const password = process.env.SUPABASE_DB_PASSWORD_STAGING;
  if (!url || !password) {
    console.error("[FATAL] SUPABASE_URL_STAGING / SUPABASE_DB_PASSWORD_STAGING 未設定。中断。");
    process.exit(1);
  }
  const projectRef = new URL(url).hostname.split(".")[0];
  if (projectRef === PROD_REF || projectRef !== STAGING_REF) {
    console.error(`[ABORT] ref='${projectRef}' は staging ではない。接続せず中断。`);
    process.exit(1);
  }
  console.log(`[OK] PROJECT REF ASSERT: ${projectRef} (env=staging)`);

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
    console.log("\n=== 消去の関数が実在すること ===");
    for (const fn of ["roji_resolve_identity", "roji_erase_person", "roji_erasure_residue"]) {
      await it(`関数 ${fn} が存在する`, async () => {
        const { rows } = await client.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = $1`, [fn]);
        assertTrue(rows[0].n > 0, `${fn} が無い`);
      });
    }

    await client.query("BEGIN");

    // ---------------------------------------------------------------
    console.log("\n=== 図2: 消えるべきものが 1 つも残らない ===");

    // 「残る」側の基準値を先に取る（消しすぎていないことを見るため）。
    const beforePreserved = (
      await client.query(
        `SELECT (SELECT count(*)::int FROM roji_edit_records) AS edits,
                (SELECT count(*)::int FROM roji_words WHERE person_seq IS NULL) AS anon,
                (SELECT count(*)::int FROM roji_delivery_months) AS months`,
      )
    ).rows[0];

    // 図2「もともと個人の記録ではない」: 場に置かれた匿名の言葉（本人の控えと同じ本文）
    await client.query(
      `INSERT INTO roji_words (body, occurred_at, person_seq, source) VALUES ($1, now(), NULL, 'event_floor')`,
      [SHARED_BODY],
    );
    // 図2「骨だけ残る」: 編むのにかかった手間
    const editId = (
      await client.query(
        `INSERT INTO roji_edit_records (edited_period, editor_ref, revision_amount, revision_kinds)
         VALUES ('2026-09','TEST-ERASE-editor',0.4,ARRAY['tone']) RETURNING id`,
      )
    ).rows[0].id as string;

    // --- 人を作る -------------------------------------------------
    // P1: 連携済み（LINE + EC 顧客番号の両方の記録を持つ人）
    //     この人の控えだけ、場に置かれた匿名の言葉と **同じ本文** にする。
    //     控えが消えて場の言葉が残ること＝両者を結ぶ鍵が無いことを、ここで見る。
    await seedPerson(client, { line: P1_LINE, shopify: P1_SHOP, withLedger: true, ownCopyBody: SHARED_BODY });
    await client.query(`UPDATE roji_delivery_ledger SET edit_record_id = $1 WHERE shopify_customer_id = $2`, [
      editId,
      P1_SHOP,
    ]);
    // P2: 未連携のまま（LINE だけ）
    await seedPerson(client, { line: P2_LINE });
    // P3: 世帯共有（同じ EC 顧客に 2 本目の LINE がぶら下がる）
    await seedPerson(client, { line: P3_LINE_A, shopify: P3_SHOP, withLedger: true });
    await client.query(
      `INSERT INTO customer_linkages (line_user_id, shopify_customer_id, source) VALUES ($1,$2,'test')`,
      ["UTEST-ERASE-P3-lineB", P3_SHOP],
    );
    // OTHER: 巻き込まれてはいけない別人
    await seedPerson(client, { line: OTHER_LINE, shopify: OTHER_SHOP, withLedger: true });

    const otherBefore = await residue(client, [OTHER_SHOP], [OTHER_LINE]);

    await it("消す前は、各置き場に記録がある（テストの前提が成立している）", async () => {
      const r = await residue(client, [P1_SHOP], [P1_LINE]);
      assertTrue(totalOf(r) >= 15, `記録が足りない: ${JSON.stringify(r)}`);
      assertTrue(r.conversations > 0 && r.message_feedback > 0, "会話・感想が入っていない");
      assertTrue(r.roji_words_person_linked > 0 && r.roji_delivery_ledger > 0, "言葉・台帳が入っていない");
    });

    // --- 連携済みの人を EC 顧客番号で消す --------------------------
    await it("連携済みの人を EC 顧客番号で消すと、LINE 側の記録も 1 件残らず消える", async () => {
      const res = (await client.query(`SELECT roji_erase_person('shopify',$1) AS r`, [P1_SHOP])).rows[0].r;
      assertTrue(res.identity.line_ids.includes(P1_LINE), `LINE の ID を辿れていない: ${JSON.stringify(res.identity)}`);
      const r = await residue(client, [P1_SHOP], [P1_LINE]);
      assertEqual(nonZero(r).join(","), "", `消し残しがある: ${nonZero(r).join(", ")}`);
    });

    await it("未連携のまま消した人も、各置き場から 1 件残らず消える", async () => {
      await client.query(`SELECT roji_erase_person('line',$1)`, [P2_LINE]);
      const r = await residue(client, [], [P2_LINE]);
      assertEqual(nonZero(r).join(","), "", `消し残しがある: ${nonZero(r).join(", ")}`);
    });

    await it("世帯共有（1 人の EC 顧客に複数の LINE）でも、ぶら下がる LINE を取り残さない", async () => {
      const res = (await client.query(`SELECT roji_erase_person('line',$1) AS r`, [P3_LINE_A])).rows[0].r;
      assertTrue(
        res.identity.line_ids.includes("UTEST-ERASE-P3-lineB"),
        `2 本目の LINE を辿れていない: ${JSON.stringify(res.identity)}`,
      );
      const r = await residue(client, [P3_SHOP], [P3_LINE_A, "UTEST-ERASE-P3-lineB"]);
      assertEqual(nonZero(r).join(","), "", `消し残しがある: ${nonZero(r).join(", ")}`);
    });

    // ---------------------------------------------------------------
    console.log("\n=== 図2: 残ると決めた 3 つが、本人に辿り着けない形で残っている ===");

    await it("残るもの2「編むのにかかった手間」が残る（誰に向けて編んだかは切り離されている）", async () => {
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM roji_edit_records WHERE id = $1`, [editId]);
      assertEqual(rows[0].n, 1, "編集の記録が消えてしまっている");
      // 個人へ辿れる列を構造上持たないことを確認する。
      const cols = (
        await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema='public' AND table_name='roji_edit_records'`,
        )
      ).rows.map((r) => r.column_name as string);
      const personish = cols.filter((c) => /customer|line_user|person_seq|email|shopify/.test(c));
      assertEqual(personish.join(","), "", `個人へ辿れる列がある: ${personish.join(", ")}`);
    });

    await it("残るもの3「イベントの場に置いた言葉」が残り、手元の控えだけが消えている", async () => {
      const { rows } = await client.query(
        `SELECT source, count(*)::int AS n FROM roji_words WHERE body = $1 GROUP BY source ORDER BY source`,
        [SHARED_BODY],
      );
      const bySource = Object.fromEntries(rows.map((r) => [r.source, r.n]));
      assertEqual(bySource.event_floor ?? 0, 1, "場に置かれた匿名の言葉が消えている");
      assertEqual(bySource.event_own_copy ?? 0, 0, "手元の控えが残っている");
    });

    await it("残った匿名の言葉から本人へ辿る鍵が無い（person_seq を持たない）", async () => {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM roji_words WHERE body = $1 AND person_seq IS NOT NULL`,
        [SHARED_BODY],
      );
      assertEqual(rows[0].n, 0, "匿名のはずの言葉が person_seq を持っている");
    });

    await it("消しすぎていない（月の締めと既存の匿名の言葉・編集の記録を巻き込んでいない）", async () => {
      const after = (
        await client.query(
          `SELECT (SELECT count(*)::int FROM roji_edit_records) AS edits,
                  (SELECT count(*)::int FROM roji_words WHERE person_seq IS NULL) AS anon,
                  (SELECT count(*)::int FROM roji_delivery_months) AS months`,
        )
      ).rows[0];
      assertEqual(after.edits, beforePreserved.edits + 1, "編集の記録が減っている");
      assertEqual(after.anon, beforePreserved.anon + 1, "匿名の言葉が減っている");
      assertEqual(after.months, beforePreserved.months, "月の締めが減っている");
    });

    // ---------------------------------------------------------------
    console.log("\n=== 巻き添え・痕跡・再登録 ===");

    await it("別人の記録を 1 件も巻き込んでいない", async () => {
      const after = await residue(client, [OTHER_SHOP], [OTHER_LINE]);
      assertEqual(JSON.stringify(after), JSON.stringify(otherBefore), "別人の記録が変化している");
    });

    await it("「削除済み 1 件」という痕跡を残していない（消去で増えた行が 1 行も無い）", async () => {
      // 本人の ID を含む行が、消去後にどこかへ新設されていないこと。
      // pg_stat ではなく実データで見る: 全表を走査し、消した ID の文字列を含む行を探す。
      const idsToHunt = [P1_LINE, P1_SHOP, P2_LINE, P3_LINE_A, P3_SHOP];
      const { rows: tables } = await client.query(
        `SELECT c.table_name, c.column_name FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_name=c.table_name AND t.table_schema=c.table_schema
         WHERE c.table_schema='public' AND t.table_type='BASE TABLE'
           AND c.data_type IN ('text','character varying')`,
      );
      const hits: string[] = [];
      for (const { table_name, column_name } of tables) {
        const { rows } = await client.query(
          `SELECT count(*)::int AS n FROM public.${table_name} WHERE ${column_name} = ANY($1)`,
          [idsToHunt],
        );
        if (rows[0].n > 0) hits.push(`${table_name}.${column_name}=${rows[0].n}`);
      }
      assertEqual(hits.join(","), "", `消した人の ID がまだ残っている: ${hits.join(", ")}`);
    });

    // ---------------------------------------------------------------
    console.log("\n=== 検算の口（roji_erasure_residue）===");

    await it("消したあと、残っているものを列挙して返せる（clean = true）", async () => {
      const { rows } = await client.query(`SELECT roji_erasure_residue($1,$2,$3) AS r`, [
        [P1_SHOP, P3_SHOP],
        [P1_LINE, P2_LINE, P3_LINE_A, "UTEST-ERASE-P3-lineB"],
        [],
      ]);
      const r = rows[0].r;
      const bad = Object.entries(r.remaining).filter(([, v]) => Number(v) !== 0);
      assertEqual(bad.map(([k, v]) => `${k}=${v}`).join(","), "", "remaining に 0 でない表がある");
      assertTrue(r.clean === true, `clean が true でない: ${JSON.stringify(r)}`);
      assertTrue(Number(r.preserved.roji_edit_records) > 0, "残るはずの編集の記録が 0");
      assertTrue(Number(r.preserved.roji_words_anonymous) > 0, "残るはずの匿名の言葉が 0");
    });

    await it("消していない人には clean = false を返す（検算が本当に効いている）", async () => {
      const { rows } = await client.query(`SELECT roji_erasure_residue($1,$2,$3) AS r`, [
        [OTHER_SHOP],
        [OTHER_LINE],
        [],
      ]);
      assertTrue(rows[0].r.clean === false, "残っているのに clean = true を返した");
    });

    // 再登録は「消えたことの確認」がすべて終わってから行う。
    // 先に行うと、新しく作った空の器が残留と見分けられなくなる。
    await it("戻ってきても、以前の記録は戻らない", async () => {
      // 同じ EC 顧客番号で作り直す = 一度も存在しなかったのと同じ状態から始まる。
      const seq = (await client.query(`INSERT INTO roji_word_persons DEFAULT VALUES RETURNING person_seq`)).rows[0]
        .person_seq as string;
      await client.query(
        `INSERT INTO roji_word_person_refs (person_seq, subject_kind, subject_id) VALUES ($1,'shopify',$2)`,
        [seq, P1_SHOP],
      );
      const { rows } = await client.query(`SELECT count(*)::int AS n FROM roji_words WHERE person_seq = $1`, [seq]);
      assertEqual(rows[0].n, 0, "再登録で以前の言葉が戻っている");
      const r = await residue(client, [P1_SHOP], [P1_LINE]);
      assertEqual(r.roji_delivery_ledger, 0, "再登録で台帳が戻っている");
      assertEqual(r.conversations, 0, "再登録で会話が戻っている");
    });

    await client.query("ROLLBACK");
    console.log("\n[OK] ROLLBACK 完了。テストデータは 1 行も残っていません。");

    await it("ROLLBACK 後、テストデータが 1 行も残っていない", async () => {
      const { rows } = await client.query(
        `SELECT (SELECT count(*)::int FROM conversations WHERE user_id LIKE 'UTEST-ERASE-%') AS conv,
                (SELECT count(*)::int FROM customer_linkages WHERE line_user_id LIKE 'UTEST-ERASE-%') AS link,
                (SELECT count(*)::int FROM roji_words WHERE body LIKE 'TEST-ERASE%') AS words,
                (SELECT count(*)::int FROM roji_edit_records WHERE editor_ref = 'TEST-ERASE-editor') AS edits,
                (SELECT count(*)::int FROM roji_delivery_ledger WHERE shopify_customer_id LIKE 'TEST-ERASE-%') AS ledger`,
      );
      const r = rows[0];
      assertEqual(r.conv + r.link + r.words + r.edits + r.ledger, 0, `残留がある: ${JSON.stringify(r)}`);
    });
  } finally {
    await client.end();
  }

  console.log(`\n=== 結果: ${passed}/${total} PASS (env=staging) ===`);
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
