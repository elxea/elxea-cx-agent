/**
 * 承認 1 点化の pin / approve コア（段1a-3・2026-09-22）。
 *
 * 何が変わったか（Boss 判断 Tier 1・2026-09-22）:
 *   **承認の権威は All Tasks の判定行 1 か所**に移した。配信DB行の people 列
 *   「承認者」「担当者」は **判定に使わない**（列は残すが読まない）。
 *   旧 2 点承認（配信DB行の承認者 != 担当者）は 1 点化では誰も埋めない項目になり、
 *   門として機能せず常時 fail（`independent approver がいない` で永久 422）になったため撤去した。
 *   経緯: 段1 結合検証 I-C。
 *
 * 2 段構えの意味:
 *   - `pinDeliveryContent`（prepare 段）: 本文・画像・配信対象の **指紋を固定** する。
 *     画像は R2 に取り込んで凍結し、そのハッシュを「コンテンツハッシュ」列に書く。
 *     **Status は動かさない（Draft のまま）**。人はまだ承認していない。
 *   - `approveDelivery`（reserve 段）: All Tasks 判定行を検証し（判定=承認 / 最終編集者=owner）、
 *     **pin 時の指紋と現在値が一致する**ことを確かめてから Status=Approved を機械が書く。
 *     pin 後に本文・画像・配信対象が変わっていたら承認しない（`content_changed_since_pin`）。
 *
 * なぜ順序が安全性そのものか:
 *   pin が Status を動かしてしまうと「人が承認する前に Approved の行が存在する」窓が開く。
 *   send-one は Status=Approved を第一の門にしているため、その窓は事故の入口になる。
 *   よって Status を書くのは **判定行の検証を通った後だけ** に限定する。
 *
 * 承認スナップショット（approvedAudienceCount / audienceKey）は **Notion に書かない**。
 *   配信DBに「通数見積」「承認日時」列は存在せず（prod / staging 双方の実スキーマで確認・
 *   2026-09-22）、存在しない列への PATCH は Notion 400 になる。承認時刻の正本は判定行の
 *   `last_edited_time`、人数スナップショットの受け渡しは **この API の応答**（呼び出し側が
 *   send-one の `approvalRef` に載せる）。同じ値を 2 か所に持たない。
 *
 * このモジュールは I/O を注入で受け取り、実 Notion / 実 LINE / 実 R2 には触れない
 *   （配線は delivery-runtime.ts）。送信は一切しない（Status を Approved にするだけ）。
 */

import {
  parseAudience,
  audienceFingerprintKey,
  type AudienceSpec,
} from "./delivery-audience";
import { computeContentHash, hashesMatch } from "./content-hash";
import type { DeliveryPage } from "./delivery-repository";
import {
  verifyApprovalTask,
  DEFAULT_APPROVAL_JUDGMENTS,
  type ApprovalRejectCode,
  type ApprovalRetryCode,
  type ApprovalTaskPort,
} from "./delivery-approval-task";

// ---------------------------------------------------------------------------
// 入出力
// ---------------------------------------------------------------------------

/** 承認 pin（prepare 段）の要求。 */
export interface PinRequest {
  /** 配信DB（配信コンテンツ）の行 id。 */
  pageId: string;
}

/**
 * 承認確定（reserve 段）の要求。
 *
 * `approvalRef` は Mac 側の承認監視が「判定=承認を初めて観測した時点」で固定した値。
 * `approvedAudienceCount` は含まない（人数は approve が送信経路と同じ resolver で実測し、
 * 応答で返す = +10% 判定の基準になる値を 1 か所で決める）。
 */
export interface ApproveRequest {
  pageId: string;
  approvalRef: {
    taskPageId: string;
    approvedEditorEmail: string;
    approvedEditedTime: string;
  };
}

/** pin / approve の機械可読な理由コード。 */
export type DeliveryApproveCode =
  | "pinned"
  | "approved"
  | "bad_request"
  | "row_fetch_failed"
  | "row_already_sent"
  | "row_sending"
  | "row_already_approved"
  | "pin_not_allowed_in_status"
  | "audience_unknown"
  | "message_invalid"
  | "image_blocked"
  | "image_config_invalid"
  | "audience_unresolved"
  | "audience_empty"
  | "pin_missing"
  | "content_changed_since_pin"
  | "pin_write_failed"
  | "status_write_failed"
  | ApprovalRejectCode
  | ApprovalRetryCode;

/** 承認スナップショット（応答で返す値。Notion には書かない）。 */
export interface ApprovalSnapshot {
  /** 指紋（本文 + 恒久R2画像URL群 + 配信対象）。 */
  contentHash: string;
  /** 配信対象人数（送信経路と同じ resolver の実測値・N-12 の基準）。 */
  approvedAudienceCount: number;
  /** 指紋に載せた配信対象の識別子（"all" / "persona:xxx" / "allowlist"）。 */
  audienceKey: string;
}

