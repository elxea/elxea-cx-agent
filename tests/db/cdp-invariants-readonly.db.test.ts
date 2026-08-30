/**
 * DB 読み取り専用検査 — CDP の配線が「正本の DB に実際に在る」ことの実測
 *
 * ─ 位置づけ（2026-08-30 の運用変更を受けて）─
 *
 * staging は凍結され、**本番が正本**になった（未リリース状態なので、本番が唯一の
 * 実物である）。書き込みを伴う検査は本番では走らせられない。しかし
 * 「migration が当たっているか」「トリガと一意制約が生きているか」
 * 「消去の列挙が置き場を取りこぼしていないか」は **読むだけで確かめられる**。
 *
 * このファイルはその読める部分を全部読む。書き込み側の挙動は
 *   - ハーメティック（`tests/hermetic/**`・インメモリ）… 応答と分岐の挙動
 *   - 書込検査（`cdp-erasure-registry.db.test.ts` ほか）… 実行環境を Boss が実行時に指定
 * が担当する。3 つで 1 セットになる。
 *
 * ─ なぜ「在ることの実測」に意味があるか ─
 *
 * 追記専用（E4）も、1 鍵 = 1 主体も、消去の自動列挙も、**すべて DB の中にしかない**。
 * TypeScript を読んでも「トリガが張られている」ことは分からず、migration ファイルが
 * リポジトリに在ることも「当たっている」ことを意味しない（deploy-prod.yml は
 * 適用する migration を人が明示指定する形なので、当て忘れが構造的に起こりうる）。
 * 当て忘れは **何も壊れず、ただ守りが無い状態**を作る。いちばん静かな壊れ方である。
 *
 * ─ 検査 ─
 *
 *   A. 置き場の国勢調査 — 人を指していそうな表は、消去の列挙に載っているか、
 *      載せない理由が宣言されているかのどちらか（統合設計 §3-3 の R10' (b)）
 *   B. CDP の置き場が 1 つ残らず列挙に載っている（逆向きの確認）
 *   C. 追記専用（E4）の配線が在る — トリガ・ガード関数・消去の例外
 *   D. 「1 鍵 = 1 主体」ほかの一意制約が在る（MID-1 の是正が生きているか）
 *   E. 設計が要求する SQL 関数が在る（migration の当て忘れ検知）
 *   F. 正本の健全性 — 退役した主体に紐づく行が 1 行も無い（消し残りゼロの実測）
 *
 * ─ 安全 ─
 *   - 接続は **読み取り専用**（`connectReadOnly` が `default_transaction_read_only=on`
 *     を張る）。書き込み SQL は Postgres 側が 25006 で拒否する。
 *   - 合成データを 1 行も作らない。他の作業（並行 worker の実証等）に一切干渉しない。
 *   - 個人を特定する値を 1 つも出力しない（出すのは件数と表名・関数名だけ）。
 *
 * 使用:
 *   pnpm test:db:cdp-invariants                    # 既定 = 本番（読み取り専用）
 *   CDP_DB_TARGET=staging pnpm test:db:cdp-invariants
 */

import dotenv from "dotenv";
import type pg from "pg";
import {
  assertEqual,
  assertTrue,
  connectReadOnly,
  createHarness,
  quoteIdent,
  resolveTarget,
} from "./lib/cdp-db-target";

dotenv.config();
dotenv.config({ path: ".dev.vars" });

const h = createHarness();

/**
 * 「人を指していそうな列」を拾う広い網。
 *
 * `roji_person_key_map()` の語彙（完全一致 8 個）より **わざと広く** 取る。狭い網で
 * 探すと、語彙に無い列名で作られた置き場（＝ まさに取りこぼしている置き場）が
 * 網にも掛からず、検査が「取りこぼしゼロ」と報告してしまう。
 */
const WIDE_NET =
  "(subject|person|line_user|login_user|customer_id|session|user_id|user_ref|email_hash|anonymous|unified_user)";

/**
 * 網には掛かるが、消去の列挙に **載っていなくてよい** 表とその理由。
 *
 * ここに 1 行足すことは「この置き場には本人の記録が残る（または人を指していない）」
 * という申告である。理由を書けないものは足せない。判断の正本は
 * roji カルテ図2「本人が記録を消したとき何が消えて何が残るか」
 * https://www.notion.so/3b570c9d064c81669025cdbe1064b12c
 */
