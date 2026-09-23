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
 *   - 承認確認用の接続 (NOTION_APPROVAL_TOKEN) が未設定 / 無効 / 判定行が接続に共有されて
 *     いない（Notion 404）→ **無効（設定エラー・再試行しない）**。配信DB用の NOTION_TOKEN へ
 *     切り替えない（案B・circl-qa 2026-09-23）
 *   - 読んだ判定行の親が All Tasks でない → **無効**
 *   - 判定行が「いま承認しようとしている配信行」の承認でない（approval_key / URL 不一致）→ **無効**
 */

/**
 * 判定行が属すべき All Tasks（正本はここ 1 か所）。
 * 2022-06-28 の API 応答は parent.database_id、新しい版は parent.data_source_id を返すため両方持つ。
 */
export const ALL_TASKS_DATABASE_ID = "50adc342-6a7f-4aff-bbfb-677722369486";
export const ALL_TASKS_DATA_SOURCE_ID = "1c95f66a-67bd-4cd8-aae6-70ed9c3c821d";

/**
 * 判定行の Details に載る機械の鍵の接頭辞。
 * パイプライン側 (~/.config/admin-pipeline scripts/line_delivery_approval.py) が
 * `approval_key=elxea-line-delivery:<env>:<配信行 page id>` の形で書く。
 */
export const DELIVERY_APPROVAL_KEY_PREFIX = "elxea-line-delivery";

/** Mac 側（予約登録時）が固定した承認スナップショット。 */
export interface ApprovalRef {
  /** All Tasks の判定行 page id。 */
  taskPageId: string;
  /** 承認を初めて観測した時点の最終編集者メール（Mac 側が固定した値）。 */
  approvedEditorEmail: string;
  /** 同時点の `last_edited_time`（ISO8601）。 */
  approvedEditedTime: string;
  /**
   * 同時点の配信対象人数（+10% 判定の基準・N-12）。
   * **send-one では必須**（`validateSendOneRequest` が 1 以上を要求する）。
   * approve 経路は人数を自分で実測して応答で返すため渡さない（任意）。
   * `verifyApprovalTask` はこの値を判定に使わない。
   */
  approvedAudienceCount?: number;
}

