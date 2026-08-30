/**
 * DB テストの接続先を 1 か所で決める（CDP 受入スイート共通）
 *
 * ─ なぜ 1 か所にまとめるか ─
 *
 * 2026-08-30 の運用変更で **staging は凍結され、本番が正本になった**（未リリース状態
 * のため、本番が「唯一の実物」である）。それまでの DB テストは接続先を各ファイルに
 * 直接書いており、`STAGING_REF` の HARD ASSERT がファイルごとに複製されていた。
 * 接続先の方針が変わるたびに 5 ファイルを直すのは、直し漏れた 1 ファイルが
 * 気づかれずに違う環境を向く形の事故を招く。よって接続先の決定はここだけで行う。
 *
 * ─ 既定は「本番・読み取り専用」─
 *
 * 既定の接続先は本番。ただし **読み取り専用**である。読み取り専用は宣言ではなく
 * 接続の設定で担保する（`newReadOnlyClient` が `default_transaction_read_only = on`
 * を張るので、書き込み SQL は Postgres 側で 25006 になって落ちる）。
 * 「気をつけて書かない」ではなく「書けない」にしてある。
 *
 * ─ 書き込みを伴う検査の扱い ─
 *
 * 追記専用トリガの両方向検査・消去の往復のように、**書いてみないと確かめられない**
 * ものがある。これらは本番では走らせない。`requireWritableTarget()` は
 *
 *   - 接続先が本番なら         … 実行を拒否して SKIP 終了（exit 0・理由付き）
 *   - 書込先が指定されていないなら … 同上
 *
 * とする。落とさず SKIP にするのは、「書ける環境が無い」ことと「検査が落ちた」ことを
 * 区別するためである（受入スイートの表でも SKIP と FAIL は別の記号で出る）。
 * **どの環境で書込検査を回すかは、実行時に Boss が指定する**（`CDP_DB_TARGET`）。
 *
 * ─ 環境変数 ─
 *
 *   CDP_DB_TARGET = prod | staging   … 接続先。未指定なら prod
 *   本番:    SUPABASE_URL          / SUPABASE_DB_PASSWORD
 *   staging: SUPABASE_URL_STAGING  / SUPABASE_DB_PASSWORD_STAGING
 *
 * 値は 1 つも表示しない（project ref だけはログに出す — どこに繋いだかを
 * 後から言えないと、テスト結果の意味が決まらないため）。
 */

import pg from "pg";

/** 本番の project ref。ここに書いてあるのは公開されている識別子であって秘密ではない。 */
export const PROD_REF = "bquqzrbzdzjegdovxalu";
/** staging の project ref（2026-08-30 に運用上は凍結）。 */
export const STAGING_REF = "espeokdhutgztksdrpzt";

export type TargetName = "prod" | "staging";

export interface DbTarget {
  name: TargetName;
  ref: string;
  host: string;
  password: string;
  /** 本番か。true のとき書き込みを伴う検査は走らせない。 */
  isProd: boolean;
}

function fail(msg: string): never {
  console.error(`[FATAL] ${msg}`);
  process.exit(1);
}

/**
 * `CDP_DB_TARGET` を読む。未指定は prod（正本）。
 *
 * 未知の値を prod に倒さない — 打ち間違いが黙って本番接続になるのは、
 * いちばん高い代償を後払いする既定である。
 */
export function targetName(): TargetName {
  const raw = (process.env.CDP_DB_TARGET || "").trim().toLowerCase();
  if (raw === "" || raw === "prod" || raw === "production") return "prod";
  if (raw === "staging" || raw === "stg") return "staging";
  fail(`CDP_DB_TARGET の値が不正: '${raw}'（prod | staging のみ）`);
}

/**
 * 接続情報を解決する。ref が想定と食い違ったら接続せずに中断する。
 *
 * ref を確かめるのは、環境変数の中身が入れ替わっていても気づけるようにするため
 * （URL を staging のつもりで本番に向けていた、という事故は実際に起こる形である）。
 */
