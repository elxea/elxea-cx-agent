/**
 * 毎日の照合 — 「台帳に行が立っているのに、サイト側の棚が合体していない人」を拾い直す
 * （再設計 M-2 / 決裁 J-2 の「(a) 通知 + **照合ジョブ**」の後半）。
 *
 * ## なぜ通知だけでは足りないのか
 *
 * 連携が成立すると cx-agent は web-app へ「台帳に行が立った」を通知する
 * （`linkage-notify.ts`）。ところがその通知は **連携そのものを止めないため fire-and-forget**
 * で送っている。web-app が落ちていても、鍵が無くても、連携は台帳上すでに成立している
 * ので、通知の失敗を理由に連携を失敗させるわけにいかない。
 *
 * その設計の裏返しとして、**通知が 1 度落ちるとその人の合体は二度と起きない**。
 * 唯一の回収経路は「次にメールでログインしたとき」だが、LINE トーク内の Account Link で
 * 連携した人は、そのままメールでログインしない可能性がある。実際 `karte-reconcile.ts` は
 * この穴を「穴4: サイト側 users/line:{id} 配下の足あと」として**範囲外**と明記していた。
 *
 * 本ジョブがその穴を塞ぐ。イベントが速さを、照合が確実さを担当する — という J-2 の
 * 立て付けを、両輪そろえて成立させる。
 *
 * ## 何をするか（合体のロジックは書かない）
 *
 * 台帳に現存する連携を読み、**同じ通知をもう一度送るだけ**である。合体そのものは
 * web-app の `/api/internal/linkage-established` が行う。ここで別経路を起こすと
 * 「合体とは何か」の定義が 2 つに割れる（`karte-reconcile` が
 * `mergeLineUserIntoShopify` をそのまま呼ぶのと同じ理由）。
 *
 * 再送してよいのは、web-app 側の合体が**冪等**だからである（運べたものだけを消す
 * 4 段。既に運び終わっていれば 0 件で終わる）。よって「届いたか分からないので送らない」
 * ではなく「分からないなら送る」に倒せる。
 *
 * ## 収束すること・しないこと（正確に言う）
 *
 * 収束する: 連携が台帳に在るのに合体が走っていない人。何日前に落ちた通知でも、
 *           次の照合で拾える（対象を「最近」で絞らないため）。
 * 収束しない: 台帳に行が無い連携。**そもそも連携が成立していない**ので、拾うものが無い。
 *
 * ## 上限を置く理由
 *
 * Workers の 1 実行あたり subrequest 数には上限がある。台帳が大きくなったときに
 * 全件送ると、上限に当たって**途中で実行ごと落ちる**（＝毎回同じ前半しか送られない）。
 * よって自分から上限で止まり、止まったことを戻り値に出す。現状の規模（本番の連携は
 * 2026-08-25 時点で 1 件、友だち約 48 人）では上限に届かない。届くようになったら、
 * 「未確認の行だけを送る」ための印を台帳に持たせる段階に進む合図になる。
 *
 * ## 安全
 *
 * - 読み取りのみ（Supabase は SELECT だけ）。台帳を書き換えない
 * - 外部送信ゼロ。LINE もメールも送らない（web-app の内部口を叩くだけ）
 * - never throw。1 件の失敗で全体を止めない。cron を落とさない
 * - 個人データを返さない・ログにも出さない（件数だけ）
 */

import type { Env } from "../index";
import { createSupabaseClient } from "./supabase";
import { notifyLinkageEstablished } from "./linkage-notify";

/** 照合 1 回の結果（件数のみ・個人データを含まない）。 */
export type LinkageReconcileResult = {
  /** 台帳から読んだ「連携が成立している」行数。 */
  scanned: number;
  /** web-app が合体まで到達した件数。 */
  merged: number;
  /** 通知が届かなかった / web-app が合体できなかった件数（次回の照合で再試行）。 */
  failed: number;
  /** 上限に当たって打ち切ったか。true なら台帳の一部しか送れていない。 */
  budgetReached: boolean;
  durationMs: number;
  /** 実行しなかった理由（設定不足等）。実行したときは null。 */
  notRun: string | null;
};

/**
 * 台帳から読む上限。暴走防止（`karte-reconcile` と同じ考え方・同じ値）。
 */
const MAX_ROWS = 2000;

