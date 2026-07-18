/**
 * Staging 専用マイグレーション適用スクリプト。
 *
 * 既存の run-migration-p0.ts / run-recovery-migration.ts は本番 Supabase 向け
 * （SUPABASE_URL + SUPABASE_DB_PASSWORD）。本スクリプトは **staging 専用**で、
 * SUPABASE_URL_STAGING（.dev.vars）+ SUPABASE_DB_PASSWORD_STAGING（.env）を使う。
 *
 * 安全（多層ガード）:
 *   - 接続先 project ref が staging（espeokdhutgztksdrpzt）でなければ中断。
 *   - 万一 prod ref（bquqzrbzdzjegdovxalu）と一致したら中断（prod 非接触の二重ガード）。
 *   - 全 SQL は IF NOT EXISTS / ADD COLUMN IF NOT EXISTS で冪等・再実行安全。
 *
 * Usage:
 *   npx tsx scripts/run-migration-staging.ts                # 既定: 026 を適用
 *   npx tsx scripts/run-migration-staging.ts src/db/migrations/026_customer_linkage_source.sql
 */
import dotenv from "dotenv";
import pg from "pg";
import { readFileSync } from "fs";

// .env（staging DB パスワード）と .dev.vars（staging URL 等）の両方を読む。
dotenv.config({ path: ".env" });
dotenv.config({ path: ".dev.vars" });

const STAGING_REF = "espeokdhutgztksdrpzt";
const PROD_REF = "bquqzrbzdzjegdovxalu";

const DEFAULT_MIGRATIONS = ["src/db/migrations/026_customer_linkage_source.sql"];
const migrations = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const files = migrations.length > 0 ? migrations : DEFAULT_MIGRATIONS;

const SUPABASE_URL_STAGING = process.env.SUPABASE_URL_STAGING;
const DB_PASSWORD = process.env.SUPABASE_DB_PASSWORD_STAGING;

async function main() {
  if (!SUPABASE_URL_STAGING) {
    console.error("[FATAL] SUPABASE_URL_STAGING が未設定（.dev.vars）。中断。");
    process.exit(1);
  }
  if (!DB_PASSWORD) {
    console.error("[FATAL] SUPABASE_DB_PASSWORD_STAGING が未設定（.env）。中断。");
    process.exit(1);
  }

  const projectRef = new URL(SUPABASE_URL_STAGING).hostname.split(".")[0];
  if (projectRef === PROD_REF) {
    console.error(`[FATAL] project ref が本番（${PROD_REF}）。staging 専用スクリプトのため中断。`);
    process.exit(1);
  }
  if (projectRef !== STAGING_REF) {
    console.error(`[FATAL] project ref が想定 staging（${STAGING_REF}）と不一致: ${projectRef}。中断。`);
    process.exit(1);
  }

  const client = new pg.Client({
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    database: "postgres",
    user: "postgres",
    password: DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  await client.connect();
  console.log(`Connected to Supabase PostgreSQL (STAGING project: ${projectRef})`);

  for (const file of files) {
    const sql = readFileSync(file, "utf8");
    await client.query(sql);
    console.log(`Applied ${file} (idempotent).`);
  }

  // 検証(1・smoke): customer_linkages.source 列が存在するか（026 由来・全実行共通のヘルスチェック）。
  const { rows } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='customer_linkages' AND column_name='source'`,
  );
  if (rows.length === 1) {
    console.log(`[OK] customer_linkages.source 列を確認: ${JSON.stringify(rows[0])}`);
  } else {
    console.error("[FAIL] customer_linkages.source 列が見つからない。");
    await client.end();
    process.exit(1);
  }

  // 検証(2): 027（カーディナリティ緩和）を適用したときは、shopify_customer_id の単一列 UNIQUE が
  //   消えている（= N:1 が許可された）ことを確認する。
  if (files.some((f) => /027/.test(f))) {
    const { rows: uniq } = await client.query(
      `SELECT con.conname
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
       WHERE nsp.nspname='public' AND rel.relname='customer_linkages'
         AND con.contype='u' AND att.attname='shopify_customer_id'
         AND array_length(con.conkey, 1) = 1`,
    );
    if (uniq.length === 0) {
      console.log("[OK] customer_linkages.shopify_customer_id の単一列 UNIQUE は無し（N:1 許可・027 適用済）。");
    } else {
      console.error(`[FAIL] shopify_customer_id の UNIQUE がまだ存在する: ${JSON.stringify(uniq)}`);
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log("Done (staging).");
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
