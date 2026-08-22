/**
 * 配信オーケストレータ（T9）。
 *
 * @layer CX — CX 所有・CDP を読む。宛先集合（delivery-audience / target-resolver）と
 *   通数台帳（message-ledger）は CDP に問い合わせるだけで、ここが決めるのは
 *   「いつ・どの文面を・どのチャネルへ出すか」という体験側の判断。台帳の形は持たない。
 *
 * 設計: 「Notion駆動 LINE配信 設計確定版 v1.0」§5/§6/§8
 *   ③検出 → claim(台帳=真の排他) → 対象解決 → 通数ガード(guardAndClaim)
 *   → pinning 照合 → 送信(stub 可) → 結果書戻し → reaper(Sending タイムアウト回収)。
 *
 * ⚠ 実送信は sender ポート（line-messages.ts の LineSender）にのみ存在する。
 *    2026-08-22 に env の実送信スイッチ（旧 sendEnabled / DELIVERY_SEND_ENABLED）は撤去した。
 *    承認・予定日時・pin 照合・通数台帳の各ガードを通った行は必ず実送信する。
 *    プレビューしたい場合はテストと同じく noopSender を注入する（runtime 経路には存在しない）。
 *
 * 依存はすべて注入（repo/ledger/consumption/resolveTargets/sender/clock/flags）で、
 * ユニットテストは fake でネットワーク非接触に順序と分岐を検証する。
 */

import {
  guardAndClaim,
  currentLineMonth,
  type LedgerStore,
  type ConsumptionFetcher,
  type GuardOptions,
} from "./message-ledger";
import type { DeliveryPage, DeliveryResult } from "./delivery-repository";
import type { AudienceSpec } from "./delivery-audience";
import { parseAudience, audienceLabel } from "./delivery-audience";
import { buildAggregationUnit, isValidAggregationUnit } from "./aggregation-unit";
import { evaluateScheduledTime } from "./delivery-time";
import { isApprovalAuthorized } from "./delivery-approval";
import { computeContentHash, hashesMatch } from "./content-hash";
import { buildMessages, type LineSender, type LineMessage } from "./line-messages";
import type { ResolvedTargets } from "./target-resolver";

// ---------------------------------------------------------------------------
// ポート・型
// ---------------------------------------------------------------------------

/** Notion 配信 DB への操作ポート（テストは fake、runtime は delivery-repository を配線）。 */
export interface DeliveryRepoPort {
  queryDue(nowIso: string): Promise<DeliveryPage[]>;
  querySending(): Promise<DeliveryPage[]>;
  setStatus(pageId: string, status: string): Promise<void>;
  writeResult(pageId: string, result: DeliveryResult): Promise<void>;
  resetApproval(pageId: string, reason: string): Promise<void>;
}

/** 1 ページの処理結果（ログ・集計用）。 */
export interface PageOutcome {
  pageId: string;
  title: string;
  audience: string | null;
  /** sent=実送信(または dry-run 完走) / skipped / reset / failed。 */
  disposition: "sent" | "skipped" | "reset" | "failed";
  reason: string;
  recipients: number;
}

/** 実行全体の結果。 */
export interface DeliveryRunResult {
  scanned: number;
  processed: PageOutcome[];
  reaper: ReaperOutcome[];
}

export interface OrchestratorDeps {
  repo: DeliveryRepoPort;
  ledger: LedgerStore;
  consumption: ConsumptionFetcher;
  /**
   * (notion_page_id, month) の claim が既に存在するかを非破壊で照会する（reaper 用）。
   * LedgerStore.claim は挿入を伴うため使えない。runtime は Supabase の select、
   * テストは fake を注入する。
   */
  ledgerHasClaim(notionPageId: string, month: string): Promise<boolean>;
  /** AudienceSpec を実対象へ解決する（target-resolver.resolveTargets を配線）。 */
  resolveTargets(audience: AudienceSpec): Promise<ResolvedTargets>;
  sender: LineSender;
  now(): Date;
  /**
   * テスト環境限定の自己承認緩和（既定 false）。
   * true のとき「承認者!=著者」の独立性チェックを免除する（承認者の存在は必須のまま）。
   * runtime は selfApprovalRelaxed(env) を渡す（prod では常に false）。
   */
  allowSelfApproval?: boolean;
  guardOptions?: GuardOptions;
  /** Sending 滞留の回収閾値（ms）。既定 15 分。 */
  reaperTimeoutMs?: number;
  /**
   * 社内テスト配信限定の順序付き画像URL群（env 供給・恒久HTTPS）。
   * audience=allowlist（社内）のときだけ本文(text)に続けて image N を組む簡易経路。
   * Notion 複数画像UIの本実装（v2）までの暫定。prod/persona/all には一切適用しない。
   * 空/未指定なら従来の単一形式（page.format）で動く。
   */
  testImageUrls?: string[];
}

