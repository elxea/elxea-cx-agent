/**
 * DB Round-trip Tests — L1（解釈）とセグメント配信の SQL 化（CDP 統合 Stage 4）
 *
 * ここで実 DB を使う理由は 1 つ: **Stage 4 の判断は SQL の中にしかない**。
 *
 *   1. 046 … L0 を畳んで L1 を作る規則（cdp_l1_build_profile）
 *   2. 046 … 内訳の和が合計を超えないこと（CHECK 制約）
 *   3. 046 … 保存値と再計算値が一致すること（E8' / cdp_l1_recompute_parity）
 *   4. 046 … セグメント配信の宛先（cdp_segment_line_targets）と除外の実効
 *   5. 042/043/046 … 消去が L1 まで届くこと（residue clean）
 *
 * TypeScript 側はこれらを呼んでログに落とすだけなので、モックで固めても
 * 「モックが素通しした」を確かめることにしかならない。
 *
 * ─ 安全 ─
 *   - 接続先は **staging のみ**（project ref を HARD ASSERT。本番 ref なら接続せず中断）。
 *   - すべて 1 本のトランザクション内で行い、**最後に必ず ROLLBACK する**。
 *     migration も合成データも DB に 1 行も残さない。
 *   - 外部送信ゼロ（LINE も Firestore も触らない）。
 *
 * 使用:
 *   npx tsx tests/db/cdp-stage4-l1.db.test.ts   # = pnpm test:db:cdp-stage4
 *
 * 必要な環境変数（.dev.vars / .env から読む。値は表示しない）:
 *   SUPABASE_URL_STAGING / SUPABASE_DB_PASSWORD_STAGING
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config();
dotenv.config({ path: ".dev.vars" });

const PROD_REF = "bquqzrbzdzjegdovxalu";
const STAGING_REF = "espeokdhutgztksdrpzt";

const MIGRATIONS_DIR = join(process.cwd(), "src", "db", "migrations");
const CDP_MIGRATIONS = [
  "040_cdp_subjects_and_edges.sql",
  "041_cdp_customer_events.sql",
  "042_cdp_erasure_subject_scope.sql",
  "043_cdp_subject_links.sql",
  "044_cdp_stage2_parity_map_agreement.sql",
  "045_cdp_l0_analytics_readout.sql",
  "046_cdp_l1_subject_profile.sql",
];

let total = 0;
let passed = 0;
const failures: Array<{ name: string; error: string }> = [];

async function it(name: string, fn: () => Promise<void>, client?: pg.Client) {
  total++;
  if (client) await client.query("SAVEPOINT sp_it");
  try {
    await fn();
    if (client) await client.query("RELEASE SAVEPOINT sp_it");
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    if (client) {
      await client.query("ROLLBACK TO SAVEPOINT sp_it").catch(() => undefined);
      await client.query("RELEASE SAVEPOINT sp_it").catch(() => undefined);
    }
    failures.push({ name, error: e instanceof Error ? e.message : String(e) });
    console.log(`  [FAIL] ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function assertTrue(v: boolean, label: string) {
  if (!v) throw new Error(label);
}

/**
 * 「落ちるはずの SQL」を実行して、落ちたかどうかだけを返す。
 *
 * Postgres は失敗した文でトランザクション全体を aborted にするので、SAVEPOINT で
 * 囲まないと **その後の検証が全部道連れになる**（落ちたことの確認そのものができない）。
 */
