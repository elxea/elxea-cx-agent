/**
 * cdp-stage2-backfill.ts — Stage 2 より前に成立していた連携を、追記 1 行として写し取る
 * （CDP 統合 Stage 2 / migration 047 / 設計 §6-1 Stage 2 の完了条件）。
 *
 * ─ なぜ要るか ─
 *
 *   `cdp_stage2_parity()` の `linked_without_link` は「旧台帳 customer_linkages で
 *   連携済みなのに、追記型の link が無い人」を数える。Stage 2 のコードが載る **前** に
 *   連携した人はここに数え上がり、しかも自然には消えない:
 *
 *     subject_links に行が入る経路は 2 本だけ（実測・2026-08-29）
 *       src/routes/identity.ts  identityLinkLiffHandler → recordLinkAndDelivery
 *       src/lib/account-link.ts handleAccountLinkEvent  → appendSubjectLink
 *
 *     どちらも「新しく連携する」出来事の中にしか無い。日次の照合
 *     （src/lib/linkage-reconcile.ts / src/lib/karte-reconcile.ts）は
 *     subject_links にも delivery_identity にも触れない。
 *
 *   よって観測を待つと 5 営業日は永久に埋まらない。1 度だけ写し取る。
 *
 * ─ 「正規経路と同じ関数を通す」ことの意味 ─
 *
 *   ここは SQL を書かない。Stage 2 のランタイムが使うのと **同じ関数** を呼ぶ:
 *
 *     appendSubjectLink      … 主体の解決/発行（resolveOrIssueSubject）+ link の追記
 *     upsertDeliveryIdentity … 配信の宛先（生 LINE userId）の派生
 *
 *   同じ関数を通すので、E4（追記専用）・J-4（1 人に LINE 1 本）・basis のホワイトリスト・
 *   retired 主体の拒否は **1 つも迂回されない**。DB 側のトリガが最終の歯である点も同じ。
 *   写し取り専用の SQL を書けば「link とは何か」の定義が 2 つに割れる（それをしない）。
 *
 * ─ basis ─
 *
 *   'legacy_ledger_backfill'（migration 047 で語彙に追加）。
 *   「旧台帳が既にそう言っている」以上の根拠を主張しない。`liff_id_token` 等に
 *   混ぜないのは、監査の読み手を誤らせないため（詳細は 047 のヘッダ）。
 *
 * ─ 安全 ─
 *
 *   - 既定は dry-run。**書き込みは `--apply` を明示したときだけ。**
 *   - 接続先 project ref を HARD ASSERT（migrate.ts と同じ二重ガード）。
 *     既定は staging。prod は `--env prod` を明示したときだけ。
 *   - 外部送信ゼロ。LINE にもメールにも Shopify にも触れない。
 *   - 生の識別子をログに出さない（マスクする）。
 *   - 冪等。2 度目以降は link が 0 件増えて終わる（ON CONFLICT DO NOTHING）。
 *   - 1 行の失敗で全体を止めない。失敗は理由付きで数え、最後に 1 行 JSON で出す。
 *
 * ─ 使い方 ─
 *
 *   npx tsx scripts/cdp-stage2-backfill.ts                      # staging / dry-run
 *   npx tsx scripts/cdp-stage2-backfill.ts --apply              # staging / 実行
 *   npx tsx scripts/cdp-stage2-backfill.ts --env prod           # prod / dry-run（読むだけ）
 *   npx tsx scripts/cdp-stage2-backfill.ts --env prod --apply   # prod / 実行（Setaka 承認が要る）
 *
 * ─ 必要な環境変数（.env / .dev.vars から読む。値は表示しない）─
 *
 *   staging: SUPABASE_URL_STAGING / SUPABASE_SERVICE_ROLE_KEY_STAGING
 *   prod   : SUPABASE_URL         / SUPABASE_SERVICE_ROLE_KEY
 */

import dotenv from "dotenv";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  appendSubjectLink,
  type LinkAppendResult,
  type LinkBasis,
} from "../src/lib/cdp/subject-links";
import { upsertDeliveryIdentity, type DeliveryIdentityResult } from "../src/lib/customer-linkage";
import { lineSeed, shopifySeed } from "../src/lib/cdp/canonical";
import { resolveOrIssueSubject } from "../src/lib/cdp/subjects";

dotenv.config();
dotenv.config({ path: ".dev.vars" });

export const PROD_REF = "bquqzrbzdzjegdovxalu";
export const STAGING_REF = "espeokdhutgztksdrpzt";

/** 写し取りの根拠（migration 047 の CHECK と 1 対 1）。 */
export const BACKFILL_BASIS: LinkBasis = "legacy_ledger_backfill";

