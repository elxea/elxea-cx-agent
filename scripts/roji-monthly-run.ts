/**
 * roji 月次処理の手動実行（S1 骨格）— `pnpm roji:monthly-run`
 *
 * 設計正本: roji出し分けの仕組み 設計書（S1シンプル版）
 *   https://www.notion.so/3b870c9d064c8191b807c59c1c2a6e74  第4章
 * 手順の本体は `src/lib/roji/monthly/monthly-run.ts`（純粋）。本ファイルは**外の世界との配線だけ**。
 *
 * ─ 安全（このスクリプトの絶対条件）─
 *   - **送信を一切行わない**。LINE / メール / Slack のクライアントを 1 つも import しない。
 *     手順の本体（monthly-run.ts）も送信系を import していない（機械チェックあり）。
 *   - **既定は dry-run**（1 行も書かない）。実際に書くのは `--apply` を明示したときだけ。
 *   - **スケジューラに登録しない**。cron / launchd への登録は次フェーズ（Setaka 判断）。
 *   - 台帳は追加のみ（INSERT）。UPDATE / DELETE を 1 度も実行しない。
 *   - 個人の氏名・メール・住所を画面に出さない（EC 上の顧客番号までに留める）。
 *
 * 使用:
 *   npx tsx scripts/roji-monthly-run.ts                          # 本番接続・dry-run・前月分
 *   npx tsx scripts/roji-monthly-run.ts --period 2026-08         # 締め対象月を明示
 *   npx tsx scripts/roji-monthly-run.ts --env staging            # staging
 *   npx tsx scripts/roji-monthly-run.ts --apply                  # 実際に台帳へ書く（要明示）
 */

import dotenv from "dotenv";
import pg from "pg";

import type { Env } from "../src/index";
import {
  buildCollectionListQuery,
  firestoreBaseUrl,
  getAccessToken,
  fromFirestoreFields,
  type FirestoreEnv,
} from "../src/lib/firestore";
import { fetchSellingTeas } from "../src/lib/tea-menu";
import { fetchJournalArticles } from "../src/lib/journal";
import type { Candidate, LedgerRow, RojiKarte } from "../src/lib/roji/assignment/types";
import {
  runMonthlyAssignment,
  type LedgerWrite,
  type MonthRecord,
  type MonthlyPorts,
  type MonthlySubject,
} from "../src/lib/roji/monthly/monthly-run";
import { derivePeriod, assertValidPeriod } from "../src/lib/roji/monthly/period";

dotenv.config({ quiet: true });
dotenv.config({ path: ".dev.vars", quiet: true });

const PROD_REF = "bquqzrbzdzjegdovxalu";
const STAGING_REF = "espeokdhutgztksdrpzt";
/** 本カルテのコレクション（Firestore users/{shopifyCustomerId}）。 */
const USERS_COLLECTION = "users";
/** 1 ページの走査件数（対象は数十人規模。暴走防止の上限も兼ねる）。 */
const PAGE = 300;
const MAX_PAGES = 50;

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
const targetEnv: "prod" | "staging" = (argValue("--env") as "prod" | "staging") ?? "prod";
const apply = argv.includes("--apply");
const period = assertValidPeriod(argValue("--period") ?? derivePeriod(new Date()));

// ---------------------------------------------------------------------------
// Firestore: 本カルテを全件走査して対象者を作る（Q2 = カルテがある人全員）
// ---------------------------------------------------------------------------

/**
 * 本カルテ（users/{shopifyCustomerId}）を全件走査する。
 *
 * 台帳の鍵は EC 上の顧客番号（項目42）なので、鍵を持つのは本カルテ側だけ。未連携カルテ
 * （lineUsers/{lineUserId}）しか持たない人は台帳に行を作れないため、ここでは拾わない。
 * **黙って落とさない**ために、未連携側の件数も別途数えて画面に出す（下の countUnkeyedKartes）。
 */