const ACCOUNTED_FOR: Record<string, string> = {
  // ─ 人を指していない（列名だけが似ている偽陽性）─
  probe_history: "persona 列は好みタイプのラベル（serenity 等）であって人を指さない。ナレッジ検査の記録",
  regression_tests: "同上。persona 列は検査ケースのラベル",

  // ─ 人を指すが、図2 で「残る」と決めたもの（042 の除外表と同じ判断）─
  roji_words: "匿名の言葉（本人向け文面3）。person_seq の CASCADE でのみ消える。列名一致で消すと二重管理になる",
  roji_word_person_refs: "同上。roji_words の CASCADE で消える",
  roji_word_persons:
    "roji の人の台帳。person_seq を主キーに持ち、roji_resolve_identity が person_seqs として解決してから消す（列名語彙ではなく解決の輪の側で扱う）",
  roji_edit_records: "編むのにかかった手間（本人向け文面2）。人に辿り着けない形で残す",
  roji_delivery_months: "月の締め（集計）",
  conversation_daily_stats: "日次集計",
  line_message_ledger: "配信の集計値",
  // 注: 042 の除外表には broadcast_stats も入っているが、正本の DB に
  //     その名前の **実表** は無い（ビューか、名前が変わっている）。実表が無い以上
  //     「消去外でよい置き場」として宣言する対象ではないので、ここには載せない。
  //     A' の死蔵検査がこれを検出して分かった。

  // ─ 主体そのもの ─
  subjects:
    "行は消さず retired_at を立てる（040 の設計）。customer_events / identity_edges からの FK を壊さないため。消えたことは F が実測する",
};

interface KeyMapRow {
  tbl: string;
  col: string;
  key_kind: string;
}

/** CDP が置いた「人の記録の置き場」。列挙から抜けたら消去が届かない。 */
const CDP_STORES = [
  "customer_events",
  "identity_edges",
  "subject_links",
  "delivery_identity",
  "subject_profile",
  "subject_segment_state",
] as const;

/** 追記専用（E4）と退役拒否の配線。名前と対象表を対にして実測する。 */
const REQUIRED_TRIGGERS: Array<{ table: string; trigger: string; why: string }> = [
  { table: "identity_edges", trigger: "identity_edges_append_only", why: "E4: 連携は書き換えない" },
  { table: "subject_links", trigger: "subject_links_append_only", why: "E4: 連携は書き換えない" },
  { table: "customer_events", trigger: "customer_events_append_only", why: "E4: 出来事は書き換えない" },
  { table: "subjects", trigger: "subjects_append_only", why: "E4: 主体は消去経路以外から変えない" },
  { table: "customer_events", trigger: "customer_events_no_retired", why: "消した人に出来事を足せない" },
  { table: "identity_edges", trigger: "identity_edges_no_retired", why: "消した人に鍵を足せない" },
  { table: "subject_links", trigger: "subject_links_no_retired", why: "消した人を結べない" },
  { table: "subject_profile", trigger: "subject_profile_no_retired", why: "消した人の解釈を作れない" },
  { table: "subject_segment_state", trigger: "subject_segment_state_no_retired", why: "消した人を配信対象にしない" },
  { table: "subject_links", trigger: "subject_links_j4", why: "J-4: 1 人に 2 本目の LINE を結ばない" },
];

/** 設計が要求する SQL 関数。当て忘れるとコード側は静かに縮退する。 */
const REQUIRED_FUNCTIONS: Array<{ name: string; why: string }> = [
  { name: "cdp_erasure_context_active", why: "E4 の例外表（消去経路だけが書き換えられる）の判定" },
  { name: "cdp_append_only_guard", why: "E4 のトリガ本体" },
  { name: "cdp_canonical_subject", why: "Stage 2: 連結成分から代表主体を出す" },
  { name: "cdp_canonical_identifiers", why: "★11: 横断読み出しが引く鍵の集合" },
  { name: "cdp_stage2_parity", why: "新旧一致の日次観測" },
  { name: "cdp_stage2_backfill_candidates", why: "旧台帳からの写し取り（047）" },
  { name: "cdp_l0_daily_counts", why: "E8': L0 二重物理の日次件数突合" },
  { name: "cdp_subject_shopify_map", why: "解析側の persons.subject_id 1:1" },
  { name: "cdp_l1_build_profile", why: "L1 の唯一の畳み方の定義" },
  { name: "cdp_l1_recompute_parity", why: "E8': 保存した解釈と畳み直しの一致" },
  { name: "cdp_l1_derive_delivery_identity", why: "配信の宛先の派生" },
  { name: "cdp_segment_line_targets", why: "T-11: 全件スキャン 3 本の置き換え先" },
  { name: "cdp_l1_exclusions_by_shopify", why: "「もういらない」が配信に効く経路" },
  { name: "roji_person_key_map", why: "消去の列挙（R10'）" },
  { name: "roji_resolve_identity", why: "消去の解決の輪" },
  { name: "roji_erase_person", why: "消去の本体" },
  { name: "roji_erasure_residue", why: "消し残りの検算" },
];