/** pin / approve の結果。`retryable=true` は「保留して再試行してよい」（503 相当）。 */
export type DeliveryApproveResult =
  | ({ ok: true; code: "pinned" | "approved" } & ApprovalSnapshot)
  | { ok: false; retryable: boolean; code: DeliveryApproveCode; reason: string };

/** 配信DB行の読み書きポート（pin はハッシュ、approve は Status だけを書く）。 */
export interface ApproveRepoPort {
  fetchPage(pageId: string): Promise<DeliveryPage>;
  /** 「コンテンツハッシュ」だけを書く（Status は動かさない）。 */
  pinContentSnapshot(pageId: string, contentHash: string): Promise<void>;
  /** Status=Approved だけを書く（判定行の検証を通った後のみ呼ぶ）。 */
  markApproved(pageId: string): Promise<void>;
  /** 拒否理由を行に残す（黙って止まらない）。Status は変えない。 */
  writeError(pageId: string, reason: string): Promise<void>;
}

/** 画像取込の結果（pin のみが使う）。 */
export type ImageIngestResult =
  | { ok: true; urls: string[] }
  | { ok: false; code: "image_blocked" | "image_config_invalid"; reason: string };

/** 配信対象人数の解決結果。 */
export type AudienceCountResult =
  | { ok: true; count: number }
  | { ok: false; reason: string };

/** 注入依存。 */
export interface DeliveryApproveDeps {
  repo: ApproveRepoPort;
  approvalTask: ApprovalTaskPort;
  /** 照合に使う唯一のメール（env DELIVERY_OWNER_EMAIL。未設定は全拒否）。 */
  ownerEmail?: string;
  /** 承認と見なす「判定」select の完全一致 allowlist（未指定は既定 ["承認"]）。 */
  approvalJudgments?: readonly string[];
  /** 配信対象人数（送信経路と同じ resolver を通す）。 */
  resolveAudienceCount(audience: AudienceSpec): Promise<AudienceCountResult>;
  /** Notion 一時URL → R2 恒久URL の取込（pin のみ）。 */
  ingestImages(pageId: string, sourceUrls: string[]): Promise<ImageIngestResult>;
  /** 恒久 R2 公開URL 群の決定的再構成（approve / send-one と同一の組み立て）。 */
  imageUrlsFor(page: DeliveryPage): string[];
}

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

function reject(
  code: DeliveryApproveCode,
  reason: string,
): DeliveryApproveResult {
  return { ok: false, retryable: false, code, reason };
}

