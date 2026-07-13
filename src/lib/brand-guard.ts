/**
 * brand-guard — ランタイム出力 egress の brand-fact ガード（runtime lint）。
 *
 * 目的（再発防止 / ID-6701）:
 *   system-prompt と静的テンプレは brand-copy.ts の正本に是正済みで、
 *   `tests/unit/brand-copy.test.ts` が静的文字列への非正本文言の再混入を機械的に防ぐ。
 *   しかし **AI が実行時に生成する回答**（RAG に混じった旧文言の引き写し・幻覚）は
 *   静的テストでは捕捉できない。本モジュールは AI 応答の送信直前に通す軽量ガードで、
 *   ブランド事実の非正本表現を検出→正本語に置換し、違反をログに残す。
 *
 * 正本（SoT）: src/lib/brand-copy.ts（さらに elxea-brand-context skill / About elxea）。
 *
 * 設計判断（シンプル優先・誤検知回避）:
 *   - 置換対象は「文脈非依存でブランド事実として常に誤り」な語/句のみに限定する。
 *     ・「エルシア」   → 読み仮名の誤り（正本: エルクシア）
 *     ・「合同会社elxea」→ 法人格の誤り（正本: 株式会社elxea）
 *     ・「鹿児島を中心」→ ブランド産地の自己紹介表現の誤り（正本: 産地は日本各地）
 *   - **「鹿児島」単体は禁止しない**。商品個別の産地事実（例: 「鹿児島産の茶葉」「知覧の煎茶」）は
 *     正当なため、禁止するのは自己紹介句「鹿児島を中心」のみ（現行リストの粒度を維持）。
 *   - 「スキンケア」「静かな豊かさ」は **本ランタイム置換には含めない**。理由:
 *     ・「スキンケア」は「スキンケア用品は扱っていません」等の正当な否定文脈で現れ、
 *       単純置換すると正当文を壊す（誤検知）。
 *     ・「静かな豊かさ」は記事本文の編集的散文としても現れ（例: 立春の記事）、
 *       機械置換は記事の意味を毀損する。
 *     両者は (a) 静的コピーは brand-copy.test.ts が担保、(b) RAG 由来の残骸は
 *     Notion ソース記事の是正（コンテンツ責任者）で根治する方針とし、ランタイムでは
 *     ブロックも破壊もしない（無応答・誤補正を避ける）。
 *   - 応答をブロックして無応答にはしない（UX 上不可）。必ず置換後テキストを返す。
 */

import { BRAND_NAME_READING, COMPANY_NAME } from "./brand-copy";

/** 1 つの検出・置換ルール。 */
export interface BrandGuardRule {
  /** ログ用の安定 ID（slug）。 */
  id: string;
  /** 検出パターン（global フラグ必須）。 */
  pattern: RegExp;
  /** 置換後の正本語（brand-copy.ts の正本を参照）。 */
  replacement: string;
}

/** 検出した 1 件の違反。 */
export interface BrandGuardViolation {
  ruleId: string;
  /** 実際にマッチした文字列。 */
  matched: string;
}

/** ガード結果。 */
export interface BrandGuardResult {
  /** 置換適用後のテキスト（常に文字列・無応答にしない）。 */
  text: string;
  /** 検出した違反の一覧。 */
  violations: BrandGuardViolation[];
  /** 置換によりテキストが変化したか。 */
  changed: boolean;
}

/**
 * 置換ルール（正本 = brand-copy.ts）。
 * 置換後の語はハードコードせず、可能な限り brand-copy 定数を参照する。
 */
export const BRAND_GUARD_RULES: BrandGuardRule[] = [
  // 読み仮名: 「エルシア」は非正本 → 正本読み仮名（エルクシア）。
  { id: "reading", pattern: /エルシア/g, replacement: BRAND_NAME_READING },
  // 法人格: 「合同会社elxea / 合同会社エルクシア」→ 正本法人名（株式会社elxea）。
  { id: "company", pattern: /合同会社\s*(?:elxea|エルクシア)/gi, replacement: COMPANY_NAME },
  // ブランド産地の自己紹介表現: 「鹿児島を中心」→ 正本ステートメントの産地（日本各地）。
  //   ※「鹿児島」単体・「鹿児島産」等の商品産地事実は対象外（正当）。
  { id: "origin", pattern: /鹿児島を中心/g, replacement: "日本各地" },
];

/**
 * AI 応答テキストに brand-fact ガードを適用する（純粋関数・I/O なし）。
 *
 * 各ルールの検出を collect し、正本語へ置換する。無応答にはせず、常に置換後テキストを返す。
 */
export function guardBrandFacts(
  text: string,
  rules: BrandGuardRule[] = BRAND_GUARD_RULES,
): BrandGuardResult {
  if (!text) return { text: text ?? "", violations: [], changed: false };

  const violations: BrandGuardViolation[] = [];
  let out = text;

  for (const rule of rules) {
    // 検出（違反ログ用にマッチ全件を収集）。lastIndex を汚さないよう複製する。
    const finder = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : rule.pattern.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = finder.exec(out)) !== null) {
      violations.push({ ruleId: rule.id, matched: m[0] });
      if (m.index === finder.lastIndex) finder.lastIndex++; // ゼロ幅対策（保険）
    }
    // 置換
    out = out.replace(rule.pattern, rule.replacement);
  }

  return { text: out, violations, changed: out !== text };
}

/**
 * 違反を既存ログ機構（Cloudflare Workers observability / console）へ構造化記録する。
 * PII は含めない（channel と検出語のみ。userId は呼び出し側の既存ログ規約に委ねる）。
 * 決して throw しない（応答をブロックしない）。
 */
export function logBrandGuardViolations(
  violations: BrandGuardViolation[],
  meta: { channel?: string; userId?: string } = {},
): void {
  if (violations.length === 0) return;
  try {
    console.warn(
      "[brand-guard] non-canonical brand fact corrected in AI output: " +
        JSON.stringify({
          channel: meta.channel ?? null,
          userId: meta.userId ?? null,
          count: violations.length,
          rules: violations.map((v) => v.ruleId),
          matched: violations.map((v) => v.matched),
        }),
    );
  } catch {
    // ログ失敗は握りつぶす（応答優先）。
  }
}

/**
 * 応答テキストにガードを適用し、違反があればログしてから置換後テキストを返す
 * 便利ラッパ（呼び出し側の choke point で 1 行で使う）。
 */
export function applyBrandGuard(
  text: string,
  meta: { channel?: string; userId?: string } = {},
): string {
  const result = guardBrandFacts(text);
  if (result.violations.length > 0) {
    logBrandGuardViolations(result.violations, meta);
  }
  return result.text;
}
