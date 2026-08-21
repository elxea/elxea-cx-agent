/**
 * 現状棚卸し (1-1): identity 台帳の実測。read-only。
 *
 * ## 何のための数字か
 *
 * 確定設計書 v1.2 (https://app.notion.com/p/3c370c9d064c819db3acd6b939957e4a) の
 * §0-2 は「移行窓の長さを実測してから決める」、§2-3 条件 3 は「D5 のカーディナリティ
 * 統一を入れる前に、実際に N:1 がどれだけあるかを知る」としている。その入力を出す。
 *
 * 特に Q7 (プロバイダー分裂をどう畳むか) の判断材料になるのは:
 *   - **移行対象の規模**: 再採番マッピングを踏ませる必要のある連携が何件あるか
 *   - **N:1 世帯**: 自動補完を禁止すべき (v1.2 R-2) 顧客が実在するか
 *   - **orphan**: Login 側と Messaging 側のどちらか片方しか無い行が何件あるか
 *     = D4 の橋が架かっていない実数
 *
 * ## 出すもの・出さないもの
 *
 * **集計値だけ**。userId・メール・顧客 ID の生値は 1 つも出力しない。レポートは Notion に
 * 載るため、そこに個人を指せる値が入ってはいけない。SQL も COUNT しか SELECT しない。
 *
 * ## 安全性
 *
 * - 読み取り専用。SELECT 以外を発行しない。トランザクションも張らない。
 * - 接続直後に `SET default_transaction_read_only = on` を掛け、事故で書けないようにする。
 * - 接続先 project ref を期待値に対して HARD ASSERT する (scripts/migrate.ts と同じ規律)。
 *   どこを数えたか分からない数字は使えないし、staging を prod と取り違えた数字は害になる。
 *
 * ## 使い方
 *
 *   set -a && . .dev.vars && set +a
 *   npx tsx scripts/inventory-identity.ts                  # prod (既定)
 *   npx tsx scripts/inventory-identity.ts --env staging
 *   npx tsx scripts/inventory-identity.ts --json
 *
 * 必要な env: SUPABASE_URL + SUPABASE_DB_PASSWORD (staging は *_STAGING)
 */
import pg from "pg";

const PROD_REF = "bquqzrbzdzjegdovxalu";
const STAGING_REF = "espeokdhutgztksdrpzt";

type TargetEnv = "prod" | "staging";

/**
 * 1 クエリ = 1 指標。SQL を並べて置いてあるのは、後から「この数字は何を数えたのか」を
 * 定義ごと読めるようにするため (レポートの脚注に貼れる形にしてある)。
 */
