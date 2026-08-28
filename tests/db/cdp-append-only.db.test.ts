/**
 * DB Round-trip Tests — CDP の追記専用（E4）と「1 鍵 = 1 主体」（migration 040 / 041 / 042）
 *
 * 設計 §5 E4 は「identity_edges / subject_links は消去経路以外から書き換えられない」と
 * 言っている。これは **配線の主張** であって、コードを読んでも確かめられない
 * （トリガと GUC が噛み合って初めて成り立つ）。よってここで両方向を実測する:
 *
 *   1. 消去経路 **以外** からの UPDATE / DELETE が失敗すること
 *   2. 消去経路（app.erasure_context を立てた側）からは成功すること
 *   3. その例外がトランザクションを抜けると自動的に閉じること
 *   4. 実際の消去関数 roji_erase_person（042）が、その例外を通って edges を消し
 *      主体を retire できること — つまり (1) と (2) が同じ配線で繋がっていること
 *
 * さらに MID-1（QA 指摘 2026-08-29）の是正も実測する:
 *
 *   5. identity_edges_uniq が (identifier_kind, identifier_value) の **2 列** であること
 *   6. 同じ鍵に別の主体を結ぼうとすると 23505 で落ちること
 *   7. **本当に並行した 2 接続** で発行しても、主体が 1 つに収束すること
 *
 * ─ 安全 ─
 *   - 接続先は **staging のみ**（project ref を HARD ASSERT。本番 ref なら接続せず中断）。
 *     `--env prod` は用意しない — 本テストは書き込みを伴うため、本番には向けない。
 *   - 検証 1〜6 は 1 本のトランザクション内で migration 040/041/042 を当ててから行い、
 *     **最後に必ず ROLLBACK する**。成功しても失敗しても DB には 1 行も、1 オブジェクトも残らない。
 *     （= このテストを走らせるために staging へ migration を当てておく必要は無い）
 *   - 検証 7 は本物の並行が要る（＝ commit が要る）ので、**使い捨てスキーマ**を 1 つ作り、
 *     その中にだけ 040 を当てて実行し、最後に DROP SCHEMA CASCADE で丸ごと落とす。
 *     public スキーマには一切触れない。
 *
 * 使用:
 *   npx tsx tests/db/cdp-append-only.db.test.ts     # = pnpm test:db:cdp
 *
 * 必要な環境変数（.dev.vars / .env から読む。値は表示しない）:
 *   SUPABASE_URL_STAGING / SUPABASE_DB_PASSWORD_STAGING
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
dotenv.config({ path: ".dev.vars" });

const PROD_REF = "bquqzrbzdzjegdovxalu";
const STAGING_REF = "espeokdhutgztksdrpzt";

const MIGRATIONS_DIR = join(process.cwd(), "src", "db", "migrations");
const CDP_MIGRATIONS = [
  "040_cdp_subjects_and_edges.sql",
  "041_cdp_customer_events.sql",
  "042_cdp_erasure_subject_scope.sql",
  "043_cdp_subject_links.sql",
];

/** 本テストが入れる値の目印。実データと衝突しない形にする。 */
const TAG = `cdptest-${Date.now()}`;
const LINE_UID = `U-${TAG}`;

let total = 0;
let passed = 0;
const failures: Array<{ name: string; error: string }> = [];

/**
 * 1 件のテスト。
 *
 * `client` を渡すと SAVEPOINT で包み、失敗したときだけ巻き戻す。トランザクション内で
 * 走らせるテストは、1 件落ちるとその後すべてが
 * "current transaction is aborted" になって **本当の原因が 1 件目にしか出ない**。
 * 落ちた 1 件だけを巻き戻せば、残りの検査結果もそのまま読める。
 * 成功した場合は巻き戻さない（後続のテストが前のテストの行を使うため）。
 */