/** どの経路が記録したか（identity_edges / subject_links の observed_by 規約: 小文字 slug）。 */
export const BACKFILL_OBSERVED_BY = "cdp-backfill-047";

export type TargetEnv = "prod" | "staging";

export interface Cli {
  env: TargetEnv;
  apply: boolean;
}

/**
 * 旧台帳の 1 行（写し取りの単位）。
 *
 * ⚠ 選ぶ述語は `cdp_stage2_parity()` の `linked_without_link` と **同じ**にすること
 *   （line_user_id IS NOT NULL AND shopify_customer_id IS NOT NULL）。ここがずれると
 *   「全部写したのに parity が緑にならない」が起きる。
 */
export interface LedgerRow {
  lineUserId: string;
  shopifyCustomerId: string;
}

/** 1 行の写し取り結果（生の識別子を持たない）。 */
export interface RowResult {
  /** ログ・レポート用のマスク済み表示。 */
  line: string;
  shopify: string;
  /** link 側の結末。 */
  link:
    | "linked"
    /** 既に 1 人として解決済み（写すものが無い）。異常ではない。 */
    | "already_same_subject"
    /** J-4: 1 Shopify 顧客に 2 本目の LINE。**写さないのが正しい。** */
    | "j4_conflict"
    /** 消去済みの主体を含む。結び直さない。 */
    | "retired_subject"
    /** 主体を出せなかった。 */
    | "subject_unavailable"
    /** それ以外の書き込み失敗。 */
    | "insert_failed";
  /** delivery_identity 側の結末。 */
  delivery: "derived" | "skipped_bad_form" | "subject_unavailable" | "failed";
  /** 失敗したときの理由（生の識別子を含まない）。 */
  detail?: string;
}

export interface BackfillSummary {
  env: TargetEnv;
  apply: boolean;
  scanned: number;
  link: Record<RowResult["link"], number>;
  delivery: Record<RowResult["delivery"], number>;
  /** この実行で subject_links に実際に増えた行数（実行前後の実測差）。 */
  linksCreated: number;
  /** 実行後の cdp_stage2_parity()。dry-run では実行前の値。 */
  parity: Record<string, unknown> | null;
}

/** Messaging userId の形（delivery_identity の CHECK / upsertDeliveryIdentity と同じ）。 */
const MESSAGING_USER_ID_RE = /^U[0-9a-f]{32}$/;

