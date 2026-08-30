/**
 * DB 書込検査 — 消去が「列挙されたすべての置き場」に及ぶこと / 消した人が復活しないこと
 *
 * ─ 位置づけ ─
 *
 * 消去（GDPR）の正しさは 3 つに分かれ、それぞれ担当が違う。
 *
 *   (i)   列挙が置き場を取りこぼしていないか      … `cdp-invariants-readonly.db.test.ts`
 *                                                   （正本 DB に対して読み取りだけで確かめる）
 *   (ii)  列挙されたすべての表から本当に消えるか  … **このファイル**（書いてみないと言えない）
 *   (iii) 消したあと復活しないか                  … **このファイル**
 *
 * (ii)(iii) は行を作って消してみるしかない。よってこのファイルは **書ける環境でしか
 * 走らない**。2026-08-30 の運用変更で staging は凍結され本番が正本になったため、
 * 既定（`CDP_DB_TARGET` 未指定 = prod）では自動的に SKIP する。
 * **どの環境で書込検査を回すかは、実行時に Boss が `CDP_DB_TARGET` で指定する。**
 *
 * ─ 検査の芯 ─
 *
 * 表名をテストに書き写さない。`roji_person_key_map()` の列挙を **駆動側** にして
 * 残渣を数える。書き写すと、書き写した表しか見なくなり、「列挙に載ったのに
 * テストに足し忘れた表」がそのまま検査の外に落ちる（それは (i) が防ぐはずの穴を
 * (ii) 側に作り直すことになる）。
 *
 * ─ 安全 ─
 *   - 本番では走らない（`connectWritable` が prod を拒否して null を返す）。
 *   - 全体を 1 本のトランザクションで包み、**最後に必ず ROLLBACK** する。
 *     成功しても失敗しても 1 行も残らない。
 *   - 合成データは 'EREGTEST' 接頭辞。並行して走る他の作業のデータと衝突しない。
 *   - 外部送信ゼロ・実 LINE 送信ゼロ。
 *
 * 使用:
 *   CDP_DB_TARGET=<書ける環境> pnpm test:db:cdp-erasure-registry
 */

import dotenv from "dotenv";
import type pg from "pg";
import {
  assertEqual,
  assertTrue,
  connectWritable,
  createHarness,
  quoteIdent,
} from "./lib/cdp-db-target";

dotenv.config();
dotenv.config({ path: ".dev.vars" });

const h = createHarness();

/**
 * このテストが入れる値の目印。
 *
 * LINE userId は `delivery_identity_line_uid_form`（043）が `^U[0-9a-f]{32}$` を
 * 要求するので、目印は 16 進の範囲で作る。先頭の `ee9`（"erasure registry" の
 * 語呂）で他テスト・実データと見分ける。実在の userId とは衝突しない
 * （実 userId は LINE 側が発行する乱数で、この接頭辞を狙って作れない）。
 */
const STAMP = Date.now().toString(16);
const LINE_UID = `U${`ee9${STAMP}${"0".repeat(32)}`.slice(0, 32)}`;
const SHOPIFY_ID = `EREGTEST-${STAMP}`;

interface KeyMapRow {
  tbl: string;
  col: string;
}

async function main(): Promise<void> {
  const conn = await connectWritable();
  if (!conn) {
    // 書ける環境が無い。落とさずに終える（「検査が落ちた」と区別する）。
    process.exit(0);
  }

  const { client } = conn;
  try {
    await run(client);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await client.end().catch(() => undefined);
  }

  h.summary("cdp-erasure-registry.db.test");
}