async function expectRejected(client: pg.Client, sql: string, params: unknown[]): Promise<boolean> {
  await client.query("SAVEPOINT sp_expect");
  try {
    await client.query(sql, params);
    await client.query("RELEASE SAVEPOINT sp_expect");
    return false;
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT sp_expect");
    await client.query("RELEASE SAVEPOINT sp_expect");
    return true;
  }
}
function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function stagingConnInfo(): { host: string; password: string } {
  const url = process.env.SUPABASE_URL_STAGING;
  const password = process.env.SUPABASE_DB_PASSWORD_STAGING;
  if (!url || !password) {
    console.error(
      "[FATAL] staging の接続情報が未設定（SUPABASE_URL_STAGING / SUPABASE_DB_PASSWORD_STAGING）。中断。",
    );
    process.exit(1);
  }
  const projectRef = new URL(url).hostname.split(".")[0];
  if (projectRef === PROD_REF) {
    console.error("[ABORT] staging 指定に本番 ref が入っている。接続せず中断。");
    process.exit(1);
  }
  if (projectRef !== STAGING_REF) {
    console.error(`[ABORT] 想定外の ref='${projectRef}'。接続せず中断。`);
    process.exit(1);
  }
  console.log(`[OK] PROJECT REF ASSERT: ${projectRef} (env=staging)`);
  return { host: `db.${projectRef}.supabase.co`, password };
}

// ---------------------------------------------------------------------------
// 合成データの道具
// ---------------------------------------------------------------------------

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let ulidCounter = 0;
function fakeUlid(): string {
  let x = (ulidCounter += 1);
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    out = ULID_ALPHABET[x % 32] + out;
    x = Math.floor(x / 32);
  }
  return out;
}
function fakeLineUid(n: number): string {
  return `U${n.toString(16).padStart(32, "0")}`;
}

let eventSeqTag = 0;
function nextDedupe(): string {
  eventSeqTag += 1;
  return `s4-${Date.now()}-${eventSeqTag}`;
}

/** 主体を 1 つ作り、LINE の鍵をぶら下げる。 */
async function newLineSubject(client: pg.Client, n: number): Promise<{ id: string; uid: string }> {
  const id = fakeUlid();
  const uid = fakeLineUid(n);
  await client.query("INSERT INTO subjects (subject_id) VALUES ($1)", [id]);
  await client.query(
    `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
     VALUES ($1, 'line_messaging_uid', $2, 'test.stage4')`,
    [id, uid],
  );
  return { id, uid };
}

/** 主体を 1 つ作り、Shopify の鍵をぶら下げる。 */
async function newShopifySubject(client: pg.Client, customerId: string): Promise<string> {
  const id = fakeUlid();
  await client.query("INSERT INTO subjects (subject_id) VALUES ($1)", [id]);
  await client.query(
    `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
     VALUES ($1, 'shopify_customer_id', $2, 'test.stage4')`,
    [id, customerId],
  );
  return id;
}

async function addEvent(
  client: pg.Client,
  subjectId: string,
  eventType: string,
  payload: unknown,
  occurredAt = "2026-08-15T03:00:00Z",
  schemaOk = true,
): Promise<void> {
  await client.query(
    `INSERT INTO customer_events
       (subject_id, event_type, channel, schema_ok, occurred_at, source, idempotency_key, payload)
     VALUES ($1, $2, 'line', $3, $4, 'test.stage4', $5, $6::jsonb)`,
    [subjectId, eventType, schemaOk, occurredAt, nextDedupe(), JSON.stringify(payload)],
  );
}

async function profileOf(client: pg.Client, subjectId: string) {
  const { rows } = await client.query(
    "SELECT * FROM subject_profile WHERE subject_id = $1",
    [subjectId],
  );
  return rows[0];
}

async function segment(client: pg.Client, persona: string) {
  const { rows } = await client.query("SELECT cdp_segment_line_targets($1, 5000) AS r", [persona]);
  return rows[0].r as {
    count: number;
    user_ids: string[];
    truncated: boolean;
    excluded: Record<string, number>;
  };
}

// ---------------------------------------------------------------------------