const QUERIES: ReadonlyArray<{ key: string; label: string; sql: string }> = [
  // --- customer_linkages (トーク側 = Messaging userId ↔ Shopify 顧客) ---
  {
    key: "linkages_total",
    label: "customer_linkages 総数",
    sql: "SELECT count(*)::int AS n FROM customer_linkages",
  },
  {
    key: "linkages_with_customer",
    label: "  うち Shopify 顧客が紐付いている",
    sql: "SELECT count(*)::int AS n FROM customer_linkages WHERE shopify_customer_id IS NOT NULL",
  },
  {
    key: "linkages_without_customer",
    label: "  うち Shopify 顧客が空 (LINE 単独)",
    sql: "SELECT count(*)::int AS n FROM customer_linkages WHERE shopify_customer_id IS NULL",
  },
  {
    key: "linkages_households",
    label: "N:1 世帯 (同一 Shopify 顧客に複数 LINE)",
    sql: `SELECT count(*)::int AS n FROM (
            SELECT shopify_customer_id
            FROM customer_linkages
            WHERE shopify_customer_id IS NOT NULL
            GROUP BY shopify_customer_id
            HAVING count(*) > 1
          ) t`,
  },
  {
    key: "linkages_household_members",
    label: "  その世帯に属する LINE 数の合計",
    sql: `SELECT coalesce(sum(c), 0)::int AS n FROM (
            SELECT count(*) AS c
            FROM customer_linkages
            WHERE shopify_customer_id IS NOT NULL
            GROUP BY shopify_customer_id
            HAVING count(*) > 1
          ) t`,
  },

  // --- user_identity_map (Web 側 = Login userId / session ↔ Shopify 顧客) ---
  {
    key: "identity_total",
    label: "user_identity_map 総数",
    sql: "SELECT count(*)::int AS n FROM user_identity_map",
  },
  {
    key: "identity_with_line_login",
    label: "  うち line_login_user_id あり",
    sql: "SELECT count(*)::int AS n FROM user_identity_map WHERE line_login_user_id IS NOT NULL",
  },
  {
    key: "identity_with_line_user",
    label: "  うち line_user_id あり",
    sql: "SELECT count(*)::int AS n FROM user_identity_map WHERE line_user_id IS NOT NULL",
  },
  {
    key: "identity_with_customer",
    label: "  うち shopify_customer_id あり",
    sql: "SELECT count(*)::int AS n FROM user_identity_map WHERE shopify_customer_id IS NOT NULL",
  },
  {
    key: "identity_distinct_unified",
    label: "  distinct unified_user_id",
    sql: "SELECT count(DISTINCT unified_user_id)::int AS n FROM user_identity_map",
  },

  // --- orphan (D4: 片側しか無い) ---
  {
    key: "orphan_messaging_only",
    label: "orphan: トーク側だけ (linkage あり / identity_map に同顧客なし)",
    sql: `SELECT count(*)::int AS n
          FROM customer_linkages cl
          WHERE cl.shopify_customer_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM user_identity_map uim
              WHERE uim.shopify_customer_id = cl.shopify_customer_id
            )`,
  },
  {
    key: "orphan_login_only",
    label: "orphan: Web 側だけ (identity_map あり / linkage に同顧客なし)",
    sql: `SELECT count(*)::int AS n
          FROM user_identity_map uim
          WHERE uim.shopify_customer_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM customer_linkages cl
              WHERE cl.shopify_customer_id = uim.shopify_customer_id
            )`,
  },
  {
    key: "bridged_both_sides",
    label: "両側そろっている顧客数 (D4 の橋が架かっている)",
    sql: `SELECT count(*)::int AS n FROM (
            SELECT DISTINCT cl.shopify_customer_id
            FROM customer_linkages cl
            JOIN user_identity_map uim
              ON uim.shopify_customer_id = cl.shopify_customer_id
            WHERE cl.shopify_customer_id IS NOT NULL
          ) t`,
  },
  {
    key: "identity_web_session_only",
    label: "identity_map: 顧客も LINE も無い行 (web_session だけ)",
    sql: `SELECT count(*)::int AS n
          FROM user_identity_map
          WHERE shopify_customer_id IS NULL
            AND line_user_id IS NULL
            AND line_login_user_id IS NULL`,
  },

  // --- D5 の前提確認: 現在の UNIQUE 制約の有無 ---
  {
    key: "unique_on_identity_customer",
    label: "user_identity_map.shopify_customer_id の単一列 UNIQUE 数 (D5 撤廃対象)",
    sql: `SELECT count(*)::int AS n
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
          WHERE nsp.nspname = 'public'
            AND rel.relname = 'user_identity_map'
            AND con.contype = 'u'
            AND att.attname = 'shopify_customer_id'
            AND array_length(con.conkey, 1) = 1`,
  },
  {
    key: "unique_on_linkage_customer",
    label: "customer_linkages.shopify_customer_id の単一列 UNIQUE 数 (027 で撤廃済みなら 0)",
    sql: `SELECT count(*)::int AS n
          FROM pg_constraint con
          JOIN pg_class rel ON rel.oid = con.conrelid
          JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
          JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
          WHERE nsp.nspname = 'public'
            AND rel.relname = 'customer_linkages'
            AND con.contype = 'u'
            AND att.attname = 'shopify_customer_id'
            AND array_length(con.conkey, 1) = 1`,
  },
];

function parseEnv(argv: string[]): TargetEnv {
  const i = argv.indexOf("--env");
  if (i === -1) return "prod";
  const value = argv[i + 1];
  if (value !== "prod" && value !== "staging") {
    console.error(`[ABORT] --env は prod|staging のみ (received: ${String(value)})`);
    process.exit(1);
  }
  return value;
}

function resolveConn(env: TargetEnv): { url?: string; password?: string } {
  return env === "staging"
    ? { url: process.env.SUPABASE_URL_STAGING, password: process.env.SUPABASE_DB_PASSWORD_STAGING }
    : { url: process.env.SUPABASE_URL, password: process.env.SUPABASE_DB_PASSWORD };
}

/** URL から project ref を取り出し、env の期待値と一致しなければ接続前に落とす。 */
function assertProjectRef(url: string, env: TargetEnv): string {
  const ref = new URL(url).hostname.split(".")[0];
  const expected = env === "prod" ? PROD_REF : STAGING_REF;
  if (ref !== expected) {
    console.error(`[ABORT] project ref '${ref}' != 期待 ${env} '${expected}'。接続せず中断。`);
    process.exit(1);
  }
  return ref;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const env = parseEnv(argv);
  const asJson = argv.includes("--json");

  const { url, password } = resolveConn(env);
  if (!url || !password) {
    console.error(
      `[ABORT] ${env} の SUPABASE_URL / SUPABASE_DB_PASSWORD が未設定 (.dev.vars を読み込んでください)`,
    );
    process.exit(1);
  }
  const ref = assertProjectRef(url, env);

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
  try {
    /* 二重の read-only。SELECT しか書いていないが、将来この関数を触る人が
     * うっかり書き込みを足したときに DB 側で止まるようにしておく。 */
    await client.query("SET default_transaction_read_only = on");

    const results: Record<string, number> = {};
    for (const q of QUERIES) {
      const { rows } = await client.query<{ n: number }>(q.sql);
      results[q.key] = rows[0]?.n ?? 0;
    }

    if (asJson) {
      console.log(JSON.stringify({ env, projectRef: ref, results }, null, 2));
      return;
    }

    console.log(`[identity] env=${env} project=${ref}`);
    for (const q of QUERIES) {
      console.log(`[identity] ${q.label.padEnd(62)}: ${results[q.key]}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[identity] inventory failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
