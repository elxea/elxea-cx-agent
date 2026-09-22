/**
 * 1 件指定の配信（段1-A）。
 *
 * ⚠ 「全件送る口」は撤去した（2026-09-22）。配信が走る経路は
 *    `POST /api/delivery/send-one` の **1 件指定のみ** で、対象以外は構造的に送れない。
 *    旧 `POST /api/delivery/run` / `runOnDemandDelivery` / `runDeliveryOnce`（Approved 全件走査）は
 *    互換残置せず削除した（プラン v6.2 §4-2 の 1 / §7-5）。
 *
 * 設計: プラン v6.2 §4-2 / §4-3 / §7-6 / §7-7
 *   https://app.notion.com/p/3e370c9d064c81c9bea7d8db2e5ccb96
 *
 * 処理順（順序そのものが安全性・すべて fail-closed）:
 *   a. 配信DB行を読む（Status=Approved かつ 送信済=false 以外は拒否）
 *   b. All Tasks 判定行で承認を確認（判定=承認 / 最終編集者=owner。メール解決の一時失敗は保留）
 *   c. 指紋照合（本文・画像・配信対象。旧形式=配信対象を含まない pin は受け付けない）
 *   d. 対象人数（承認時比 +10% 超は停止・N-12）と台帳残枠（実効 190）を確認
 *   e. claim-before-send（原子的に「送信中」を取る。二重は 409・同一予約は冪等・N-06 / N-07）
 *   f. 送信（X-Line-Retry-Key 必須。同一実行内で最大 2 回まで再試行・E-02 / N-08）
 *   g. 成功応答を確認してのみ Sent。失敗は Failed と理由（Sent と誤記録しない・N-15）
 *
 * このモジュールは依存をすべて注入で受け取り、ユニットテストはネットワーク非接触で
 * 順序と分岐を検証する（実 I/O の配線は delivery-runtime.ts）。
 */

import {
  parseAudience,
  audienceLabel,
  audienceFingerprintKey,
  type AudienceSpec,
} from "./delivery-audience";
import {
  buildMessages,
  deterministicRetryKey,
  type LineSender,
  type LineMessage,
} from "./line-messages";
import { computeContentHash, hashesMatch } from "./content-hash";
import { buildAggregationUnit, isValidAggregationUnit } from "./aggregation-unit";
import {
  computeRemaining,
  currentLineMonth,
  FREE_TIER_CAP,
  DEFAULT_SAFETY_HEADROOM,
  type ConsumptionFetcher,
  type GuardOptions,
} from "./message-ledger";
import type { DeliveryPage, DeliveryResult } from "./delivery-repository";
import type { ResolvedTargets } from "./target-resolver";
import {
  verifyApprovalTask,
  DEFAULT_APPROVAL_JUDGMENTS,
  type ApprovalRef,
  type ApprovalTaskPort,
} from "./delivery-approval-task";

// ---------------------------------------------------------------------------
// 入出力
// ---------------------------------------------------------------------------

/** 1 件指定送信の要求。 */
export interface SendOneRequest {
  /** 配信DB（配信コンテンツ）の行 id。 */
  pageId: string;
  /** Mac 側が予約登録時に固定した承認スナップショット。 */
  approvalRef: ApprovalRef;
  /** 予約 ID。冪等キー兼 X-Line-Retry-Key の種。 */
  reservationId: string;
}

/** 応答の種別。 */
export type SendOneStatus = "sent" | "rejected" | "failed" | "retryable";

/** 機械可読な理由コード（HTTP ステータスの決定と記録に使う）。 */
export type SendOneCode =
  | "sent"
  | "idempotent_sent"
  | "idempotent_failed"
  | "bad_request"
  | "row_fetch_failed"
  | "row_not_approved"
  | "row_already_sent"
  | "row_sending"
  | "audience_unknown"
  | "message_invalid"
  | "fingerprint_missing"
  | "fingerprint_mismatch"
  | "audience_unresolved"
  | "audience_count_grew"
  | "consumption_unavailable"
  | "ledger_exhausted"
  | "ledger_error"
  | "claim_conflict"
  | "claim_in_flight"
  | "send_failed"
  | "send_unconfirmed"
  | "owner_email_unset"
  | "judgment_not_approved"
  | "editor_missing"
  | "email_empty"
  | "editor_mismatch"
  | "email_lookup_retryable"
  | "task_fetch_retryable";