const DEFAULT_REAPER_TIMEOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// メイン: 1 巡実行
// ---------------------------------------------------------------------------

/**
 * 配信を 1 巡実行する。設計 §5 の順序を厳守:
 *   1. 対象抽出（repo.queryDue: Approved & <=now & 未送信）
 *   2. 各ページ: 入力/日時/自己承認/pinning を検証（fail-closed）
 *   3. 対象解決 → 見積件数
 *   4. 通数ガード + 台帳 claim（guardAndClaim = 真の排他 + 会計）
 *   5. Sending マーク → 送信 → 結果書戻し
 *   6. reaper（Sending タイムアウト回収）
 *
 * 直列処理（走行合計の前提）。1 件でも例外は握って failed に落とし、続行する。
 */
export async function runDeliveryOnce(
  deps: OrchestratorDeps,
): Promise<DeliveryRunResult> {
  const now = deps.now();
  const nowIso = now.toISOString();
  const month = currentLineMonth(now);
  const processed: PageOutcome[] = [];

  let due: DeliveryPage[] = [];
  try {
    due = await deps.repo.queryDue(nowIso);
  } catch (err) {
    // 取得できなければ何もしない（fail-closed）。reaper だけ試みる。
    const reaper = await runReaper(deps, now).catch(() => [] as ReaperOutcome[]);
    return {
      scanned: 0,
      processed: [
        {
          pageId: "-",
          title: "-",
          audience: null,
          disposition: "failed",
          reason: `queryDue 失敗: ${err instanceof Error ? err.message : String(err)}`,
          recipients: 0,
        },
      ],
      reaper,
    };
  }

  for (const page of due) {
    try {
      processed.push(await processPage(page, deps, now, month));
    } catch (err) {
      processed.push({
        pageId: page.id,
        title: page.title,
        audience: page.audienceRaw,
        disposition: "failed",
        reason: `例外: ${err instanceof Error ? err.message : String(err)}`,
        recipients: 0,
      });
    }
  }

  const reaper = await runReaper(deps, now).catch(() => [] as ReaperOutcome[]);
  return { scanned: due.length, processed, reaper };
}

function skip(page: DeliveryPage, reason: string): PageOutcome {
  return {
    pageId: page.id,
    title: page.title,
    audience: page.audienceRaw,
    disposition: "skipped",
    reason,
    recipients: 0,
  };
}

