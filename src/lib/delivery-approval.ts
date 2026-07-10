/**
 * 承認ガード（純粋・I/O なし）。
 *
 * 設計: 「Notion駆動 LINE配信 設計確定版 v1.0」§4 / Must-fix 10
 *   承認者 != 著者（担当者）をサーバ側で検証（最低限 自己承認検知）。
 *
 * Notion の people プロパティは user id の配列。担当者=著者側、承認者=承認側。
 * 「独立した承認者が 1 人もいない」= 自己承認とみなし送信不可に倒す。
 */

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
