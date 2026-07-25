/**
 * migrate.ts — src/db/migrations/*.sql を「番号順に適用し、適用済みは schema_migrations 台帳で
 * スキップ」する統合マイグレーション runner。ad-hoc runner（run-migration-*.ts）を置換する正本。
 *
 * ─ 何をするか ─
 *   1. schema_migrations 台帳（000_schema_migrations.sql）を bootstrap（IF NOT EXISTS）。
 *   2. 台帳の適用済み version 集合を読む。
 *   3. src/db/migrations/*.sql を「ファイル名昇順」（= 000,001,...,029 の番号順）に走査し、
 *      未適用のものだけを 1 本ずつトランザクション内で適用し、直後に version を台帳へ記録する
 *      （apply と記録が同一 tx でアトミック。失敗時は当該 migration ごと巻き戻る）。
 *
 * ─ version の規約 ─
 *   ファイル名から拡張子 .sql を除いた文字列（例 "026_customer_linkage_source"）。026 の同番号衝突は
 *   本台帳導入時に 026_marche_activation_log → 029_marche_activation_log へリネームして解消済み。
 *
 * ─ baseline（既存 DB を台帳に取り込む）─ high-water-mark を使わない per-version introspection ─
 *   本番/staging は ad-hoc runner で **非連続**に適用されてきた（016 単独 / 018 / 021-023 /
 *   026・029・027・028 が別時期）。よって「N 以下は全部適用済み」（high-water-mark）は誤り。
 *   `--baseline` は各 migration が生成するオブジェクト（テーブル / index / カラム / 関数 / RLS）を
 *   pg_catalog / information_schema で **実在確認**し、実在が確認できた version のみ schema_migrations に
 *   登録する。検証レポートを stdout に出す（この結果は Setaka 承認に回す）。
 *     - `--baseline`            : 検証 + 登録（登録は単一 tx でアトミック）。
 *     - `--baseline --dry-run`  : 検証レポートのみ（一切書き込まない）。
 *
 * ─ 既存 SQL の冪等性（正確な記述・虚偽コメント修正）─
 *   ⚠ 全 SQL が冪等なわけではない。以下は **非冪等**（IF NOT EXISTS 欠如の index/table、RENAME COLUMN 等）:
 *     - 001: `create index knowledge_chunks_embedding_idx`（IF NOT EXISTS 無し）
 *     - 002: `create index customer_linkages_line_idx / _shopify_idx`（IF NOT EXISTS 無し）
 *     - 004: `create index unanswered_queries_created_idx`（IF NOT EXISTS 無し）
 *     - 006: `ALTER TABLE ... ADD COLUMN`（IF NOT EXISTS 無し）+ `RENAME COLUMN line_user_id TO user_id`
 *     - 008: `CREATE TABLE message_feedback` / `CREATE INDEX`（IF NOT EXISTS 無し）
 *     - 015: `CREATE TABLE probe_history` / `CREATE INDEX`（IF NOT EXISTS 無し）
 *     - 016: `CREATE TABLE regression_tests` / `CREATE INDEX`（IF NOT EXISTS 無し）
 *   これらは再実行すると「already exists」等で失敗する。029 は IF NOT EXISTS で冪等（対象外）。
 *   → だからこそ high-water-mark ではなく introspection baseline が必要。**既存 SQL は書き換えない**
 *     （適用済み実体との対応を壊さないため）。台帳スキップで二重適用を防ぐ。
 *
 * ─ 安全（本適用の二重ガード）─
 *   - 本適用は **明示フラグ `--apply` が必須**。付けない実行は自動で dry-run 扱い（何も変更しない）。
 *   - 接続先 project ref を **HARD ASSERT**:
 *       prod（既定）  : ref === bquqzrbzdzjegdovxalu でなければ接続せず中断。
 *       --env staging : ref === espeokdhutgztksdrpzt かつ ≠ prod ref でなければ中断（prod 非接触の二重ガード）。
 *
 * ─ 使い方 ─
 *   npx tsx scripts/migrate.ts --dry-run                       # 適用予定（未適用）の一覧（非破壊）
 *   npx tsx scripts/migrate.ts --dry-run --env staging
 *   npx tsx scripts/migrate.ts --baseline --dry-run            # baseline 検証レポートのみ（非破壊）
 *   npx tsx scripts/migrate.ts --baseline                      # baseline 検証 + 台帳登録（tx アトミック）
 *   SUPABASE_DB_PASSWORD=xxx npx tsx scripts/migrate.ts --apply
 *   npx tsx scripts/migrate.ts --apply --env staging
 *
 *   ※ 引数無しは安全側に倒して dry-run 相当（案内を出して終了）。
 */