/** 一意制約。無くなると「1 鍵 = 1 主体」も冪等キーも黙って破れる。 */
const REQUIRED_UNIQUE: Array<{ index: string; table: string; columns: string[]; why: string }> = [
  {
    index: "identity_edges_uniq",
    table: "identity_edges",
    columns: ["identifier_kind", "identifier_value"],
    why: "MID-1 の是正: 1 鍵 = 1 主体。3 列だった頃は同じ鍵に別の主体が付けられた",
  },
  {
    index: "delivery_identity_line_uid",
    table: "delivery_identity",
    columns: ["line_user_id"],
    why: "1 つの LINE が 2 人の宛先にならない",
  },
];

async function main(): Promise<void> {
  const target = resolveTarget();
  const client = await connectReadOnly(target);

  try {
    await runCensus(client);
    await runWiring(client);
    await runHealth(client, target.isProd);
  } finally {
    await client.end().catch(() => undefined);
  }

  h.summary(`cdp-invariants-readonly.db.test (target=${target.name})`);
}

// --- A / B. 置き場の国勢調査 -----------------------------------------------------

async function runCensus(client: pg.Client): Promise<void> {
  console.log("\n--- A / B. 置き場の国勢調査（消去が取りこぼしていないか）---");

  const { rows: enumerated } = await client.query<KeyMapRow>(
    `SELECT tbl, col, key_kind FROM roji_person_key_map() ORDER BY tbl, col`,
  );
  const enumeratedTables = new Set(enumerated.map((r) => r.tbl));

  const { rows: wide } = await client.query<{ tbl: string; cols: string }>(
    `SELECT c.table_name::text AS tbl,
            string_agg(c.column_name::text, ', ' ORDER BY c.column_name) AS cols
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema
        AND t.table_name   = c.table_name
        AND t.table_type   = 'BASE TABLE'
      WHERE c.table_schema = 'public'
        AND c.column_name ~ $1
      GROUP BY c.table_name
      ORDER BY 1`,
    [WIDE_NET],
  );

  console.log(`  （消去の列挙 ${enumeratedTables.size} 表 / 広い網 ${wide.length} 表）`);

  await h.it("A. 人を指していそうな表は、消去に載っているか、載せない理由が宣言されている", async () => {
    const unaccounted = wide
      .filter((r) => !enumeratedTables.has(r.tbl) && !(r.tbl in ACCOUNTED_FOR))
      .map((r) => `${r.tbl} (${r.cols})`);

    assertTrue(
      unaccounted.length === 0,
      `消去の列挙にも申告にも無い置き場がある:\n    - ${unaccounted.join("\n    - ")}\n` +
        `  対処: (1) 列名を roji_person_key_map の語彙に合わせて消去に載せる、または\n` +
        `        (2) ACCOUNTED_FOR に理由を書いて「残す」と申告する`,
    );
  });

  await h.it("A'. 申告が死蔵していない（もう存在しない表の枠を残していない）", async () => {
    // 「死蔵」の定義は **表がもう存在しない** こと。「網に掛からなくなった」ではない。
    //
    // 042 の除外表と同じく、いま人を指す列を持っていない表を先回りで宣言しておくのは
    // 妥当である（あとで列が増えたときに既に申告済みになる）。一方、表ごと消えたのに
    // 申告だけ残っているのは「その名前の表なら消去外でよい」という枠を将来に向けて
    // 開けたままにすることであり、これは締めるべき緩みである。
    const { rows: existing } = await client.query<{ tbl: string }>(
      `SELECT table_name::text AS tbl FROM information_schema.tables
        WHERE table_schema='public' AND table_type='BASE TABLE'`,
    );
    const existingTables = new Set(existing.map((r) => r.tbl));
    const stale = Object.keys(ACCOUNTED_FOR).filter((t) => !existingTables.has(t));
    assertTrue(
      stale.length === 0,
      `ACCOUNTED_FOR に、もう存在しない表が残っている: ${stale.join(", ")}。` +
        `古い申告を残すと「その名前の表なら消去外でよい」という枠が黙って生き続ける`,
    );
  });

  for (const tbl of CDP_STORES) {
    await h.it(`B. ${tbl} が消去の列挙に載っている`, async () => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name=$1`,
        [tbl],
      );
      assertEqual(rows[0].n, 1, `${tbl} がこの DB に存在しない（migration の当て忘れ）`);
      assertTrue(enumeratedTables.has(tbl), `${tbl} が roji_person_key_map() の列挙に無い`);
    });
  }

  await h.it("B'. subjects は列挙から外れている（行を消さず retired_at を立てるため）", async () => {
    assertTrue(
      !enumeratedTables.has("subjects"),
      "subjects が列挙に入っている。行ごと消すと customer_events / identity_edges の FK が壊れる",
    );
  });
}

// --- C / D / E. 配線が在るか -----------------------------------------------------

async function runWiring(client: pg.Client): Promise<void> {
  console.log("\n--- C / D / E. 配線が正本の DB に在るか（migration の当て忘れ検知）---");

  for (const t of REQUIRED_TRIGGERS) {
    await h.it(`C. トリガ ${t.table}.${t.trigger} が在る（${t.why}）`, async () => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pg_trigger g
           JOIN pg_class c ON c.oid = g.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relname = $1
            AND g.tgname  = $2
            AND NOT g.tgisinternal`,
        [t.table, t.trigger],
      );
      assertEqual(rows[0].n, 1, `トリガが無い。${t.why} が効いていない`);
    });
  }

  for (const u of REQUIRED_UNIQUE) {
    await h.it(`D. 一意制約 ${u.index} が (${u.columns.join(", ")}) で在る（${u.why}）`, async () => {
      const { rows } = await client.query<{ cols: string[]; isuniq: boolean }>(
        `SELECT array_agg(a.attname::text ORDER BY k.ord) AS cols, bool_and(ix.indisunique) AS isuniq
           FROM pg_index ix
           JOIN pg_class  ic ON ic.oid = ix.indexrelid
           JOIN pg_class  tc ON tc.oid = ix.indrelid
           JOIN pg_namespace ns ON ns.oid = tc.relnamespace
           CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = k.attnum
          WHERE ns.nspname = 'public' AND tc.relname = $1 AND ic.relname = $2
          GROUP BY ic.relname`,
        [u.table, u.index],
      );
      assertTrue(rows.length === 1, `索引 ${u.index} が無い`);
      assertTrue(rows[0].isuniq, `${u.index} が一意索引でない`);
      assertEqual(
        rows[0].cols.join(","),
        u.columns.join(","),
        `${u.index} の列が違う。${u.why}`,
      );
    });
  }

  await h.it("D'. customer_events.idempotency_key が一意（二重加算の構造的な止め）", async () => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_index ix
         JOIN pg_class tc ON tc.oid = ix.indrelid
         JOIN pg_namespace ns ON ns.oid = tc.relnamespace
         CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = tc.oid AND a.attnum = k.attnum
        WHERE ns.nspname='public' AND tc.relname='customer_events'
          AND ix.indisunique AND a.attname='idempotency_key'
          AND array_length(ix.indkey, 1) = 1`,
    );
    assertTrue(rows[0].n >= 1, "idempotency_key に単一列の一意索引が無い。同じ注文が 2 回加算されうる");
  });

  await h.it("D''. customer_events.subject_id が NOT NULL + FK（E3: 事実は必ず誰かの事実）", async () => {
    const { rows: nn } = await client.query<{ notnull: boolean }>(
      `SELECT a.attnotnull AS notnull
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relname='customer_events' AND a.attname='subject_id'`,
    );
    assertTrue(nn.length === 1 && nn[0].notnull, "customer_events.subject_id が NOT NULL でない");

    const { rows: fk } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_constraint co
         JOIN pg_class c ON c.oid = co.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relname='customer_events' AND co.contype='f'`,
    );
    assertTrue(fk[0].n >= 1, "customer_events に外部キーが無い（subjects への参照が切れている）");
  });

  for (const f of REQUIRED_FUNCTIONS) {
    await h.it(`E. 関数 ${f.name} が在る（${f.why}）`, async () => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname = $1`,
        [f.name],
      );
      assertTrue(rows[0].n >= 1, `関数が無い。migration の当て忘れ — ${f.why}`);
    });
  }

  await h.it("E'. 消去の例外表は roji_erase_person だけが開ける（set_config の持ち主が 1 つ）", async () => {
    // 数えるのは **例外を開ける側（setter）** だけ。`app.erasure_context` に触れる
    // 関数を全部数えると、読む側（cdp_erasure_context_active）とその呼び出し側
    // （cdp_append_only_guard）まで混ざる — 読む側が増えるのは危険ではない。
    // 危険なのは「消去以外の関数が例外を開けられる」ことなので、set_config を
    // 呼んでいるものだけを数える。
    //
    // prokind='f'（通常の関数）に絞るのは、集約関数に pg_get_functiondef を当てると
    // "is an aggregate function" で落ち、走査そのものが失敗するため。走査が落ちると
    // 「数えられなかった」と「1 つだった」が区別できなくなる。
    const { rows } = await client.query<{ proname: string }>(
      `SELECT p.proname::text
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public'
          AND p.prokind = 'f'
          AND pg_get_functiondef(p.oid) ILIKE '%set_config(''app.erasure_context''%'
        ORDER BY 1`,
    );
    const owners = rows.map((r) => r.proname);
    assertEqual(
      owners.join(","),
      "roji_erase_person",
      `E4 の例外表を開ける関数が想定と違う: [${owners.join(", ")}]。` +
        `消去以外の経路が例外を開けられると、追記専用は名ばかりになる`,
    );
  });
}

// --- F. 正本の健全性 -------------------------------------------------------------

async function runHealth(client: pg.Client, isProd: boolean): Promise<void> {
  console.log(`\n--- F. ${isProd ? "本番（正本）" : "対象 DB"} の健全性（観測）---`);

  const { rows: keymap } = await client.query<KeyMapRow>(
    `SELECT tbl, col, key_kind FROM roji_person_key_map() WHERE key_kind = 'subject' ORDER BY tbl, col`,
  );

  await h.it("F-1. 退役した主体に紐づく行が 1 行も残っていない（消し残りゼロの実測）", async () => {
    const leftovers: string[] = [];
    for (const row of keymap) {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM ${quoteIdent(row.tbl)} t
           JOIN subjects s ON s.subject_id = t.${quoteIdent(row.col)}
          WHERE s.retired_at IS NOT NULL`,
      );
      if (rows[0].n > 0) leftovers.push(`${row.tbl}.${row.col}=${rows[0].n}`);
    }
    assertTrue(
      leftovers.length === 0,
      `消したはずの人の記録が残っている: ${leftovers.join(", ")}。` +
        `消去が途中で止まったか、列挙から漏れた経路がある`,
    );
  });

  await h.it("F-2. 主体を持たない事実の行が無い（E3 が実データでも成立している）", async () => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM customer_events e
         LEFT JOIN subjects s ON s.subject_id = e.subject_id
        WHERE s.subject_id IS NULL`,
    );
    assertEqual(rows[0].n, 0, "customer_events に、対応する主体が無い行がある（孤児）");
  });

  await h.it("F-3. 1 つの鍵が 2 人の主体に結ばれていない（1 鍵 = 1 主体が実データでも成立）", async () => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT identifier_kind, identifier_value
           FROM identity_edges
          GROUP BY 1,2 HAVING count(DISTINCT subject_id) > 1
       ) x`,
    );
    assertEqual(rows[0].n, 0, "同じ鍵が複数の主体に結ばれている（別人の履歴が混ざる）");
  });

  await h.it("F-4. subject_links は正規化された向きだけを持つ（無向辺が 2 通りに増えていない）", async () => {
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM subject_links WHERE subject_a >= subject_b`,
    );
    assertEqual(rows[0].n, 0, "subject_a < subject_b に正規化されていない行がある");
  });

  // 観測値。合否は付けない（数そのものは日々変わる）。表に残すことで
  // 「空の DB を検査して緑」を後から見分けられるようにする。
  const { rows: counts } = await client.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM subjects)                                   AS subjects,
       (SELECT count(*) FROM subjects WHERE retired_at IS NOT NULL)      AS subjects_retired,
       (SELECT count(*) FROM identity_edges)                             AS identity_edges,
       (SELECT count(*) FROM subject_links)                              AS subject_links,
       (SELECT count(*) FROM customer_events)                            AS customer_events,
       (SELECT count(*) FROM customer_events WHERE schema_ok = false)    AS l0_schema_not_ok,
       (SELECT count(*) FROM subject_profile)                            AS subject_profile,
       (SELECT count(*) FROM subject_segment_state)                      AS subject_segment_state,
       (SELECT count(*) FROM delivery_identity)                          AS delivery_identity,
       (SELECT count(*) FROM customer_linkages)                          AS customer_linkages_legacy,
       (SELECT count(*) FROM user_identity_map)                          AS user_identity_map_legacy`,
  );
  console.log("  [OBSERVE] 件数（合否なし・空の DB を緑と読み違えないための記録）:");
  for (const [k, v] of Object.entries(counts[0])) console.log(`            ${k.padEnd(26)} ${v}`);
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
