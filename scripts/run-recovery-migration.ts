/**
 * R1 復旧マイグレーション適用スクリプト。
 * src/db/migrations/018_recovery_missing_tables.sql を Supabase に直接適用する。
 * 冪等なので再実行安全。適用後に 3 テーブルの存在を検証する。
 *
 * Usage:
 *   SUPABASE_DB_PASSWORD=xxx npx tsx scripts/run-recovery-migration.ts
 *   npx tsx scripts/run-recovery-migration.ts --password=xxx
 *
 * SUPABASE_DB_PASSWORD は Supabase の Postgres 直接接続パスワード
 * （Dashboard > Project Settings > Database > Connection string / Database password）。
 * .dev.vars には含まれないため、実行時に別途渡す必要がある。
 * パスワード無しで起動すると SQL 全文と Supabase SQL Editor の URL を出力して終了する
 * （手動適用フォールバック）。
 *
 * 安全: 本番適用は ENV-3 ゲート（staging 検証 → Setaka 承認）後にのみ実行する。
 * 接続先は SUPABASE_URL（.dev.vars）が指すプロジェクト。staging/本番の取り違えに注意。
 */

import dotenv from "dotenv";
import pg from "pg";
import { readFileSync } from "fs";

dotenv.config({ path: ".dev.vars" });

const MIGRATION_FILE = "src/db/migrations/018_recovery_missing_tables.sql";
const REQUIRED_TABLES = [
  "customer_linkages",
  "sync_logs",
  "pending_follow_refs",
];

const SUPABASE_URL = process.env.SUPABASE_URL;
const args = process.argv.slice(2);
const passwordArg = args
  .find((a) => a.startsWith("--password="))
  ?.split("=")[1];
const DB_PASSWORD = passwordArg ?? process.env.SUPABASE_DB_PASSWORD;

if (!SUPABASE_URL) {
  console.error("SUPABASE_URL is not set (.dev.vars). Aborting.");
  process.exit(1);
}

const sql = readFileSync(MIGRATION_FILE, "utf8");

async function main() {
  const url = new URL(SUPABASE_URL!);
  const projectRef = url.hostname.split(".")[0];

  if (!DB_PASSWORD) {
    console.log("SUPABASE_DB_PASSWORD not set.\n");
    console.log("Option 1: Pass password as argument:");
    console.log(
      "  npx tsx scripts/run-recovery-migration.ts --password=YOUR_PASSWORD\n",
    );
    console.log("Option 2: Run SQL manually in Supabase SQL Editor:");
    console.log(`  https://supabase.com/dashboard/project/${projectRef}/sql\n`);
    console.log("--- SQL ---");
    console.log(sql);
    console.log("--- END ---");
    process.exit(1);
  }

  const client = new pg.Client({
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    database: "postgres",
    user: "postgres",
    password: DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });

  await client.connect();
  console.log(`Connected to Supabase PostgreSQL (project: ${projectRef})`);

  await client.query(sql);
  console.log(`Applied ${MIGRATION_FILE} successfully (idempotent).`);

  // 検証: 3 テーブルすべての存在を確認
  const { rows } = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)",
    [REQUIRED_TABLES],
  );
  const found = new Set(rows.map((r: { tablename: string }) => r.tablename));
  let allPresent = true;
  for (const t of REQUIRED_TABLES) {
    const present = found.has(t);
    if (!present) allPresent = false;
    console.log(`  Verification: ${t} exists = ${present}`);
  }

  await client.end();

  if (!allPresent) {
    console.error("One or more required tables are still missing. Investigate.");
    process.exit(1);
  }
  console.log("All 3 required tables present. Recovery migration verified.");
}

main().catch((err) => {
  console.error("Recovery migration failed:", err.message);
  process.exit(1);
});
