/**
 * roji 最初のアンケート — 安全に関する申告（項目6）があった人の一覧。
 *
 * ## なぜこれが要るか
 *
 * 2026-08-08 の Setaka の決定により、**カフェインが苦手 / 妊娠中・授乳中 と申告した人は
 * 自動の割当から外し、人が個別に決める**ことになった（販売中の銘柄はすべて茶葉のお茶で、
 * カフェインレスの商品が 1 つも無いため）。
 *
 * 「人が個別に決める」を選んだ以上、**申告があったことに誰かが気づけないと、その人には何も届かない**。
 * この一覧が、その「気づく」ための唯一の経路。**外部送信は一切しない**（見に行けば分かる形にする）。
 *
 * ## 使いどころ（運用の決めごと）
 *
 * **創刊号を編む前に、必ず 1 回実行して申告のある人を確認する。** 詳細は
 * `docs/deploy-runbook.md` の「roji 最初のアンケート — 安全の申告に気づく」を参照。
 *
 * ## 何を読むか
 *
 * 出来事の置き場（`flow_events`・項目31）の `survey.answer` / step=`q5` を読む。
 * カルテ（Firestore）ではなく出来事の置き場を正とする理由は 2 つ:
 *   - 出来事の置き場は **1 問ごとにその場で書かれる**ので、途中でやめた人の申告も必ず残る
 *   - カルテ側は Firestore で、まとめて串刺しに数えるのに向かない
 *
 * ## 安全
 *
 * - **読み取り専用**。INSERT / UPDATE / DELETE を 1 度も実行しない。
 * - LINE API を 1 度も呼ばない（通知は作らない・送らない）。
 * - `--summary` を付けると**件数だけ**を出す（人の識別子を画面に出さない）。報告や共有に使うときはこちら。
 *   識別子まで要るのは「実際にその人の号を編むとき」だけなので、既定を summary にはせず、
 *   **人に見せる用途では明示的に `--summary` を選ぶ**運用にする。
 *
 * 使用:
 *   npx tsx scripts/roji-safety-declarations.ts                  # 本番・申告のある人の一覧
 *   npx tsx scripts/roji-safety-declarations.ts --summary        # 本番・件数だけ
 *   npx tsx scripts/roji-safety-declarations.ts --env staging    # staging
 */

import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ quiet: true });
dotenv.config({ path: ".dev.vars", quiet: true });

const PROD_REF = "bquqzrbzdzjegdovxalu";
const STAGING_REF = "espeokdhutgztksdrpzt";

const env: "prod" | "staging" = process.argv.includes("--env")
  ? (process.argv[process.argv.indexOf("--env") + 1] as "prod" | "staging")
  : "prod";
const summaryOnly = process.argv.includes("--summary");

/**
 * 人が個別に決める必要がある申告（Setaka 決定 2026-08-08）。
 *   - caffeine_sensitive  : カフェインが苦手 → カフェインレスの在庫が無いので人が決める
 *   - pregnant_or_nursing : 妊娠中・授乳中   → 同上
 * `allergy`（アレルギーがある）は **除外処理そのものが不要**（30 銘柄すべて茶葉のみと確定したため）。
 * ただし申告は記録として残り、この一覧にも「参考」として出す（見落としを作らないため）。
 */
const NEEDS_HUMAN = new Set(["caffeine_sensitive", "pregnant_or_nursing"]);
const LABELS: Record<string, string> = {
  caffeine_sensitive: "カフェインが苦手",
  pregnant_or_nursing: "妊娠中・授乳中",
  allergy: "アレルギーがある",
  none: "特にない",
};

function resolve(): { url?: string; password?: string; ref: string } {
  return env === "staging"
    ? {
        url: process.env.SUPABASE_URL_STAGING,
        password: process.env.SUPABASE_DB_PASSWORD_STAGING,
        ref: STAGING_REF,
      }
    : { url: process.env.SUPABASE_URL, password: process.env.SUPABASE_DB_PASSWORD, ref: PROD_REF };
}

async function main() {
  const { url, password, ref: expected } = resolve();
  if (!url || !password) {
    console.error(`[FATAL] ${env} の接続情報が未設定。中断。`);
    process.exit(1);
  }
  const ref = new URL(url).hostname.split(".")[0];
  if (ref !== expected) {
    console.error(`[ABORT] ${env} 指定だが ref='${ref}'。接続せず中断。`);
    process.exit(1);
  }
  console.log(`[assert] project ref = ${ref} (env=${env}) / 読み取り専用`);

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
    // 同じ人が同じ申告を 2 度押しても 1 行にまとめる（最初に押した日時を残す）。
    const { rows } = await client.query<{
      user_ref: string;
      value: string;
      first_at: string;
    }>(
      `select user_ref, value, min(created_at)::text as first_at
         from flow_events
        where event_name = 'survey.answer'
          and step = 'q5'
          and value is not null
        group by user_ref, value
        order by min(created_at) asc`,
    );

    const needing = rows.filter((r) => NEEDS_HUMAN.has(r.value));
    const byPerson = new Map<string, string[]>();
    for (const r of needing) {
      byPerson.set(r.user_ref, [...(byPerson.get(r.user_ref) ?? []), r.value]);
    }

    console.log(`\n===== 安全に関する申告（項目6）@ ${new Date().toISOString()} =====`);
    console.log(`  人が個別に決める必要がある人: ${byPerson.size} 人`);
    for (const slug of ["caffeine_sensitive", "pregnant_or_nursing", "allergy", "none"]) {
      const n = rows.filter((r) => r.value === slug).length;
      const note = slug === "allergy" ? "（茶葉のみ確定のため除外処理は不要・記録のみ）" : "";
      console.log(`    ${LABELS[slug]}: ${n} 件${note}`);
    }

    if (byPerson.size === 0) {
      console.log("\n  対応が要る人はいません。");
      return;
    }

    if (summaryOnly) {
      console.log("\n  （--summary のため識別子は出しません。編むときは --summary 無しで実行）");
      return;
    }

    console.log("\n  [対応が要る人]（この人たちは自動の割当から外し、人が決める）");
    for (const [userRef, slugs] of byPerson) {
      const first = needing.find((r) => r.user_ref === userRef)?.first_at ?? "";
      console.log(`    ${userRef} | ${slugs.map((s) => LABELS[s]).join(" / ")} | 初回 ${first}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
