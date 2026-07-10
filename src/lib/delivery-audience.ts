/**
 * 配信対象（audience）の日本語 ↔ enum 変換層（純粋・I/O なし）。
 *
 * 設計: 「Notion駆動 LINE配信 設計確定版 v1.0」§7
 *   https://app.notion.com/p/39870c9d064c81f7a593f2cb248ef076
 *
 * Notion 配信DB の「配信対象」select は日本語（全員 / 癒し / 探求 / 味覚）。
 * 内部のペルソナ enum は Firestore の PersonaType（serenity / explorer / sensory）。
 * 全員は broadcast パス（ペルソナに属さない）として扱う。
 *
 * fail-closed: 空・未知値は null を返し「送信対象化しない」（設計 DB 定義:
 *   「配信対象」空は送信対象化しない）。
 */

import type { PersonaType } from "./firestore";

/**
 * 送信の対象種別。
 * - all       = 全友だち broadcast
 * - persona   = ペルソナ multicast（Firestore/Supabase 結合で解決）
 * - allowlist = 社内テスト配信。指定 LINE user ID にだけ multicast する。
 *   userIds は Notion select には持たせず（PII をコンテンツDBに書かない）、
 *   env `LINE_INTERNAL_USER_IDS` を供給元として resolveTargets が deps 経由で読む。
 *   したがって parseAudience が返す時点の userIds は空配列プレースホルダ。
 */
export type AudienceSpec =
  | { kind: "all" }
  | { kind: "persona"; persona: PersonaType }
  | { kind: "allowlist"; userIds: string[] };

/** Notion「配信対象」select の日本語ラベル。 */
export const AUDIENCE_LABEL_ALL = "全員";

/** Notion「配信対象」select の社内テスト配信ラベル（allowlist）。 */
export const AUDIENCE_LABEL_INTERNAL = "社内";

/** 日本語ラベル → ペルソナ enum の対応表（全員は persona を持たない）。 */
const JP_PERSONA_MAP: Record<string, PersonaType> = {
  癒し: "serenity",
  探求: "explorer",
  味覚: "sensory",
};

/** ペルソナ enum → 日本語ラベル（結果表示・ログ用）。 */
const PERSONA_JP_MAP: Record<PersonaType, string> = {
  serenity: "癒し",
  explorer: "探求",
  sensory: "味覚",
};

/**
 * Notion「配信対象」の日本語ラベルを AudienceSpec に変換する。
 * 空・未知・null は null（＝送信対象化しない・fail-closed）。
 */
export function parseAudience(
  jp: string | null | undefined,
): AudienceSpec | null {
  if (typeof jp !== "string") return null;
  const trimmed = jp.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === AUDIENCE_LABEL_ALL) return { kind: "all" };
  // 社内テスト配信: userIds は env 供給（resolveTargets が deps 経由で解決）。
  // ここでは空プレースホルダを返す（Notion select に PII を持たせない）。
  if (trimmed === AUDIENCE_LABEL_INTERNAL) return { kind: "allowlist", userIds: [] };
  const persona = JP_PERSONA_MAP[trimmed];
  if (!persona) return null;
  return { kind: "persona", persona };
}

/** ペルソナ enum を日本語ラベルに戻す（ログ・表示用）。 */
export function personaToJp(persona: PersonaType): string {
  return PERSONA_JP_MAP[persona] ?? persona;
}

/** AudienceSpec を人間可読ラベルに（結果書戻し・ログ用）。 */
export function audienceLabel(spec: AudienceSpec): string {
  if (spec.kind === "all") return AUDIENCE_LABEL_ALL;
  if (spec.kind === "allowlist") return AUDIENCE_LABEL_INTERNAL;
  return personaToJp(spec.persona);
}