/** 同期応答（呼び出し側がその場で結果を確認できることを配線の要件とする）。 */
export interface SendOneResponse {
  status: SendOneStatus;
  code: SendOneCode;
  reason: string;
  /** 実送信人数（送っていないときは 0）。 */
  sentCount: number;
  /** 送信直前に実測した配信対象人数（解決前は 0）。 */
  audienceCount: number;
  /** 判定時点の台帳残枠（取得前・取得不能は null）。 */
  ledgerRemaining: number | null;
  reservationId: string;
  /**
   * LINE が返した送信 1 回ぶんの鍵（`X-Line-Request-Id` / 再試行キー受理済みなら
   * `x-line-accepted-request-id`）。**送れたときだけ入る。それ以外は null**。
   *
   * なぜ応答に載せるか: 呼び出し側（Mac 側パイプライン）が実配信数の後追い照合に使う鍵で、
   *   この場で受け取らないと二度と手に入らない（LINE の統計は送信から 14 日で消える）。
   * multicast は 1 配信が複数リクエストに割れて鍵が 1 本に定まらないため null
   *   （multicast の計測は customAggregationUnits 経由で別に取る）。
   * 同一 reservationId の二重到達（冪等応答）も、前回の鍵は保持していないため null。
   */
  requestId: string | null;
}

/** claim の結果（原子的に取れたか / 既存がいるか）。 */
export type ReservationClaim =
  | { kind: "claimed" }
  | {
      kind: "duplicate";
      /** 既存 claim の予約 ID が今回と同一か。 */
      sameReservation: boolean;
      /** 既存 claim の送信状態。 */
      sendState: "sending" | "sent" | "failed" | "unknown";
      /** 既存 claim の記録済み送信数（不明は null）。 */
      sentCount: number | null;
    };

/**
 * 送信予約ポート（claim-before-send の原子性を担う）。
 *
 * 実装は line_message_ledger の UNIQUE (notion_page_id, month) を使った
 * `INSERT ... ON CONFLICT DO NOTHING`。**アプリ層の read→write では実装しない**
 * （並列 2 本が同時に「未送信」を読む窓を残さないため・N-07）。
 */
export interface SendReservationPort {
  claim(input: {
    pageId: string;
    month: string;
    reservationId: string;
    recipients: number;
    aggregationUnit?: string;
  }): Promise<ReservationClaim>;
  /** 送信後の確定（send_state / sent_count / line_request_id）。 */
  finish(input: {
    pageId: string;
    month: string;
    sendState: "sent" | "failed";
    sentCount: number;
    lineRequestId?: string;
  }): Promise<void>;
}

/** 配信DB行の読み書きポート（Status 遷移と結果書戻しのみ）。 */
export interface SendOneRepoPort {
  fetchPage(pageId: string): Promise<DeliveryPage>;
  setStatus(pageId: string, status: string): Promise<void>;
  writeResult(pageId: string, result: DeliveryResult): Promise<void>;
  /** 拒否・失敗の理由を行に残す（黙って止まらない）。Status は変えない。 */
  writeError(pageId: string, reason: string): Promise<void>;
}

/** 注入依存。 */
export interface SendOneDeps {
  repo: SendOneRepoPort;
  reservation: SendReservationPort;
  /** 台帳の当月確定消費（走行合計の主判定）。 */
  confirmedConsumption(month: string): Promise<number>;
  consumption: ConsumptionFetcher;
  approvalTask: ApprovalTaskPort;
  /** 照合に使う唯一のメール（env DELIVERY_OWNER_EMAIL。既定なし＝未設定は送信不可）。 */
  ownerEmail?: string;
  /**
   * 承認と見なす「判定」select の実オプション名（完全一致 allowlist）。
   * 未指定は `DEFAULT_APPROVAL_JUDGMENTS`（= ["承認"]）。差し替えは env
   * `DELIVERY_APPROVAL_JUDGMENTS` 1 か所（runtime が parse して渡す）。
   */
  approvalJudgments?: readonly string[];
  resolveTargets(audience: AudienceSpec): Promise<ResolvedTargets>;
  sender: LineSender;
  now(): Date;
  /** pageId / 画像枚数から恒久 R2 URL 群を決定的に再構成する（runtime が R2 公開ベースを知る）。 */
  imageUrlsFor(page: DeliveryPage): string[];
  guardOptions?: GuardOptions;
  /** 送信の総試行回数（既定 3 = 初回 + 最大 2 回再試行・E-02）。 */
  maxSendAttempts?: number;
  /** 対象人数の許容増加率（既定 0.10 = +10%・N-12）。 */
  audienceGrowthTolerance?: number;
}

