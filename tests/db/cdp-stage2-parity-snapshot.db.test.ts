/**
 * DB Round-trip Tests — 観測が日ごとに残り、5 営業日を数えられる（migration 048）
 *
 * ─ 何を確かめるか ─
 *
 *   043 / 044 の cdp_stage2_parity() は **その瞬間の 1 時点** しか返さない。
 *   Stage 2 の完了条件「新旧解決の一致率 100% を 5 営業日観測」は、観測が
 *   残らない限り原理的に判定できない。048 はその 1 行を残す表と、書き手・読み口を置く。
 *
 *   ここで固定するのは **plpgsql の意味**（字面ではなく、実際に走らせた結果）:
 *
 *     (A) 書き手はその日の 1 行を残す（compared_count / mismatch_count / raw つき）
 *     (B) 同じ日に 2 回呼んでも 1 行のまま（ON CONFLICT ＝ 冪等）。created_at は動かない
 *     (C) **比べる相手が 0 人の日は緑にならない**（in_agreement=true でも is_green=false）
 *     (D) 追記専用 — 過ぎた日は UPDATE できず、DELETE はどの日もできない
 *     (E) 連続営業日は土日を飛ばして数え、**観測が無い営業日で切れる**
 *     (F) 観測が直近の営業日に届いていなければ meets_target は立たない
 *     (G) 5 営業日そろえば meets_target が立つ（ゲートが実際に通る形になっている）
 *
 *   TS 側の呼び方（どの関数をどう呼び、戻りをどう読むか）は
 *   tests/hermetic/flow24-cdp-stage2-parity-snapshot.test.ts が実 DB 抜きで持つ。
 *   SQL の字面（一意制約・生成列の式・分母の組み立て）は
 *   tests/unit/cdp-stage2-parity-snapshot.test.ts が持つ。
 *
 * ─ 実データを前提にしない ─
 *
 *   staging には Stage 2 未反映の実連携が残っている。よって (C) や (G) を
 *   「本物の cdp_stage2_parity() の戻り」で作ろうとすると、環境次第で緑にも赤にもなる。
 *   ここでは表と読み口に **直接行を入れて** 判定を確かめる（書き手の経路は (A)(B) で
 *   本物の関数を通して確かめる）。分けているのは、「読み口の数え方」が
 *   「その日たまたま本番データがどうだったか」に左右されないようにするため。
 *
 * ─ 安全 ─
 *   - 接続先は **staging のみ**（project ref を HARD ASSERT。本番 ref なら接続せず中断）。
 *   - すべて 1 本のトランザクション内で行い、**最後に必ず ROLLBACK する**。
 *     migration の適用も、合成した観測行も、DB には 1 行も残らない。
 *   - 外部送信ゼロ。LINE にも Shopify にも触れない。
 *
 * 使用:
 *   npx tsx tests/db/cdp-stage2-parity-snapshot.db.test.ts   # = pnpm test:db:cdp-stage2-parity-snapshot
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
  "048_cdp_stage2_parity_snapshots.sql",
];

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

/** 「この文は拒まれるはず」を savepoint で囲って確かめる（tx を aborted のまま残さない）。 */
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
  assertTrue(message !== null, label);
  if (matcher) {
    assertTrue(matcher.test(message ?? ""), `${label}（理由が想定と違う: ${message}）`);
  }
}

/** その日の 1 行を作る（読み口の数え方を、実データに左右されずに確かめるため）。 */
async function seedSnapshot(
  client: pg.Client,
  offsetDaysFromToday: number,
  opts: { inAgreement: boolean; compared: number; mismatch: number },
) {
  await client.query(
    `INSERT INTO cdp_stage2_parity_snapshots
       (snapshot_date, in_agreement, compared_count, mismatch_count, raw)
     VALUES (((now() AT TIME ZONE 'Asia/Tokyo')::date + $1::integer), $2, $3, $4, '{}'::jsonb)`,
    [offsetDaysFromToday, opts.inAgreement, opts.compared, opts.mismatch],
  );
}

/** 直近の営業日（JST）を N 個、今日から遡って返す（土日を飛ばす）。 */
async function recentBusinessDayOffsets(client: pg.Client, count: number): Promise<number[]> {
  const { rows } = await client.query<{ offset: number }>(
    `SELECT g AS offset
       FROM generate_series(0, 40) g
      WHERE cdp_is_business_day(((now() AT TIME ZONE 'Asia/Tokyo')::date - g))
      ORDER BY g
      LIMIT $1`,
    [count],
  );
  return rows.map((r) => -Number(r.offset));
}

