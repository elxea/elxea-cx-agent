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

  console.log("\n=== Stage 1 の範囲確認 ===");

  await it("subject_links はまだ存在しない（Stage 2 の範囲）", async () => {
    const { rows } = await client.query(`SELECT to_regclass('public.subject_links') AS reg`);
    // 存在するようになったら、上と同じ両方向テストをこのファイルに足すこと。
    assertTrue(
      rows[0].reg === null,
      "subject_links ができている。E4 の両方向テストをこのファイルに追加すること",
    );
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
