/**
 * 配信対象（audience）の日本語 ↔ enum 変換層（純粋・I/O なし）。
 *
 * @layer CDP — CDP 所有。日本語ラベルと内部ペルソナ enum の対応は「顧客をどう区切るか」という
 *   データ側の語彙定義であり、配信文面（CX）とは独立に決まる。ここを変えると顧客の分類が
 *   変わるため、CX の都合で書き換えない。
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
  | {
      kind: "all";
      /**
       * 上限付きの全員配信（2026-10-29）。指定すると送り口は broadcast ではなく
       * narrowcast（宛先指定なし = 友だち全員から LINE が無作為に選ぶ）になり、送る人数は
       * この値・送る時点の台帳の残り・友だち数のいちばん小さい数に収まる。
       * Notion の「配信対象」select には持たせない（欄を変えない）。運用者が依頼を起動するときの
       * 指定（Mac の LINE_RECIPIENT_CAP）が pin / approve / ledger / send-one の要求で渡り、
       * `applyRecipientCap` でここに載る。未指定は従来どおりの全員 broadcast（挙動を変えない）。
       */
      maxRecipients?: number;
    }
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

/**
 * 指紋（コンテンツハッシュ）に載せる配信対象の決定的な識別子。
 *
 * 日本語ラベルそのままではなく enum 側の語彙で組む（"all" / "persona:serenity" /
 * "allowlist"）。ラベルの表記揺れ（全角空白など）で指紋がぶれると、承認後に何も
 * 変えていないのに送れなくなるため、`parseAudience` を通した結果から組む。
 *
 * 未知・空の配信対象は `parseAudience` が null を返して手前で止まるので、ここには来ない。
 */
export function audienceFingerprintKey(spec: AudienceSpec): string {
  if (spec.kind === "all") {
    // 上限付きは上限の値まで指紋に入れる（承認した上限が後で変わったら送らずに止まる）。
    // 上限なしは従来どおり "all"（既存の pin の指紋を変えない）。
    return spec.maxRecipients === undefined ? "all" : `all:max=${spec.maxRecipients}`;
  }
  if (spec.kind === "allowlist") return "allowlist";
  return `persona:${spec.persona}`;
}

/** 上限の値の検証結果。 */
export type RecipientCapParse =
  | { ok: true; cap: number | undefined }
  | { ok: false; reason: string };

/**
 * 要求に載ってきた上限（`recipientCap`）を読む（純粋・fail-closed）。
 * 未指定（undefined / null）は「上限なし」。1 以上の整数（数か数字だけの文字列）だけを受け、
 * それ以外（0・負・小数・文字・真偽値）は拒否する。黙って上限なしに倒さない。
 */
export function parseRecipientCap(raw: unknown): RecipientCapParse {
  if (raw === undefined || raw === null) return { ok: true, cap: undefined };
  let n: number;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string" && /^[0-9]+$/.test(raw.trim())) {
    n = Number.parseInt(raw.trim(), 10);
  } else {
    return { ok: false, reason: `上限 (recipientCap) が数ではない: ${JSON.stringify(raw)}` };
  }
  if (!Number.isSafeInteger(n) || n < 1) {
    return { ok: false, reason: `上限 (recipientCap) は 1 以上の整数: ${JSON.stringify(raw)}` };
  }
  return { ok: true, cap: n };
}

/**
 * 配信対象に上限を載せる（純粋・fail-closed）。
 * - 上限なし → そのまま返す（従来の挙動）
 * - 上限あり × 全員 → `{ kind: "all", maxRecipients }`
 * - 上限あり × 区分・社内 → 拒否（上限付きは全員の narrowcast だけ。区分を無作為に削らない）
 */
export function applyRecipientCap(
  spec: AudienceSpec,
  cap: number | undefined,
): { ok: true; spec: AudienceSpec } | { ok: false; reason: string } {
  if (cap === undefined) return { ok: true, spec };
  if (spec.kind !== "all") {
    return {
      ok: false,
      reason: `上限付きの配信は「全員」だけ（配信対象=${audienceLabel(spec)} に上限は付けられない）`,
    };
  }
  if (!Number.isSafeInteger(cap) || cap < 1) {
    return { ok: false, reason: `上限は 1 以上の整数: ${cap}` };
  }
  return { ok: true, spec: { kind: "all", maxRecipients: cap } };
}

/** ペルソナ enum を日本語ラベルに戻す（ログ・表示用）。 */
export function personaToJp(persona: PersonaType): string {
  return PERSONA_JP_MAP[persona] ?? persona;
}

/** AudienceSpec を人間可読ラベルに（結果書戻し・ログ用）。 */
export function audienceLabel(spec: AudienceSpec): string {
  if (spec.kind === "all") {
    return spec.maxRecipients === undefined
      ? AUDIENCE_LABEL_ALL
      : `${AUDIENCE_LABEL_ALL}（上限${spec.maxRecipients}・無作為）`;
  }
  if (spec.kind === "allowlist") return AUDIENCE_LABEL_INTERNAL;
  return personaToJp(spec.persona);
}