async function it(name: string, fn: () => Promise<void>, client?: pg.Client) {
  total++;
  if (client) await client.query("SAVEPOINT sp_it");
  try {
    await fn();
    if (client) await client.query("RELEASE SAVEPOINT sp_it");
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    if (client) {
      await client.query("ROLLBACK TO SAVEPOINT sp_it").catch(() => undefined);
      await client.query("RELEASE SAVEPOINT sp_it").catch(() => undefined);
    }
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

/**
 * 実行して「拒否されること」を期待する。落ちなければテスト失敗。
 * SAVEPOINT で包むので、拒否されたあとも外側のトランザクションは続行できる。
 */
async function expectReject(
  client: pg.Client,
  sql: string,
  params: unknown[],
  label: string,
  opts?: { messageIncludes?: string; code?: string },
) {
  await client.query("SAVEPOINT sp_expect_reject");
  let rejected: Error | null = null;
  try {
    await client.query(sql, params);
  } catch (e) {
    rejected = e instanceof Error ? e : new Error(String(e));
  }
  await client.query("ROLLBACK TO SAVEPOINT sp_expect_reject");
  await client.query("RELEASE SAVEPOINT sp_expect_reject");
  if (!rejected) throw new Error(`${label}: 拒否されるはずが通ってしまった`);
  if (opts?.messageIncludes && !rejected.message.includes(opts.messageIncludes)) {
    throw new Error(`${label}: 別の理由で落ちた（期待: "${opts.messageIncludes}" / 実際: ${rejected.message}）`);
  }
  if (opts?.code && (rejected as { code?: string }).code !== opts.code) {
    throw new Error(
      `${label}: SQLSTATE が違う（期待: ${opts.code} / 実際: ${(rejected as { code?: string }).code}）`,
    );
  }
}

function stagingConnInfo(): { host: string; password: string } {
  const url = process.env.SUPABASE_URL_STAGING;
  const password = process.env.SUPABASE_DB_PASSWORD_STAGING;
  if (!url || !password) {
    console.error("[FATAL] staging の接続情報が未設定（SUPABASE_URL_STAGING / SUPABASE_DB_PASSWORD_STAGING）。中断。");
    process.exit(1);
  }
  const projectRef = new URL(url).hostname.split(".")[0];
  if (projectRef === PROD_REF) {
    console.error("[ABORT] staging 指定に本番 ref が入っている。接続せず中断。");
    process.exit(1);
  }
  if (projectRef !== STAGING_REF) {
    console.error(`[ABORT] 想定外の ref='${projectRef}'。接続せず中断。`);
    process.exit(1);
  }
  console.log(`[OK] PROJECT REF ASSERT: ${projectRef} (env=staging)`);
  return { host: `db.${projectRef}.supabase.co`, password };
}

function newClient(host: string, password: string): pg.Client {
  return new pg.Client({
    host,
    port: 5432,
    database: "postgres",
    user: "postgres",
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
}

function migrationSql(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8");
}

/** ULID の形（040 の CHECK と同じ）を満たすテスト用 ID。 */
function fakeUlid(seed: string): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    out += alphabet[(seed.charCodeAt(i % seed.length) + i * 7) % alphabet.length];
  }
  return out;
}

// ===========================================================================
// 1〜6: 1 本のトランザクション内で migration を当てて検証し、最後に ROLLBACK
// ===========================================================================
async function runAppendOnlyChecks(client: pg.Client) {
  console.log("\n=== migration 040 / 041 / 042 を tx 内で適用（最後に ROLLBACK）===");
  await client.query("BEGIN");

  for (const file of CDP_MIGRATIONS) {
    await it(`${file} が適用できる`, async () => {
      await client.query(migrationSql(file));
    }, client);
  }

  const SUBJECT_A = fakeUlid("subject-a");
  const SUBJECT_B = fakeUlid("subject-b");

  console.log("\n=== MID-1: 1 つの鍵は 1 つの主体しか指さない ===");

  await it("identity_edges_uniq は (identifier_kind, identifier_value) の 2 列である", async () => {
    const { rows } = await client.query(
      `SELECT pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'public.identity_edges'::regclass
          AND c.relname = 'identity_edges_uniq'`,
    );
    assertEqual(rows.length, 1, "identity_edges_uniq が無い");
    const def = rows[0].def as string;
    assertTrue(def.includes("UNIQUE"), `一意でない: ${def}`);
    assertTrue(def.includes("identifier_kind"), `identifier_kind が入っていない: ${def}`);
    assertTrue(def.includes("identifier_value"), `identifier_value が入っていない: ${def}`);
    // ここが 3 列だと、並行 2 リクエストで主体が 2 つ立つ（QA 指摘 MID-1）。
    assertTrue(!def.includes("subject_id"), `subject_id が入っている（3 列版のまま）: ${def}`);
  }, client);

  await it("同じ鍵を別の主体に結ぼうとすると 23505 で落ちる", async () => {
    await client.query(`INSERT INTO subjects (subject_id) VALUES ($1), ($2)`, [SUBJECT_A, SUBJECT_B]);
    await client.query(
      `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
       VALUES ($1, 'line_messaging_uid', $2, 'db-test')`,
      [SUBJECT_A, LINE_UID],
    );
    await expectReject(
      client,
      `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
       VALUES ($1, 'line_messaging_uid', $2, 'db-test')`,
      [SUBJECT_B, LINE_UID],
      "同じ鍵に 2 つ目の主体",
      { code: "23505" },
    );
  }, client);

  await it("同じ（鍵・主体）の再観測も 1 行に収まる（重複が積み上がらない）", async () => {
    await client.query("SAVEPOINT sp_dup");
    await expectReject(
      client,
      `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
       VALUES ($1, 'line_messaging_uid', $2, 'db-test-again')`,
      [SUBJECT_A, LINE_UID],
      "同じ鍵・同じ主体の 2 行目",
      { code: "23505" },
    );
    // ON CONFLICT DO NOTHING なら例外にならず、行も増えない（呼び出し側の作法）。
    await client.query(
      `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
       VALUES ($1, 'line_messaging_uid', $2, 'db-test-again')
       ON CONFLICT (identifier_kind, identifier_value) DO NOTHING`,
      [SUBJECT_A, LINE_UID],
    );
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM identity_edges WHERE identifier_value = $1`,
      [LINE_UID],
    );
    assertEqual(rows[0].n, 1, "edge が 2 本になっている");
    await client.query("RELEASE SAVEPOINT sp_dup");
  }, client);

  console.log("\n=== E4-A: 消去経路 **以外** からは書き換えられない ===");

  await it("identity_edges の UPDATE は拒否される", async () => {
    await expectReject(
      client,
      `UPDATE identity_edges SET observed_by = 'tampered' WHERE identifier_value = $1`,
      [LINE_UID],
      "edge の UPDATE",
      { messageIncludes: "append-only violation" },
    );
  }, client);

  await it("identity_edges の DELETE は拒否される", async () => {
    await expectReject(
      client,
      `DELETE FROM identity_edges WHERE identifier_value = $1`,
      [LINE_UID],
      "edge の DELETE",
      { messageIncludes: "append-only violation" },
    );
  }, client);

  await it("subjects の DELETE は拒否される", async () => {
    await expectReject(
      client,
      `DELETE FROM subjects WHERE subject_id = $1`,
      [SUBJECT_A],
      "subjects の DELETE",
      { messageIncludes: "append-only violation" },
    );
  }, client);

  await it("subjects.retired_at を消去経路の外から立てることはできない", async () => {
    await expectReject(
      client,
      `UPDATE subjects SET retired_at = now() WHERE subject_id = $1`,
      [SUBJECT_A],
      "retired_at の勝手な設定",
      { messageIncludes: "GDPR 消去経路" },
    );
  }, client);

  await it("subjects.subject_id / created_at は消去経路からでも変えられない（不変）", async () => {
    await client.query("SAVEPOINT sp_immutable");
    await client.query(`SELECT set_config('app.erasure_context', 'on', true)`);
    await expectReject(
      client,
      `UPDATE subjects SET created_at = now() - interval '1 day' WHERE subject_id = $1`,
      [SUBJECT_A],
      "created_at の書き換え",
      { messageIncludes: "不変" },
    );
    await client.query("ROLLBACK TO SAVEPOINT sp_immutable");
    await client.query("RELEASE SAVEPOINT sp_immutable");
  }, client);

  console.log("\n=== E4-B: 消去経路（app.erasure_context）からは通る ===");

  await it("app.erasure_context を立てると identity_edges を UPDATE / DELETE できる", async () => {
    await client.query("SAVEPOINT sp_erasure");
    await client.query(`SELECT set_config('app.erasure_context', 'on', true)`);

    const upd = await client.query(
      `UPDATE identity_edges SET observed_by = 'erasure-path' WHERE identifier_value = $1`,
      [LINE_UID],
    );
    assertEqual(upd.rowCount, 1, "消去経路からの UPDATE が通っていない");

    const del = await client.query(`DELETE FROM identity_edges WHERE identifier_value = $1`, [LINE_UID]);
    assertEqual(del.rowCount, 1, "消去経路からの DELETE が通っていない");

    const ret = await client.query(`UPDATE subjects SET retired_at = now() WHERE subject_id = $1`, [SUBJECT_A]);
    assertEqual(ret.rowCount, 1, "消去経路からの retired_at 設定が通っていない");

    // ここまでを巻き戻し、以降のテストのために edge を戻す。
    await client.query("ROLLBACK TO SAVEPOINT sp_erasure");
    await client.query("RELEASE SAVEPOINT sp_erasure");
  }, client);

  await it("例外は SAVEPOINT を巻き戻すと閉じる（立てっぱなしにできない）", async () => {
    // 直前のテストで立てた app.erasure_context が生き残っていれば、ここが通ってしまう。
    await expectReject(
      client,
      `DELETE FROM identity_edges WHERE identifier_value = $1`,
      [LINE_UID],
      "巻き戻した後の DELETE",
      { messageIncludes: "append-only violation" },
    );
    const { rows } = await client.query(`SELECT current_setting('app.erasure_context', true) AS v`);
    assertTrue(rows[0].v === null || rows[0].v === "", `例外表が残っている: ${JSON.stringify(rows[0].v)}`);
  }, client);

  console.log("\n=== E4-C: 実際の消去関数が同じ配線を通ること（配線が繋がっている）===");

  await it("roji_erase_person が edges を消し、主体を retire する（トリガを通り抜けられる）", async () => {
    await client.query("SAVEPOINT sp_real_erase");

    // 出来事も 1 件積んでおく（消去の列挙に載ることを確認するため）。
    await client.query(
      `INSERT INTO customer_events (subject_id, event_type, channel, schema_ok, occurred_at, source, idempotency_key)
       VALUES ($1, 'behavior.view_content', 'line', true, now(), 'db-test', $2)`,
      [SUBJECT_A, `db-test:${TAG}`],
    );

    const res = await client.query(`SELECT roji_erase_person('line', $1) AS r`, [LINE_UID]);
    const r = res.rows[0].r as {
      subjects_retired: number;
      identity: { subject_ids: string[] };
      deleted: Record<string, number>;
    };

    assertTrue(
      r.identity.subject_ids.includes(SUBJECT_A),
      `解決が主体に届いていない: ${JSON.stringify(r.identity.subject_ids)}`,
    );
    assertEqual(r.subjects_retired, 1, "主体が retire されていない");
    assertEqual(r.deleted.identity_edges ?? 0, 1, "identity_edges が消えていない");
    assertEqual(r.deleted.customer_events ?? 0, 1, "customer_events が消えていない");

    const left = await client.query(
      `SELECT count(*)::int AS n FROM identity_edges WHERE identifier_value = $1`,
      [LINE_UID],
    );
    assertEqual(left.rows[0].n, 0, "edge が残っている");

    const retired = await client.query(`SELECT retired_at FROM subjects WHERE subject_id = $1`, [SUBJECT_A]);
    assertEqual(retired.rows.length, 1, "主体の行まで消えている（retire で残すはず）");
    assertTrue(retired.rows[0].retired_at !== null, "retired_at が立っていない");

    await client.query("ROLLBACK TO SAVEPOINT sp_real_erase");
    await client.query("RELEASE SAVEPOINT sp_real_erase");
  }, client);

  await it("消去関数を抜けたあとは例外表が閉じている（関数の中だけで立つ）", async () => {
    const { rows } = await client.query(`SELECT current_setting('app.erasure_context', true) AS v`);
    assertTrue(rows[0].v === null || rows[0].v === "", `関数を抜けても例外表が残っている: ${JSON.stringify(rows[0].v)}`);
  }, client);

  // =========================================================================
  // Stage 2: subject_links — Stage 1 のこのファイルが「できたら足すこと」と
  //          書いていた両方向テストを、約束どおりここに足す（2026-08-29）。
  // =========================================================================
  console.log("\n=== Stage 2: subject_links の型（basis ホワイトリスト / 無向の正規化）===");

  const SUBJECT_L = fakeUlid("stage2-line-x");
  const SUBJECT_S = fakeUlid("stage2-shop-x");
  const SUBJECT_W = fakeUlid("stage2-web-x");
  const LINE_UID_2 = `U${"a".repeat(31)}1`;
  const LINE_UID_3 = `U${"b".repeat(31)}2`;
  const SHOP_ID = `9${TAG.replace(/\D/g, "").slice(-8)}`;
  const WEB_SID = `sess-${TAG}`;

  await it("subject_links が存在し、Stage 2 の 3 主体と鍵を用意できる", async () => {
    const { rows } = await client.query(`SELECT to_regclass('public.subject_links') AS reg`);
    assertTrue(rows[0].reg !== null, "subject_links が無い（043 が当たっていない）");

    await client.query(`INSERT INTO subjects (subject_id) VALUES ($1), ($2), ($3)`, [
      SUBJECT_L,
      SUBJECT_S,
      SUBJECT_W,
    ]);
    await client.query(
      `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by) VALUES
         ($1, 'line_messaging_uid',  $2, 'db-test'),
         ($3, 'shopify_customer_id', $4, 'db-test'),
         ($5, 'web_session_id',      $6, 'db-test')`,
      [SUBJECT_L, LINE_UID_2, SUBJECT_S, SHOP_ID, SUBJECT_W, WEB_SID],
    );
  }, client);

  await it("SEC-1: basis='email_equality' は型で拒否される（メール等値で人を結べない）", async () => {
    await expectReject(
      client,
      `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
       VALUES ($1, $2, 'email_equality', 'db-test')`,
      [SUBJECT_L < SUBJECT_S ? SUBJECT_L : SUBJECT_S, SUBJECT_L < SUBJECT_S ? SUBJECT_S : SUBJECT_L],
      "email_equality による link",
      { code: "23514" },
    );
  }, client);

  await it("向きは持てない（subject_a < subject_b に正規化されていないと入らない）", async () => {
    const [lo, hi] = SUBJECT_L < SUBJECT_S ? [SUBJECT_L, SUBJECT_S] : [SUBJECT_S, SUBJECT_L];
    await expectReject(
      client,
      `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
       VALUES ($1, $2, 'liff_id_token', 'db-test')`,
      [hi, lo],
      "逆向きの link",
      { code: "23514" },
    );
    // 自分自身に結ぶ行も同じ CHECK で入らない。
    await expectReject(
      client,
      `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
       VALUES ($1, $1, 'liff_id_token', 'db-test')`,
      [SUBJECT_L],
      "自己ループ",
      { code: "23514" },
    );
  }, client);

  await it("同じ 2 主体・同じ根拠の 2 行目は 23505（ON CONFLICT DO NOTHING なら増えない）", async () => {
    const [lo, hi] = SUBJECT_L < SUBJECT_S ? [SUBJECT_L, SUBJECT_S] : [SUBJECT_S, SUBJECT_L];
    await client.query(
      `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
       VALUES ($1, $2, 'liff_id_token', 'db-test')`,
      [lo, hi],
    );
    await expectReject(
      client,
      `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
       VALUES ($1, $2, 'liff_id_token', 'db-test-again')`,
      [lo, hi],
      "同じ判断の 2 行目",
      { code: "23505" },
    );
    await client.query(
      `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
       VALUES ($1, $2, 'liff_id_token', 'db-test-again')
       ON CONFLICT (subject_a, subject_b, basis) DO NOTHING`,
      [lo, hi],
    );
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM subject_links WHERE subject_a = $1 AND subject_b = $2`,
      [lo, hi],
    );
    assertEqual(rows[0].n, 1, "link が 2 本になっている");
  }, client);

  console.log("\n=== Stage 2 / E4-A: 消去経路 **以外** からは書き換えられない ===");

  await it("subject_links の UPDATE は拒否される", async () => {
    await expectReject(
      client,
      `UPDATE subject_links SET observed_by = 'tampered' WHERE subject_a = $1 OR subject_b = $1`,
      [SUBJECT_L],
      "link の UPDATE",
      { messageIncludes: "append-only violation" },
    );
  }, client);

  await it("subject_links の DELETE は拒否される", async () => {
    await expectReject(
      client,
      `DELETE FROM subject_links WHERE subject_a = $1 OR subject_b = $1`,
      [SUBJECT_L],
      "link の DELETE",
      { messageIncludes: "append-only violation" },
    );
  }, client);

  console.log("\n=== Stage 2 / E4-B: 消去経路（app.erasure_context）からは通る ===");

  await it("app.erasure_context を立てると subject_links を UPDATE / DELETE できる", async () => {
    await client.query("SAVEPOINT sp_link_erasure");
    await client.query(`SELECT set_config('app.erasure_context', 'on', true)`);

    const upd = await client.query(
      `UPDATE subject_links SET observed_by = 'erasure-path' WHERE subject_a = $1 OR subject_b = $1`,
      [SUBJECT_L],
    );
    assertEqual(upd.rowCount, 1, "消去経路からの UPDATE が通っていない");

    const del = await client.query(
      `DELETE FROM subject_links WHERE subject_a = $1 OR subject_b = $1`,
      [SUBJECT_L],
    );
    assertEqual(del.rowCount, 1, "消去経路からの DELETE が通っていない");

    await client.query("ROLLBACK TO SAVEPOINT sp_link_erasure");
    await client.query("RELEASE SAVEPOINT sp_link_erasure");
  }, client);

  await it("例外は巻き戻すと閉じる（link 側でも立てっぱなしにできない）", async () => {
    await expectReject(
      client,
      `DELETE FROM subject_links WHERE subject_a = $1 OR subject_b = $1`,
      [SUBJECT_L],
      "巻き戻した後の link DELETE",
      { messageIncludes: "append-only violation" },
    );
  }, client);

  console.log("\n=== Stage 2: J-4（1 Shopify 顧客に LINE は 1 本まで）===");

  await it("同じ人に 2 本目の LINE を結ぼうとすると J-4 で落ちる", async () => {
    const SUBJECT_L2 = fakeUlid("stage2-line-y");
    await client.query(`INSERT INTO subjects (subject_id) VALUES ($1)`, [SUBJECT_L2]);
    await client.query(
      `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
       VALUES ($1, 'line_messaging_uid', $2, 'db-test')`,
      [SUBJECT_L2, LINE_UID_3],
    );
    const [lo, hi] = SUBJECT_L2 < SUBJECT_S ? [SUBJECT_L2, SUBJECT_S] : [SUBJECT_S, SUBJECT_L2];
    await expectReject(
      client,
      `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
       VALUES ($1, $2, 'line_account_link', 'db-test')`,
      [lo, hi],
      "2 本目の LINE 束縛",
      { messageIncludes: "J-4 violation" },
    );
  }, client);

  console.log("\n=== Stage 2: canonical 解決（★11 の恒久解が実際に繋がること）===");

  await it("link 前は自分の鍵しか返らない（連携していない人の挙動は変わらない）", async () => {
    const { rows } = await client.query(
      `SELECT cdp_canonical_identifiers('web_session_id', $1) AS r`,
      [WEB_SID],
    );
    const r = rows[0].r as { found: boolean; link_count: number; identifier_values: string[] };
    assertTrue(r.found, "主体が引けていない");
    assertEqual(r.link_count, 0, "link が無いのに link_count が 0 でない");
    assertEqual(r.identifier_values.length, 1, "自分以外の鍵まで返っている");
    assertEqual(r.identifier_values[0], WEB_SID, "自分の鍵が返っていない");
  }, client);

  await it("link を足すと LINE の鍵から Shopify・Web の鍵まで届く（★11 の断線が塞がる）", async () => {
    // web を shopify に結ぶ（匿名昇格）。LINE ↔ Shopify は既に上のテストで結ばれている。
    const [lo, hi] = SUBJECT_W < SUBJECT_S ? [SUBJECT_W, SUBJECT_S] : [SUBJECT_S, SUBJECT_W];
    await client.query(
      `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
       VALUES ($1, $2, 'anonymous_promotion', 'db-test')`,
      [lo, hi],
    );

    const { rows } = await client.query(
      `SELECT cdp_canonical_identifiers('line_messaging_uid', $1) AS r`,
      [LINE_UID_2],
    );
    const r = rows[0].r as {
      found: boolean;
      link_count: number;
      member_count: number;
      identifier_values: string[];
    };
    assertTrue(r.found, "LINE の鍵から主体が引けていない");
    assertEqual(r.member_count, 3, "連結成分が 3 主体になっていない");
    assertTrue(r.link_count >= 2, `link_count が足りない: ${r.link_count}`);
    for (const expected of [LINE_UID_2, SHOP_ID, WEB_SID]) {
      assertTrue(
        r.identifier_values.includes(expected),
        `canonical 解決が ${expected === LINE_UID_2 ? "LINE" : expected === SHOP_ID ? "Shopify" : "Web"} の鍵に届いていない: ${JSON.stringify(r.identifier_values)}`,
      );
    }
  }, client);

  await it("SEC-1: email_hash では引けない・返らない", async () => {
    await client.query(
      `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
       VALUES ($1, 'email_hash', $2, 'db-test')`,
      [SUBJECT_S, `hash-${TAG}`],
    );
    const byHash = await client.query(
      `SELECT cdp_canonical_identifiers('email_hash', $1) AS r`,
      [`hash-${TAG}`],
    );
    assertEqual(
      (byHash.rows[0].r as { found: boolean }).found,
      false,
      "email_hash で人が引けてしまっている",
    );
    const fromLine = await client.query(
      `SELECT cdp_canonical_identifiers('line_messaging_uid', $1) AS r`,
      [LINE_UID_2],
    );
    const values = (fromLine.rows[0].r as { identifier_values: string[] }).identifier_values;
    assertTrue(
      !values.includes(`hash-${TAG}`),
      `email_hash が返り値に混ざっている: ${JSON.stringify(values)}`,
    );
  }, client);

  console.log("\n=== Stage 2 / GDPR: 消去の列挙に subject_links と delivery_identity が載る ===");

  await it("消去の列挙（roji_person_key_map）が subject_a / subject_b / delivery_identity を含む", async () => {
    const { rows } = await client.query(
      `SELECT tbl, col, key_kind FROM roji_person_key_map()
        WHERE tbl IN ('subject_links', 'delivery_identity') ORDER BY tbl, col`,
    );
    const got = rows.map((r) => `${r.tbl}.${r.col}:${r.key_kind}`);
    for (const expected of [
      "subject_links.subject_a:subject",
      "subject_links.subject_b:subject",
      "delivery_identity.subject_id:subject",
      "delivery_identity.line_user_id:line",
    ]) {
      assertTrue(got.includes(expected), `列挙に ${expected} が無い: ${JSON.stringify(got)}`);
    }
  }, client);

  await it("roji_erase_person が link の向こう側まで消し、residue が clean になる", async () => {
    await client.query("SAVEPOINT sp_stage2_erase");

    // 配信の宛先の派生と、両主体の出来事を 1 件ずつ置く。
    await client.query(
      `INSERT INTO delivery_identity (subject_id, line_user_id, source)
       VALUES ($1, $2, 'db-test')`,
      [SUBJECT_L, LINE_UID_2],
    );
    await client.query(
      `INSERT INTO customer_events (subject_id, event_type, channel, schema_ok, occurred_at, source, idempotency_key)
       VALUES ($1, 'behavior.view_content', 'line', true, now(), 'db-test', $2),
              ($3, 'purchase.order_paid',   'shopify', true, now(), 'db-test', $4)`,
      [SUBJECT_L, `s2-line:${TAG}`, SUBJECT_S, `s2-shop:${TAG}`],
    );

    // LINE の鍵だけで消す。link を辿らなければ Shopify 側の主体が残る。
    const res = await client.query(`SELECT roji_erase_person('line', $1) AS r`, [LINE_UID_2]);
    const r = res.rows[0].r as {
      subjects_retired: number;
      identity: { subject_ids: string[] };
      deleted: Record<string, number>;
    };

    for (const s of [SUBJECT_L, SUBJECT_S, SUBJECT_W]) {
      assertTrue(
        r.identity.subject_ids.includes(s),
        `解決が link の向こう側に届いていない（${s} が無い）: ${JSON.stringify(r.identity.subject_ids)}`,
      );
    }
    assertEqual(r.subjects_retired, 3, "3 主体すべてが retire されていない");
    assertTrue((r.deleted.subject_links ?? 0) >= 2, "subject_links が消えていない");
    assertEqual(r.deleted.delivery_identity ?? 0, 1, "delivery_identity が消えていない");
    assertEqual(r.deleted.customer_events ?? 0, 2, "customer_events が両方消えていない");

    // 検算: 孤児（retire 済みの主体を指す行）が 0 で clean。
    const residue = await client.query(
      `SELECT roji_erasure_residue(ARRAY[$1], ARRAY[$2], ARRAY[$3]) AS r`,
      [SHOP_ID, LINE_UID_2, WEB_SID],
    );
    const res2 = residue.rows[0].r as {
      clean: boolean;
      remaining: Record<string, number>;
    };
    assertEqual(
      res2.remaining.cdp_retired_subject_orphans ?? -1,
      0,
      `孤児が残っている: ${JSON.stringify(res2.remaining)}`,
    );
    assertTrue(res2.clean, `residue が clean でない: ${JSON.stringify(res2.remaining)}`);

    await client.query("ROLLBACK TO SAVEPOINT sp_stage2_erase");
    await client.query("RELEASE SAVEPOINT sp_stage2_erase");
  }, client);

  await it("cdp_stage2_parity が呼べて、判定キーが揃っている（日次 tick の材料）", async () => {
    const { rows } = await client.query(`SELECT cdp_stage2_parity() AS r`);
    const r = rows[0].r as Record<string, unknown>;
    for (const key of [
      "linked_ledger_rows",
      "linked_without_link",
      "delivery_identity_missing",
      "multi_line_components",
      "max_component_size",
      "links_total",
      "in_agreement",
    ]) {
      assertTrue(key in r, `突合の返り値に ${key} が無い: ${JSON.stringify(Object.keys(r))}`);
    }
    // J-4 のトリガが効いている限り、この数は常に 0。
    assertEqual(r.multi_line_components as number, 0, "J-4 が破れている成分がある");
  }, client);

  await client.query("ROLLBACK");
  console.log("  [OK] ROLLBACK 完了（DB には 1 行も 1 オブジェクトも残っていない）");
}

