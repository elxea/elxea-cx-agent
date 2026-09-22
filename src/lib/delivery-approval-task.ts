/**
 * All Tasks「判定」行による承認確認（配信本体側の第二の防御）。
 *
 * 位置づけ（プラン v6.2 §4-2 の 2）:
 *   人の承認は All Tasks の判定行 1 か所に置く。その「判定=承認を初めて見た時点で
 *   最終編集者を固定する」関門は **Mac 側の承認監視スクリプトが主**で、ここはその
 *   固定値を受け取って送信直前にもう一度突き合わせる **第二の防御**である。
 *   単独で他者承認を見抜くことはできない（`last_edited_by` はページ全体で 1 人）。
 *
 * このモジュールは I/O を注入で受け取り、判定そのものは純粋関数に寄せる。
 * 実送信・Notion 書き込みは一切しない（読み取りのみ）。
 *
 * fail-closed の向き:
 *   - 判定が承認系でない / 最終編集者のメールが owner と一致しない → **無効（rejected）**
 *   - メール解決が一時的に失敗した（429 / 5xx / ネットワーク）→ **保留（retryable）**。
 *     「解決できて不一致」のときだけ無効にする（失敗シナリオ N-03 / S-02）。
 *   - owner メールが未設定 → **無効**（既定値を持たない。設定 1 か所に 1 件だけ・N-05）
 */

/** Mac 側（予約登録時）が固定した承認スナップショット。 */
export interface ApprovalRef {
  /** All Tasks の判定行 page id。 */
  taskPageId: string;
  /** 承認を初めて観測した時点の最終編集者メール（Mac 側が固定した値）。 */
  approvedEditorEmail: string;
  /** 同時点の `last_edited_time`（ISO8601）。 */
  approvedEditedTime: string;
  /** 同時点の配信対象人数（+10% 判定の基準・N-12）。 */
  approvedAudienceCount: number;
}

/** 判定行の生の読み取り結果（Notion REST の必要部分だけ）。 */
export interface ApprovalTaskSnapshot {
  /** select「判定」の値（未設定は null）。 */
  judgment: string | null;
  /** `last_edited_by` の user id。 */
  lastEditedById: string | null;
  /** `last_edited_time`（ISO8601）。 */
  lastEditedTime: string | null;
}

/** 承認確認の結果。 */
export type ApprovalTaskVerdict =
  | {
      ok: true;
      /** 承認観測時から最終編集時刻が変わっていたか（記録用）。 */
      editedTimeChanged: boolean;
      /** 解決した最終編集者メール。 */
      editorEmail: string;
    }
  | { ok: false; retryable: false; code: ApprovalRejectCode; reason: string }
  | { ok: false; retryable: true; code: ApprovalRetryCode; reason: string };

export type ApprovalRejectCode =
  | "owner_email_unset"
  | "judgment_not_approved"
  | "editor_missing"
  | "email_empty"
  | "editor_mismatch";

export type ApprovalRetryCode = "email_lookup_retryable" | "task_fetch_retryable";

/** 判定行の読み取り・メール解決のポート（runtime は Notion REST を配線）。 */
export interface ApprovalTaskPort {
  /** 判定行を読む。一時失敗は `RetryableApprovalError` を throw する。 */
  fetchTask(taskPageId: string): Promise<ApprovalTaskSnapshot>;
  /**
   * user id → メール。Notion `GET /v1/users/<id>` の `person.email`。
   * 取得できたが空（integration に user 情報の読み取り capability が無い等）は null を返し、
   * 一時失敗（429 / 5xx / ネットワーク）は `RetryableApprovalError` を throw する。
   */
  resolveUserEmail(userId: string): Promise<string | null>;
}

/** 一時失敗（保留して再試行すべき）を表す明示エラー。 */
export class RetryableApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableApprovalError";
  }
}

/**
 * 「判定」の値が承認系かを判定する（純粋・fail-closed）。
 *
 * 否定・保留系（未承認 / 非承認 / 却下 / 差し戻し / 修正して / 保留）を **先に** 弾く。
 * 「未承認」は文字列として「承認」を含むため、含有判定だけでは通ってしまう。
 */