async function processPage(
  page: DeliveryPage,
  deps: OrchestratorDeps,
  now: Date,
  month: string,
): Promise<PageOutcome> {
  // 冪等: 既に送信済みなら何もしない。
  if (page.sent) return skip(page, "既に送信済み");

  // (a) 配信対象の解釈（空・未知は fail-closed）。
  const audience: AudienceSpec | null = parseAudience(page.audienceRaw);
  if (!audience) return skip(page, "配信対象が空/未知（fail-closed）");

  // (b) 日時の厳格化（date-only/空/不正は送信不可。未来は due:false）。
  const sched = evaluateScheduledTime(page.scheduledStart, now);
  if (!sched.sendable) return skip(page, `配信予定日時が不正: ${sched.reason}`);
  if (!sched.due) return skip(page, "配信予定日時がまだ未来");

  // (c) 自己承認検知（承認者 != 著者）。独立承認者ゼロは送信不可。
  //     allowSelfApproval=true（test 緩和時のみ）は独立性を免除（承認者の存在は必須）。
  if (
    !isApprovalAuthorized(
      page.assignees,
      page.approvers,
      deps.allowSelfApproval === true,
    )
  ) {
    return skip(page, "独立した承認者がいない（自己承認・fail-closed）");
  }

  // (d) 形式別の必須項目 + メッセージ組み立て（text 本文 / image 恒久HTTPS）。
  if (page.format !== "text" && page.format !== "image") {
    return skip(page, "形式が未設定/未知");
  }
  // 画像 URL 群の解決（送信順・恒久HTTPS）:
  //   1) Notion files「画像」→ R2 の恒久URL群（page.imageUrls）が最優先。全 audience に適用する
  //      （運用者が Notion に画像をドラッグする本経路）。ハッシュ照合の対象もこの URL 群。
  //   2) page.imageUrls が空のときのみ、旧 env 供給ブリッジ（DELIVERY_TEST_IMAGE_URLS）に
  //      フォールバックする。ブリッジは社内テスト(allowlist)・全員(all) 限定・ペルソナには注入しない。
  //      ブリッジ画像は「送信」には使うがハッシュには含めない（従来挙動の後方互換）。
  // 安全ガード（承認・日時・pin 照合・通数台帳）はこの経路の前後で従来どおり維持される
  // （buildMessages 側で合計 LINE_MAX_MESSAGES=5 以内・恒久HTTPS のみを fail-closed 検証）。
  const notionImages = page.imageUrls ?? [];
  const extraImageUrls =
    notionImages.length > 0
      ? notionImages
      : (audience.kind === "allowlist" || audience.kind === "all") &&
          deps.testImageUrls &&
          deps.testImageUrls.length > 0
        ? deps.testImageUrls
        : undefined;
  const built = buildMessages({
    format: page.format,
    body: page.body,
    imageUrls: extraImageUrls,
  });
  if (!built.ok) return skip(page, `メッセージ不正: ${built.reason}`);
  const messages: LineMessage[] = built.messages;

  // (e) コンテンツ pinning（TOCTOU）: 現在値のハッシュと承認時スナップショットを照合。
  //   画像は「恒久R2 URL 群（notionImages）」でハッシュする（pin 時と同じ決定的URL群）。
  //   承認後に画像の枚数/順序が変われば不一致 → 承認自動リセットで送信中止する。
  const currentHash = await computeContentHash({
    format: page.format,
    body: page.body,
    imageUrls: notionImages,
  });
  if (!page.contentHash) {
    // 承認時スナップショット欠如 → 承認をリセット（送信不可）。
    await deps.repo.resetApproval(page.id, "コンテンツハッシュ未設定のため承認リセット");
    return {
      pageId: page.id,
      title: page.title,
      audience: page.audienceRaw,
      disposition: "reset",
      reason: "コンテンツハッシュ未設定",
      recipients: 0,
    };
  }
  if (!hashesMatch(page.contentHash, currentHash)) {
    await deps.repo.resetApproval(
      page.id,
      "承認後に本文/画像が編集されたため承認リセット（ハッシュ不一致）",
    );
    return {
      pageId: page.id,
      title: page.title,
      audience: page.audienceRaw,
      disposition: "reset",
      reason: "コンテンツハッシュ不一致（編集検知）",
      recipients: 0,
    };
  }

  // (f) 対象解決 → 見積件数。
  const targets = await deps.resolveTargets(audience);
  if (targets.kind === "error") {
    return skip(page, `対象解決失敗: ${targets.reason}`);
  }
  const estimated = targets.estimatedRecipients;

  // ==== 以降は実送信経路（env の実送信スイッチは 2026-08-22 に撤去） ====
  // ここまでのガード（承認者独立性・予定日時・コンテンツ pin 照合・宛先解決）を通った行だけが
  // 到達する。以降は台帳 claim → Sending マーク → 送信 → 結果書戻しの順で副作用が発生する。

  // P0-7a: 配信計測の集計単位（後付け不可）。送信時に付与しないと unit 別統計が永久に取れない。
  //   ⚠ LINE 仕様: customAggregationUnits は push / multicast のみ対応で **broadcast は非対応**。
  //   よって unit を付けるのは multicast（ペルソナ / 社内）のときだけ。全員配信（broadcast）は
  //   unit 計測対象外（LINE 標準の per-message insight で足りる）。台帳にも broadcast は unit を記録しない。
  //   命名不正（LINE 制約違反）は fail-closed で unit を付けない（送信自体は止めない＝計測欠落に留める）。
  const unit = buildAggregationUnit(audience, now);
  const aggregationUnit =
    targets.kind === "multicast" && isValidAggregationUnit(unit) ? unit : undefined;

  // (g) 通数ガード + 台帳 claim（真の排他 + 会計）。送信より前に必ず実施。
  const decision = await guardAndClaim(
    deps.ledger,
    deps.consumption,
    {
      notionPageId: page.id,
      month,
      recipients: estimated,
      source: "broadcast",
      aggregationUnit,
    },
    deps.guardOptions,
  );
  if (!decision.ok) {
    return skip(page, `通数ガードで送信不可: ${decision.reason}`);
  }

  // (h) Sending マーク（reaper のための中間状態）。
  await deps.repo.setStatus(page.id, "Sending");

  // (i) 送信（実 sender）。案A（P0-4）で通常経路は multicast のみ（broadcast は deprecated）。
  const outcome =
    targets.kind === "broadcast"
      ? await deps.sender.broadcast(messages, estimated, aggregationUnit)
      : await deps.sender.multicast(targets.batches, messages, aggregationUnit);
  const delivered = outcome.deliveredRecipients;
  const partial = outcome.partial;
  const sendError = outcome.error;
  if (!outcome.ok && delivered === 0) {
    // 全失敗。Failed 書戻し。台帳 claim は済みだが実送信ゼロ。
    await deps.repo.writeResult(page.id, {
      status: "Failed",
      sentAtUtc: now.toISOString(),
      summary: `送信失敗（${audienceLabel(audience)}・見積${estimated}）`,
      consumed: 0,
      errorDetail: sendError ?? "unknown",
    });
    return {
      pageId: page.id,
      title: page.title,
      audience: page.audienceRaw,
      disposition: "failed",
      reason: `送信失敗: ${sendError ?? "unknown"}`,
      recipients: 0,
    };
  }

  // (j) 結果書戻し（Sent / PartialFail）。
  const status = partial ? "PartialFail" : "Sent";
  await deps.repo.writeResult(page.id, {
    status,
    sentAtUtc: now.toISOString(),
    summary: `${status}（${audienceLabel(audience)}・実送信${delivered}/${estimated}）`,
    consumed: delivered,
    errorDetail: partial ? sendError : undefined,
  });

  return {
    pageId: page.id,
    title: page.title,
    audience: page.audienceRaw,
    disposition: "sent",
    reason: `${status}: 実送信 ${delivered}/${estimated}`,
    recipients: delivered,
  };
}