import dotenv from "dotenv";
import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = "src/db/migrations";
const PROD_REF = "bquqzrbzdzjegdovxalu";
const STAGING_REF = "espeokdhutgztksdrpzt";

export type TargetEnv = "prod" | "staging";

interface Cli {
  apply: boolean;
  dryRun: boolean;
  baseline: boolean;
  env: TargetEnv;
}

// ---------------------------------------------------------------------------
// per-version introspection マップ（baseline の要）
//
// 各 version が生成するオブジェクトの「実在で判定できる sentinel」を定義する。sentinel が
// すべて実在すれば applied、すべて不在なら absent、一部だけなら partial（要手動確認）と判定する。
// idempotent な redefinition 系（012 / 027）で「実在で一意に判定できる正の sentinel が無い」ものは
// specs を空にする（= no-sentinel。台帳登録せず、--apply が冪等に再適用する＝安全）。
// ---------------------------------------------------------------------------

export type ObjectSpec =
  | { kind: "table"; table: string }
  | { kind: "column"; table: string; column: string }
  | { kind: "index"; index: string }
  | { kind: "function"; func: string }
  | { kind: "rls"; table: string };

export interface VersionIntrospection {
  /** 既存 SQL が冪等（再実行安全）か。false は再実行で失敗しうる（レポート表示用のメタ）。 */
  idempotent: boolean;
  /** 実在確認に使う sentinel オブジェクト群（空 = no-sentinel）。 */
  specs: ObjectSpec[];
}