const DEFAULT_MAX_SEND_ATTEMPTS = 3;
const DEFAULT_AUDIENCE_GROWTH_TOLERANCE = 0.1;

// ---------------------------------------------------------------------------
// 純粋関数
// ---------------------------------------------------------------------------

/**
 * 対象人数が承認時から許容を超えて増えていないか（純粋・N-12）。
 * 承認時人数が 1 未満のスナップショットは無効（判定の基準が無い）。
 */
export function audienceCountWithinTolerance(
  approved: number,
  current: number,
  tolerance: number,
): boolean {
  if (!Number.isFinite(approved) || approved < 1) return false;
  if (!Number.isFinite(current) || current < 0) return false;
  return current <= approved * (1 + tolerance);
}

/** 要求の形式検証（純粋・fail-closed）。問題があれば理由を返す。 */
export function validateSendOneRequest(req: SendOneRequest): string | null {
  const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (!nonEmpty(req?.pageId)) return "pageId が必須";
  if (!nonEmpty(req?.reservationId)) return "reservationId が必須";
  const ref = req?.approvalRef;
  if (!ref || typeof ref !== "object") return "approvalRef が必須";
  if (!nonEmpty(ref.taskPageId)) return "approvalRef.taskPageId が必須";
  if (!nonEmpty(ref.approvedEditorEmail))
    return "approvalRef.approvedEditorEmail が必須";
  if (!nonEmpty(ref.approvedEditedTime))
    return "approvalRef.approvedEditedTime が必須";
  if (
    typeof ref.approvedAudienceCount !== "number" ||
    !Number.isFinite(ref.approvedAudienceCount) ||
    ref.approvedAudienceCount < 1
  ) {
    return "approvalRef.approvedAudienceCount は 1 以上の数値が必須";
  }
  return null;
}