function retryable(
  code: DeliveryApproveCode,
  reason: string,
): DeliveryApproveResult {
  return { ok: false, retryable: true, code, reason };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 本文・画像・配信対象が揃っているか（pin / approve 共通・fail-closed）。 */
type ContentCheck =
  | { ok: true; audience: AudienceSpec; format: "text" | "image" }
  | { ok: false; code: DeliveryApproveCode; reason: string };

function validateContent(page: DeliveryPage, imageUrls: string[]): ContentCheck {
  const audience = parseAudience(page.audienceRaw);
  if (!audience) {
    return {
      ok: false,
      code: "audience_unknown",
      reason: "配信対象が空/未知（fail-closed）",
    };
  }
  if (page.format !== "text" && page.format !== "image") {
    return { ok: false, code: "message_invalid", reason: "形式が未設定/未知" };
  }
  if (page.format === "text" && !(page.body ?? "").trim()) {
    return {
      ok: false,
      code: "message_invalid",
      reason: "本文が空（本文か画像のどちらかが必須）",
    };
  }
  if (page.format === "image" && imageUrls.length === 0) {
    return {
      ok: false,
      code: "message_invalid",
      reason: "画像が空（画像をドラッグしてください）",
    };
  }
  return { ok: true, audience, format: page.format };
}

// ---------------------------------------------------------------------------
// pin（prepare 段）
// ---------------------------------------------------------------------------

/**
 * 本文・画像・配信対象の指紋を固定する（**Status は変えない**）。
 *
 * 受け付けるのは **Status=Draft（未承認）の行だけ**。Draft の間は人がまだ承認していない
 * = 何も確定していないので **再 pin は上書き可**。承認後（Approved / Sending / Sent / Failed）は
 * 409 `pin_not_allowed_in_status` で拒否する（指紋の上書きで未承認の内容が
 * approve / send-one の指紋照合を通るのを防ぐ）。承認後に内容を直したい場合は
 * Status を Draft に戻す（= 人の操作）ことが必要で、承認後の本文変更自体は
 * approve の指紋照合と send-one 側の再照合が引き続き弾く。
 */
export async function pinDeliveryContent(
  deps: DeliveryApproveDeps,
  req: PinRequest,
): Promise<DeliveryApproveResult> {
  if (typeof req?.pageId !== "string" || req.pageId.trim().length === 0) {
    return reject("bad_request", "pageId が必須");
  }

  let page: DeliveryPage;
  try {
    page = await deps.repo.fetchPage(req.pageId);
  } catch (err) {
    return retryable(
      "row_fetch_failed",
      `配信DB行の取得に失敗（保留・再試行可）: ${errText(err)}`,
    );
  }

  // 送信済みの行は pin し直さない（確定済みの指紋を動かさない）。
  if (page.sent) {
    return reject("row_already_sent", "この行は既に送信済み（pin しない）");
  }
  // pin は **Draft（未承認）の行だけ** 受け付ける。
  // 承認後（Approved / Sending / Sent / Failed）に再 pin を許すと、人が承認した内容とは
  // 別の本文で指紋だけを上書きでき、approve の指紋照合も send-one の再照合も
  // 「一致」と答えてしまう（= 未承認の内容が送信経路を通る）。Status は動かさず 409 で拒す。
  if (page.status !== "Draft") {
    return reject(
      "pin_not_allowed_in_status",
      `Status=${page.status || "(空)"} の行は pin できない（pin は Draft のみ）。` +
        "内容を直すなら Status を Draft に戻して prepare からやり直す",
    );
  }

  // 画像は Notion 一時URL → R2 恒久URL に取り込んで凍結する（TOCTOU 対策）。
  const srcUrls = page.imageSourceUrls ?? [];
  let r2Urls: string[] = [];
  if (srcUrls.length > 0) {
    const ingest = await deps.ingestImages(req.pageId, srcUrls);
    if (!ingest.ok) {
      await deps.repo.writeError(req.pageId, ingest.reason).catch(() => {});
      return reject(ingest.code, ingest.reason);
    }
    r2Urls = ingest.urls;
  }

  const content = validateContent(page, r2Urls);
  if (!content.ok) {
    await deps.repo.writeError(req.pageId, content.reason).catch(() => {});
    return reject(content.code, content.reason);
  }

  // 承認時点の配信対象人数（+10% 判定の基準）。数えられないまま pin すると基準が無くなる。
  const counted = await deps.resolveAudienceCount(content.audience);
  if (!counted.ok) {
    return retryable(
      "audience_unresolved",
      `配信対象の人数を数えられない（保留・再試行可）: ${counted.reason}`,
    );
  }
  if (!Number.isInteger(counted.count) || counted.count < 1) {
    return reject(
      "audience_empty",
      "配信対象の人数が 0（送る相手がいない・fail-closed）",
    );
  }

  const audienceKey = audienceFingerprintKey(content.audience);
  const contentHash = await computeContentHash({
    format: content.format,
    body: page.body,
    imageUrls: r2Urls,
    audience: audienceKey,
  });

  try {
    await deps.repo.pinContentSnapshot(req.pageId, contentHash);
  } catch (err) {
    return retryable(
      "pin_write_failed",
      `コンテンツハッシュの保存に失敗（保留・再試行可）: ${errText(err)}`,
    );
  }

  return {
    ok: true,
    code: "pinned",
    contentHash,
    approvedAudienceCount: counted.count,
    audienceKey,
  };
}

// ---------------------------------------------------------------------------
// approve（reserve 段）
// ---------------------------------------------------------------------------

/**
 * All Tasks 判定行の承認を確かめ、pin 時の指紋と一致していれば Status=Approved を書く。
 *
 * 判定順（順序そのものが安全性）:
 *   a. 配信DB行を読む（送信済み / 送信中は受け付けない）
 *   b. pin されているか（コンテンツハッシュが空なら prepare を通っていない）
 *   c. All Tasks 判定行の検証（判定=承認 / 最終編集者=owner。メール解決の一時失敗は保留）
 *   d. 指紋照合（pin 後に本文・画像・配信対象が変わっていたら承認しない）
 *   e. 配信対象人数の実測（応答で返す = 送信直前の +10% 判定の基準）
 *   f. Status=Approved（ここだけが機械の書き込み）
 *
 * 配信DB行の people 列「承認者」「担当者」は **読まない**（1 点化・Boss 判断 2026-09-22）。
 */
export async function approveDelivery(
  deps: DeliveryApproveDeps,
  req: ApproveRequest,
): Promise<DeliveryApproveResult> {
  if (typeof req?.pageId !== "string" || req.pageId.trim().length === 0) {
    return reject("bad_request", "pageId が必須");
  }
  const ref = req?.approvalRef;
  const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (!ref || typeof ref !== "object") {
    return reject("bad_request", "approvalRef が必須（承認の権威は All Tasks 判定行）");
  }
  if (!nonEmpty(ref.taskPageId)) return reject("bad_request", "approvalRef.taskPageId が必須");
  if (!nonEmpty(ref.approvedEditorEmail))
    return reject("bad_request", "approvalRef.approvedEditorEmail が必須");
  if (!nonEmpty(ref.approvedEditedTime))
    return reject("bad_request", "approvalRef.approvedEditedTime が必須");

  // (a) 配信DB行。
  let page: DeliveryPage;
  try {
    page = await deps.repo.fetchPage(req.pageId);
  } catch (err) {
    return retryable(
      "row_fetch_failed",
      `配信DB行の取得に失敗（保留・再試行可）: ${errText(err)}`,
    );
  }
  if (page.sent) {
    return reject("row_already_sent", "この行は既に送信済み");
  }
  if (page.status === "Sending") {
    return reject("row_sending", "この行は送信中（承認を動かさない）");
  }

  // (b) pin 済みか。prepare（pin）を通っていない行は承認しない。
  if (!page.contentHash || page.contentHash.trim().length === 0) {
    const reason =
      "承認時のコンテンツハッシュが無い（先に POST /api/delivery/pin を通すこと・fail-closed）";
    await deps.repo.writeError(req.pageId, reason).catch(() => {});
    return reject("pin_missing", reason);
  }

  // (c) All Tasks 判定行（承認の権威はここ 1 か所）。
  const verdict = await verifyApprovalTask(
    deps.approvalTask,
    {
      taskPageId: ref.taskPageId,
      approvedEditorEmail: ref.approvedEditorEmail,
      approvedEditedTime: ref.approvedEditedTime,
    },
    deps.ownerEmail,
    deps.approvalJudgments ?? DEFAULT_APPROVAL_JUDGMENTS,
  );
  if (!verdict.ok) {
    if (verdict.retryable) {
      // メール解決・判定行取得の一時失敗は「無効」にしない（N-03 / S-02）。
      return retryable(verdict.code, verdict.reason);
    }
    await deps.repo
      .writeError(req.pageId, `承認確認で停止: ${verdict.reason}`)
      .catch(() => {});
    return reject(verdict.code, verdict.reason);
  }

  // (d) 指紋照合。pin 後に本文・画像・配信対象が変わっていたら承認しない。
  const imageUrls = deps.imageUrlsFor(page);
  const content = validateContent(page, imageUrls);
  if (!content.ok) {
    await deps.repo.writeError(req.pageId, content.reason).catch(() => {});
    return reject(content.code, content.reason);
  }
  const audienceKey = audienceFingerprintKey(content.audience);
  const currentHash = await computeContentHash({
    format: content.format,
    body: page.body,
    imageUrls,
    audience: audienceKey,
  });
  if (!hashesMatch(page.contentHash, currentHash)) {
    const reason =
      "pin 後に本文・画像・配信対象のいずれかが変わった（指紋不一致・承認しない。" +
      "直したら prepare からやり直す）";
    await deps.repo.writeError(req.pageId, reason).catch(() => {});
    return reject("content_changed_since_pin", reason);
  }

  // (e) 配信対象人数の実測（応答で返す値 = 送信直前の +10% 判定の基準）。
  const counted = await deps.resolveAudienceCount(content.audience);
  if (!counted.ok) {
    return retryable(
      "audience_unresolved",
      `配信対象の人数を数えられない（保留・再試行可）: ${counted.reason}`,
    );
  }
  if (!Number.isInteger(counted.count) || counted.count < 1) {
    const reason = "配信対象の人数が 0（送る相手がいない・fail-closed）";
    await deps.repo.writeError(req.pageId, reason).catch(() => {});
    return reject("audience_empty", reason);
  }

  // (f) ここだけが機械の書き込み（人の承認を判定行で確認した後）。
  if (page.status !== "Approved") {
    try {
      await deps.repo.markApproved(req.pageId);
    } catch (err) {
      return retryable(
        "status_write_failed",
        `Status=Approved の書き込みに失敗（保留・再試行可）: ${errText(err)}`,
      );
    }
  }

  return {
    ok: true,
    code: "approved",
    contentHash: page.contentHash,
    approvedAudienceCount: counted.count,
    audienceKey,
  };
}

/** HTTP ステータスへの写像（route が使う）。 */
export function httpStatusForApprove(
  res: DeliveryApproveResult,
): 200 | 400 | 409 | 422 | 503 {
  if (res.ok) return 200;
  if (res.code === "bad_request") return 400;
  if (
    res.code === "row_already_sent" ||
    res.code === "row_sending" ||
    res.code === "pin_not_allowed_in_status"
  )
    return 409;
  return res.retryable ? 503 : 422;
}