/** version（ファイル名から .sql を除いた文字列）→ introspection 定義。 */
export const INTROSPECTION: Record<string, VersionIntrospection> = {
  // 000 は台帳自身。baseline の対象外（常に register 済み扱い）だが、判定簡素化のため table sentinel を持たせる。
  "000_schema_migrations": { idempotent: true, specs: [{ kind: "table", table: "schema_migrations" }] },
  "001_fix_vector_dimension": {
    idempotent: false,
    specs: [{ kind: "index", index: "knowledge_chunks_embedding_idx" }],
  },
  "002_customer_linkage_table": {
    idempotent: false,
    specs: [
      { kind: "table", table: "customer_linkages" },
      { kind: "index", index: "customer_linkages_line_idx" },
    ],
  },
  "003_hybrid_search": {
    idempotent: true,
    specs: [
      { kind: "column", table: "knowledge_chunks", column: "notion_last_edited_at" },
      { kind: "function", func: "search_knowledge_hybrid" },
    ],
  },
  "004_unanswered_queries": {
    idempotent: false,
    specs: [
      { kind: "table", table: "unanswered_queries" },
      { kind: "column", table: "sync_logs", column: "sync_type" },
    ],
  },
  "005_metadata_filter": {
    idempotent: true,
    specs: [{ kind: "index", index: "knowledge_chunks_source_type_idx" }],
  },
  "006_channel_adapter": {
    idempotent: false,
    specs: [
      { kind: "table", table: "user_identity_map" },
      { kind: "column", table: "conversations", column: "channel" },
    ],
  },
  "007_conversation_search": {
    idempotent: true,
    specs: [{ kind: "function", func: "search_conversations" }],
  },
  "008_message_feedback": {
    idempotent: false,
    specs: [{ kind: "table", table: "message_feedback" }],
  },
  "009_tasting_notes_survey": {
    idempotent: true,
    specs: [{ kind: "table", table: "tasting_note_survey" }],
  },
  "010_data_retention": {
    idempotent: true,
    specs: [{ kind: "table", table: "conversation_daily_stats" }],
  },
  "011_identity_email": {
    idempotent: true,
    specs: [{ kind: "column", table: "user_identity_map", column: "email" }],
  },
  // 012 は search_knowledge / search_knowledge_hybrid を DROP + CREATE OR REPLACE で「作り直す」。
  // 関数の存在自体は 001/003 でも真になり 012 を一意に判定できない。冪等なので no-sentinel（再適用安全）。
  "012_fix_hybrid_search": { idempotent: true, specs: [] },
  "013_line_login_user_id": {
    idempotent: true,
    specs: [{ kind: "column", table: "user_identity_map", column: "line_login_user_id" }],
  },
  "014_pending_follow_refs": {
    idempotent: true,
    specs: [{ kind: "table", table: "pending_follow_refs" }],
  },
  "015_probe_history": {
    idempotent: false,
    specs: [{ kind: "table", table: "probe_history" }],
  },
  "016_regression_tests": {
    idempotent: false,
    specs: [{ kind: "table", table: "regression_tests" }],
  },
  "017_enable_rls": {
    idempotent: true,
    specs: [{ kind: "rls", table: "knowledge_chunks" }],
  },
  "018_recovery_missing_tables": {
    idempotent: true,
    specs: [
      { kind: "table", table: "customer_linkages" },
      { kind: "table", table: "sync_logs" },
      { kind: "table", table: "pending_follow_refs" },
      { kind: "column", table: "sync_logs", column: "sync_type" },
    ],
  },
  "019_line_message_ledger": {
    idempotent: true,
    specs: [{ kind: "table", table: "line_message_ledger" }],
  },
  "020_line_delivery_optout": {
    idempotent: true,
    specs: [{ kind: "column", table: "customer_linkages", column: "broadcast_opted_out" }],
  },
  "021_flow_events": {
    idempotent: true,
    specs: [{ kind: "table", table: "flow_events" }],
  },
  "022_product_ratings": {
    idempotent: true,
    specs: [{ kind: "table", table: "product_ratings" }],
  },
  "023_line_message_ledger_aggregation_unit": {
    idempotent: true,
    specs: [{ kind: "column", table: "line_message_ledger", column: "aggregation_unit" }],
  },
  "024_broadcast_stats": {
    idempotent: true,
    specs: [{ kind: "table", table: "broadcast_stats" }],
  },
  "025_dormant_reengagement_log": {
    idempotent: true,
    specs: [{ kind: "table", table: "dormant_reengagement_log" }],
  },
  "026_customer_linkage_source": {
    idempotent: true,
    specs: [{ kind: "column", table: "customer_linkages", column: "source" }],
  },
  // 027 は shopify_customer_id 単一列 UNIQUE 制約を動的 DROP する（負の状態）。正の sentinel が無く冪等。
  "027_customer_linkage_cardinality": { idempotent: true, specs: [] },
  "028_account_link_nonces": {
    idempotent: true,
    specs: [{ kind: "table", table: "account_link_nonces" }],
  },
  "029_marche_activation_log": {
    idempotent: true,
    specs: [{ kind: "table", table: "marche_activation_log" }],
  },
};

// ---------------------------------------------------------------------------
// 純粋ロジック（DB 非依存・ユニットテスト対象）
// ---------------------------------------------------------------------------

/** src/db/migrations/*.sql をファイル名昇順（番号順）で返す。 */
export function listMigrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));
}

/** ファイル名 → version（拡張子 .sql を除いた文字列）。 */
export function versionOf(file: string): string {
  return file.replace(/\.sql$/, "");
}