/** 生値を出さないための表示用マスク。 */
export function mask(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}***${value.slice(-3)}`;
}

export function parseCli(argv: readonly string[]): Cli {
  let env: TargetEnv = "staging";
  const i = argv.findIndex((a) => a === "--env" || a.startsWith("--env="));
  if (i >= 0) {
    const raw = argv[i].startsWith("--env=") ? argv[i].slice("--env=".length) : argv[i + 1];
    if (raw !== "prod" && raw !== "staging") {
      throw new Error(`--env は prod|staging のみ（受領: ${raw ?? "(none)"}）`);
    }
    env = raw;
  }
  return { env, apply: argv.includes("--apply") };
}

/**
 * 接続先 project ref を突き合わせる（migrate.ts と同じ二重ガード）。
 *
 * 「staging のつもりで prod を書いた」を型では防げないので、URL から取り出した ref が
 * 期待と一致しない限り 1 行も書かせない。
 */
export function assertTargetRef(env: TargetEnv, supabaseUrl: string): string {
  const ref = new URL(supabaseUrl).hostname.split(".")[0];
  const expected = env === "prod" ? PROD_REF : STAGING_REF;
  if (env === "staging" && ref === PROD_REF) {
    throw new Error(`--env staging だが project ref が本番（${PROD_REF}）。中断。`);
  }
  if (ref !== expected) {
    throw new Error(`project ref '${ref}' が期待 '${expected}'（env=${env}）と不一致。中断。`);
  }
  return ref;
}

/** appendSubjectLink の結末を、数えられる名前に読み替える。 */
export function classifyLink(result: LinkAppendResult): RowResult["link"] {
  if (result.ok) return "linked";
  if (result.reason === "same_subject") return "already_same_subject";
  if (result.reason === "j4_conflict") return "j4_conflict";
  if (result.reason === "retired_subject") return "retired_subject";
  if (result.reason.startsWith("subject_unavailable")) return "subject_unavailable";
  return "insert_failed";
}

/** 依存を差し替えられるようにしておく（DB 無しで枝を検証するため）。 */
export interface BackfillDeps {
  appendLink: typeof appendSubjectLink;
  upsertDelivery: typeof upsertDeliveryIdentity;
  resolveSubject: typeof resolveOrIssueSubject;
}

const DEFAULT_DEPS: BackfillDeps = {
  appendLink: appendSubjectLink,
  upsertDelivery: upsertDeliveryIdentity,
  resolveSubject: resolveOrIssueSubject,
};

/**
 * 1 行を写し取る。**決して throw しない。**
 *
 * 手順は `src/routes/identity.ts` の recordLinkAndDelivery と同じ順序・同じ関数:
 *   1. link を 1 行足す（主体が無ければ appendSubjectLink の中で発行される）
 *   2. link 側で解決済みの LINE 主体をそのまま使って delivery_identity を派生させる
 *      （link が張れなかったときだけ引き直す）
 */
export async function backfillRow(
  supabase: SupabaseClient,
  row: LedgerRow,
  deps: BackfillDeps = DEFAULT_DEPS,
): Promise<RowResult> {
  const masked = { line: mask(row.lineUserId), shopify: mask(row.shopifyCustomerId) };

  const linkResult = await deps.appendLink(supabase, {
    left: lineSeed(row.lineUserId),
    right: shopifySeed(row.shopifyCustomerId),
    basis: BACKFILL_BASIS,
    observedBy: BACKFILL_OBSERVED_BY,
  });
  const link = classifyLink(linkResult);
  const linkDetail = linkResult.ok ? undefined : (linkResult.detail ?? linkResult.reason);

  // 配信の宛先を派生できない形は、link とは別に落とす（黙って緑にしない）。
  // upsertDeliveryIdentity も同じ検査を持つが、ここで先に分岐しておくと
  // 「なぜ delivery が無いのか」が 1 語で残る。
  if (!MESSAGING_USER_ID_RE.test(row.lineUserId)) {
    return { ...masked, link, delivery: "skipped_bad_form", detail: linkDetail };
  }

  let lineSubjectId: string | null = linkResult.ok ? linkResult.leftSubjectId : null;
  if (lineSubjectId === null) {
    const subject = await deps.resolveSubject(
      supabase,
      lineSeed(row.lineUserId),
      BACKFILL_OBSERVED_BY,
    );
    lineSubjectId = subject.subjectId;
  }
  if (lineSubjectId === null) {
    return { ...masked, link, delivery: "subject_unavailable", detail: linkDetail };
  }

  const derived: DeliveryIdentityResult = await deps.upsertDelivery(supabase, {
    subjectId: lineSubjectId,
    lineUserId: row.lineUserId,
    source: BACKFILL_OBSERVED_BY,
  });
  if (!derived.ok) {
    return { ...masked, link, delivery: "failed", detail: derived.error };
  }
  return { ...masked, link, delivery: "derived", detail: linkDetail };
}

export function emptyLinkCounts(): Record<RowResult["link"], number> {
  return {
    linked: 0,
    already_same_subject: 0,
    j4_conflict: 0,
    retired_subject: 0,
    subject_unavailable: 0,
    insert_failed: 0,
  };
}

export function emptyDeliveryCounts(): Record<RowResult["delivery"], number> {
  return { derived: 0, skipped_bad_form: 0, subject_unavailable: 0, failed: 0 };
}

/** 行ごとの結末を数え上げる（純粋関数・テストが直接呼ぶ）。 */
export function summarize(results: readonly RowResult[]): {
  link: Record<RowResult["link"], number>;
  delivery: Record<RowResult["delivery"], number>;
} {
  const link = emptyLinkCounts();
  const delivery = emptyDeliveryCounts();
  for (const r of results) {
    link[r.link] += 1;
    delivery[r.delivery] += 1;
  }
  return { link, delivery };
}

/* ===========================================================================
 * ここから下は I/O（Supabase を実際に触る側）
 * =========================================================================== */

function connInfo(env: TargetEnv): { url: string; serviceKey: string } {
  const url = env === "prod" ? process.env.SUPABASE_URL : process.env.SUPABASE_URL_STAGING;
  const serviceKey =
    env === "prod"
      ? process.env.SUPABASE_SERVICE_ROLE_KEY
      : process.env.SUPABASE_SERVICE_ROLE_KEY_STAGING;
  if (!url) {
    throw new Error(`${env === "prod" ? "SUPABASE_URL" : "SUPABASE_URL_STAGING"} 未設定。中断。`);
  }
  if (!serviceKey) {
    throw new Error(
      `${env === "prod" ? "SUPABASE_SERVICE_ROLE_KEY" : "SUPABASE_SERVICE_ROLE_KEY_STAGING"} 未設定。中断。`,
    );
  }
  return { url, serviceKey };
}

/** 母数を読む。述語は cdp_stage2_parity() の linked_without_link と同じ。 */
async function loadLedgerRows(supabase: SupabaseClient): Promise<LedgerRow[]> {
  const { data, error } = await supabase
    .from("customer_linkages")
    .select("line_user_id, shopify_customer_id")
    .not("line_user_id", "is", null)
    .not("shopify_customer_id", "is", null);
  if (error) throw new Error(`customer_linkages の読み出しに失敗: ${error.message}`);
  return (data ?? [])
    .map((r) => ({
      lineUserId: String((r as { line_user_id: unknown }).line_user_id ?? ""),
      shopifyCustomerId: String((r as { shopify_customer_id: unknown }).shopify_customer_id ?? ""),
    }))
    .filter((r) => r.lineUserId !== "" && r.shopifyCustomerId !== "");
}

async function countLinks(supabase: SupabaseClient): Promise<number> {
  const { count, error } = await supabase
    .from("subject_links")
    .select("link_seq", { count: "exact", head: true });
  if (error) throw new Error(`subject_links の件数取得に失敗: ${error.message}`);
  return count ?? 0;
}

async function readParity(supabase: SupabaseClient): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase.rpc("cdp_stage2_parity");
  if (error) {
    console.warn(`[warn] cdp_stage2_parity 呼び出しに失敗: ${error.message}`);
    return null;
  }
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

async function readCandidates(supabase: SupabaseClient): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase.rpc("cdp_stage2_backfill_candidates");
  if (error) {
    console.warn(
      `[warn] cdp_stage2_backfill_candidates 呼び出しに失敗（047 未適用か）: ${error.message}`,
    );
    return null;
  }
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  const { url, serviceKey } = connInfo(cli.env);
  const ref = assertTargetRef(cli.env, url);
  console.log(
    `cdp-stage2-backfill — env=${cli.env} / mode=${cli.apply ? "apply" : "dry-run"} / ref=${ref}`,
  );
  if (!cli.apply) {
    console.log("  [dry-run] 1 行も書きません（書くには --apply を明示）。");
  }

  const supabase = createClient(url, serviceKey);

  const before = await readParity(supabase);
  console.log("\n== 実行前 cdp_stage2_parity() ==");
  console.log(JSON.stringify(before, null, 1));

  const candidates = await readCandidates(supabase);
  console.log("\n== 見立て cdp_stage2_backfill_candidates() ==");
  console.log(JSON.stringify(candidates, null, 1));

  const rows = await loadLedgerRows(supabase);
  console.log(`\n== 母数 ==\n  customer_linkages の連携済み行: ${rows.length} 件`);

  if (!cli.apply) {
    for (const r of rows) {
      console.log(`  - line=${mask(r.lineUserId)} shopify=${mask(r.shopifyCustomerId)}`);
    }
    console.log("\n[dry-run] ここで終了（書き込みなし）。");
    return;
  }

  const linksBefore = await countLinks(supabase);
  const results: RowResult[] = [];
  for (const row of rows) {
    const result = await backfillRow(supabase, row);
    results.push(result);
    console.log(
      `  - line=${result.line} shopify=${result.shopify} link=${result.link} delivery=${result.delivery}` +
        (result.detail ? ` detail=${result.detail}` : ""),
    );
  }
  const linksAfter = await countLinks(supabase);

  const counts = summarize(results);
  const after = await readParity(supabase);
  const summary: BackfillSummary = {
    env: cli.env,
    apply: cli.apply,
    scanned: rows.length,
    link: counts.link,
    delivery: counts.delivery,
    linksCreated: linksAfter - linksBefore,
    parity: after,
  };

  console.log("\n== 実行後 cdp_stage2_parity() ==");
  console.log(JSON.stringify(after, null, 1));
  console.log("\n[cdp/backfill] summary:", JSON.stringify(summary));

  // 写せなかった行が 1 つでもあれば、緑にならない理由が残っている。非 0 で終わる。
  const blocked =
    counts.link.j4_conflict +
    counts.link.retired_subject +
    counts.link.subject_unavailable +
    counts.link.insert_failed +
    counts.delivery.skipped_bad_form +
    counts.delivery.subject_unavailable +
    counts.delivery.failed;
  if (blocked > 0) {
    console.error(`\n[FAIL] 写せなかった行が ${blocked} 件ある。parity は緑にならない。`);
    process.exit(1);
  }
  if (after && after.in_agreement !== true) {
    console.error("\n[FAIL] 全行を写したが in_agreement が true にならない。内訳を確認すること。");
    process.exit(1);
  }
  console.log("\n[OK] 写し取り完了。in_agreement=true。");
}

// 直接実行されたときだけ走らせる（テストから import しても main が動かないように）。
const invokedDirectly =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("cdp-stage2-backfill.ts");
if (invokedDirectly) {
  main().catch((e) => {
    console.error("[FATAL]", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