export function isApprovedJudgment(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  const v = raw.normalize("NFKC").replace(/[\s　]/g, "");
  if (v.length === 0) return false;
  if (
    /(未|非|不|要)承認|承認(しない|不要|不可|待ち|取消|取り消)|却下|差し戻|修正|保留|reject|pending|hold/i.test(
      v,
    )
  ) {
    return false;
  }
  if (/^approved?$/i.test(v)) return true;
  return v.startsWith("承認");
}

/** メール比較の正規化（前後空白除去 + 小文字化。ドメインの大小を無視する）。 */
export function normalizeEmail(raw: string | null | undefined): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/**
 * 判定行を読み直して承認を確認する。
 *
 * @param ownerEmail 照合に使う唯一のメール（env DELIVERY_OWNER_EMAIL・既定なし）。
 */
export async function verifyApprovalTask(
  port: ApprovalTaskPort,
  ref: ApprovalRef,
  ownerEmail: string | undefined,
): Promise<ApprovalTaskVerdict> {
  const owner = normalizeEmail(ownerEmail);
  if (owner.length === 0) {
    return {
      ok: false,
      retryable: false,
      code: "owner_email_unset",
      reason:
        "DELIVERY_OWNER_EMAIL が未設定（承認者の照合先が無いため送信不可・fail-closed）",
    };
  }

  let task: ApprovalTaskSnapshot;
  try {
    task = await port.fetchTask(ref.taskPageId);
  } catch (err) {
    if (err instanceof RetryableApprovalError) {
      return {
        ok: false,
        retryable: true,
        code: "task_fetch_retryable",
        reason: `判定行の取得が一時的に失敗（保留・再試行可）: ${err.message}`,
      };
    }
    throw err;
  }

  if (!isApprovedJudgment(task.judgment)) {
    return {
      ok: false,
      retryable: false,
      code: "judgment_not_approved",
      reason: `判定が承認ではない（現在値: ${task.judgment ?? "未設定"}）`,
    };
  }

  if (!task.lastEditedById) {
    return {
      ok: false,
      retryable: false,
      code: "editor_missing",
      reason: "判定行の最終編集者が取得できない（fail-closed）",
    };
  }

  let email: string | null;
  try {
    email = await port.resolveUserEmail(task.lastEditedById);
  } catch (err) {
    if (err instanceof RetryableApprovalError) {
      return {
        ok: false,
        retryable: true,
        code: "email_lookup_retryable",
        reason: `最終編集者のメール解決が一時的に失敗（保留・再試行可）: ${err.message}`,
      };
    }
    throw err;
  }

  const resolved = normalizeEmail(email);
  if (resolved.length === 0) {
    // 「解決できて空」= capability 不足等。無効理由を 3 値のうち「メール空」として残す。
    return {
      ok: false,
      retryable: false,
      code: "email_empty",
      reason:
        "最終編集者のメールが空（Notion 接続にユーザー情報の読み取り権限が無い可能性・fail-closed）",
    };
  }
  if (resolved !== owner) {
    return {
      ok: false,
      retryable: false,
      code: "editor_mismatch",
      reason: "判定行の最終編集者が承認者本人ではない（不一致・fail-closed）",
    };
  }

  // 承認観測時のスナップショットと時刻がずれていても、編集者が owner で
  // あり（上で確認済み）かつ指紋が一致する限り可とする（呼び出し側が指紋を照合する）。
  const editedTimeChanged =
    (task.lastEditedTime ?? "") !== (ref.approvedEditedTime ?? "");

  // 承認スナップショットの編集者が owner 以外なら、Mac 側の固定値そのものが無効。
  if (normalizeEmail(ref.approvedEditorEmail) !== owner) {
    return {
      ok: false,
      retryable: false,
      code: "editor_mismatch",
      reason:
        "承認スナップショットの編集者が承認者本人ではない（Mac 側の固定値が無効・fail-closed）",
    };
  }

  return { ok: true, editedTimeChanged, editorEmail: resolved };
}
