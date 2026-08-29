/**
 * DB Round-trip Tests — Stage 2 の写し取り（backfill）が parity を緑にする（migration 047）
 *
 * ─ 何を確かめるか ─
 *
 *   Stage 2 のコードが載る **前** に成立していた連携は、旧台帳 customer_linkages に
 *   行があるだけで subject_links を持たない。`cdp_stage2_parity()` はそれを
 *   `linked_without_link` として数え、`in_agreement` は false のままになる。
 *   自然に link 化される経路は 1 本も無い（詳細は 047 のヘッダ）。
 *
 *   ここで固定するのは、写し取りが **parity をちゃんと緑にする** ことと、
 *   写し取りが **不変条件を 1 つも迂回しない** ことの 2 つ:
 *
 *     (A) 写す前は in_agreement=false（linked_without_link / delivery_identity_missing > 0）
 *     (B) 写した後は in_agreement=true（4 つの数がすべて 0）
 *     (C) basis のホワイトリスト（SEC-1）— email_equality は 047 の後も入らない
 *     (D) E4 — 写した link も UPDATE / DELETE を拒む（追記専用は緩まない）
 *     (E) J-4 — 世帯共有（1 Shopify に 2 本目の LINE）は写せない。**写らないのが正しい**
 *     (F) 冪等 — 2 度写しても link は増えない（ON CONFLICT DO NOTHING）
 *     (G) cdp_stage2_backfill_candidates() の母数が parity の母数と一致する
 *
 * ─ なぜ SQL で写すのか（本番の写し取りは TypeScript なのに）─
 *
 *   本番の写し取りは `scripts/cdp-stage2-backfill.ts` が Stage 2 の正規経路と同じ関数
 *   （appendSubjectLink / resolveOrIssueSubject / upsertDeliveryIdentity）を通して行う。
 *   ここはそれを **PostgREST 抜きで再現できない** ので、同じ順序・同じ列で
 *   INSERT する（トリガと CHECK は同じものが当たる）。よってこのファイルが見るのは
 *   「DB 側の配線」であって「スクリプトの分岐」ではない。分岐は
 *   tests/unit/cdp-stage2-backfill.test.ts が DB 抜きで持つ。
 *   スクリプト経由の実効確認は staging での実行ログが持つ（PR 本文に添付）。
 *
 * ─ 安全 ─
 *   - 接続先は **staging のみ**（project ref を HARD ASSERT。本番 ref なら接続せず中断）。
 *   - すべて 1 本のトランザクション内で行い、**最後に必ず ROLLBACK する**。
 *     migration 040〜047 の適用も、合成データも、DB には 1 行も残らない。
 *   - 外部送信ゼロ。LINE にも Shopify にも触れない。
 *
 * 使用:
 *   npx tsx tests/db/cdp-stage2-backfill.db.test.ts   # = pnpm test:db:cdp-stage2-backfill
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
  "044_cdp_stage2_parity_map_agreement.sql",
  "047_cdp_stage2_legacy_backfill.sql",
];

/** 写し取りの根拠と経路名（scripts/cdp-stage2-backfill.ts と同じ値）。 */
const BACKFILL_BASIS = "legacy_ledger_backfill";
const BACKFILL_OBSERVED_BY = "cdp-backfill-047";

/** 合成する「Stage 2 より前の連携」の件数。 */
const LEGACY_ROWS = 6;

const TAG = Date.now().toString(16).padStart(12, "0").slice(-12);