async function run(client: pg.Client) {
  console.log("\n=== migration 040〜046 を tx 内で適用（最後に ROLLBACK）===");
  await client.query("BEGIN");
  for (const file of CDP_MIGRATIONS) {
    await client.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    console.log(`  [OK] ${file}`);
  }

  /* staging には実データが入りうる。宛先の集合を数える検証が既存行に引きずられないよう、
   * **この tx の中でだけ** 配信まわりの派生と旧台帳を空にする。tx は最後に ROLLBACK する
   * ので staging のデータは 1 行も減らない（Stage 3 のテストと同じ作法）。
   * customer_events / identity_edges は追記専用（E4）なので消さない — 代わりに
   * 検証は「自分が作った主体」だけを名指しで見る。 */
  await client.query("DELETE FROM delivery_identity");
  await client.query("DELETE FROM customer_linkages");

  // -------------------------------------------------------------------------
  console.log("\n=== 1. L0 を畳んで L1 を作る（persona / 内訳 / 月別内訳）===");

  await it(
    "点の増減を畳んで合計・出所別内訳・月別内訳が同時に立つ",
    async () => {
      const s = await newLineSubject(client, 0x4101);
      await addEvent(
        client,
        s.id,
        "persona.signal_applied",
        { source: "diagnosis", delta: { serenity: 3 } },
        "2026-07-10T03:00:00Z",
      );
      await addEvent(
        client,
        s.id,
        "persona.signal_applied",
        { source: "purchase", delta: { serenity: 3, explorer: 1 } },
        "2026-08-10T03:00:00Z",
      );
      await client.query("SELECT cdp_l1_recompute_subject($1)", [s.id]);

      const p = await profileOf(client, s.id);
      assertEqual(Number(p.persona_scores.serenity), 6, "合計 serenity");
      assertEqual(Number(p.persona_scores.explorer), 1, "合計 explorer");
      assertEqual(p.persona_primary, "serenity", "代表値");
      assertEqual(Number(p.persona_sources.diagnosis.serenity), 3, "内訳 diagnosis");
      assertEqual(Number(p.persona_sources.purchase.serenity), 3, "内訳 purchase");
      // 期間別内訳は **暦の月（JST）**で切る。07-10 03:00Z = JST 07-10 12:00。
      assertEqual(Number(p.persona_windows["2026-07"].serenity), 3, "7 月の内訳");
      assertEqual(Number(p.persona_windows["2026-08"].serenity), 3, "8 月の内訳");
      assertEqual(Number(p.persona_windows["2026-08"].explorer), 1, "8 月の explorer");
    },
    client,
  );

  await it(
    "移行の起点（baseline）が土台になり、そのあとの増減が上に積まれる",
    async () => {
      const s = await newLineSubject(client, 0x4102);
      await addEvent(
        client,
        s.id,
        "persona.baseline_imported",
        { scores: { serenity: 9, explorer: 0, sensory: 0 }, sources: { diagnosis: { serenity: 9, explorer: 0, sensory: 0 } } },
        "2026-06-01T03:00:00Z",
      );
      await addEvent(
        client,
        s.id,
        "persona.signal_applied",
        { source: "survey", delta: { explorer: 3 } },
        "2026-08-01T03:00:00Z",
      );
      await client.query("SELECT cdp_l1_recompute_subject($1)", [s.id]);

      const p = await profileOf(client, s.id);
      assertEqual(Number(p.persona_scores.serenity), 9, "土台がそのまま入る");
      assertEqual(Number(p.persona_scores.explorer), 3, "そのあとの増減が積まれる");
      assertEqual(p.persona_primary, "serenity", "代表値は土台側");
    },
    client,
  );

  await it(
    "押し替えの取り消し（マイナスの増減）でも内訳の和が合計を超えない",
    async () => {
      const s = await newLineSubject(client, 0x4103);
      // 合計が 0 で止まるのに内訳だけ動くと CHECK 制約に当たる。実際に効いた分だけ
      // 内訳に入れる実装（v_eff）が効いているかを見る。
      await addEvent(client, s.id, "persona.signal_applied", {
        source: "survey",
        delta: { explorer: 3 },
      });
      await addEvent(client, s.id, "persona.signal_applied", {
        source: "diagnosis",
        delta: { explorer: -9 },
      });
      await client.query("SELECT cdp_l1_recompute_subject($1)", [s.id]);

      const p = await profileOf(client, s.id);
      assertEqual(Number(p.persona_scores.explorer), 0, "合計は 0 未満にしない");
      const { rows } = await client.query(
        "SELECT cdp_persona_sources_within_total($1::jsonb, $2::jsonb) AS ok",
        [JSON.stringify(p.persona_scores), JSON.stringify(p.persona_sources)],
      );
      assertTrue(rows[0].ok === true, "内訳の和 <= 合計（§3-2 の不変条件）");
    },
    client,
  );

  await it(
    "内訳が合計を超える行は **保存できない**（CHECK 制約が効いている）",
    async () => {
      const s = await newLineSubject(client, 0x4104);
      const rejected = await expectRejected(
        client,
        `INSERT INTO subject_profile (subject_id, persona_scores, persona_sources)
         VALUES ($1, '{"serenity":1,"explorer":0,"sensory":0}'::jsonb,
                     '{"survey":{"serenity":5,"explorer":0,"sensory":0}}'::jsonb)`,
        [s.id],
      );
      assertTrue(rejected, "超えた内訳は INSERT が落ちる");
    },
    client,
  );

  await it(
    "解釈に使えない行（schema_ok=false）は畳まないが、数には入る",
    async () => {
      const s = await newLineSubject(client, 0x4105);
      await addEvent(client, s.id, "persona.signal_applied", { source: "survey", delta: { serenity: 3 } });
      // 形が壊れている行（gateway なら schema_ok=false で入る）。
      await addEvent(client, s.id, "persona.signal_applied", { delta: "壊れている" }, "2026-08-15T03:00:00Z", false);
      await client.query("SELECT cdp_l1_recompute_subject($1)", [s.id]);

      const p = await profileOf(client, s.id);
      assertEqual(Number(p.persona_scores.serenity), 3, "壊れた行は解釈に混ざらない");
      assertEqual(Number(p.event_count), 2, "受け取った数は 2");
      assertEqual(Number(p.folded_count), 1, "畳んだ数は 1（差が「読めなかった数」）");
    },
    client,
  );

  // -------------------------------------------------------------------------
  console.log("\n=== 2. 除外・通知・本人訂正の受け口が L1 に効く ===");

  await it(
    "「もういらない」は積める・解除できる（押した順が結果を決める）",
    async () => {
      const s = await newLineSubject(client, 0x4201);
      await addEvent(client, s.id, "exclusion.set", { kind: "tea", ref: "10023" }, "2026-08-01T03:00:00Z");
      await addEvent(client, s.id, "exclusion.set", { kind: "tea", ref: "10024" }, "2026-08-02T03:00:00Z");
      await addEvent(client, s.id, "exclusion.cleared", { kind: "tea", ref: "10023" }, "2026-08-03T03:00:00Z");
      await client.query("SELECT cdp_l1_recompute_subject($1)", [s.id]);

      const p = await profileOf(client, s.id);
      assertEqual(JSON.stringify(p.exclusions.tea_refs), '["10024"]', "解除した分は残らない");
    },
    client,
  );

  await it(
    "安全に関する申告は **減らす方向に畳まれない**（union のみ）",
    async () => {
      const s = await newLineSubject(client, 0x4202);
      await addEvent(client, s.id, "safety.declared", { tags: ["allergy"] }, "2026-08-01T03:00:00Z");
      await addEvent(client, s.id, "safety.declared", { tags: ["none"] }, "2026-08-05T03:00:00Z");
      await addEvent(
        client,
        s.id,
        "safety.declared",
        { tags: ["caffeine_sensitive"] },
        "2026-08-09T03:00:00Z",
      );
      await client.query("SELECT cdp_l1_recompute_subject($1)", [s.id]);

      const p = await profileOf(client, s.id);
      const tags = p.exclusions.safety_tags as string[];
      assertTrue(tags.includes("allergy"), "あとから「特になし」を押しても消えない");
      assertTrue(tags.includes("caffeine_sensitive"), "足した申告は残る");
      assertTrue(!tags.includes("none"), "「特になし」は申告として積まない");
    },
    client,
  );

  await it(
    "本人訂正が好みタイプの代表値を上書きする（点は動かさない）",
    async () => {
      const s = await newLineSubject(client, 0x4203);
      await addEvent(client, s.id, "persona.signal_applied", { source: "survey", delta: { serenity: 6 } });
      await addEvent(client, s.id, "profile.override", { field: "persona_primary", value: "sensory" });
      await client.query("SELECT cdp_l1_recompute_subject($1)", [s.id]);

      const p = await profileOf(client, s.id);
      assertEqual(p.persona_primary, "sensory", "訂正が勝つ");
      assertEqual(Number(p.persona_scores.serenity), 6, "点そのものは触らない");
    },
    client,
  );

  // -------------------------------------------------------------------------
  console.log("\n=== 3. セグメント配信の SQL 1 本（T-11 の置き換え先）===");

  await it(
    "未連携の人にも宛先が立ち、セグメントに入る（T-9 の置き換えが成立する）",
    async () => {
      const s = await newLineSubject(client, 0x4301);
      await addEvent(client, s.id, "persona.signal_applied", { source: "diagnosis", delta: { explorer: 3 } });
      // 連携していない（customer_linkages に行が無い）状態で畳み直す。
      await client.query("SELECT cdp_l1_recompute_all(500)");

      const seg = await segment(client, "explorer");
      assertTrue(seg.user_ids.includes(s.uid), "未連携の人が宛先に居る");
    },
    client,
  );

  await it(
    "友だち解除の人は宛先から外れ、外れた数が返る",
    async () => {
      const s = await newLineSubject(client, 0x4302);
      await addEvent(client, s.id, "persona.signal_applied", { source: "diagnosis", delta: { sensory: 3 } });
      await client.query("SELECT cdp_l1_recompute_all(500)");
      assertTrue((await segment(client, "sensory")).user_ids.includes(s.uid), "まずは宛先に居る");

      await client.query(
        `INSERT INTO customer_linkages (line_user_id, shopify_customer_id, unfollowed_at)
         VALUES ($1, $2, now())`,
        [s.uid, "990001"],
      );
      const after = await segment(client, "sensory");
      assertTrue(!after.user_ids.includes(s.uid), "友だち解除の人は宛先から外れる");
      assertTrue(after.excluded.unfollowed >= 1, "外れた数が返る（黙って減らさない）");
    },
    client,
  );

  await it(
    "配信の停止申告はセグメントから外れ、理由が残る",
    async () => {
      const s = await newLineSubject(client, 0x4303);
      await addEvent(client, s.id, "persona.signal_applied", { source: "diagnosis", delta: { serenity: 3 } });
      await addEvent(client, s.id, "notify.suppressed", { reason: "requested_by_person" });
      await client.query("SELECT cdp_l1_recompute_all(500)");

      const seg = await segment(client, "serenity");
      assertTrue(!seg.user_ids.includes(s.uid), "停止申告の人は宛先に居ない");

      const { rows } = await client.query(
        `SELECT in_segment, reason FROM subject_segment_state
          WHERE subject_id = $1 AND segment_key = 'persona:serenity'`,
        [s.id],
      );
      assertEqual(rows[0].in_segment, false, "セグメントに入っていない");
      assertEqual(rows[0].reason, "broadcast_suppressed", "外れた理由が残る");
    },
    client,
  );

  await it(
    "停止を解除すると宛先に戻る（申告は取り消せる）",
    async () => {
      const s = await newLineSubject(client, 0x4304);
      await addEvent(client, s.id, "persona.signal_applied", { source: "diagnosis", delta: { serenity: 3 } }, "2026-08-01T03:00:00Z");
      await addEvent(client, s.id, "notify.suppressed", { reason: "requested_by_person" }, "2026-08-02T03:00:00Z");
      await addEvent(client, s.id, "notify.resumed", {}, "2026-08-03T03:00:00Z");
      await client.query("SELECT cdp_l1_recompute_all(500)");

      assertTrue((await segment(client, "serenity")).user_ids.includes(s.uid), "宛先に戻る");
    },
    client,
  );

  await it(
    "連携した 2 つの主体は 1 冊に畳まれる（宛先も 1 つ）",
    async () => {
      const line = await newLineSubject(client, 0x4305);
      const shop = await newShopifySubject(client, "990305");
      await addEvent(client, line.id, "persona.signal_applied", { source: "diagnosis", delta: { explorer: 3 } });
      await addEvent(client, shop, "persona.signal_applied", { source: "purchase", delta: { explorer: 3 } });
      await client.query(
        `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
         VALUES (least($1,$2), greatest($1,$2), 'liff_id_token', 'test.stage4')`,
        [line.id, shop],
      );
      // 宛先の派生（identity_edges → delivery_identity）も含めて畳み直す。
      await client.query("SELECT cdp_l1_recompute_all(500)");

      const { rows } = await client.query(
        "SELECT subject_id, persona_scores FROM subject_profile WHERE subject_id = ANY($1)",
        [[line.id, shop]],
      );
      assertEqual(rows.length, 1, "L1 は 1 行だけ（同じ人の解釈が 2 冊にならない）");
      assertEqual(Number(rows[0].persona_scores.explorer), 6, "両方の点が 1 冊に入る");

      const seg = await segment(client, "explorer");
      assertEqual(
        seg.user_ids.filter((u) => u === line.uid).length,
        1,
        "宛先は 1 つ（二重に送らない）",
      );
    },
    client,
  );

  await it(
    "割当が読む除外条件を Shopify 顧客番号で引ける",
    async () => {
      const shop = await newShopifySubject(client, "990306");
      await addEvent(client, shop, "exclusion.set", { kind: "tea", ref: "10077" });
      await client.query("SELECT cdp_l1_recompute_subject($1)", [shop]);

      const { rows } = await client.query(
        "SELECT cdp_l1_exclusions_by_shopify($1) AS r",
        [["990306", "999999"]],
      );
      const map = rows[0].r as Record<string, { tea_refs: string[] }>;
      assertEqual(JSON.stringify(map["990306"].tea_refs), '["10077"]', "申告が引ける");
      assertTrue(!("999999" in map), "L1 が無い人は入らない（除外なし）");
    },
    client,
  );

  // -------------------------------------------------------------------------
  console.log("\n=== 4. E8'（保存してある解釈が、いま畳み直したものと一致するか）===");

  await it(
    "畳み直した直後は一致している",
    async () => {
      const s = await newLineSubject(client, 0x4401);
      await addEvent(client, s.id, "persona.signal_applied", { source: "survey", delta: { serenity: 3 } });
      await client.query("SELECT cdp_l1_recompute_all(500)");

      const { rows } = await client.query("SELECT cdp_l1_recompute_parity(500) AS r");
      const r = rows[0].r as { checked: number; mismatched: number; in_agreement: boolean };
      assertTrue(r.checked > 0, "1 件以上見ている");
      assertEqual(r.mismatched, 0, "食い違いゼロ");
      assertTrue(r.in_agreement, "一致した日と言える");
    },
    client,
  );

  await it(
    "作り置きが元とずれたら不一致として数える（どの項目かも残る）",
    async () => {
      const s = await newLineSubject(client, 0x4402);
      await addEvent(client, s.id, "persona.signal_applied", { source: "survey", delta: { serenity: 3 } });
      await client.query("SELECT cdp_l1_recompute_subject($1)", [s.id]);

      // 誰かが L1 を直接書き換えた状況（= 作り置きが元とずれた）。
      await client.query(
        `UPDATE subject_profile SET persona_scores = '{"serenity":99,"explorer":0,"sensory":0}'::jsonb
          WHERE subject_id = $1`,
        [s.id],
      );

      const { rows } = await client.query("SELECT cdp_l1_recompute_parity(500) AS r");
      const r = rows[0].r as {
        mismatched: number;
        in_agreement: boolean;
        mismatch_fields: Record<string, number>;
      };
      assertTrue(r.mismatched >= 1, "食い違いを数えた");
      assertTrue(!r.in_agreement, "一致していない");
      assertTrue(
        (r.mismatch_fields.persona_scores ?? 0) >= 1,
        "どの項目がずれたかが残る",
      );
    },
    client,
  );

  await it(
    "1 件も見ていない日を「一致した日」と言わない（空虚合格の封鎖）",
    async () => {
      await client.query("DELETE FROM subject_segment_state");
      await client.query("DELETE FROM subject_profile");
      const { rows } = await client.query("SELECT cdp_l1_recompute_parity(500) AS r");
      const r = rows[0].r as { checked: number; in_agreement: boolean };
      assertEqual(r.checked, 0, "1 件も見ていない");
      assertTrue(!r.in_agreement, "それでも false");
    },
    client,
  );

  await it(
    "同じ L0 を 2 回畳んでも同じ解釈になる（再計算が決定的）",
    async () => {
      const s = await newLineSubject(client, 0x4403);
      await addEvent(client, s.id, "persona.signal_applied", { source: "survey", delta: { serenity: 3 } }, "2026-07-01T03:00:00Z");
      await addEvent(client, s.id, "persona.signal_applied", { source: "purchase", delta: { sensory: 3 } }, "2026-08-01T03:00:00Z");

      const { rows: a } = await client.query("SELECT cdp_l1_build_profile($1) AS r", [s.id]);
      const { rows: b } = await client.query("SELECT cdp_l1_build_profile($1) AS r", [s.id]);
      assertEqual(JSON.stringify(a[0].r), JSON.stringify(b[0].r), "2 回の結果が同じ");
    },
    client,
  );

  // -------------------------------------------------------------------------
  console.log("\n=== 5. 消去が L1 まで届く（GDPR ゲート）===");

  await it(
    "消去で L1 の行も消え、検算が clean になる",
    async () => {
      const s = await newLineSubject(client, 0x4501);
      await addEvent(client, s.id, "persona.signal_applied", { source: "survey", delta: { serenity: 3 } });
      await addEvent(client, s.id, "safety.declared", { tags: ["allergy"] });
      await client.query("SELECT cdp_l1_recompute_subject($1)", [s.id]);
      assertTrue((await profileOf(client, s.id)) !== undefined, "消す前は L1 に行がある");

      await client.query("SELECT roji_erase_person('line', $1)", [s.uid]);

      assertEqual(await profileOf(client, s.id), undefined, "L1 の行が消えた");
      const { rows: seg } = await client.query(
        "SELECT count(*)::int AS n FROM subject_segment_state WHERE subject_id = $1",
        [s.id],
      );
      assertEqual(seg[0].n, 0, "セグメントの行も消えた");

      const { rows } = await client.query(
        "SELECT roji_erasure_residue(ARRAY[]::text[], ARRAY[$1]::text[], ARRAY[]::text[]) AS r",
        [s.uid],
      );
      const residue = rows[0].r as { clean: boolean; remaining: Record<string, number> };
      assertTrue(residue.clean, `消し残しなし（remaining=${JSON.stringify(residue.remaining)}）`);
    },
    client,
  );

  await it(
    "消した人の解釈は畳み直しても復活しない",
    async () => {
      const s = await newLineSubject(client, 0x4502);
      await addEvent(client, s.id, "persona.signal_applied", { source: "survey", delta: { serenity: 3 } });
      await client.query("SELECT roji_erase_person('line', $1)", [s.uid]);

      // 消去のあとに畳み直しが走る状況（日次 tick と消去が前後した場合）。
      await client.query("SELECT cdp_l1_recompute_all(500)");
      assertEqual(await profileOf(client, s.id), undefined, "L1 に復活していない");

      // 念のため、直接 INSERT しようとしても入口で止まることを見る。
      const rejected = await expectRejected(
        client,
        "INSERT INTO subject_profile (subject_id) VALUES ($1)",
        [s.id],
      );
      assertTrue(rejected, "retire 済みの主体には行を足せない");
    },
    client,
  );
}

async function main() {
  const { host, password } = stagingConnInfo();
  const client = new pg.Client({
    host,
    port: 5432,
    database: "postgres",
    user: "postgres",
    password,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 120000,
  });
  await client.connect();
  try {
    await run(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
    console.log("\n[OK] ROLLBACK 済み（migration も合成データも DB に残っていない）");
  }

  console.log(`\n=== cdp-stage4-l1.db.test: ${passed}/${total} passed, ${failures.length} failed ===`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