/** version 文字列の先頭数字部分を number として返す（"026_x" → 26 / "000" → 0）。非数字先頭は NaN。 */
export function versionNumber(version: string): number {
  const m = /^(\d+)/.exec(version);
  return m ? parseInt(m[1], 10) : NaN;
}

/** ObjectSpec を一意キー化する（probe 結果の Map キーに使う）。 */
export function specKey(spec: ObjectSpec): string {
  switch (spec.kind) {
    case "table":
      return `table:public.${spec.table}`;
    case "column":
      return `column:public.${spec.table}.${spec.column}`;
    case "index":
      return `index:public.${spec.index}`;
    case "function":
      return `function:public.${spec.func}`;
    case "rls":
      return `rls:public.${spec.table}`;
  }
}

export type Detection = "applied" | "absent" | "partial" | "no-sentinel";
export type BaselineAction =
  | "register"
  | "skip-registered"
  | "leave-absent"
  | "leave-partial"
  | "leave-idempotent";

export interface BaselineDecision {
  version: string;
  idempotent: boolean;
  specs: ObjectSpec[];
  detected: Detection;
  alreadyRegistered: boolean;
  action: BaselineAction;
}

/**
 * sentinel 群の実在結果から detection を判定する（純粋）。
 *   specs 空          → "no-sentinel"
 *   すべて実在        → "applied"
 *   すべて不在        → "absent"
 *   一部のみ実在      → "partial"
 */
export function detectVersion(specs: ObjectSpec[], existsMap: Map<string, boolean>): Detection {
  if (specs.length === 0) return "no-sentinel";
  let present = 0;
  for (const s of specs) {
    if (existsMap.get(specKey(s)) === true) present++;
  }
  if (present === specs.length) return "applied";
  if (present === 0) return "absent";
  return "partial";
}

/**
 * baseline プラン（純粋）。files（version 一覧）・既登録集合・実在 Map から各 version の action を導く。
 * high-water-mark を使わず、version ごとに独立に判定する（非連続適用集合を正しく扱う）。
 */
export function computeBaselinePlan(
  versions: string[],
  registered: Set<string>,
  existsMap: Map<string, boolean>,
): BaselineDecision[] {
  return versions.map((version) => {
    const intro = INTROSPECTION[version] ?? { idempotent: true, specs: [] };
    const detected = detectVersion(intro.specs, existsMap);
    const alreadyRegistered = registered.has(version);
    let action: BaselineAction;
    if (alreadyRegistered) action = "skip-registered";
    else if (detected === "applied") action = "register";
    else if (detected === "no-sentinel") action = "leave-idempotent";
    else if (detected === "partial") action = "leave-partial";
    else action = "leave-absent";
    return { version, idempotent: intro.idempotent, specs: intro.specs, detected, alreadyRegistered, action };
  });
}

/** baseline プランから、台帳へ INSERT すべき version 群を返す（純粋）。 */
export function versionsToRegister(plan: BaselineDecision[]): string[] {
  return plan.filter((d) => d.action === "register").map((d) => d.version);
}

// ---------------------------------------------------------------------------
// CLI パース
// ---------------------------------------------------------------------------

export function parseCli(argv: string[]): Cli {
  const args = argv.slice(2);
  const has = (f: string) => args.includes(f);
  const envArg = (() => {
    const i = args.findIndex((a) => a === "--env" || a.startsWith("--env="));
    if (i === -1) return "prod" as TargetEnv;
    const raw = args[i].includes("=") ? args[i].split("=")[1] : args[i + 1];
    if (raw !== "prod" && raw !== "staging") {
      console.error(`[FATAL] --env は prod|staging のみ（受領: ${raw ?? "(none)"}）。中断。`);
      process.exit(1);
    }
    return raw as TargetEnv;
  })();
  return { apply: has("--apply"), dryRun: has("--dry-run"), baseline: has("--baseline"), env: envArg };
}