/** HTTP ステータスへの写像（route が使う）。 */
export function httpStatusFor(res: SendOneResponse): 200 | 400 | 409 | 422 | 502 | 503 {
  switch (res.code) {
    case "sent":
    case "idempotent_sent":
    case "idempotent_failed":
      return 200;
    case "bad_request":
      return 400;
    case "row_already_sent":
    case "row_sending":
    case "claim_conflict":
    case "claim_in_flight":
      return 409;
    case "email_lookup_retryable":
    case "task_fetch_retryable":
    case "consumption_unavailable":
    case "row_fetch_failed":
    case "ledger_error":
      return 503;
    case "send_failed":
    case "send_unconfirmed":
      return 502;
    default:
      return 422;
  }
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

function reject(
  code: SendOneCode,
  reason: string,
  reservationId: string,
  extra?: { audienceCount?: number; ledgerRemaining?: number | null },
): SendOneResponse {
  return {
    status: "rejected",
    code,
    reason,
    sentCount: 0,
    audienceCount: extra?.audienceCount ?? 0,
    ledgerRemaining: extra?.ledgerRemaining ?? null,
    reservationId,
    requestId: null,
  };
}

function retryable(
  code: SendOneCode,
  reason: string,
  reservationId: string,
): SendOneResponse {
  return {
    status: "retryable",
    code,
    reason,
    sentCount: 0,
    audienceCount: 0,
    ledgerRemaining: null,
    reservationId,
    requestId: null,
  };
}

/**
 * 指定 1 件だけを送る。対象以外は構造的に送れない（走査しない・引数の 1 行のみ）。
 */
export async function sendOneDelivery(
  deps: SendOneDeps,
  req: SendOneRequest,
): Promise<SendOneResponse> {
  const reservationId = typeof req?.reservationId === "string" ? req.reservationId : "";

  const invalid = validateSendOneRequest(req);
  if (invalid) return reject("bad_request", invalid, reservationId);

  const now = deps.now();
  const month = currentLineMonth(now);
  const tolerance = deps.audienceGrowthTolerance ?? DEFAULT_AUDIENCE_GROWTH_TOLERANCE;

  // (a) 配信DB行。Status=Approved かつ 送信済=false 以外は送らない。
  let page: DeliveryPage;
  try {
    page = await deps.repo.fetchPage(req.pageId);
  } catch (err) {
    return retryable(
      "row_fetch_failed",
      `配信DB行の取得に失敗（保留・再試行可）: ${errText(err)}`,
      reservationId,
    );
  }
  if (page.sent) {
    return reject("row_already_sent", "この行は既に送信済み", reservationId);
  }
  if (page.status === "Sending") {
    return reject(
      "row_sending",
      "この行は送信中（二重送信を避けるため受け付けない）",
      reservationId,
    );
  }
  if (page.status !== "Approved") {
    return reject(
      "row_not_approved",
      `配信DB行が承認済みではない（現在: ${page.status || "未設定"}）`,
      reservationId,
    );
  }

  // (b) All Tasks 判定行で承認を確認（第二の防御）。
  const verdict = await verifyApprovalTask(
    deps.approvalTask,
    req.approvalRef,
    deps.ownerEmail,
    deps.approvalJudgments ?? DEFAULT_APPROVAL_JUDGMENTS,
  );
  if (!verdict.ok) {
    if (verdict.retryable) {
      // 「無効」にしない。保留して再試行させる（N-03 / S-02）。
      return retryable(verdict.code, verdict.reason, reservationId);
    }
    await deps.repo.writeError(req.pageId, `承認確認で停止: ${verdict.reason}`).catch(() => {});
    return reject(verdict.code, verdict.reason, reservationId);
  }

  // (c) 配信対象の解釈（空・未知は fail-closed）。
  const audience: AudienceSpec | null = parseAudience(page.audienceRaw);
  if (!audience) {
    const reason = "配信対象が空/未知（fail-closed）";
    await deps.repo.writeError(req.pageId, reason).catch(() => {});
    return reject("audience_unknown", reason, reservationId);
  }
  if (page.format !== "text" && page.format !== "image") {
    const reason = "形式が未設定/未知";
    await deps.repo.writeError(req.pageId, reason).catch(() => {});
    return reject("message_invalid", reason, reservationId);
  }

  const imageUrls = deps.imageUrlsFor(page);
  const built = buildMessages({
    format: page.format,
    body: page.body,
    imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
  });
  if (!built.ok) {
    const reason = `メッセージ不正: ${built.reason}`;
    await deps.repo.writeError(req.pageId, reason).catch(() => {});
    return reject("message_invalid", reason, reservationId);
  }
  const messages: LineMessage[] = built.messages;

  // (c-2) 指紋照合（本文・画像・配信対象）。旧形式（配信対象を含まない pin）は
  //   一致しないため受け付けられない = fail-closed（旧 pin は全件送信経路の遺物）。
  if (!page.contentHash) {
    const reason =
      "承認時のコンテンツハッシュが無い（承認 pin を通っていない・fail-closed）";
    await deps.repo.writeError(req.pageId, reason).catch(() => {});
    return reject("fingerprint_missing", reason, reservationId);
  }
  const currentHash = await computeContentHash({
    format: page.format,
    body: page.body,
    imageUrls,
    audience: audienceFingerprintKey(audience),
  });
  if (!hashesMatch(page.contentHash, currentHash)) {
    const reason =
      "承認後に本文・画像・配信対象のいずれかが変わった（指紋不一致・送信中止）";
    await deps.repo.writeError(req.pageId, reason).catch(() => {});
    return reject("fingerprint_mismatch", reason, reservationId);
  }

  // (d) 対象解決 → 人数判定（承認時比 +10% / 台帳残枠）。
  const targets = await deps.resolveTargets(audience);
  if (targets.kind === "error") {
    const reason = `対象解決失敗: ${targets.reason}`;
    await deps.repo.writeError(req.pageId, reason).catch(() => {});
    return reject("audience_unresolved", reason, reservationId);
  }
  const audienceCount = targets.estimatedRecipients;

  // validateSendOneRequest が 1 以上の数値であることを既に要求している（型は任意でも
  // 送信経路では必須。ここで再度 fail-closed に倒す）。
  const approvedCount = req.approvalRef.approvedAudienceCount ?? 0;
  if (!audienceCountWithinTolerance(approvedCount, audienceCount, tolerance)) {
    const reason =
      `対象人数が承認時から許容を超えて増えた（承認時 ${approvedCount} → ` +
      `現在 ${audienceCount} / 許容 +${Math.round(tolerance * 100)}%）`;
    await deps.repo.writeError(req.pageId, reason).catch(() => {});
    return reject("audience_count_grew", reason, reservationId, { audienceCount });
  }

  const cap = deps.guardOptions?.cap ?? FREE_TIER_CAP;
  const headroom = deps.guardOptions?.safetyHeadroom ?? DEFAULT_SAFETY_HEADROOM;
  const snapshot = await deps.consumption();
  if (!snapshot.ok || typeof snapshot.totalUsage !== "number") {
    return retryable(
      "consumption_unavailable",
      "LINE の当月消費が取得できない（残枠を判定できないため保留・fail-closed）",
      reservationId,
    );
  }
  let confirmed: number;
  try {
    confirmed = await deps.confirmedConsumption(month);
  } catch (err) {
    return retryable(
      "ledger_error",
      `通数台帳を読めない（保留・再試行可）: ${errText(err)}`,
      reservationId,
    );
  }
  const ledgerRemaining = computeRemaining(
    cap,
    headroom,
    confirmed,
    snapshot.totalUsage,
  );
  if (audienceCount < 1 || audienceCount > ledgerRemaining) {
    const reason =
      `無料枠の残りが足りない（対象 ${audienceCount} 通 / 残枠 ${ledgerRemaining} 通・実効上限 ${cap - headroom}）`;
    await deps.repo.writeError(req.pageId, reason).catch(() => {});
    return reject("ledger_exhausted", reason, reservationId, {
      audienceCount,
      ledgerRemaining,
    });
  }

  // LINE 仕様: customAggregationUnits は multicast のみ（broadcast は非対応）。
  const unit = buildAggregationUnit(audience, now);
  const aggregationUnit =
    targets.kind === "multicast" && isValidAggregationUnit(unit) ? unit : undefined;

  // (e) claim-before-send。原子的に「送信中」を取る（N-06 / N-07）。
  let claim: ReservationClaim;
  try {
    claim = await deps.reservation.claim({
      pageId: req.pageId,
      month,
      reservationId: req.reservationId,
      recipients: audienceCount,
      aggregationUnit,
    });
  } catch (err) {
    return retryable(
      "ledger_error",
      `送信予約を取れない（保留・再試行可）: ${errText(err)}`,
      reservationId,
    );
  }
  if (claim.kind === "duplicate") {
    if (claim.sameReservation && claim.sendState === "sent") {
      // 同一予約の二重到達。再送せず、前回の結果をそのまま返す（冪等）。
      return {
        status: "sent",
        code: "idempotent_sent",
        reason: "同一 reservationId の二重到達（再送せず前回の結果を返す）",
        sentCount: claim.sentCount ?? 0,
        audienceCount,
        ledgerRemaining,
        reservationId,
        requestId: null,
      };
    }
    if (claim.sameReservation && claim.sendState === "failed") {
      return {
        status: "failed",
        code: "idempotent_failed",
        reason: "同一 reservationId の二重到達（前回失敗・自動再送はしない）",
        sentCount: 0,
        audienceCount,
        ledgerRemaining,
        reservationId,
        requestId: null,
      };
    }
    if (claim.sameReservation) {
      // 送信中のまま（並列到達 / 前回が送信途中で落ちた）。再送せず滞留検出へ回す。
      return reject(
        "claim_in_flight",
        "同一 reservationId が送信中（再送しない。滞留は別経路で検出する）",
        reservationId,
        { audienceCount, ledgerRemaining },
      );
    }
    return reject(
      "claim_conflict",
      "この行は別の予約が既に送信を確保している（二重送信を拒否）",
      reservationId,
      { audienceCount, ledgerRemaining },
    );
  }

  // 中間状態（滞留検出のため）。失敗しても送信は続ける（記録の精度の問題）。
  await deps.repo.setStatus(req.pageId, "Sending").catch(() => {});

  // (f) 送信。X-Line-Retry-Key は予約 ID から決定的に導出した UUID（全試行で同一）。
  const maxAttempts = Math.max(1, deps.maxSendAttempts ?? DEFAULT_MAX_SEND_ATTEMPTS);
  const retryKey = await deterministicRetryKey(req.reservationId);

  let outcome = await attemptSend(deps, targets, messages, audienceCount, aggregationUnit, retryKey);
  let attempts = 1;
  while (!outcome.ok && outcome.deliveredRecipients === 0 && attempts < maxAttempts) {
    attempts += 1;
    outcome = await attemptSend(
      deps,
      targets,
      messages,
      audienceCount,
      aggregationUnit,
      retryKey,
    );
  }

  const delivered = outcome.deliveredRecipients;
  const sentAtUtc = deps.now().toISOString();

  // (g) Sent は「成功応答を確認してのみ」。送信数 0、または全員配信で request id が
  //   取れていない場合は Failed（成果物フィールドの有無で成否を判定しない・N-15）。
  const confirmedOk =
    outcome.ok &&
    delivered > 0 &&
    (targets.kind !== "broadcast" || typeof outcome.requestId === "string");

  if (!confirmedOk) {
    const code: SendOneCode =
      outcome.ok && delivered > 0 ? "send_unconfirmed" : "send_failed";
    const reason =
      code === "send_unconfirmed"
        ? "LINE は成功を返したが送信 1 回を指す鍵（request id）が取れなかった（Sent と記録しない・自動再送もしない）"
        : `送信失敗（${attempts} 回試行）: ${outcome.error ?? "unknown"}`;
    await deps.reservation
      .finish({
        pageId: req.pageId,
        month,
        sendState: "failed",
        sentCount: 0,
        lineRequestId: outcome.requestId,
      })
      .catch(() => {});
    await deps.repo
      .writeResult(req.pageId, {
        status: "Failed",
        sentAtUtc,
        summary: `Failed（${audienceLabel(audience)}・対象 ${audienceCount}）`,
        consumed: 0,
        errorDetail: reason,
      })
      .catch(() => {});
    return {
      status: "failed",
      code,
      reason,
      sentCount: 0,
      audienceCount,
      ledgerRemaining,
      reservationId,
      requestId: outcome.requestId ?? null,
    };
  }

  await deps.reservation
    .finish({
      pageId: req.pageId,
      month,
      sendState: "sent",
      sentCount: delivered,
      lineRequestId: outcome.requestId,
    })
    .catch(() => {});

  const status = outcome.partial ? "PartialFail" : "Sent";
  await deps.repo.writeResult(req.pageId, {
    status,
    sentAtUtc,
    summary: `${status}（${audienceLabel(audience)}・実送信 ${delivered}/${audienceCount}）`,
    consumed: delivered,
    errorDetail: outcome.partial ? outcome.error : undefined,
  });

  // 「前回の要求が受理済みだった」ことは記録に残す（今回送ったのではない）。
  const acceptedNote = outcome.alreadyAccepted
    ? "・再試行キーで受理済みと判明（重複送信なし）"
    : "";
  return {
    status: "sent",
    code: "sent",
    reason: `${status}: 実送信 ${delivered}/${audienceCount}（${attempts} 回試行${acceptedNote}）`,
    sentCount: delivered,
    audienceCount,
    ledgerRemaining,
    reservationId,
    requestId: outcome.requestId ?? null,
  };
}

async function attemptSend(
  deps: SendOneDeps,
  targets: ResolvedTargets,
  messages: LineMessage[],
  audienceCount: number,
  aggregationUnit: string | undefined,
  retryKey: string,
) {
  if (targets.kind === "broadcast") {
    return deps.sender.broadcast(messages, audienceCount, aggregationUnit, retryKey);
  }
  if (targets.kind === "multicast") {
    return deps.sender.multicast(targets.batches, messages, aggregationUnit, retryKey);
  }
  return {
    ok: false,
    deliveredRecipients: 0,
    partial: false,
    error: "対象解決の結果が送信可能な形ではない（fail-closed）",
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
