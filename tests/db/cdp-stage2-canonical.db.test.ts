/**
 * DB Round-trip Tests — Stage 2 の新旧解決の一致（合成データ N≥20）
 *
 * ─ なぜ合成データなのか ─
 *
 *   設計 §6-1 Stage 2 の完了条件は「新旧解決の一致率 100%」だが、**本番の連携は
 *   0 件**（2026-08-25 実測）なので、実データで突合しても「0 件を 0 件と突き合わせて
 *   合格」になる。設計自身がそれを空虚合格と呼び、staging 合成データで
 *   **N≥20（LIFF / Account Link / anonymous 昇格の 3 経路を各 5 件以上）** を必須と
 *   定めている。このファイルがその N≥20 を作って回す。
 *
 * ─ 「一致」の定義（ここを曖昧にすると合格が意味を失う）─
 *
 *   連携済みの人については、新旧は **意図的に違う**（旧が拾えていなかったものを
 *   新が拾うのが ★11 の修正そのもの）。よって一致は次の 2 つで定義する:
 *
 *     (A) 非退行  … 旧解決が拾えていた user_id を、新解決が 1 つも落としていない
 *                   （旧 ⊆ 新）。落とすと「履歴が消えた」になる。
 *     (B) 正しさ  … 新解決の集合が、合成時に作った **ground truth と完全一致**する。
 *                   多くても少なくても不合格（多い = 他人の履歴が混ざる）。
 *
 *   さらに、連携していない人については (C) 旧 == 新（挙動が 1 つも変わらない）。
 *
 * ─ ★11 の実機確認 ─
 *
 *   LIFF / Account Link で連携した人の **LINE の会話が統合ビューに出る**ことを、
 *   合成した会話行に対して実際のクエリ形（user_id = ANY(...)）で確かめる。
 *   user_id の集合は本番と同じ実装（src/lib/supabase.ts の unionCrossChannelUserIds）
 *   から作る — テスト用に組み直すと「テストがテストを検証する」形になるため。
 *   ⚠ LINE への実送信は一切しない（合成会話行の挿入だけ）。
 *
 * ─ 安全 ─
 *   - 接続先は **staging のみ**（project ref を HARD ASSERT。本番 ref なら接続せず中断）。
 *   - すべて 1 本のトランザクション内で行い、**最後に必ず ROLLBACK する**。
 *     migration 040〜043 の適用も、合成データも、DB には 1 行も残らない。
 *   - 消去関数は呼ばない（消去側の検証は cdp-append-only.db.test.ts が持つ）。
 *
 * 使用:
 *   npx tsx tests/db/cdp-stage2-canonical.db.test.ts   # = pnpm test:db:cdp-stage2
 *
 * 必要な環境変数（.dev.vars / .env から読む。値は表示しない）:
 *   SUPABASE_URL_STAGING / SUPABASE_DB_PASSWORD_STAGING
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";
import pg from "pg";
import { unionCrossChannelUserIds } from "../../src/lib/supabase";

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
];

/** 1 経路あたりの合成件数（設計の下限は 5）。3 経路 × 7 = 21 件 ≥ 20。 */
const PER_PATH = 7;