// ---------------------------------------------------------------------------
// DB 依存（接続・probe・適用）
// ---------------------------------------------------------------------------

function resolveConn(env: TargetEnv): { url: string | undefined; password: string | undefined } {
  if (env === "staging") {
    return {
      url: process.env.SUPABASE_URL_STAGING,
      password: process.env.SUPABASE_DB_PASSWORD_STAGING,
    };
  }
  return { url: process.env.SUPABASE_URL, password: process.env.SUPABASE_DB_PASSWORD };
}

/** 接続先 project ref を env 期待値に対して HARD ASSERT する。不一致は中断。 */
function assertProjectRef(projectRef: string, env: TargetEnv): void {
  if (env === "prod") {
    if (projectRef !== PROD_REF) {
      console.error(`[ABORT] project ref '${projectRef}' !== 期待 prod '${PROD_REF}'。接続せず中断。`);
      process.exit(1);
    }
  } else {
    if (projectRef === PROD_REF) {
      console.error(`[ABORT] --env staging だが project ref が本番（${PROD_REF}）。中断。`);
      process.exit(1);
    }
    if (projectRef !== STAGING_REF) {
      console.error(`[ABORT] --env staging の project ref '${projectRef}' が期待 staging '${STAGING_REF}' と不一致。中断。`);
      process.exit(1);
    }
  }
  console.log(`[OK] PROJECT REF ASSERT: ${projectRef} (env=${env})`);
}

function newClient(projectRef: string, password: string): pg.Client {
  return new pg.Client({
    host: `db.${projectRef}.supabase.co`,
    port: 5432,
    database: "postgres",
    user: "postgres",
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
}

async function fetchApplied(client: pg.Client): Promise<Set<string>> {
  const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
  return new Set(rows.map((r: { version: string }) => r.version));
}

async function fetchAppliedReadOnly(client: pg.Client): Promise<Set<string>> {
  try {
    return await fetchApplied(client);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === "42P01") {
      console.log("   （schema_migrations 台帳は未作成。書き込みはしない＝全件が未適用扱い。）");
      return new Set<string>();
    }
    throw e;
  }
}

/** 単一 ObjectSpec の実在を pg_catalog / information_schema で確認する（read-only）。 */
async function probeSpec(client: pg.Client, spec: ObjectSpec): Promise<boolean> {
  switch (spec.kind) {
    case "table":
    case "index": {
      const name = spec.kind === "table" ? spec.table : spec.index;
      const { rows } = await client.query<{ present: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [`public.${name}`],
      );
      return rows[0]?.present === true;
    }
    case "column": {
      const { rows } = await client.query<{ present: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name=$1 AND column_name=$2
         ) AS present`,
        [spec.table, spec.column],
      );
      return rows[0]?.present === true;
    }
    case "function": {
      const { rows } = await client.query<{ present: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname='public' AND p.proname=$1
         ) AS present`,
        [spec.func],
      );
      return rows[0]?.present === true;
    }
    case "rls": {
      const { rows } = await client.query<{ present: boolean | null }>(
        "SELECT relrowsecurity AS present FROM pg_class WHERE oid = to_regclass($1)",
        [`public.${spec.table}`],
      );
      return rows[0]?.present === true;
    }
  }
}

/** plan に登場する全 spec を重複排除して probe し、specKey→exists の Map を返す。 */
async function probeAll(client: pg.Client, versions: string[]): Promise<Map<string, boolean>> {
  const seen = new Map<string, ObjectSpec>();
  for (const v of versions) {
    for (const s of INTROSPECTION[v]?.specs ?? []) seen.set(specKey(s), s);
  }
  const out = new Map<string, boolean>();
  for (const [key, spec] of seen) out.set(key, await probeSpec(client, spec));
  return out;
}