// ===========================================================================
// 7: 本当に並行した 2 接続で発行しても、主体が 1 つに収束する
//    使い捨てスキーマを作り、その中にだけ 040 を当てて実行する。
// ===========================================================================
async function runConcurrencyChecks(host: string, password: string) {
  const schema = `cdp_race_${TAG.replace(/[^a-z0-9]/gi, "_")}`;
  const setup = newClient(host, password);
  const a = newClient(host, password);
  const b = newClient(host, password);

  console.log(`\n=== 並行発行（使い捨てスキーマ ${schema} 内で実施・最後に丸ごと削除）===`);
  await setup.connect();
  try {
    await setup.query(`CREATE SCHEMA ${schema}`);
    await setup.query(`SET search_path TO ${schema}, public`);
    // 040 だけで足りる（subjects / identity_edges / 追記専用トリガ）。
    await setup.query(migrationSql(CDP_MIGRATIONS[0]));

    await a.connect();
    await b.connect();
    for (const c of [a, b]) await c.query(`SET search_path TO ${schema}, public`);

    const SUB_A = fakeUlid("race-a");
    const SUB_B = fakeUlid("race-b");
    const KEY = `U-race-${TAG}`;

    await it("先に commit した側が鍵を取り、後から来た側は 23505 で落ちる（自動コミット＝本番の形）", async () => {
      // web-app / cx-agent は PostgREST 経由なので 1 文ごとに自動コミットされる。
      await a.query(`INSERT INTO subjects (subject_id) VALUES ($1)`, [SUB_A]);
      await b.query(`INSERT INTO subjects (subject_id) VALUES ($1)`, [SUB_B]);
      await a.query(
        `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
         VALUES ($1, 'line_messaging_uid', $2, 'race-a')`,
        [SUB_A, KEY],
      );
      let rejected: { code?: string } | null = null;
      try {
        await b.query(
          `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
           VALUES ($1, 'line_messaging_uid', $2, 'race-b')`,
          [SUB_B, KEY],
        );
      } catch (e) {
        rejected = e as { code?: string };
      }
      assertTrue(rejected !== null, "2 つ目の発行が通ってしまった（主体が 2 つ立つ）");
      assertEqual(rejected?.code, "23505", "落ち方が一意制約違反ではない");

      // 負けた側は引き直して勝者に合流する（subjects.ts と同じ手順）。
      const { rows } = await b.query(
        `SELECT subject_id FROM identity_edges
          WHERE identifier_kind = 'line_messaging_uid' AND identifier_value = $1`,
        [KEY],
      );
      assertEqual(rows.length, 1, "edge が 1 本でない");
      assertEqual(rows[0].subject_id, SUB_A, "負けた側が勝者に合流していない");
    });

    await it("トランザクションが重なった場合も、ロック待ちのあと後発が落ちる（1 本に収束）", async () => {
      const KEY2 = `U-race2-${TAG}`;
      const SUB_C = fakeUlid("race-c");
      const SUB_D = fakeUlid("race-d");

      await a.query("BEGIN");
      await b.query("BEGIN");
      await a.query(`INSERT INTO subjects (subject_id) VALUES ($1)`, [SUB_C]);
      await b.query(`INSERT INTO subjects (subject_id) VALUES ($1)`, [SUB_D]);
      await a.query(
        `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
         VALUES ($1, 'line_messaging_uid', $2, 'race-c')`,
        [SUB_C, KEY2],
      );

      // B の INSERT は A が未 commit の間ブロックされる（await しない）。
      const pending = b
        .query(
          `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
           VALUES ($1, 'line_messaging_uid', $2, 'race-d')`,
          [SUB_D, KEY2],
        )
        .then(
          () => ({ ok: true as const }),
          (e: { code?: string }) => ({ ok: false as const, code: e.code }),
        );

      await a.query("COMMIT");
      const outcome = await pending;
      assertTrue(!outcome.ok, "重なった 2 つの発行が両方通ってしまった");
      assertEqual(outcome.code, "23505", "落ち方が一意制約違反ではない");

      await b.query("ROLLBACK");
      const { rows } = await b.query(
        `SELECT count(*)::int AS n FROM identity_edges WHERE identifier_value = $1`,
        [KEY2],
      );
      assertEqual(rows[0].n, 1, "edge が 1 本でない");
    });
  } finally {
    for (const c of [a, b]) {
      try {
        await c.query("ROLLBACK");
      } catch {
        /* トランザクション中でなければ無視 */
      }
      await c.end().catch(() => undefined);
    }
    // 使い捨てスキーマを丸ごと落とす（append-only トリガは DDL には効かない）。
    await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch((e) => {
      console.error(`[WARN] 使い捨てスキーマ ${schema} の削除に失敗: ${e instanceof Error ? e.message : e}`);
    });
    await setup.end().catch(() => undefined);
    console.log(`  [OK] 使い捨てスキーマ ${schema} を削除`);
  }
}

async function main() {
  const { host, password } = stagingConnInfo();

  const client = newClient(host, password);
  await client.connect();
  try {
    await runAppendOnlyChecks(client);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await client.end().catch(() => undefined);
  }

  await runConcurrencyChecks(host, password);

  console.log(`\n=== cdp-append-only.db.test: ${passed}/${total} passed, ${failures.length} failed ===`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
