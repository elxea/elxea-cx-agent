/**
 * 配送台帳への手動投入 — `npx tsx scripts/record-delivery.ts --file <path>`
 *
 * 仕様の正本: elxea CX Agent機能定義 v1.5
 *   https://www.notion.so/3b970c9d064c81ddb60ff08c23152929  3-2 / 第5節 タスク9
 * 器: `src/db/migrations/038_tea_delivery_ledger.sql`（本スクリプトは DDL を実行しない）
 * 規則の本体: `src/lib/delivery-ledger.ts`（純粋）＋ DB 関数 `record_tea_deliveries`
 *
 * ─ なぜ手動経路が要るか ─
 *   EC はまだ開店しておらず、Shopify 注文 webhook から流れてくる記録がまだ無い。
 *   一方でこの記録は**過去に遡って作れない**（書かなかった月は永久に空欄）。
 *   マルシェの手渡し・EC 開店前の実配送を、今月分から人手で書き始めるための口。
 *
 * ─ 安全 ─
 *   - **送信を一切行わない**（LINE / メール / Slack のクライアントを 1 つも import しない）。
 *   - **既定は dry-run**。実際に書くのは `--apply` を明示したときだけ。
 *   - 接続先を HARD ASSERT（既定 staging。prod は `--env prod` の明示が必要）。
 *   - 追加と「より確かな日付での更新」だけ。DELETE を 1 度も実行しない。
 *   - 氏名・住所・メールを画面にも台帳にも出さない（鍵は顧客番号 / LINE の ID まで）。
 *
 * ─ 入力ファイルの形（JSON・配列）─
 *   [
 *     {
 *       "lineUserId": "U....",              // または "shopifyCustomerId": "123456"
 *       "deliveredOn": "2026-08-05",
 *       "sourceRef": "marche-2026-08-05",   // 出所の根拠（再実行の鍵）
 *       "note": "マルシェで手渡し",
 *       "items": [
 *         { "itemRef": "roji-sencha-01", "itemName": "煎茶 やぶきた", "itemKind": "tea", "quantity": 1 }
 *       ]
 *     }
 *   ]
 *
 * 使用:
 *   npx tsx scripts/record-delivery.ts --file data/deliveries.json                 # staging・dry-run
 *   npx tsx scripts/record-delivery.ts --file data/deliveries.json --apply         # staging へ書く
 *   npx tsx scripts/record-delivery.ts --file data/deliveries.json --env prod --apply  # 本番（要 Setaka 承認）
 */

import { readFileSync } from "node:fs";

import dotenv from "dotenv";
import pg from "pg";

import {
  buildManualDeliveryRecords,
  toLedgerPayload,
  type DeliveryRecord,
  type ManualDeliveryInput,
} from "../src/lib/delivery-ledger";

dotenv.config({ quiet: true });
dotenv.config({ path: ".dev.vars", quiet: true });

const PROD_REF = "bquqzrbzdzjegdovxalu";
const STAGING_REF = "espeokdhutgztksdrpzt";

const argv = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
/** 既定は staging（本番は明示しないと触れない）。 */
const targetEnv: "prod" | "staging" = (argValue("--env") as "prod" | "staging") ?? "staging";
const apply = argv.includes("--apply");
const file = argValue("--file");

function fail(msg: string): never {
  console.error(`[record-delivery] ${msg}`);
  process.exit(1);
}

/** 接続先が意図した env かを ref で HARD ASSERT する（migrate.ts と同じ姿勢）。 */
function assertRef(url: string): string {
  const ref = new URL(url).hostname.split(".")[0];
  if (targetEnv === "staging" && (ref !== STAGING_REF || ref === PROD_REF)) {
    fail(`--env staging を指定したが接続先が staging ではない（ref=${ref}）。中断する。`);
  }
  if (targetEnv === "prod" && ref !== PROD_REF) {
    fail(`--env prod を指定したが接続先が本番ではない（ref=${ref}）。中断する。`);
  }
  return ref;
}

async function main() {
  if (!file) fail("--file <path> が必要（投入する JSON のパス）");

  const raw = readFileSync(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`JSON として読めない: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) fail("入力は配列で書く（1 要素 = 1 回の配送）");

  // 検証は書き込みの前に全件通す（半分だけ書かれた状態を作らない）。
  const rows: DeliveryRecord[] = [];
  (parsed as ManualDeliveryInput[]).forEach((input, i) => {
    try {
      rows.push(...buildManualDeliveryRecords(input));
    } catch (err) {
      fail(`${i + 1} 件目: ${(err as Error).message}`);
    }
  });

  console.log(`[record-delivery] env=${targetEnv} apply=${apply} 配送 ${(parsed as unknown[]).length} 回 / 明細 ${rows.length} 行`);
  for (const r of rows) {
    const who = r.shopifyCustomerId ? `ec:${r.shopifyCustomerId}` : `line:${r.lineUserId?.slice(0, 6)}…`;
    console.log(`  ${r.deliveredOn}  ${who}  ${r.itemRef} x${r.quantity}  [${r.itemKind}] (${r.sourceRef}#${r.sourceLineRef})`);
  }

  if (!apply) {
    console.log("[record-delivery] dry-run のため 1 行も書いていない（書くには --apply）");
    return;
  }

  const url = process.env.SUPABASE_URL;
  if (!url) fail("SUPABASE_URL が未設定");
  const ref = assertRef(url);
  const password = process.env.SUPABASE_DB_PASSWORD;
  if (!password) fail("SUPABASE_DB_PASSWORD が未設定");

  const client = new pg.Client({
    host: `db.${ref}.supabase.co`,
    port: 5432,
    database: "postgres",
    user: "postgres",
    password,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const res = await client.query("SELECT record_tea_deliveries($1::jsonb) AS result", [
      JSON.stringify(toLedgerPayload(rows)),
    ]);
    console.log("[record-delivery] 結果:", JSON.stringify(res.rows[0].result));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("[record-delivery] 失敗:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