// ---------------------------------------------------------------------------
// Reaper（Sending タイムアウト回収）
// ---------------------------------------------------------------------------

export interface ReaperOutcome {
  pageId: string;
  action: "recover_failed" | "reset_retry" | "skip";
  reason: string;
}

/**
 * Sending 滞留ページの分類（純粋）。
 *   - まだタイムアウトしていない → skip
 *   - タイムアウト & 台帳 claim あり → 送信途中でクラッシュした可能性 → Failed 化（二重送信を避ける）
 *   - タイムアウト & 台帳 claim なし → 送信前に落ちた → Approved に戻して再試行可
 */
export function classifyStaleSending(
  page: { lastEditedTime: string | null },
  now: Date,
  timeoutMs: number,
  hasClaim: boolean,
): ReaperOutcome["action"] {
  const edited = page.lastEditedTime ? Date.parse(page.lastEditedTime) : NaN;
  if (Number.isNaN(edited)) return "skip";
  if (now.getTime() - edited < timeoutMs) return "skip";
  return hasClaim ? "recover_failed" : "reset_retry";
}

/**
 * reaper 本体。Sending を走査し、タイムアウトしたものを台帳照合で回収する。
 * 台帳 claim の有無は confirmedConsumption ではなく、月内 claim の存在で判定する必要があるが、
 * LedgerStore は claim 存在の直接照会を持たないため、claim を試みて既存(=false)なら「claim あり」とみなす。
 */
async function runReaper(
  deps: OrchestratorDeps,
  now: Date,
): Promise<ReaperOutcome[]> {
  const timeoutMs = deps.reaperTimeoutMs ?? DEFAULT_REAPER_TIMEOUT_MS;
  const month = currentLineMonth(now);
  const sending = await deps.repo.querySending();
  const out: ReaperOutcome[] = [];

  for (const page of sending) {
    // claim の有無を「非破壊」で判定する（claim を試すと 0 行を挿入して再試行を阻害するため）。
    // 判定不能（例外）は安全側 = 送信着手済とみなし二重送信を避ける。
    let hasClaim: boolean;
    try {
      hasClaim = await deps.ledgerHasClaim(page.id, month);
    } catch {
      hasClaim = true;
    }

    const action = classifyStaleSending(page, now, timeoutMs, hasClaim);
    try {
      if (action === "recover_failed") {
        await deps.repo.writeResult(page.id, {
          status: "Failed",
          sentAtUtc: now.toISOString(),
          summary: "Sending タイムアウト回収（送信着手済のため Failed 化・二重送信防止）",
          consumed: 0,
          errorDetail: "reaper: stale Sending with ledger claim",
        });
        out.push({ pageId: page.id, action, reason: "台帳 claim あり→Failed" });
      } else if (action === "reset_retry") {
        await deps.repo.setStatus(page.id, "Approved");
        out.push({ pageId: page.id, action, reason: "台帳 claim なし→Approved 再試行" });
      } else {
        out.push({ pageId: page.id, action, reason: "未タイムアウト" });
      }
    } catch (err) {
      out.push({
        pageId: page.id,
        action: "skip",
        reason: `回収失敗: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return out;
}
