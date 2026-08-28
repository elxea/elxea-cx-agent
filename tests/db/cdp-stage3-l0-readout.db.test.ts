/**
 * DB Round-trip Tests — Stage 3 の読み口と、Stage 2 の突合の是正（MID-1）
 *
 * ここで実 DB を使う理由は 1 つ: **この 3 つの判断は SQL の中にしかない**。
 *
 *   1. 044 … 「新旧一致」の判定に user_identity_map を入れたこと（MID-1）
 *   2. 045 … 日の境界が JST であること（E8' の突合軸）
 *   3. 045 … 主体を canonical で返すこと（persons.subject_id が 1:1 であるための前提）
 *
 * TypeScript 側はこれらを呼んでログに落とすだけなので、モックで固めても
 * 「モックが素通しした」を確かめることにしかならない。
 *
 * ─ 安全 ─
 *   - 接続先は **staging のみ**（project ref を HARD ASSERT。本番 ref なら接続せず中断）。
 *   - すべて 1 本のトランザクション内で行い、**最後に必ず ROLLBACK する**。
 *     migration も合成データも DB に 1 行も残さない。
 *   - 外部送信ゼロ。消去関数は呼ばない。
 *
 * 使用:
 *   npx tsx tests/db/cdp-stage3-l0-readout.db.test.ts   # = pnpm test:db:cdp-stage3
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
  "045_cdp_l0_analytics_readout.sql",
];

const TAG = `s3-${Date.now()}`;

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
function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
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

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let ulidCounter = 0;
function fakeUlid(): string {
  let x = (ulidCounter += 1);
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    out = ULID_ALPHABET[x % 32] + out;
    x = Math.floor(x / 32);
  }
  return out;
}
function fakeLineUid(n: number): string {
  return `U${n.toString(16).padStart(32, "0")}`;
}

interface ParityResult {
  linked_without_link: number;
  identity_map_without_link: number;
  delivery_identity_missing: number;
  multi_line_components: number;
  in_agreement: boolean;
  in_agreement_by: Record<string, boolean>;
}

async function parity(client: pg.Client): Promise<ParityResult> {
  const { rows } = await client.query(`SELECT cdp_stage2_parity() AS r`);
  return rows[0].r as ParityResult;
}

async function run(client: pg.Client) {
  console.log("\n=== migration 040〜045 を tx 内で適用（最後に ROLLBACK）===");
  await client.query("BEGIN");
  for (const file of CDP_MIGRATIONS) {
    await client.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    console.log(`  [OK] ${file}`);
  }

  // -------------------------------------------------------------------------
  console.log("\n=== 044: 一致の判定に旧台帳 2 冊とも入っている（MID-1）===");

  /* staging には既に実データ（連携行）が入っており、そのままだと突合は最初から
   * 不一致になる。それでは「map の行が判定を動かした」ことを示せない（既に false の
   * ものが false のままでは何も言えない）ので、**この tx の中でだけ** 旧台帳を空にして
   * 素の状態を作る。tx は最後に ROLLBACK するので staging のデータは 1 行も減らない。
   *
   * customer_events / identity_edges は追記専用（E4）なので消さない。日の突合の検証は
   * 既存データの無い将来日付を使って避ける。 */
  await client.query("DELETE FROM delivery_identity");
  await client.query("DELETE FROM customer_linkages");
  await client.query("DELETE FROM user_identity_map");

  await it(
    "旧台帳が空なら一致（この節の前提を作る）",
    async () => {
      const r = await parity(client);
      assertEqual(r.linked_without_link, 0, "customer_linkages 側が空になっていない");
      assertEqual(r.identity_map_without_link, 0, "user_identity_map 側が空になっていない");
      assertEqual(r.in_agreement, true, "空の状態で一致していない");
    },
    client,
  );

  await it(
    "user_identity_map に link の無い連携行があると in_agreement=false になる",
    async () => {
      const line = fakeLineUid(9001);
      const shopify = "8100001";
      await client.query(
        `INSERT INTO user_identity_map (unified_user_id, line_user_id, shopify_customer_id)
         VALUES ($1, $2, $3)`,
        [`${TAG}-u1`, line, shopify],
      );

      const r = await parity(client);
      assertEqual(r.identity_map_without_link, 1, "user_identity_map の未リンク行が数えられていない");
      assertEqual(r.linked_without_link, 0, "customer_linkages 側は空のはず");
      assertEqual(
        r.in_agreement,
        false,
        "★11 の読出が引く台帳に未リンク行があるのに一致と判定されている（MID-1 の退行）",
      );
      assertEqual(
        r.in_agreement_by.identity_map_without_link,
        false,
        "内訳がどれで落ちたかを言えていない",
      );
      assertEqual(
        r.in_agreement_by.linked_without_link,
        true,
        "落ちていない項目まで false になっている",
      );
    },
    client,
  );

  await it(
    "その行に link を足すと in_agreement=true に戻る（判定が実データに追随する）",
    async () => {
      const line = fakeLineUid(9002);
      const shopify = "8100002";
      const subjLine = fakeUlid();
      const subjShop = fakeUlid();

      /* 直前のテスト（PASS したので savepoint は RELEASE 済み）が残した行を片づける。
       * 残したままだとこの節の「0 に戻る」が、前のテストの行のせいで永久に成立しない。 */
      await client.query("DELETE FROM user_identity_map");

      await client.query(
        `INSERT INTO user_identity_map (unified_user_id, line_user_id, shopify_customer_id)
         VALUES ($1, $2, $3)`,
        [`${TAG}-u2`, line, shopify],
      );
      assertEqual((await parity(client)).in_agreement, false, "足す前は不一致のはず");

      await client.query(`INSERT INTO subjects (subject_id) VALUES ($1), ($2)`, [subjLine, subjShop]);
      await client.query(
        `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
         VALUES ($1, 'line_messaging_uid', $2, 'test'), ($3, 'shopify_customer_id', $4, 'test')`,
        [subjLine, line, subjShop, shopify],
      );
      await client.query(
        `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
         VALUES (LEAST($1,$2), GREATEST($1,$2), 'liff_id_token', 'test')`,
        [subjLine, subjShop],
      );

      const r = await parity(client);
      assertEqual(r.identity_map_without_link, 0, "link を足しても未リンクとして数えている");
      assertEqual(r.in_agreement, true, "link を足しても一致にならない");
    },
    client,
  );

  // -------------------------------------------------------------------------
  console.log("\n=== 045: 日の境界が JST（E8' の突合軸）===");

  await it(
    "JST 00:00 の前後 1 秒が別の日に落ちる",
    async () => {
      const subj = fakeUlid();
      await client.query(`INSERT INTO subjects (subject_id) VALUES ($1)`, [subj]);
      // JST 2035-08-29 00:00:00 = UTC 2035-08-28 15:00:00
      const before = "2035-08-28T14:59:59Z"; // JST 8/28 23:59:59
      const after = "2035-08-28T15:00:00Z"; // JST 8/29 00:00:00
      await client.query(
        `INSERT INTO customer_events
           (subject_id, event_type, channel, occurred_at, recorded_at, source, idempotency_key)
         VALUES ($1,'behavior.view_content','web',$2,$2,'test',$3),
                ($1,'behavior.view_content','web',$4,$4,'test',$5)`,
        [subj, before, `${TAG}-a`, after, `${TAG}-b`],
      );

      const { rows } = await client.query(
        `SELECT cdp_l0_daily_counts('2035-08-27'::date, '2035-08-30'::date) AS r`,
      );
      const days = (rows[0].r.days as Array<{ day: string; events: number }>).filter(
        (d) => d.events > 0,
      );
      const byDay = Object.fromEntries(days.map((d) => [d.day, d.events]));
      assertEqual(byDay["2035-08-28"], 1, "JST 8/28 側の 1 件が別の日に落ちている");
      assertEqual(byDay["2035-08-29"], 1, "JST 8/29 側の 1 件が別の日に落ちている");
      assertEqual(rows[0].r.tz, "Asia/Tokyo", "境界の宣言が返り値に無い");
    },
    client,
  );

  await it(
    "未知の型（schema_ok=false）は events に含めつつ unknown でも数える",
    async () => {
      const subj = fakeUlid();
      await client.query(`INSERT INTO subjects (subject_id) VALUES ($1)`, [subj]);
      await client.query(
        `INSERT INTO customer_events
           (subject_id, event_type, channel, schema_ok, occurred_at, recorded_at, source, idempotency_key)
         VALUES ($1,'weird.thing','web',false,$2,$2,'test',$3)`,
        [subj, "2035-09-15T03:00:00Z", `${TAG}-c`],
      );
      const { rows } = await client.query(
        `SELECT cdp_l0_daily_counts('2035-09-15'::date, '2035-09-15'::date) AS r`,
      );
      const day = (rows[0].r.days as Array<{ day: string; events: number; unknown: number }>)[0];
      assertEqual(day.events, 1, "未知の型が events から落ちている（捨てた扱いになっている）");
      assertEqual(day.unknown, 1, "未知の型が unknown で数えられていない");
    },
    client,
  );

  // -------------------------------------------------------------------------
  console.log("\n=== 045: 主体は canonical で返る（persons.subject_id 1:1 の前提）===");

  await it(
    "link で結ばれた 2 主体は、どちらの edge からも同じ 1 つの主体として返る",
    async () => {
      const line = fakeLineUid(9101);
      const shopA = "8200001";
      const shopB = "8200002";
      const subjLine = fakeUlid();
      const subjA = fakeUlid();
      const subjB = fakeUlid();

      await client.query(`INSERT INTO subjects (subject_id) VALUES ($1),($2),($3)`, [
        subjLine,
        subjA,
        subjB,
      ]);
      await client.query(
        `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
         VALUES ($1,'line_messaging_uid',$2,'test'),
                ($3,'shopify_customer_id',$4,'test'),
                ($5,'shopify_customer_id',$6,'test')`,
        [subjLine, line, subjA, shopA, subjB, shopB],
      );
      // subjA と subjLine を結ぶ（subjB は独立のまま）。
      await client.query(
        `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
         VALUES (LEAST($1,$2), GREATEST($1,$2), 'liff_id_token', 'test')`,
        [subjLine, subjA],
      );

      const { rows } = await client.query(`SELECT cdp_subject_shopify_map(0, 500) AS r`);
      const mapped = (rows[0].r.rows as Array<{ subject_id: string; shopify_customer_id: string }>);
      const byShop = Object.fromEntries(mapped.map((m) => [m.shopify_customer_id, m.subject_id]));

      const canonical = (
        await client.query(`SELECT cdp_canonical_subject($1) AS c`, [subjA])
      ).rows[0].c as string;
      assertEqual(
        byShop[shopA],
        canonical,
        "結ばれた側が canonical ではなく生の主体で返っている（link が入った日に 1:1 が崩れる）",
      );
      assertEqual(byShop[shopB], subjB, "結ばれていない主体まで書き換わっている");
    },
    client,
  );

  await it(
    "退役した主体（GDPR 消去済み）は返らない",
    async () => {
      const subj = fakeUlid();
      const shop = "8200003";
      await client.query(`INSERT INTO subjects (subject_id) VALUES ($1)`, [subj]);
      await client.query(
        `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
         VALUES ($1,'shopify_customer_id',$2,'test')`,
        [subj, shop],
      );
      const before = (await client.query(`SELECT cdp_subject_shopify_map(0, 500) AS r`)).rows[0].r;
      assertTrue(
        (before.rows as Array<{ shopify_customer_id: string }>).some(
          (m) => m.shopify_customer_id === shop,
        ),
        "前提が崩れている（退役前に返っていない）",
      );

      // 消去経路と同じ形で retire する（E4 の例外表を立てて UPDATE する）。
      await client.query(`SELECT set_config('app.erasure_context', 'on', true)`);
      await client.query(`UPDATE subjects SET retired_at = now() WHERE subject_id = $1`, [subj]);

      const after = (await client.query(`SELECT cdp_subject_shopify_map(0, 500) AS r`)).rows[0].r;
      assertTrue(
        !(after.rows as Array<{ shopify_customer_id: string }>).some(
          (m) => m.shopify_customer_id === shop,
        ),
        "退役した主体が解析側へ流れ出ている",
      );
    },
    client,
  );

  await it(
    "ページングは続きがあるときだけ next を返す",
    async () => {
      const shops: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const subj = fakeUlid();
        const shop = `830000${i}`;
        shops.push(shop);
        await client.query(`INSERT INTO subjects (subject_id) VALUES ($1)`, [subj]);
        await client.query(
          `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
           VALUES ($1,'shopify_customer_id',$2,'test')`,
          [subj, shop],
        );
      }
      const page1 = (await client.query(`SELECT cdp_subject_shopify_map(0, 2) AS r`)).rows[0].r;
      assertEqual((page1.rows as unknown[]).length, 2, "1 ページの件数が上限どおりでない");
      assertTrue(page1.next !== null, "続きがあるのに next が null");

      const page2 = (
        await client.query(`SELECT cdp_subject_shopify_map($1, 2) AS r`, [page1.next])
      ).rows[0].r;
      assertTrue((page2.rows as unknown[]).length >= 1, "2 ページ目が空");
    },
    client,
  );

  await client.query("ROLLBACK");
  console.log("  [OK] ROLLBACK 完了（合成データも migration も DB に残っていない）");
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

  console.log(`\n=== cdp-stage3-l0-readout.db.test: ${passed}/${total} passed, ${failures.length} failed ===`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`[FATAL] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