async function listKarteSubjects(fsEnv: FirestoreEnv): Promise<MonthlySubject[]> {
  const accessToken = await getAccessToken(fsEnv);
  const url = `${firestoreBaseUrl(fsEnv.FIREBASE_PROJECT_ID)}:runQuery`;
  const out: MonthlySubject[] = [];
  let cursor: string | undefined;

  for (let i = 0; i < MAX_PAGES; i++) {
    const structuredQuery = buildCollectionListQuery(USERS_COLLECTION, {
      limit: PAGE,
      startAfterName: cursor,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) {
      throw new Error(`Firestore runQuery (users 全走査) 失敗 (${res.status}): ${await res.text()}`);
    }
    const rows = (await res.json()) as Array<{
      document?: { name: string; fields?: Record<string, Record<string, unknown>> };
    }>;

    let count = 0;
    let lastName: string | undefined;
    for (const entry of rows) {
      if (!entry.document?.name) continue;
      count++;
      lastName = entry.document.name;
      const shopifyCustomerId = entry.document.name.split("/").pop() ?? "";
      if (!/^\d+$/.test(shopifyCustomerId)) continue; // 鍵の形が違う行は台帳に書けない。
      const fields = (fromFirestoreFields(entry.document.fields ?? {}) ?? {}) as Record<string, unknown>;
      out.push({ shopifyCustomerId, karte: toRojiKarte(fields) });
    }
    cursor = count >= PAGE ? lastName : undefined;
    if (!cursor) break;
  }
  return out;
}

/** Firestore のカルテ本体 → 割当が読む面だけ（新しいカルテ項目を作らない・types.ts の RojiKarte）。 */
function toRojiKarte(fields: Record<string, unknown>): RojiKarte {
  const persona = (fields.persona ?? null) as { primary?: string } | null;
  const primary = persona?.primary;
  return {
    persona:
      primary === "serenity" || primary === "explorer" || primary === "sensory" ? primary : null,
    tasteProfile: (fields.tasteProfile ?? null) as RojiKarte["tasteProfile"],
    teaRequests: (fields.teaRequests ?? null) as RojiKarte["teaRequests"],
    windowAffinity: (fields.windowAffinity ?? null) as RojiKarte["windowAffinity"],
  };
}

// ---------------------------------------------------------------------------
// Supabase（台帳）
// ---------------------------------------------------------------------------

function resolveDb(): { url?: string; password?: string; ref: string } {
  return targetEnv === "staging"
    ? {
        url: process.env.SUPABASE_URL_STAGING,
        password: process.env.SUPABASE_DB_PASSWORD_STAGING,
        ref: STAGING_REF,
      }
    : { url: process.env.SUPABASE_URL, password: process.env.SUPABASE_DB_PASSWORD, ref: PROD_REF };
}

/** 台帳・締め記録への口（INSERT と SELECT のみ。UPDATE / DELETE を書かない）。 */
function dbPorts(client: pg.Client): Pick<
  MonthlyPorts,
  | "loadRecentLedger"
  | "hasLedgerRow"
  | "insertLedgerRow"
  | "countLedgerRows"
  | "isMonthClosed"
  | "insertMonthRecord"
> {
  return {
    async loadRecentLedger(shopifyCustomerId: string, p: string): Promise<LedgerRow[]> {
      // 対象月より前の行だけを渡す（同月の自分の行を数えると再実行で結果が変わる・s1-engine の注記）。
      const { rows } = await client.query<{ period: string; teas: unknown }>(
        `select period, teas from roji_delivery_ledger
          where shopify_customer_id = $1 and period < $2
          order by period desc limit 12`,
        [shopifyCustomerId, p],
      );
      return rows.map((r: { period: string; teas: unknown }) => ({
        period: r.period,
        teas: Array.isArray(r.teas) ? (r.teas as LedgerRow["teas"]) : [],
      }));
    },
    async hasLedgerRow(shopifyCustomerId: string, p: string): Promise<boolean> {
      const { rows } = await client.query(
        `select 1 from roji_delivery_ledger where shopify_customer_id = $1 and period = $2 limit 1`,
        [shopifyCustomerId, p],
      );
      return rows.length > 0;
    },
    async insertLedgerRow(row: LedgerWrite): Promise<void> {
      // 既存行は上書きしない（凍結原則）。呼び出し側で hasLedgerRow を見ているが、
      // 同時実行に備えて DO NOTHING も置く（UNIQUE 制約が最後の砦）。
      await client.query(
        `insert into roji_delivery_ledger
           (shopify_customer_id, period, teas, candidates_not_chosen, issue_materials, estimate_snapshot)
         values ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb)
         on conflict (shopify_customer_id, period) do nothing`,
        [
          row.shopifyCustomerId,
          row.period,
          JSON.stringify(row.teas),
          JSON.stringify(row.candidatesNotChosen),
          JSON.stringify(row.issueMaterials),
          JSON.stringify(row.estimateSnapshot),
        ],
      );
    },
    async countLedgerRows(p: string): Promise<number> {
      const { rows } = await client.query<{ n: string }>(
        `select count(*)::text as n from roji_delivery_ledger where period = $1`,
        [p],
      );
      return Number(rows[0]?.n ?? 0);
    },
    async isMonthClosed(p: string): Promise<boolean> {
      const { rows } = await client.query(
        `select 1 from roji_delivery_months where period = $1 limit 1`,
        [p],
      );
      return rows.length > 0;
    },
    async insertMonthRecord(record: MonthRecord): Promise<void> {
      await client.query(
        `insert into roji_delivery_months (period, closed_at, member_count, row_count)
         values ($1, $2, $3, $4)
         on conflict (period) do nothing`,
        [record.period, record.closedAt.toISOString(), record.memberCount, record.rowCount],
      );
    },
  };
}

/** dry-run 用のかぶせ物: 書き込みだけを握りつぶし、何を書くはずだったかを溜める。 */
function withDryRun(ports: MonthlyPorts, sink: { ledger: LedgerWrite[]; months: MonthRecord[] }): MonthlyPorts {
  return {
    ...ports,
    async insertLedgerRow(row) {
      sink.ledger.push(row);
    },
    async insertMonthRecord(record) {
      sink.months.push(record);
    },
  };
}

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

async function main() {
  const { url, password, ref: expected } = resolveDb();
  if (!url || !password) {
    console.error(`[FATAL] ${targetEnv} の接続情報が未設定。中断。`);
    process.exit(1);
  }
  const ref = new URL(url).hostname.split(".")[0];
  if (ref !== expected) {
    console.error(`[ABORT] ${targetEnv} 指定だが ref='${ref}'。接続せず中断。`);
    process.exit(1);
  }

  const workerEnv = {
    NOTION_TOKEN: process.env.NOTION_TOKEN,
    NOTION_TEA_MENU_DB_ID: process.env.NOTION_TEA_MENU_DB_ID,
    NOTION_CONTENT_HUB_DB_ID: process.env.NOTION_CONTENT_HUB_DB_ID,
    DELIVERY_TARGET_ENV: process.env.DELIVERY_TARGET_ENV ?? (targetEnv === "prod" ? "prod" : "test"),
  } as unknown as Env;

  const fsEnv: FirestoreEnv = {
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ?? "",
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL ?? "",
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ?? "",
  };
  if (!fsEnv.FIREBASE_PROJECT_ID || !fsEnv.FIREBASE_CLIENT_EMAIL || !fsEnv.FIREBASE_PRIVATE_KEY) {
    console.error("[FATAL] Firebase の接続情報が未設定。カルテを読めないため中断。");
    process.exit(1);
  }

  console.log(`[assert] project ref = ${ref} (env=${targetEnv})`);
  console.log(`[assert] 締め対象月 period = ${period}（月末23:59 JST締め・翌月1日に計算）`);
  console.log(`[assert] mode = ${apply ? "APPLY（台帳へ書く）" : "DRY-RUN（1行も書かない）"}`);
  console.log("[assert] 送信は行わない（送信系モジュールを import していない）");

  const client = new pg.Client({
    host: `db.${ref}.supabase.co`,
    port: 5432,
    database: "postgres",
    user: "postgres",
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  await client.connect();

  const sink = { ledger: [] as LedgerWrite[], months: [] as MonthRecord[] };
  try {
    const realPorts: MonthlyPorts = {
      listSubjects: () => listKarteSubjects(fsEnv),
      loadCandidates: async (): Promise<Candidate[]> => {
        const [teas, articles] = await Promise.all([
          fetchSellingTeas(workerEnv),
          fetchJournalArticles(workerEnv),
        ]);
        return [
          ...teas.map((tea) => ({ kind: "tea" as const, tea })),
          ...articles.map((article) => ({ kind: "article" as const, article })),
        ];
      },
      ...dbPorts(client),
    };

    const ports = apply ? realPorts : withDryRun(realPorts, sink);
    const result = await runMonthlyAssignment(period, ports);

    console.log(`\n===== roji 月次割当 ${result.period} =====`);
    console.log(`  対象者（カルテがある人）: ${result.memberCount} 人`);
    console.log(`  新しく台帳へ書いた人      : ${result.assigned.length} 人`);
    console.log(`  既存行があってスキップ    : ${result.skipped.length} 人（凍結・上書きしない）`);
    console.log(`  実行後の台帳行数          : ${result.rowCount} 行`);
    console.log(`  月の締め記録              : ${result.monthRecord}`);
    if (result.countMismatch) {
      console.log("  [WARN] 対象者数と台帳行数が食い違っています（記録の事故・人の目で確認してください）");
    }
    if (result.shortages.length > 0) {
      console.log(`  [WARN] 候補不足 / 重複回避の緩和: ${result.shortages.length} 人`);
      for (const s of result.shortages) {
        console.log(
          `    - ${s.shopifyCustomerId}: ${s.shortage.code} (${s.shortage.delivered}/${s.shortage.requested})`,
        );
      }
    }
    if (!apply) {
      console.log(`\n[DRY-RUN] 書くはずだった台帳行: ${sink.ledger.length} 件 / 締め記録: ${sink.months.length} 件`);
      console.log("[DRY-RUN] 実際に書くには --apply を付けてください。");
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  // 途中で失敗したらその月ごと止める（設計 4-2）。締め記録は書かれないため未締めとして残る。
  console.error("[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