/**
 * 1 回の照合で送る通知の上限。Workers の subrequest 上限より十分小さく取る。
 *
 * ここに当たったら「印を持つ設計へ進む合図」であって、黙って一部だけ送り続ける
 * 状態にしない（`budgetReached` で自己申告する）。
 */
const MAX_NOTIFY = 200;

/**
 * 連携済みなのに合体していない人を拾い直す。**決して throw しない。**
 *
 * @param env Workers 環境変数
 * @param deps テスト用 DI（本番は省略）。実 I/O を差し替えてハーメティックに検証する。
 */
export async function runLinkageReconcile(
  env: Env,
  deps?: {
    listLinkages?: () => Promise<Array<{ lineUserId: string; shopifyCustomerId: string }>>;
    notify?: typeof notifyLinkageEstablished;
    fetchImpl?: typeof fetch;
  },
): Promise<LinkageReconcileResult> {
  const startedAt = Date.now();
  const base = (notRun: string | null): LinkageReconcileResult => ({
    scanned: 0,
    merged: 0,
    failed: 0,
    budgetReached: false,
    durationMs: Date.now() - startedAt,
    notRun,
  });

  /* 送り先が無いなら読みにも行かない。台帳を無駄に舐めない。
     ⚠ trim して見る（G12 / 2026-08-22 の本番障害と同じ理由）。 */
  const hasTarget =
    (env.WEB_APP_BASE_URL ?? "").trim().length > 0 &&
    (env.LINKAGE_EVENT_SECRET ?? "").trim().length > 0;
  if (!hasTarget) {
    /* 無音にしない。ここが黙って落ちると「合体が起きない理由」が誰にも分からなくなる
       （通知側と同じ扱い）。 */
    console.warn(
      "[linkage-reconcile] WEB_APP_BASE_URL / LINKAGE_EVENT_SECRET 未設定のため照合しない",
    );
    return base("web-app notify target not configured");
  }

  const listLinkages =
    deps?.listLinkages ??
    (async () => {
      const supabase = createSupabaseClient(env);
      /* 条件は `getLinkageByLineUser` と同じ「shopify_customer_id IS NOT NULL」。
         **unfollowed_at では絞らない** — LINE をブロックしただけの人も連携は生きており、
         その人の荷物こそ置き去りになりやすい（cx-agent #38 / P4 と同じ判断）。 */
      const { data, error } = await supabase
        .from("customer_linkages")
        .select("line_user_id, shopify_customer_id")
        .not("shopify_customer_id", "is", null)
        .limit(MAX_ROWS);
      if (error) throw new Error(`customer_linkages query failed: ${error.message}`);
      return (data ?? [])
        .filter((r) => r.line_user_id && r.shopify_customer_id)
        .map((r) => ({
          lineUserId: String(r.line_user_id),
          shopifyCustomerId: String(r.shopify_customer_id),
        }));
    });

  const notify = deps?.notify ?? notifyLinkageEstablished;

  let rows: Array<{ lineUserId: string; shopifyCustomerId: string }>;
  try {
    rows = await listLinkages();
  } catch (err) {
    console.warn(
      "[linkage-reconcile] 台帳の読み取りに失敗（non-blocking）:",
      err instanceof Error ? err.message : err,
    );
    return base("linkage query failed");
  }

  const result = base(null);
  result.scanned = rows.length;

  for (const row of rows) {
    if (result.merged + result.failed >= MAX_NOTIFY) {
      result.budgetReached = true;
      console.warn(
        `[linkage-reconcile] 1 回の上限 ${MAX_NOTIFY} 件に達したので打ち切る（残り ${rows.length - MAX_NOTIFY} 件は次回）`,
      );
      break;
    }

    try {
      const sent = await notify(
        env,
        {
          lineUserId: row.lineUserId,
          shopifyCustomerId: row.shopifyCustomerId,
          /* 出所を分ける。web-app 側はこれをログ・Sentry の切り分けにしか使わないが、
             「連携の瞬間」と「毎日の照合」を混ぜると、どちらが落ちているか分からなくなる。 */
          source: "reconcile",
        },
        deps?.fetchImpl ?? fetch,
      );
      if (sent.ok) result.merged++;
      else result.failed++;
    } catch (err) {
      /* notify は never throw の契約だが、二重の安全網（未処理 reject を残さない）。 */
      result.failed++;
      console.warn(
        "[linkage-reconcile] 通知が例外で落ちた（next run で再試行）:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  result.durationMs = Date.now() - startedAt;
  return result;
}