const TAG = `s2-${Date.now()}`;

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
function assertEqual<T>(actual: T, expected: T, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assertSameSet(actual: string[], expected: string[], label: string) {
  const a = [...new Set(actual)].sort();
  const b = [...new Set(expected)].sort();
  if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
    throw new Error(`${label}\n    新: ${JSON.stringify(a)}\n    期待: ${JSON.stringify(b)}`);
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

function migrationSql(file: string): string {
  return readFileSync(join(MIGRATIONS_DIR, file), "utf8");
}

/**
 * ULID の形（040 の CHECK と同じ）を満たすテスト用 ID。
 *
 * ⚠ 文字列を混ぜて作る簡易ハッシュにしないこと。初版はそれで **衝突**し、
 *   合成データの投入が subjects_pkey で落ちた（そして落ちたことが後続の
 *   「新解決が空」という別の症状に化けた）。連番を base32 に展開すれば
 *   相異なる n が必ず相異なる 26 文字になる。
 */
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

/** Messaging userId の形（U + 32 hex）。 */
function fakeLineUid(n: number): string {
  return `U${n.toString(16).padStart(32, "0")}`;
}

/** 連携の 3 経路。合成データはこの 3 つを各 PER_PATH 件ずつ作る。 */
type Path = "liff" | "account_link" | "anonymous";

const BASIS_OF: Record<Path, string> = {
  liff: "liff_id_token",
  account_link: "line_account_link",
  anonymous: "anonymous_promotion",
};

interface Person {
  path: Path;
  index: number;
  lineUid: string;
  shopifyId: string;
  webSid: string;
  subjectLine: string;
  subjectShopify: string;
  subjectWeb: string;
  /** 旧台帳に何が入っているか（経路ごとに違う。これが ★11 の原因そのもの）。 */
  inIdentityMap: boolean;
  inCustomerLinkages: boolean;
  /** この人の会話が保存されている user_id（＝正しく引けるべき集合の素）。 */
  conversationUserIds: string[];
  /** 新解決が返すべき識別子の集合（ground truth）。 */
  groundTruth: string[];
}

function buildPeople(): Person[] {
  const people: Person[] = [];
  let seq = 1;
  for (const path of ["liff", "account_link", "anonymous"] as Path[]) {
    for (let i = 0; i < PER_PATH; i += 1) {
      const n = seq++;
      const lineUid = fakeLineUid(n);
      const shopifyId = `${7000000 + n}`;
      const webSid = `${TAG}-web-${n}`;
      const p: Person = {
        path,
        index: i,
        lineUid,
        shopifyId,
        webSid,
        subjectLine: fakeUlid(),
        subjectShopify: fakeUlid(),
        subjectWeb: fakeUlid(),
        // ★11 の再現: LIFF と Account Link は customer_linkages にしか行を書かない
        //   （＝ user_identity_map を引く旧解決からは「未連携」に見える）。
        //   匿名昇格だけが user_identity_map 側に行を作る経路。
        inIdentityMap: path === "anonymous",
        inCustomerLinkages: path !== "anonymous",
        conversationUserIds: [lineUid, webSid],
        groundTruth: [lineUid, shopifyId, webSid],
      };
      people.push(p);
    }
  }
  return people;
}

/** 連携していない対照群（挙動が 1 つも変わらないことを確かめる相手）。 */
interface Control {
  lineUid: string;
  subjectLine: string;
}

function buildControls(): Control[] {
  return Array.from({ length: 5 }, (_, i) => ({
    lineUid: fakeLineUid(9000 + i),
    subjectLine: fakeUlid(),
  }));
}

// ===========================================================================
// 合成データの投入（すべて tx 内・最後に ROLLBACK）
// ===========================================================================
async function seed(client: pg.Client, people: Person[], controls: Control[]) {
  for (const p of people) {
    // 主体 3 つ（LINE / Shopify / Web）と、それぞれの観測 edge。
    // Stage 1 の gateway が通っていれば実際にこうなる形をそのまま作る。
    await client.query(`INSERT INTO subjects (subject_id) VALUES ($1), ($2), ($3)`, [
      p.subjectLine,
      p.subjectShopify,
      p.subjectWeb,
    ]);
    await client.query(
      `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by) VALUES
         ($1, 'line_messaging_uid',  $2, 'seed'),
         ($3, 'shopify_customer_id', $4, 'seed'),
         ($5, 'web_session_id',      $6, 'seed')`,
      [p.subjectLine, p.lineUid, p.subjectShopify, p.shopifyId, p.subjectWeb, p.webSid],
    );

    // 旧台帳（経路ごとに書かれる先が違う ＝ ★11 の原因）。
    if (p.inCustomerLinkages) {
      await client.query(
        `INSERT INTO customer_linkages (line_user_id, shopify_customer_id, source, linked_at)
         VALUES ($1, $2, $3, now())`,
        [p.lineUid, p.shopifyId, p.path === "liff" ? "liff" : "account_link"],
      );
    }
    if (p.inIdentityMap) {
      await client.query(
        `INSERT INTO user_identity_map (unified_user_id, web_session_id, shopify_customer_id)
         VALUES ($1, $2, $1)`,
        [p.shopifyId, p.webSid],
      );
    }

    // Stage 2 の追記（3 経路が実際に足す 1 行）。
    const pairs: Array<[string, string]> = [
      p.path === "anonymous" ? [p.subjectWeb, p.subjectShopify] : [p.subjectLine, p.subjectShopify],
    ];
    // 3 主体が 1 人になるよう、もう 1 本の橋も足す（本番では別経路の連携で足される）。
    pairs.push(
      p.path === "anonymous" ? [p.subjectLine, p.subjectShopify] : [p.subjectWeb, p.subjectShopify],
    );
    for (const [x, y] of pairs) {
      const [lo, hi] = x < y ? [x, y] : [y, x];
      await client.query(
        `INSERT INTO subject_links (subject_a, subject_b, basis, observed_by)
         VALUES ($1, $2, $3, 'seed')
         ON CONFLICT (subject_a, subject_b, basis) DO NOTHING`,
        [lo, hi, BASIS_OF[p.path]],
      );
    }

    // 配信の宛先の派生（E5 の行き先）。
    await client.query(
      `INSERT INTO delivery_identity (subject_id, line_user_id, source)
       VALUES ($1, $2, 'seed') ON CONFLICT (subject_id) DO NOTHING`,
      [p.subjectLine, p.lineUid],
    );

    // 会話（LINE 側と Web 側に 1 通ずつ）。★11 は「LINE 側が出てこない」だった。
    await client.query(
      `INSERT INTO conversations (user_id, channel, role, content) VALUES
         ($1, 'line', 'user', $2), ($3, 'web', 'user', $4)`,
      [p.lineUid, `LINE from ${p.path} #${p.index}`, p.webSid, `WEB from ${p.path} #${p.index}`],
    );
  }

  // 対照群（連携していない人）。主体と edge と会話だけ。link は無い。
  for (const c of controls) {
    await client.query(`INSERT INTO subjects (subject_id) VALUES ($1)`, [c.subjectLine]);
    await client.query(
      `INSERT INTO identity_edges (subject_id, identifier_kind, identifier_value, observed_by)
       VALUES ($1, 'line_messaging_uid', $2, 'seed')`,
      [c.subjectLine, c.lineUid],
    );
    await client.query(
      `INSERT INTO conversations (user_id, channel, role, content)
       VALUES ($1, 'line', 'user', $2)`,
      [c.lineUid, `LINE control ${c.lineUid}`],
    );
  }
}

// ===========================================================================
// 旧解決（Stage 2 以前の読み出し）を SQL で再現する
//
//   src/lib/identity.ts resolveUnifiedUserId（LINE）+ src/lib/supabase.ts の
//   user_identity_map 1 行 join。**customer_linkages を一切見ない**のが要点で、
//   これが ★11 の断線そのもの。
// ===========================================================================
async function legacyResolve(
  client: pg.Client,
  lineUid: string,
): Promise<{ unifiedUserId: string; isLinked: boolean; row?: Record<string, string | null> }> {
  const byMessaging = await client.query(
    `SELECT unified_user_id, line_user_id, web_session_id, shopify_customer_id
       FROM user_identity_map WHERE line_user_id = $1 LIMIT 1`,
    [lineUid],
  );
  if (byMessaging.rows.length > 0) {
    const r = byMessaging.rows[0];
    return { unifiedUserId: r.unified_user_id, isLinked: true, row: r };
  }
  const byLogin = await client.query(
    `SELECT unified_user_id, line_user_id, web_session_id, shopify_customer_id
       FROM user_identity_map WHERE line_login_user_id = $1 LIMIT 1`,
    [lineUid],
  );
  if (byLogin.rows.length > 0) {
    const r = byLogin.rows[0];
    return { unifiedUserId: r.unified_user_id, isLinked: true, row: r };
  }
  return { unifiedUserId: lineUid, isLinked: false };
}

/** 新解決（canonical）。cdp_canonical_identifiers をそのまま呼ぶ。 */
async function canonicalResolve(
  client: pg.Client,
  lineUid: string,
): Promise<{ linked: boolean; refs: string[]; memberCount: number }> {
  const { rows } = await client.query(
    `SELECT cdp_canonical_identifiers('line_messaging_uid', $1) AS r`,
    [lineUid],
  );
  const r = rows[0].r as {
    found: boolean;
    link_count?: number;
    member_count?: number;
    identifier_values?: string[];
  };
  if (!r.found) return { linked: false, refs: [], memberCount: 0 };
  return {
    linked: (r.link_count ?? 0) > 0,
    refs: r.identifier_values ?? [],
    memberCount: r.member_count ?? 0,
  };
}

async function run(client: pg.Client) {
  const people = buildPeople();
  const controls = buildControls();

  console.log("\n=== migration 040 / 041 / 042 / 043 を tx 内で適用（最後に ROLLBACK）===");
  await client.query("BEGIN");
  for (const file of CDP_MIGRATIONS) {
    await it(`${file} が適用できる`, async () => {
      await client.query(migrationSql(file));
    }, client);
  }

  // 合成データを入れる **前** の突合値。staging には Stage 2 未反映の実連携が
  // 残っているので、合否は絶対値ではなくこの baseline との差分で見る。
  const baselineRes = await client.query(`SELECT cdp_stage2_parity() AS r`);
  const baseline = baselineRes.rows[0].r as Record<string, number | boolean>;

  console.log(
    `\n=== 合成データ投入: 連携済み ${people.length} 件（LIFF ${PER_PATH} / Account Link ${PER_PATH} / 匿名昇格 ${PER_PATH}）+ 対照 ${controls.length} 件 ===`,
  );
  await it(`合成データ N=${people.length}（各経路 ${PER_PATH} 件・下限 5 を満たす）を投入できる`, async () => {
    assertTrue(people.length >= 20, `N が 20 未満: ${people.length}`);
    assertTrue(PER_PATH >= 5, `1 経路あたりが 5 件未満: ${PER_PATH}`);
    await seed(client, people, controls);
  }, client);

  console.log("\n=== (A) 非退行: 旧が拾えていた user_id を新が 1 つも落としていない ===");
  await it("旧解決の user_id 集合 ⊆ 新解決の user_id 集合（全 21 件）", async () => {
    const lost: string[] = [];
    for (const p of people) {
      const legacy = await legacyResolve(client, p.lineUid);
      const canonical = await canonicalResolve(client, p.lineUid);

      const legacyIds = unionCrossChannelUserIds({
        unifiedUserId: legacy.unifiedUserId,
        legacy: legacy.row,
      });
      const newIds = unionCrossChannelUserIds({
        unifiedUserId: legacy.unifiedUserId,
        legacy: legacy.row,
        extraUserIds: canonical.refs,
      });
      for (const id of legacyIds) {
        if (!newIds.includes(id)) lost.push(`${p.path}#${p.index}:${id}`);
      }
    }
    assertEqual(lost.length, 0, `新解決が落とした user_id がある: ${JSON.stringify(lost)}`);
  }, client);

  console.log("\n=== (B) 正しさ: 新解決 == ground truth（多くても少なくても不合格）===");
  await it("新解決の識別子集合が合成時の ground truth と完全一致（全 21 件）", async () => {
    const mismatches: string[] = [];
    for (const p of people) {
      const canonical = await canonicalResolve(client, p.lineUid);
      const a = [...new Set(canonical.refs)].sort();
      const b = [...new Set(p.groundTruth)].sort();
      if (a.length !== b.length || a.some((v, i) => v !== b[i])) {
        mismatches.push(`${p.path}#${p.index}: 新=${JSON.stringify(a)} 期待=${JSON.stringify(b)}`);
      }
      if (canonical.memberCount !== 3) {
        mismatches.push(`${p.path}#${p.index}: 連結成分が 3 でない (${canonical.memberCount})`);
      }
    }
    assertEqual(mismatches.length, 0, `一致しない人がいる:\n    ${mismatches.join("\n    ")}`);
  }, client);

  console.log("\n=== (C) 非連携の人は挙動が 1 つも変わらない ===");
  await it("対照群（link 無し）は旧 == 新（横断を開かない・鍵も増えない）", async () => {
    for (const c of controls) {
      const legacy = await legacyResolve(client, c.lineUid);
      const canonical = await canonicalResolve(client, c.lineUid);
      assertEqual(legacy.isLinked, false, `対照群が旧解決で連携済みになっている: ${c.lineUid}`);
      assertEqual(canonical.linked, false, `対照群が新解決で連携済みになっている: ${c.lineUid}`);
      assertSameSet(canonical.refs, [c.lineUid], `対照群の鍵が増えている: ${c.lineUid}`);

      const legacyIds = unionCrossChannelUserIds({ unifiedUserId: legacy.unifiedUserId });
      const newIds = unionCrossChannelUserIds({
        unifiedUserId: legacy.unifiedUserId,
        extraUserIds: canonical.refs,
      });
      assertSameSet(newIds, legacyIds, `対照群の読み出し集合が変わっている: ${c.lineUid}`);
    }
  }, client);

  console.log("\n=== ★11: 連携済みの人の LINE 会話が統合ビューに出る（実機確認）===");
  await it("旧解決では LIFF / Account Link の LINE 会話が出てこない（断線の再現）", async () => {
    // 修正前の壊れ方をここで固定しておかないと、修正が何を直したのか言えない。
    const missed: string[] = [];
    for (const p of people.filter((x) => x.path !== "anonymous")) {
      const legacy = await legacyResolve(client, p.lineUid);
      // 旧解決では isLinked=false なので、そもそも横断読みに入らない
      // （src/routes/line.ts の分岐が getRecentMessages 側に落ちる）。
      if (legacy.isLinked) missed.push(`${p.path}#${p.index}`);
    }
    assertEqual(
      missed.length,
      0,
      `断線が再現していない（旧解決で連携済みに見えている）: ${JSON.stringify(missed)}`,
    );
  }, client);

  await it("新解決なら LINE と Web の会話が 1 人分としてまとめて引ける（全 21 件）", async () => {
    const broken: string[] = [];
    for (const p of people) {
      const legacy = await legacyResolve(client, p.lineUid);
      const canonical = await canonicalResolve(client, p.lineUid);
      assertTrue(canonical.linked, `${p.path}#${p.index} が新解決で連携済みになっていない`);

      // 本番と同じ実装で user_id 集合を作り、本番と同じクエリ形で会話を引く。
      const userIds = unionCrossChannelUserIds({
        unifiedUserId: legacy.unifiedUserId,
        legacy: legacy.row,
        extraUserIds: canonical.refs,
      });
      const { rows } = await client.query(
        `SELECT user_id, channel, content FROM conversations
          WHERE user_id = ANY($1) ORDER BY created_at DESC LIMIT 30`,
        [userIds],
      );
      const channels = new Set(rows.map((r) => r.channel as string));
      if (!channels.has("line")) broken.push(`${p.path}#${p.index}: LINE の会話が出ない`);
      if (!channels.has("web")) broken.push(`${p.path}#${p.index}: Web の会話が出ない`);
      // 他人の会話が混ざっていないこと（多すぎる = 情報漏れ）。
      for (const r of rows) {
        if (!p.conversationUserIds.includes(r.user_id as string)) {
          broken.push(`${p.path}#${p.index}: 他人の会話が混ざった (${r.user_id})`);
        }
      }
    }
    assertEqual(broken.length, 0, `★11 が塞がっていない:\n    ${broken.join("\n    ")}`);
  }, client);

  console.log("\n=== 突合ジョブ（日次 tick 相乗り）が合成データを一致と判定する ===");
  await it("cdp_stage2_parity が合成分を 1 件も不一致にしない（baseline との差分で見る）", async () => {
    const { rows } = await client.query(`SELECT cdp_stage2_parity() AS r`);
    const after = rows[0].r as Record<string, number | boolean>;
    console.log(`        baseline: ${JSON.stringify(baseline)}`);
    console.log(`        after   : ${JSON.stringify(after)}`);

    // ⚠ 絶対値で 0 を期待しない。staging には **本物の連携行が既にある**
    //   （Stage 2 未デプロイなので当然 link を持たない）。それを合成データの
    //   不一致として数えると、テストが staging の実在データに引きずられる。
    //   見るのは差分 — 「合成した 21 人が 1 人も不一致になっていない」こと。
    assertEqual(
      (after.linked_without_link as number) - (baseline.linked_without_link as number),
      0,
      "合成した人のうち link が立っていない人がいる",
    );
    assertEqual(
      (after.delivery_identity_missing as number) - (baseline.delivery_identity_missing as number),
      0,
      "合成した人のうち配信の宛先の派生が無い人がいる",
    );
    assertEqual(
      (after.links_total as number) - (baseline.links_total as number),
      people.length * 2,
      "追記された link の本数が合わない",
    );
    // J-4 の破れは合成でも既存でも 1 件もあってはならない（絶対値で 0）。
    assertEqual(after.multi_line_components as number, 0, "J-4 が破れている成分がある");
    assertEqual(after.max_component_size as number, 3, "最大連結成分が 3 でない");
  }, client);

  // baseline が 0 でなかったことは「staging に Stage 2 未反映の実連携がある」という
  // 事実そのものなので、合否とは別に必ず表に出す（観測開始時に見るべき数）。
  const preexisting = baseline.linked_without_link as number;
  if (preexisting > 0) {
    console.log(
      `\n  [WARN] staging に Stage 2 の link を持たない実連携が ${preexisting} 件ある。` +
        "\n         Stage 2 デプロイ直後の日次突合は in_agreement=false で始まる（想定どおり）。" +
        "\n         この 2 件は次の連携操作か、Stage 3 の backfill で link が立つまで残る。",
    );
  }

  await client.query("ROLLBACK");
  console.log("  [OK] ROLLBACK 完了（合成データも migration も DB に残っていない）");
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
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  try {
    await run(client);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    await client.end().catch(() => undefined);
  }

  console.log(`\n=== cdp-stage2-canonical.db.test: ${passed}/${total} passed, ${failures.length} failed ===`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