async function run(client: pg.Client): Promise<void> {
  await client.query("BEGIN");

  const { SUBJ_A, SUBJ_B, IDEM } = await seed(client);

  // 列挙を駆動側にする。subject 系だけを取る（借りた鍵の側は既存の
  // roji-erasure.db.test.ts が全経路を見ている）。
  const { rows: keymap } = await client.query<KeyMapRow>(
    `SELECT tbl, col FROM roji_person_key_map() WHERE key_kind = 'subject' ORDER BY tbl, col`,
  );
  console.log(`  （列挙された subject 系の置き場: ${keymap.length} 列）`);

  await h.it(
    "0. 消す前に、列挙された置き場に本当に行がある（空を消して緑にしない）",
    async () => {
      let withRows = 0;
      for (const row of keymap) {
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${quoteIdent(row.tbl)}
            WHERE ${quoteIdent(row.col)} = ANY($1::text[])`,
          [[SUBJ_A, SUBJ_B]],
        );
        if (rows[0].n > 0) withRows++;
      }
      assertTrue(
        withRows >= 6,
        `合成データが列挙された置き場に届いていない（行のある列 ${withRows} / 期待 6 以上）。` +
          `これを確かめずに 1 を通すと「空だから消えている」を合格と読み違える`,
      );
    },
    client,
  );

  await h.it(
    "1. 消去は、列挙された subject 系の置き場すべてから行を消す",
    async () => {
      await client.query(`SELECT roji_erase_person('line', $1)`, [LINE_UID]);

      const leftovers: string[] = [];
      for (const row of keymap) {
        const { rows } = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${quoteIdent(row.tbl)}
            WHERE ${quoteIdent(row.col)} = ANY($1::text[])`,
          [[SUBJ_A, SUBJ_B]],
        );
        if (rows[0].n > 0) leftovers.push(`${row.tbl}.${row.col}=${rows[0].n}`);
      }
      assertTrue(leftovers.length === 0, `消し残りがある: ${leftovers.join(", ")}`);
    },
    client,
  );

  await h.it(
    "2. 主体は行ごと消えず、link の向こう側まで retire される",
    async () => {
      const { rows } = await client.query<{ n: number; retired: number }>(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE retired_at IS NOT NULL)::int AS retired
           FROM subjects WHERE subject_id = ANY($1::text[])`,
        [[SUBJ_A, SUBJ_B]],
      );
      assertEqual(rows[0].n, 2, "主体の行が消えている（外部キーを壊す）");
      assertEqual(rows[0].retired, 2, "link の向こう側の主体が retire されていない");
    },
    client,
  );

  await h.it(
    "3. 既存の残渣検査も clean と言う（列挙駆動の検査と食い違わない）",
    async () => {
      const { rows } = await client.query<{ r: { clean?: boolean } }>(
        `SELECT roji_erasure_residue(ARRAY[$1]::text[], ARRAY[$2]::text[], ARRAY[]::text[]) AS r`,
        [SHOPIFY_ID, LINE_UID],
      );
      assertEqual(rows[0].r.clean, true, `residue が clean でない: ${JSON.stringify(rows[0].r)}`);
    },
    client,
  );

  await h.it(
    "4. 退役した主体には、新しい出来事を結び付けられない（消した人が生き返らない）",
    async () => {
      // 失敗することを確かめる SQL は、それ専用の SAVEPOINT で包む。
      // 包まないと、失敗がトランザクション全体を abort させ、以降の SQL が
      // すべて "current transaction is aborted" になる — 実際に起きたことと
      // 後片付けの失敗が区別できなくなる。
      await client.query("SAVEPOINT sp_expect_reject");
      const r = await client
        .query(
          `INSERT INTO customer_events
             (subject_id, event_type, channel, occurred_at, source, idempotency_key, payload, schema_ok)
           VALUES ($1,'behavior.view_content','web', now(), 'test.erasure-registry', $2, '{}'::jsonb, true)`,
          [SUBJ_A, `${IDEM}:revive`],
        )
        .then(() => ({ ok: true }))
        .catch(() => ({ ok: false }));
      await client.query("ROLLBACK TO SAVEPOINT sp_expect_reject");
      assertTrue(!r.ok, "退役した主体に出来事を積めてしまった");
    },
    client,
  );

  await h.it(
    "5. 同じ冪等キーで来ても、退役した主体ではなく新しい主体に付く",
    async () => {
      // 消去で edge が消えているので、同じ LINE userId を再観測すると新しい主体が
      // 立つ。ここで古い主体に戻ると「消しました」が嘘になる。
      const { rows: fresh } = await client.query<{ subject_id: string }>(
        `INSERT INTO subjects (subject_id)
         VALUES (upper(substr(replace(gen_random_uuid()::text,'-',''),1,26)))
         RETURNING subject_id`,
      );
      const NEW_SUBJ = fresh[0].subject_id;
      assertTrue(NEW_SUBJ !== SUBJ_A, "消す前と同じ主体 ID が再発行された");

      await client.query(
        `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
         VALUES ($1,'line_messaging_uid',$2,'test.erasure-registry')`,
        [NEW_SUBJ, LINE_UID],
      );
      await client.query(
        `INSERT INTO customer_events
           (subject_id, event_type, channel, occurred_at, source, idempotency_key, payload, schema_ok)
         VALUES ($1,'behavior.view_content','web', now(), 'test.erasure-registry', $2, '{}'::jsonb, true)`,
        [NEW_SUBJ, IDEM],
      );

      const { rows: old } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM customer_events WHERE subject_id = ANY($1::text[])`,
        [[SUBJ_A, SUBJ_B]],
      );
      assertEqual(old[0].n, 0, "消したはずの主体に出来事が戻っている");

      const { rows: retired } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM subjects WHERE subject_id = $1 AND retired_at IS NOT NULL`,
        [SUBJ_A],
      );
      assertEqual(retired[0].n, 1, "退役が解除されている");
    },
    client,
  );

  await client.query("ROLLBACK");
  console.log("  [OK] ROLLBACK 完了（1 行も残していない）");
}

/**
 * 合成データを作る。LINE と Shopify を 1 本の link で結んだ 1 人を作り、
 * CDP の置き場すべてに行を置く。
 */
async function seed(client: pg.Client): Promise<{ SUBJ_A: string; SUBJ_B: string; IDEM: string }> {
  const { rows: subj } = await client.query<{ a: string; b: string }>(
    `WITH ins AS (
       INSERT INTO subjects (subject_id) VALUES
         (upper(substr(replace(gen_random_uuid()::text,'-',''),1,26))),
         (upper(substr(replace(gen_random_uuid()::text,'-',''),1,26)))
       RETURNING subject_id
     )
     SELECT min(subject_id) AS a, max(subject_id) AS b FROM ins`,
  );
  const SUBJ_A = subj[0].a;
  const SUBJ_B = subj[0].b;

  await client.query(
    `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
     VALUES ($1,'line_messaging_uid',$2,'test.erasure-registry'),
            ($3,'shopify_customer_id',$4,'test.erasure-registry')`,
    [SUBJ_A, LINE_UID, SUBJ_B, SHOPIFY_ID],
  );
  await client.query(
    `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
     VALUES ($1,$2,'liff_id_token','test.erasure-registry')`,
    [SUBJ_A, SUBJ_B],
  );

  const IDEM = `test.erasure-registry:${SUBJ_A}:behavior.view_content:${STAMP}`;
  await client.query(
    `INSERT INTO customer_events
       (subject_id, event_type, channel, occurred_at, source, idempotency_key, payload, schema_ok)
     VALUES ($1,'behavior.view_content','web', now(), 'test.erasure-registry', $2, '{}'::jsonb, true)`,
    [SUBJ_A, IDEM],
  );
  await client.query(
    `INSERT INTO delivery_identity (subject_id, line_user_id, source)
     VALUES ($1,$2,'test.erasure-registry')`,
    [SUBJ_A, LINE_UID],
  );
  await client.query(
    `INSERT INTO subject_profile (subject_id, persona_primary, event_count)
     VALUES ($1,'serenity',1)`,
    [SUBJ_A],
  );
  await client.query(
    `INSERT INTO subject_segment_state (subject_id, segment_key, in_segment, reason)
     VALUES ($1,'persona:serenity',true,'test')`,
    [SUBJ_A],
  );

  return { SUBJ_A, SUBJ_B, IDEM };
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
