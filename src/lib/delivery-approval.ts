/**
 * 承認ガード（純粋・I/O なし）。
 *
 * 設計: 「Notion駆動 LINE配信 設計確定版 v1.0」§4 / Must-fix 10
 *   承認者 != 著者（担当者）をサーバ側で検証（最低限 自己承認検知）。
 *
 * Notion の people プロパティは user id の配列。担当者=著者側、承認者=承認側。
 * 「独立した承認者が 1 人もいない」= 自己承認とみなし送信不可に倒す。
 */

import { parseTargetEnv } from "./delivery-channel";

/**
 * 独立した承認者が存在するか。
 *
 * true の条件: 承認者が 1 人以上いて、かつ担当者集合に含まれない承認者が
 * 少なくとも 1 人いること。
 *
 * false（自己承認 → 送信不可）:
 *   - 承認者が空
 *   - すべての承認者が担当者を兼ねている
 */
export function hasIndependentApprover(
  assignees: string[],
  approvers: string[],
): boolean {
  if (!Array.isArray(approvers) || approvers.length === 0) return false;
  const authors = new Set(assignees ?? []);
  return approvers.some((a) => !authors.has(a));
}

/**
 * 自己承認緩和ポリシー（純粋）。既定は fail-closed（独立承認者を要求）。
 *
 * test（DELIVERY_TARGET_ENV=test / 未設定・不正）:
 *   DELIVERY_ALLOW_SELF_APPROVAL_TEST="true" のときだけ「承認者!=著者」の独立性を免除する。
 *
 * prod（DELIVERY_TARGET_ENV=prod）:
 *   既定は **常に false**（緩和不可・fail-closed）。
 *   ただし明示フラグ DELIVERY_ALLOW_SELF_APPROVAL_PROD="true" のときだけ独立性を免除する。
 *   これは「独立した承認者を人的に置けない一時状況」向けの Tier2 例外ゲート
 *   （Setaka 明示承認・2026-07-25 導入）。フラグ未設定/非 "true" は従来どおり fail-closed に戻り、
 *   チェック本体は削除していない（=フラグを外せば即座に独立承認者必須へ復帰・可逆）。
 *
 * targetEnv の解釈は parseTargetEnv と同一（未設定・不正値は "test"）。
 */
export function selfApprovalRelaxed(env: {
  DELIVERY_TARGET_ENV?: string;
  DELIVERY_ALLOW_SELF_APPROVAL_TEST?: string;
  DELIVERY_ALLOW_SELF_APPROVAL_PROD?: string;
}): boolean {
  if (parseTargetEnv(env.DELIVERY_TARGET_ENV) === "prod") {
    return env.DELIVERY_ALLOW_SELF_APPROVAL_PROD === "true";
  }
  return env.DELIVERY_ALLOW_SELF_APPROVAL_TEST === "true";
}

/**
 * 承認が有効か（送信可否の最終判定・純粋）。
 *
 * - 承認者が 1 人以上いることは **常に必須**（空は false・fail-closed）。
 * - allowSelfApproval=false（既定・prod は常にこちら）:
 *     承認者!=著者 の独立性まで要求する（hasIndependentApprover）。
 * - allowSelfApproval=true（test 緩和が有効なときのみ渡る）:
 *     独立性を免除し、承認者が 1 人以上いれば true（自己承認を許容）。
 */
export function isApprovalAuthorized(
  assignees: string[],
  approvers: string[],
  allowSelfApproval: boolean,
): boolean {
  if (!Array.isArray(approvers) || approvers.length === 0) return false;
  if (allowSelfApproval) return true;
  return hasIndependentApprover(assignees, approvers);
}