let total = 0;
let passed = 0;
const failures: Array<{ name: string; error: string }> = [];

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
function assertEqual<T>(a: T, b: T, label: string) {
  if (a !== b) throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function stagingConnInfo(): { host: string; password: string } {
  const url = process.env.SUPABASE_URL_STAGING;
  const password = process.env.SUPABASE_DB_PASSWORD_STAGING;
  if (!url || !password) {
    console.error(
      "[FATAL] staging の接続情報が未設定（SUPABASE_URL_STAGING / SUPABASE_DB_PASSWORD_STAGING）。中断。",
    );
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

function migrationSql(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8");
}

/**
 * ULID の形（040 の CHECK）を満たすテスト用 ID。
 *
 * ⚠ 文字列を混ぜて作る簡易ハッシュにしないこと。初版はそれで **全部同じ 26 文字**に
 *   潰れ（LCG の乗算が 2^53 を超えて `>>> 0` が 0 を返していた）、別々の鍵が同じ主体を
 *   指した。症状は subject_links_ordered（a = b）と J-4 違反という **別の顔**で出たので、
 *   原因に辿り着くまで遠回りした。連番を base32 に展開すれば相異なる n が必ず
 *   相異なる 26 文字になる（cdp-stage2-canonical.db.test.ts が同じ罠を踏んで同じ形で直している）。
 */
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let ulidCounter = 0;
function newSubjectId(): string {
  let x = (ulidCounter += 1);
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    out = ULID_ALPHABET[x % 32] + out;
    x = Math.floor(x / 32);
  }
  return out;
}

/** Messaging userId の形（U + 32 hex）を満たす合成値。 */
function lineUid(n: number): string {
  return `U${TAG}${n.toString(16).padStart(20, "0")}`;
}
function shopifyId(n: number): string {
  return `99${TAG}${n.toString().padStart(2, "0")}`;
}

interface Legacy {
  line: string;
  shopify: string;
}

function buildLegacy(): Legacy[] {
  return Array.from({ length: LEGACY_ROWS }, (_, i) => ({
    line: lineUid(i + 1),
    shopify: shopifyId(i + 1),
  }));
}

/**
 * 旧台帳にだけ行がある状態（= Stage 2 より前に連携した人）を作る。
 *
 * ⚠ 冪等にする。it() は成功したテストの SAVEPOINT を RELEASE する（= tx 内に残る）ので、
 *   後続のテストが同じ行を入れ直そうとして UNIQUE 衝突するのを避ける。
 */
async function seedLegacyLedger(client: pg.Client, rows: Legacy[]) {
  for (const r of rows) {
    await client.query(
      `INSERT INTO customer_linkages (line_user_id, shopify_customer_id, linked_at, created_at, updated_at)
       VALUES ($1, $2, now(), now(), now())
       ON CONFLICT (line_user_id) DO NOTHING`,
      [r.line, r.shopify],
    );
  }
}

/**
 * 「この文は拒まれるはず」を確かめる。
 *
 * ⚠ Postgres は 1 文が落ちた時点で tx 全体を aborted にする。JS 側で catch しても
 *   状態は戻らない（後続の文が全部 25P02 で落ちる）ので、**必ず savepoint で囲って
 *   巻き戻す**。囲わずに書いたせいで「拒まれた」以降のテストが連鎖失敗した。
 */
let spSeq = 0;
async function expectRejected(
  client: pg.Client,
  label: string,
  fn: () => Promise<unknown>,
  matcher?: RegExp,
): Promise<void> {
  const sp = `sp_rej_${spSeq++}`;
  await client.query(`SAVEPOINT ${sp}`);
  let message: string | null = null;
  try {
    await fn();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
  await client.query(`RELEASE SAVEPOINT ${sp}`);
  if (message === null) throw new Error(`${label}: 拒まれずに通ってしまった`);
  if (matcher && !matcher.test(message)) {
    throw new Error(`${label}: 想定と違う理由で落ちた: ${message}`);
  }
}

/**
 * 写し取り 1 行（scripts/cdp-stage2-backfill.ts と同じ順序・同じ列）。
 *
 * 1. 両端の主体を解決 or 発行（identity_edges の UNIQUE が 1 鍵 = 1 主体を保つ）
 * 2. subject_links に 1 行追記（a < b に正規化・ON CONFLICT DO NOTHING）
 * 3. delivery_identity を派生（onConflict=subject_id）
 */
async function backfillOne(client: pg.Client, row: Legacy): Promise<void> {
  const lineSubject = await resolveOrIssue(client, "line_messaging_uid", row.line);
  const shopSubject = await resolveOrIssue(client, "shopify_customer_id", row.shopify);
  const [a, b] = lineSubject < shopSubject ? [lineSubject, shopSubject] : [shopSubject, lineSubject];
  await client.query(
    `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (subject_a, subject_b, basis) DO NOTHING`,
    [a, b, BACKFILL_BASIS, BACKFILL_OBSERVED_BY],
  );
  await client.query(
    `INSERT INTO delivery_identity (subject_id, line_user_id, source, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (subject_id) DO UPDATE SET line_user_id = EXCLUDED.line_user_id, updated_at = now()`,
    [lineSubject, row.line, BACKFILL_OBSERVED_BY],
  );
}

async function resolveOrIssue(client: pg.Client, kind: string, value: string): Promise<string> {
  const found = await client.query(
    `SELECT subject_id FROM identity_edges WHERE identifier_kind = $1 AND identifier_value = $2 LIMIT 1`,
    [kind, value],
  );
  if (found.rows.length > 0) return found.rows[0].subject_id as string;
  const sid = newSubjectId();
  await client.query(`INSERT INTO subjects (subject_id) VALUES ($1) ON CONFLICT DO NOTHING`, [sid]);
  await client.query(
    `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (identifier_kind, identifier_value) DO NOTHING`,
    [sid, kind, value, BACKFILL_OBSERVED_BY],
  );
  const settled = await client.query(
    `SELECT subject_id FROM identity_edges WHERE identifier_kind = $1 AND identifier_value = $2 LIMIT 1`,
    [kind, value],
  );
  return settled.rows[0].subject_id as string;
}

async function parity(client: pg.Client): Promise<Record<string, number | boolean>> {
  const r = await client.query(`SELECT cdp_stage2_parity() AS p`);
  return r.rows[0].p as Record<string, number | boolean>;
}
async function candidates(client: pg.Client): Promise<Record<string, number | boolean>> {
  const r = await client.query(`SELECT cdp_stage2_backfill_candidates() AS c`);
  return r.rows[0].c as Record<string, number | boolean>;
}
async function countLinks(client: pg.Client): Promise<number> {
  const r = await client.query(`SELECT count(*)::int AS n FROM subject_links`);
  return r.rows[0].n as number;
}

async function run(client: pg.Client) {
  const rows = buildLegacy();

  console.log("\n=== migration 040 / 041 / 042 / 043 / 044 / 047 を tx 内で適用（最後に ROLLBACK）===");
  await client.query("BEGIN");
  for (const file of CDP_MIGRATIONS) {
    await it(
      `${file} が適用できる`,
      async () => {
        await client.query(migrationSql(file));
      },
      client,
    );
  }

  // staging には Stage 2 未反映の実連携が残っている。合否は絶対値ではなく
  // **この baseline との差分**で見る（実データを前提にしない）。
  const baseline = await parity(client);
  console.log(`\n[baseline] ${JSON.stringify(baseline)}`);

  console.log("\n=== (C) SEC-1: 047 の後も email_equality は語彙に無い ===");
  await it(
    "basis の CHECK は 4 値で、email_equality を拒む",
    async () => {
      const sid1 = await resolveOrIssue(client, "line_messaging_uid", lineUid(900));
      const sid2 = await resolveOrIssue(client, "shopify_customer_id", shopifyId(900));
      const [a, b] = sid1 < sid2 ? [sid1, sid2] : [sid2, sid1];

      await expectRejected(
        client,
        "email_equality が通ってしまった（SEC-1 が緩んでいる）",
        () =>
          client.query(
            `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by) VALUES ($1,$2,'email_equality','t')`,
            [a, b],
          ),
        /subject_links_basis_allowed/,
      );

      // 043 の 3 値も引き続き通る（**狭めていない**ことの確認）。
      for (const basis of ["liff_id_token", "line_account_link", "anonymous_promotion"]) {
        await client.query(
          `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by) VALUES ($1,$2,$3,'t')`,
          [a, b, basis],
        );
      }
      // 047 が足した値も通る。
      await client.query(
        `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by) VALUES ($1,$2,$3,'t')`,
        [a, b, BACKFILL_BASIS],
      );
    },
    client,
  );

  console.log("\n=== (A) 写す前: 旧台帳にだけ行がある人は in_agreement を false にする ===");
  await it(
    `Stage 2 より前の連携 ${LEGACY_ROWS} 件を投入すると linked_without_link が ${LEGACY_ROWS} 増える`,
    async () => {
      const before = await parity(client);
      await seedLegacyLedger(client, rows);
      const after = await parity(client);
      assertEqual(
        Number(after.linked_without_link) - Number(before.linked_without_link),
        LEGACY_ROWS,
        "linked_without_link の増分",
      );
      assertEqual(
        Number(after.delivery_identity_missing) - Number(before.delivery_identity_missing),
        LEGACY_ROWS,
        "delivery_identity_missing の増分",
      );
      assertEqual(after.in_agreement, false, "in_agreement が false になっていない");
    },
    client,
  );

  console.log("\n=== (G) 見立ての母数が parity の母数と一致する ===");
  await it(
    "cdp_stage2_backfill_candidates().pending_link == cdp_stage2_parity().linked_without_link",
    async () => {
      await seedLegacyLedger(client, rows);
      const p = await parity(client);
      const c = await candidates(client);
      assertEqual(
        Number(c.pending_link),
        Number(p.linked_without_link),
        "母数がずれている（全部写しても緑にならない形）",
      );
      assertEqual(
        Number(c.linked_ledger_rows),
        Number(p.linked_ledger_rows),
        "母数（分母）がずれている",
      );
    },
    client,
  );

  console.log("\n=== (B) 写した後: in_agreement が true になる ===");
  await it(
    "写し取り後は 4 つの数がすべて 0 で in_agreement=true",
    async () => {
      // staging に残っている実連携も含めて **母数を全部** 写す（parity と同じ述語）。
      await seedLegacyLedger(client, rows);
      const all = await client.query(
        `SELECT line_user_id, shopify_customer_id FROM customer_linkages
          WHERE line_user_id IS NOT NULL AND shopify_customer_id IS NOT NULL`,
      );
      for (const r of all.rows) {
        await backfillOne(client, {
          line: r.line_user_id as string,
          shopify: r.shopify_customer_id as string,
        });
      }
      const p = await parity(client);
      assertEqual(Number(p.linked_without_link), 0, "linked_without_link が 0 でない");
      assertEqual(Number(p.identity_map_without_link), 0, "identity_map_without_link が 0 でない");
      assertEqual(Number(p.delivery_identity_missing), 0, "delivery_identity_missing が 0 でない");
      assertEqual(Number(p.multi_line_components), 0, "multi_line_components が 0 でない");
      assertEqual(p.in_agreement, true, `in_agreement が true にならない: ${JSON.stringify(p)}`);
    },
    client,
  );

  console.log("\n=== (F) 冪等: 2 度写しても link は増えない ===");
  await it(
    "同じ行をもう一度写しても subject_links は 1 行も増えない",
    async () => {
      await seedLegacyLedger(client, rows);
      for (const r of rows) await backfillOne(client, r);
      const n1 = await countLinks(client);
      for (const r of rows) await backfillOne(client, r);
      const n2 = await countLinks(client);
      assertEqual(n2, n1, "2 度目で link が増えた（ON CONFLICT DO NOTHING が効いていない）");
    },
    client,
  );

  console.log("\n=== (D) E4: 写した link も書き換えられない ===");
  await it(
    "写した subject_links の UPDATE / DELETE はトリガが拒む",
    async () => {
      await seedLegacyLedger(client, [rows[0]]);
      await backfillOne(client, rows[0]);

      await expectRejected(
        client,
        "写した link を UPDATE できてしまった（E4 が緩んでいる）",
        () =>
          client.query(`UPDATE subject_links SET observed_by = 'x' WHERE basis = $1`, [
            BACKFILL_BASIS,
          ]),
      );
      await expectRejected(
        client,
        "写した link を DELETE できてしまった（E4 が緩んでいる）",
        () => client.query(`DELETE FROM subject_links WHERE basis = $1`, [BACKFILL_BASIS]),
      );
    },
    client,
  );

  console.log("\n=== (E) J-4: 世帯共有（1 Shopify に 2 本目の LINE）は写せない ===");
  await it(
    "同じ Shopify 顧客に別の LINE を写そうとするとトリガが拒む（写らないのが正しい）",
    async () => {
      const shared = shopifyId(77);
      const lineA = lineUid(770);
      const lineB = lineUid(771);
      await backfillOne(client, { line: lineA, shopify: shared });
      await expectRejected(
        client,
        "J-4 を破る link が写せてしまった",
        () => backfillOne(client, { line: lineB, shopify: shared }),
        /J-4 violation/,
      );
    },
    client,
  );

  console.log("\n=== 後片付け ===");
  await client.query("ROLLBACK");
  console.log("  [OK] ROLLBACK 完了（合成データも migration も DB に残っていない）");

  // ROLLBACK が効いたことを確かめる（tx の外で 047 の関数が消えていること）。
  const gone = await client.query(`SELECT to_regproc('public.cdp_stage2_backfill_candidates') IS NULL AS gone`);
  assertTrue(gone.rows[0].gone === true, "ROLLBACK 後も 047 の関数が残っている");
  console.log("  [OK] tx 外で 047 の関数は存在しない（staging を汚していない）");
}

async function main() {
  const { host, password } = stagingConnInfo();
  const client = new pg.Client({
    host,
    port: 5432,
    database: "postgres",
    user: "postgres",
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  try {
    await run(client);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await client.end().catch(() => undefined);
  }

  console.log(
    `\n=== cdp-stage2-backfill.db.test: ${passed}/${total} passed, ${failures.length} failed ===`,
  );
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