/** 判定行の生の読み取り結果（Notion REST の必要部分だけ）。 */
export interface ApprovalTaskSnapshot {
  /** select「判定」の値（未設定は null）。 */
  judgment: string | null;
  /** `last_edited_by` の user id。 */
  lastEditedById: string | null;
  /** `last_edited_time`（ISO8601）。 */
  lastEditedTime: string | null;
  /** 親 database id（API 2022-06-28 の parent.database_id）。無ければ null。 */
  parentDatabaseId: string | null;
  /** 親 data source id（新しい API 版の parent.data_source_id）。無ければ null。 */
  parentDataSourceId: string | null;
  /** Details 列の平文（`approval_key=...` の行を含む）。 */
  details: string;
  /** URL 列の平文（配信行の URL。空なら ""）。 */
  targetUrl: string;
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
  | ApprovalConfigCode
  | "task_parent_mismatch"
  | "task_link_mismatch"
  | "owner_email_unset"
  | "judgment_not_approved"
  | "editor_missing"
  | "email_empty"
  | "editor_mismatch";

export type ApprovalRetryCode = "email_lookup_retryable" | "task_fetch_retryable";

/** 設定エラー（再試行しても直らない）の区分。 */
export type ApprovalConfigCode =
  | "approval_token_unset"
  | "approval_token_invalid"
  | "task_not_shared";

/** 判定行の読み取り・メール解決のポート（runtime は Notion REST を配線）。 */
export interface ApprovalTaskPort {
  /**
   * 判定行を読む。一時失敗は `RetryableApprovalError`、設定エラー（token 未設定・
   * 無効・判定行が接続に共有されていない）は `ApprovalConfigError` を throw する。
   */
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

/** 設定エラー（token 未設定・無効・共有漏れ）。再試行では直らないので保留にしない。 */
export class ApprovalConfigError extends Error {
  constructor(
    readonly code: ApprovalConfigCode,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalConfigError";
  }
}

/** Notion id の比較用正規化（ハイフン除去 + 小文字）。 */
export function normalizeNotionId(raw: string | null | undefined): string {
  return typeof raw === "string" ? raw.replace(/-/g, "").trim().toLowerCase() : "";
}

/** 判定行の親が All Tasks か（database_id / data_source_id のどちらかが一致）。 */
export function isAllTasksParent(task: ApprovalTaskSnapshot): boolean {
  const db = normalizeNotionId(task.parentDatabaseId);
  const ds = normalizeNotionId(task.parentDataSourceId);
  return (
    (db.length > 0 && db === normalizeNotionId(ALL_TASKS_DATABASE_ID)) ||
    (ds.length > 0 && ds === normalizeNotionId(ALL_TASKS_DATA_SOURCE_ID))
  );
}

/**
 * 判定行が配信行 `deliveryPageId` の承認かを確かめる（純粋・fail-closed）。
 *
 * 正とするのは Details の `approval_key=elxea-line-delivery:<env>:<page id>`
 * （パイプラインが作る機械の鍵。二重起票防止の照合にも使う唯一の鍵）。
 *   - approval_key が 1 つも無い → 不一致
 *   - 複数ある場合は **すべて** が同じ配信行を指すこと（手で書き足された鍵で通さない）
 * URL 列は補助: Notion の page id（32 桁 hex）が読み取れる場合、その最後の id も一致を要求する
 * （空なら approval_key だけで判定。パイプラインは target_url が空だと URL 列を省略する）。
 * `<env>` 部分は照合しない（Worker 側に同じ語彙の環境名を持たないため）。
 */
export function checkApprovalTaskLink(
  task: ApprovalTaskSnapshot,
  deliveryPageId: string,
): { ok: true } | { ok: false; reason: string } {
  const expected = normalizeNotionId(deliveryPageId);
  if (expected.length === 0) {
    return { ok: false, reason: "照合先の配信行 id が空（fail-closed）" };
  }
  const keys = [...(task.details ?? "").matchAll(/approval_key=(\S+)/g)].map((m) => m[1]);
  if (keys.length === 0) {
    return { ok: false, reason: "判定行に approval_key が無い（どの配信行の承認か確かめられない）" };
  }
  for (const key of keys) {
    const parts = key.split(":");
    if (parts.length !== 3 || parts[0] !== DELIVERY_APPROVAL_KEY_PREFIX) {
      return { ok: false, reason: "判定行の approval_key が LINE 配信の形式ではない" };
    }
    if (normalizeNotionId(parts[2]) !== expected) {
      return { ok: false, reason: "判定行の approval_key が別の配信行を指している" };
    }
  }
  const urlIds = (task.targetUrl ?? "").toLowerCase().match(/[0-9a-f]{32}/g);
  if (urlIds && urlIds.length > 0 && urlIds[urlIds.length - 1] !== expected) {
    return { ok: false, reason: "判定行の URL 列が別の配信行を指している" };
  }
  return { ok: true };
}

/**
 * 承認と見なす「判定」select の **実オプション名**（完全一致 allowlist・正本はここ 1 か所）。
 *
 * なぜ allowlist か: 以前は `startsWith("承認")` の許容判定だったため、否定リストに無い
 * 将来のオプション（例「承認前確認」「承認予定」）が**承認として通ってしまう**。
 * select に選択肢が 1 つ増えるだけで配信が飛ぶ構造は、取り消しの効かない処理には置けない
 * （QA MID-5）。よって「一致したものだけ通す」に倒す。
 *
 * 差し替え方: All Tasks の「判定」select の実オプション名は段1-B で実地確認する。
 * ずれていたらこの定数 1 か所（または env `DELIVERY_APPROVAL_JUDGMENTS`）を直す。
 * 値は NFKC 正規化 + 空白除去した形で書く（比較側と同じ正規化を通す）。
 */
export const DEFAULT_APPROVAL_JUDGMENTS: readonly string[] = ["承認"];

/** 判定値の比較用正規化（NFKC + 全角/半角空白除去）。allowlist 側にも同じものを通す。 */
function normalizeJudgment(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFKC").replace(/[\s　]/g, "");
}

/**
 * env `DELIVERY_APPROVAL_JUDGMENTS`（カンマ区切り）を allowlist として読む。
 * 未設定・空・実質空は既定（`DEFAULT_APPROVAL_JUDGMENTS`）に倒す = 緩めない方向の既定。
 */
export function parseApprovalJudgments(raw: string | null | undefined): string[] {
  const parsed = (typeof raw === "string" ? raw.split(",") : [])
    .map((v) => normalizeJudgment(v))
    .filter((v) => v.length > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_APPROVAL_JUDGMENTS];
}

/**
 * 「判定」の値が承認かを判定する（純粋・fail-closed）。
 *
 * **完全一致 allowlist**。allowlist に無い値はすべて承認ではない（未知の新オプションは通さない）。
 * 否定・保留系（未承認 / 却下 / 差し戻し / 保留 …）は allowlist に無いので自動的に落ちる。
 * さらに二重の安全として、allowlist が誤って否定語を含むよう設定された場合でも弾く
 * （env の設定ミスが「未承認で配信」に化けないようにする）。
 */
export function isApprovedJudgment(
  raw: string | null | undefined,
  allowlist: readonly string[] = DEFAULT_APPROVAL_JUDGMENTS,
): boolean {
  const v = normalizeJudgment(raw);
  if (v.length === 0) return false;
  // 設定ミスの保険: 否定・保留系の語を含む値は allowlist にあっても承認にしない。
  if (
    /(未|非|不|要)承認|承認(しない|不要|不可|待ち|取消|取り消|前|予定)|却下|差し戻|修正|保留|reject|pending|hold/i.test(
      v,
    )
  ) {
    return false;
  }
  return allowlist.some((allowed) => normalizeJudgment(allowed) === v);
}

/** メール比較の正規化（前後空白除去 + 小文字化。ドメインの大小を無視する）。 */
export function normalizeEmail(raw: string | null | undefined): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

/**
 * 判定行を読み直して承認を確認する。
 *
 * @param ownerEmail 照合に使う唯一のメール（env DELIVERY_OWNER_EMAIL・既定なし）。
 * @param opts.deliveryPageId いま承認・送信しようとしている配信行（呼び出し側の req.pageId）。
 *   判定行がこの行の承認であることを確かめる（別件: 第二の防御の強化）。
 */
export async function verifyApprovalTask(
  port: ApprovalTaskPort,
  ref: ApprovalRef,
  ownerEmail: string | undefined,
  opts: { deliveryPageId: string; approvalJudgments?: readonly string[] },
): Promise<ApprovalTaskVerdict> {
  const approvalJudgments = opts.approvalJudgments ?? DEFAULT_APPROVAL_JUDGMENTS;
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
    if (err instanceof ApprovalConfigError) {
      return configRejected(err);
    }
    throw err;
  }

  // 判定の値を読む前に「どこの行か」を確かめる（他 DB・他の配信行の値で判断しない）。
  if (!isAllTasksParent(task)) {
    return {
      ok: false,
      retryable: false,
      code: "task_parent_mismatch",
      reason: "判定行が All Tasks の行ではない（fail-closed）",
    };
  }
  const link = checkApprovalTaskLink(task, opts.deliveryPageId);
  if (!link.ok) {
    return {
      ok: false,
      retryable: false,
      code: "task_link_mismatch",
      reason: `判定行がこの配信行の承認ではない: ${link.reason}（fail-closed）`,
    };
  }

  if (!isApprovedJudgment(task.judgment, approvalJudgments)) {
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
    if (err instanceof ApprovalConfigError) {
      return configRejected(err);
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

/** 設定エラーを「無効・再試行しない」の判定に写す。 */
function configRejected(err: ApprovalConfigError): ApprovalTaskVerdict {
  return {
    ok: false,
    retryable: false,
    code: err.code,
    reason: `承認確認の設定エラー（再試行しない）: ${err.message}`,
  };
}