async function streak(client: pg.Client): Promise<Record<string, unknown>> {
  const { rows } = await client.query<{ s: Record<string, unknown> }>(
    "SELECT cdp_stage2_parity_streak() AS s",
  );
  return rows[0].s;
}

async function run(client: pg.Client) {
  console.log("\n=== migration 040-044 / 047 / 048 を tx 内で適用（最後に ROLLBACK）===");
  await client.query("BEGIN");
  for (const file of CDP_MIGRATIONS) {
    await it(`${file} が適用できる`, async () => { await client.query(migrationSql(file)); }, client);
  }

  await it(
    "048 は冪等（2 回当てても落ちない）",
    async () => { await client.query(migrationSql("048_cdp_stage2_parity_snapshots.sql")); },
    client,
  );

  console.log("\n=== (A) 書き手はその日の 1 行を残す ===");
  await it(
    "cdp_stage2_parity_snapshot() が行を作り、044 の戻りをそのまま持つ",
    async () => {
      const { rows } = await client.query<{ r: Record<string, unknown> }>(
        "SELECT cdp_stage2_parity_snapshot() AS r",
      );
      const r = rows[0].r;
      assertEqual(r.persisted, true, "persisted が返らない");
      assertTrue(typeof r.snapshot_date === "string", "snapshot_date が返らない");
      assertTrue(r.in_agreement_by !== undefined, "044 の内訳が落ちている（戻りが痩せた）");

      const stored = await client.query<{
        n: string;
        compared_count: string;
        mismatch_count: string;
        raw: Record<string, unknown>;
      }>(
        `SELECT count(*)::text AS n, max(compared_count)::text AS compared_count,
                max(mismatch_count)::text AS mismatch_count, (array_agg(raw))[1] AS raw
           FROM cdp_stage2_parity_snapshots
          WHERE snapshot_date = (now() AT TIME ZONE 'Asia/Tokyo')::date`,
      );
      assertEqual(stored.rows[0].n, "1", "今日の行が 1 行になっていない");
      assertTrue(stored.rows[0].raw.in_agreement !== undefined, "raw に 044 の戻りが入っていない");

      // 分母は旧台帳 2 冊の合計そのもの。
      const raw = stored.rows[0].raw as Record<string, number>;
      assertEqual(
        Number(stored.rows[0].compared_count),
        Number(raw.linked_ledger_rows) + Number(raw.identity_map_linked_rows),
        "compared_count が旧台帳 2 冊の合計になっていない",
      );
    },
    client,
  );

  console.log("\n=== (B) 同じ日に 2 回呼んでも 1 行のまま（冪等）===");
  await it(
    "2 回目は行を増やさず、created_at も動かない",
    async () => {
      await client.query("SELECT cdp_stage2_parity_snapshot()");
      const before = await client.query<{ created_at: string; observed_at: string }>(
        `SELECT created_at::text, observed_at::text FROM cdp_stage2_parity_snapshots
          WHERE snapshot_date = (now() AT TIME ZONE 'Asia/Tokyo')::date`,
      );
      await client.query("SELECT pg_sleep(0.01)");
      await client.query("SELECT cdp_stage2_parity_snapshot()");
      const after = await client.query<{ n: string; created_at: string }>(
        `SELECT count(*)::text AS n, min(created_at)::text AS created_at
           FROM cdp_stage2_parity_snapshots
          WHERE snapshot_date = (now() AT TIME ZONE 'Asia/Tokyo')::date`,
      );
      assertEqual(after.rows[0].n, "1", "同じ日に 2 行できた（連続日数が狂う）");
      assertEqual(
        after.rows[0].created_at,
        before.rows[0].created_at,
        "created_at が動いた（いつから見ているかを失う）",
      );
    },
    client,
  );

  console.log("\n=== (C) 比べる相手が 0 人の日は緑にならない ===");
  await it(
    "in_agreement=true でも compared_count=0 なら is_green=false",
    async () => {
      // 既存行には触らない（触ろうとすればガードに拒まれ tx が aborted になる）。
      // 別の日を 1 つ足して、その行の生成列だけを見る。
      await seedSnapshot(client, -14, { inAgreement: true, compared: 0, mismatch: 0 });
      const { rows } = await client.query<{ is_green: boolean }>(
        `SELECT is_green FROM cdp_stage2_parity_snapshots
          WHERE snapshot_date = ((now() AT TIME ZONE 'Asia/Tokyo')::date - 14)`,
      );
      assertEqual(rows[0].is_green, false, "何も比べていない日が緑になっている");
    },
    client,
  );

  await it(
    "compared_count > 0 かつ in_agreement=true の日だけが緑",
    async () => {
      await seedSnapshot(client, -15, { inAgreement: true, compared: 3, mismatch: 0 });
      await seedSnapshot(client, -16, { inAgreement: false, compared: 3, mismatch: 1 });
      const { rows } = await client.query<{ d: string; is_green: boolean }>(
        `SELECT snapshot_date::text AS d, is_green FROM cdp_stage2_parity_snapshots
          WHERE snapshot_date IN (((now() AT TIME ZONE 'Asia/Tokyo')::date - 15),
                                  ((now() AT TIME ZONE 'Asia/Tokyo')::date - 16))
          ORDER BY snapshot_date DESC`,
      );
      assertEqual(rows[0].is_green, true, "一致していて分母もある日が緑でない");
      assertEqual(rows[1].is_green, false, "食い違いのある日が緑になっている");
    },
    client,
  );

  console.log("\n=== (D) 追記専用 — 過ぎた日は不変・削除不可 ===");
  await it(
    "過ぎた日の UPDATE は拒まれる",
    async () => {
      await seedSnapshot(client, -20, { inAgreement: false, compared: 1, mismatch: 1 });
      await expectRejected(
        client,
        "過ぎた日を書き換えられてしまった（証跡にならない）",
        () =>
          client.query(
            `UPDATE cdp_stage2_parity_snapshots SET in_agreement = true
              WHERE snapshot_date = ((now() AT TIME ZONE 'Asia/Tokyo')::date - 20)`,
          ),
        /過ぎた日の観測は書き換えられない/,
      );
    },
    client,
  );

  await it(
    "DELETE はどの日でも拒まれる",
    async () => {
      await seedSnapshot(client, -21, { inAgreement: true, compared: 1, mismatch: 0 });
      await expectRejected(
        client,
        "観測の履歴が消せてしまった",
        () =>
          client.query(
            `DELETE FROM cdp_stage2_parity_snapshots
              WHERE snapshot_date = ((now() AT TIME ZONE 'Asia/Tokyo')::date - 21)`,
          ),
        /append-only violation/,
      );
    },
    client,
  );

  await it(
    "snapshot_date の付け替えは拒まれる",
    async () => {
      await client.query("SELECT cdp_stage2_parity_snapshot()");
      await expectRejected(
        client,
        "観測日を付け替えられてしまった",
        () =>
          client.query(
            `UPDATE cdp_stage2_parity_snapshots
                SET snapshot_date = snapshot_date - 1
              WHERE snapshot_date = (now() AT TIME ZONE 'Asia/Tokyo')::date`,
          ),
        /snapshot_date は不変|過ぎた日の観測は書き換えられない/,
      );
    },
    client,
  );

  console.log("\n=== (E)(F)(G) 連続営業日の数え方 ===");

  /** 観測表を空にする（ガードを一時的に外して片付ける。tx 内なので外に漏れない）。 */
  async function clearSnapshots() {
    await client.query("ALTER TABLE cdp_stage2_parity_snapshots DISABLE TRIGGER cdp_stage2_parity_snapshots_append_only");
    await client.query("DELETE FROM cdp_stage2_parity_snapshots");
    await client.query("ALTER TABLE cdp_stage2_parity_snapshots ENABLE TRIGGER cdp_stage2_parity_snapshots_append_only");
  }

  await it(
    "観測が 1 日も無ければ streak=0 / break_reason=no_snapshot",
    async () => {
      await clearSnapshots();
      const s = await streak(client);
      assertEqual(s.streak_business_days, 0, "観測が無いのに連続日数が立っている");
      assertEqual(s.break_reason, "no_snapshot", "理由が no_snapshot でない");
      assertEqual(s.meets_target, false, "観測が無いのに目標を満たしている");
    },
    client,
  );

  await it(
    "直近 5 営業日そろって緑なら meets_target=true（土日は飛ばす）",
    async () => {
      await clearSnapshots();
      const offsets = await recentBusinessDayOffsets(client, 5);
      assertEqual(offsets.length, 5, "営業日を 5 日分取れない");
      for (const off of offsets) {
        await seedSnapshot(client, off, { inAgreement: true, compared: 4, mismatch: 0 });
      }
      const s = await streak(client);
      assertEqual(s.streak_business_days, 5, `連続日数が 5 でない: ${JSON.stringify(s)}`);
      assertEqual(s.is_stale, false, "直近の営業日まで観測があるのに stale 判定");
      assertEqual(s.meets_target, true, "5 営業日そろっても目標を満たさない");
    },
    client,
  );

  await it(
    "途中の営業日に観測が無ければ、そこで連続が切れる（見ていない日を緑としない）",
    async () => {
      await clearSnapshots();
      const offsets = await recentBusinessDayOffsets(client, 5);
      // 3 番目の営業日だけ観測を残さない。
      for (const [i, off] of offsets.entries()) {
        if (i === 2) continue;
        await seedSnapshot(client, off, { inAgreement: true, compared: 4, mismatch: 0 });
      }
      const s = await streak(client);
      assertEqual(s.streak_business_days, 2, `欠測で切れていない: ${JSON.stringify(s)}`);
      assertEqual(s.break_reason, "missing", "切れた理由が missing でない");
      assertEqual(s.meets_target, false, "欠測があるのに目標を満たしている");
    },
    client,
  );

  await it(
    "0 件の日は nothing_compared で切れる（mismatch と区別できる）",
    async () => {
      await clearSnapshots();
      const offsets = await recentBusinessDayOffsets(client, 5);
      for (const [i, off] of offsets.entries()) {
        await seedSnapshot(client, off, {
          inAgreement: true,
          compared: i === 1 ? 0 : 4,
          mismatch: 0,
        });
      }
      const s = await streak(client);
      assertEqual(s.streak_business_days, 1, `0 件の日で切れていない: ${JSON.stringify(s)}`);
      assertEqual(s.break_reason, "nothing_compared", "0 件の日が別の理由で数えられている");
    },
    client,
  );

  await it(
    "観測が直近の営業日に届いていなければ meets_target は立たない",
    async () => {
      await clearSnapshots();
      // 5 営業日そろっているが、いちばん新しい観測が 1 営業日ぶん古い。
      const offsets = await recentBusinessDayOffsets(client, 6);
      for (const off of offsets.slice(1)) {
        await seedSnapshot(client, off, { inAgreement: true, compared: 4, mismatch: 0 });
      }
      const s = await streak(client);
      assertEqual(s.streak_business_days, 5, "連続日数の数え方が変わっている");
      assertEqual(s.is_stale, true, "古い観測が stale と判定されない");
      assertEqual(s.meets_target, false, "古い観測で目標を満たしたと言っている");
    },
    client,
  );

  await it(
    "days は営業日ごとの内訳を返す（祝日の数え直しができる）",
    async () => {
      await clearSnapshots();
      const offsets = await recentBusinessDayOffsets(client, 3);
      for (const off of offsets) {
        await seedSnapshot(client, off, { inAgreement: true, compared: 4, mismatch: 0 });
      }
      const s = await streak(client);
      assertEqual(s.holidays_excluded, false, "祝日を除いたことになっている");
      const days = s.days as Array<Record<string, unknown>>;
      assertTrue(Array.isArray(days) && days.length >= 3, "days が返っていない");
      assertEqual(days[0].status, "green", "days の先頭が緑でない");
      assertTrue(days[0].compared_count !== undefined, "days に分母が入っていない");
    },
    client,
  );

  console.log("\n=== 片付け（tx 全体を ROLLBACK。1 行も残さない）===");
  await client.query("ROLLBACK");

  const { rows } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('public.cdp_stage2_parity_snapshots') IS NOT NULL AS present",
  );
  console.log(
    `  [OK] tx 外の 048 の適用状態: ${rows[0].present ? "適用済み" : "未適用"} — このテストは環境を変えていない`,
  );
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
    `\n=== cdp-stage2-parity-snapshot.db.test: ${passed}/${total} passed, ${failures.length} failed ===`,
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
