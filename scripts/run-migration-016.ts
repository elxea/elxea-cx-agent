/**
 * Run migration 016_regression_tests.sql via Supabase direct connection.
 * Usage: npx tsx scripts/run-migration-016.ts
 *
 * Requires SUPABASE_DB_PASSWORD env var (or pass as argument):
 *   SUPABASE_DB_PASSWORD=xxx npx tsx scripts/run-migration-016.ts
 *   npx tsx scripts/run-migration-016.ts --password=xxx
 */

import dotenv from "dotenv";
import pg from "pg";
import { readFileSync } from "fs";

dotenv.config({ path: ".dev.vars" });

const SUPABASE_URL = process.env.SUPABASE_URL!;
const args = process.argv.slice(2);
const passwordArg = args
  .find((a) => a.startsWith("--password="))
  ?.split("=")[1];
const DB_PASSWORD = passwordArg ?? process.env.SUPABASE_DB_PASSWORD;

const sql = readFileSync("src/db/migrations/016_regression_tests.sql", "utf8");

async function main() {
  if (!DB_PASSWORD) {
    const url = new URL(SUPABASE_URL);
    const projectRef = url.hostname.split(".")[0];
    console.log("SUPABASE_DB_PASSWORD not set.\n");
    console.log("Option 1: Pass password as argument:");
    console.log("  npx tsx scripts/run-migration-016.ts --password=YOUR_PASSWORD\n");
    console.log("Option 2: Run SQL manually in Supabase SQL Editor:");
    console.log(
      `  https://supabase.com/dashboard/project/${projectRef}/sql\n`,
    );
    console.log("--- SQL ---");
    console.log(sql);
    console.log("--- END ---");
    process.exit(1);
  }

  const url = new URL(SUPABASE_URL);
  const projectRef = url.hostname.split(".")[0];

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
  console.log("Connected to Supabase PostgreSQL");

  await client.query(sql);
  console.log("Migration 016_regression_tests.sql applied successfully!");

  // Verify
  const { rows } = await client.query(
    "SELECT tablename FROM pg_tables WHERE tablename = 'regression_tests'",
  );
  console.log(`Verification: table exists = ${rows.length > 0}`);

  await client.end();
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