export function resolveTarget(name: TargetName = targetName()): DbTarget {
  const isProd = name === "prod";
  const url = isProd ? process.env.SUPABASE_URL : process.env.SUPABASE_URL_STAGING;
  const password = isProd ? process.env.SUPABASE_DB_PASSWORD : process.env.SUPABASE_DB_PASSWORD_STAGING;

  if (!url || !password) {
    fail(
      `${name} の接続情報が未設定` +
        (isProd
          ? "（SUPABASE_URL / SUPABASE_DB_PASSWORD）"
          : "（SUPABASE_URL_STAGING / SUPABASE_DB_PASSWORD_STAGING）"),
    );
  }

  let ref: string;
  try {
    ref = new URL(url).hostname.split(".")[0];
  } catch {
    fail(`${name} の URL が URL として読めない`);
  }

  const expected = isProd ? PROD_REF : STAGING_REF;
  if (ref !== expected) {
    fail(`接続先 ref が想定と違う: target=${name} ref='${ref}' expected='${expected}'。接続せず中断`);
  }

  console.log(`[OK] TARGET ASSERT: ${name} ref=${ref}${isProd ? " (読み取り専用で接続する)" : ""}`);
  return { name, ref, host: `db.${ref}.supabase.co`, password, isProd };
}

function baseClient(t: DbTarget): pg.Client {
  return new pg.Client({
    host: t.host,
    port: 5432,
    database: "postgres",
    user: "postgres",
    password: t.password,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 30_000,
  });
}

/**
 * 読み取り専用で接続する。
 *
 * `default_transaction_read_only = on` を接続直後に張るので、以後この接続からの
 * INSERT / UPDATE / DELETE / DDL は Postgres 側が 25006 で拒否する。
 * テストの側で「書かないように気をつける」必要が無くなる。
 */
export async function connectReadOnly(t: DbTarget): Promise<pg.Client> {
  const client = baseClient(t);
  await client.connect();
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  const { rows } = await client.query<{ ro: string }>(
    `SELECT current_setting('default_transaction_read_only') AS ro`,
  );
  if (rows[0].ro !== "on") {
    await client.end().catch(() => undefined);
    fail("読み取り専用の設定が効いていない。接続を閉じて中断");
  }
  return client;
}

/**
 * 書き込みを伴う検査のための接続。**本番では絶対に開かない。**
 *
 * 開けない場合は理由を出して `null` を返す。呼び出し側は SKIP として終了する
 * （落とさない — 「書ける環境が無い」は検査の失敗ではない）。
 */
export async function connectWritable(): Promise<{ client: pg.Client; target: DbTarget } | null> {
  const name = targetName();
  if (name === "prod") {
    console.log(
      "[SKIP] 書き込みを伴う検査は本番では走らせない。\n" +
        "       書ける環境を CDP_DB_TARGET で指定すること（実行時に Boss が決める）。\n" +
        "       例: CDP_DB_TARGET=staging pnpm test:db:cdp-erasure-registry",
    );
    return null;
  }
  const target = resolveTarget(name);
  const client = baseClient(target);
  await client.connect();
  return { client, target };
}

/**
 * 識別子（表名・列名）を安全に埋め込む。
 *
 * 値は information_schema 由来で外部入力ではないが、文字列連結で SQL を組む箇所を
 * 1 つに閉じ、そこで必ず形を検査して引用符で包む。
 */
export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`想定外の識別子: ${name}`);
  return `"${name}"`;
}

// --- 小さなテスト土台（DB テスト間で共通） --------------------------------------

export interface Harness {
  it(name: string, fn: () => Promise<void>, client?: pg.Client): Promise<void>;
  summary(label: string): void;
}

export function createHarness(): Harness {
  let total = 0;
  let passed = 0;
  const failures: Array<{ name: string; error: string }> = [];

  return {
    async it(name, fn, client) {
      total++;
      if (client) await client.query("SAVEPOINT sp_it");
      try {
        await fn();
        if (client) await client.query("RELEASE SAVEPOINT sp_it");
        passed++;
        console.log(`  [PASS] ${name}`);
      } catch (e) {
        if (client) await client.query("ROLLBACK TO SAVEPOINT sp_it").catch(() => undefined);
        const error = e instanceof Error ? e.message : String(e);
        failures.push({ name, error });
        console.log(`  [FAIL] ${name}`);
        console.log(`         ${error}`);
      }
    },
    summary(label) {
      console.log(`\n=== ${label}: ${passed}/${total} passed, ${failures.length} failed ===`);
      if (failures.length > 0) {
        for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
        process.exit(1);
      }
    },
  };
}

export function assertTrue(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

export function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg} (actual=${String(actual)} expected=${String(expected)})`);
}