/** schema_migrations 台帳を bootstrap（000 の SQL を冪等適用）。既存なら no-op。 */
async function ensureLedger(client: pg.Client): Promise<void> {
  const ledgerSql = readFileSync(join(MIGRATIONS_DIR, "000_schema_migrations.sql"), "utf8");
  await client.query(ledgerSql);
}

function printBaselineReport(plan: BaselineDecision[], willWrite: boolean): void {
  console.log(`\n===== baseline 検証レポート（${willWrite ? "登録あり" : "dry-run・登録なし"}）=====`);
  console.log("version                                    | idem | detected    | action");
  console.log("-------------------------------------------+------+-------------+------------------");
  for (const d of plan) {
    console.log(
      `${d.version.padEnd(42)} | ${(d.idempotent ? "yes" : "NO ").padEnd(4)} | ` +
        `${d.detected.padEnd(11)} | ${d.action}`,
    );
  }
  const toRegister = versionsToRegister(plan);
  const partials = plan.filter((d) => d.action === "leave-partial");
  console.log("-------------------------------------------+------+-------------+------------------");
  console.log(`登録対象（register）: ${toRegister.length} 件 ${toRegister.length ? "→ " + toRegister.join(", ") : ""}`);
  if (partials.length > 0) {
    console.log(
      `⚠ partial（sentinel の一部だけ実在＝要手動確認・登録しない）: ${partials.map((p) => p.version).join(", ")}`,
    );
  }
  console.log("=========================================================\n");
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  // .env（staging DB パスワード等）と .dev.vars（URL 等）を読む（import 時副作用を避け main 内で実行）。
  dotenv.config({ path: ".env" });
  dotenv.config({ path: ".dev.vars" });

  const cli = parseCli(process.argv);
  const files = listMigrationFiles();
  const versions = files.map(versionOf);

  console.log(
    `migrate.ts — env=${cli.env} / mode=${cli.baseline ? "BASELINE" : cli.apply ? "APPLY" : "dry-run"}`,
  );
  console.log(`migrations dir: ${MIGRATIONS_DIR}（${files.length} files）`);

  const { url, password } = resolveConn(cli.env);

  // ─ baseline（検証 + 登録。--dry-run 併用で検証のみ）─
  if (cli.baseline) {
    if (!url || !password) {
      console.error(
        `[FATAL] baseline は DB 接続が必須（${cli.env === "staging" ? "SUPABASE_URL_STAGING / SUPABASE_DB_PASSWORD_STAGING" : "SUPABASE_URL / SUPABASE_DB_PASSWORD"}）。中断。`,
      );
      process.exit(1);
    }
    const projectRef = new URL(url).hostname.split(".")[0];
    assertProjectRef(projectRef, cli.env);
    const client = newClient(projectRef, password);
    await client.connect();
    try {
      const registered = await fetchAppliedReadOnly(client);
      const existsMap = await probeAll(client, versions);
      const plan = computeBaselinePlan(versions, registered, existsMap);
      const willWrite = !cli.dryRun;
      printBaselineReport(plan, willWrite);

      if (!willWrite) {
        console.log("[baseline --dry-run] 検証のみ。台帳への登録は行いません。");
        return;
      }
      const toRegister = versionsToRegister(plan);
      if (toRegister.length === 0) {
        console.log("[baseline] 新規登録対象なし。台帳は変更しません。");
        return;
      }
      // 台帳 bootstrap + 登録を単一 tx でアトミックに行う。
      await client.query("BEGIN");
      try {
        await ensureLedger(client);
        for (const v of toRegister) {
          await client.query(
            "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
            [v],
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
      console.log(`[baseline] ${toRegister.length} 件を schema_migrations に登録しました（${cli.env}）: ${toRegister.join(", ")}`);
    } finally {
      await client.end();
    }
    return;
  }

  // ─ dry-run（既定・非破壊）─
  if (!cli.apply) {
    if (!cli.dryRun) {
      console.log(
        "\nℹ️  --apply / --dry-run / --baseline のいずれも無し。安全側に倒して dry-run 相当で終了します。\n" +
          "   適用予定を見る:   npx tsx scripts/migrate.ts --dry-run [--env staging]\n" +
          "   baseline 検証のみ: npx tsx scripts/migrate.ts --baseline --dry-run [--env staging]\n" +
          "   本適用する:       (SUPABASE_DB_PASSWORD=xxx) npx tsx scripts/migrate.ts --apply [--env staging]",
      );
    }
    if (!url || !password) {
      console.log("\n[dry-run] 接続情報が未設定のため適用済み判定はできません。全 migration を番号順に列挙します:");
      for (const f of files) console.log(`   - ${versionOf(f)}`);
      console.log(
        "\n   （SUPABASE_URL[_STAGING] と SUPABASE_DB_PASSWORD[_STAGING] を設定すると、" +
          "適用済みを除いた「未適用のみ」を表示します。）",
      );
      return;
    }
    const projectRef = new URL(url).hostname.split(".")[0];
    assertProjectRef(projectRef, cli.env);
    const client = newClient(projectRef, password);
    await client.connect();
    try {
      const applied = await fetchAppliedReadOnly(client);
      const pending = files.filter((f) => !applied.has(versionOf(f)));
      console.log(`\n[dry-run] 適用済み: ${applied.size} 件 / 未適用: ${pending.length} 件`);
      if (pending.length === 0) {
        console.log("   → 未適用なし（すべて適用済み）。");
      } else {
        console.log("   適用予定（この順で適用されます）:");
        for (const f of pending) console.log(`   - ${versionOf(f)}`);
        if (applied.size === 0) {
          console.log(
            "\n   ⚠ 台帳が空です。既存 DB なら先に baseline を実行してください（非冪等 migration の二重適用を防ぐ）:\n" +
              "     npx tsx scripts/migrate.ts --baseline --dry-run   # まず検証\n" +
              "     npx tsx scripts/migrate.ts --baseline             # 承認後に登録",
          );
        }
      }
    } finally {
      await client.end();
    }
    return;
  }

  // ─ 本適用（--apply）─
  if (!url) {
    console.error(`[FATAL] ${cli.env === "staging" ? "SUPABASE_URL_STAGING" : "SUPABASE_URL"} 未設定。中断。`);
    process.exit(1);
  }
  if (!password) {
    console.error(`[FATAL] ${cli.env === "staging" ? "SUPABASE_DB_PASSWORD_STAGING" : "SUPABASE_DB_PASSWORD"} 未設定。中断。`);
    process.exit(1);
  }

  const projectRef = new URL(url).hostname.split(".")[0];
  assertProjectRef(projectRef, cli.env);

  const client = newClient(projectRef, password);
  await client.connect();
  console.log(`Connected to Supabase PostgreSQL (${cli.env} project: ${projectRef})`);

  try {
    await ensureLedger(client);
    const applied = await fetchApplied(client);
    const pending = files.filter((f) => !applied.has(versionOf(f)));

    if (pending.length === 0) {
      console.log("未適用なし。すべて適用済み。何もしません。");
      return;
    }

    console.log(`未適用 ${pending.length} 件を番号順に適用します...`);
    for (const file of pending) {
      const version = versionOf(file);
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      // apply と台帳記録を同一トランザクションでアトミックに行う（失敗時は当該 migration が丸ごと巻き戻る）。
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING",
          [version],
        );
        await client.query("COMMIT");
        console.log(`  [applied] ${version}`);
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(
          `migration ${version} の適用に失敗（rollback 済み・以降は未適用のまま）: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    console.log(`Done. ${pending.length} 件を適用し schema_migrations に記録しました（${cli.env}）。`);
  } finally {
    await client.end();
  }
}

/** このファイルが直接実行されたときだけ main を走らせる（import 時は副作用ゼロ＝テスト可能にする）。 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === entry;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((e) => {
    console.error("[FATAL]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
