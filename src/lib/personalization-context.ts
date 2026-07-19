/**
 * A-1 文脈接続 — AI 会話応答へ「positive/neutral な事実」を注入するプロンプト断片ビルダー（純粋）。
 *
 * 設計正本: 個別最適化(出し分け)設計案 v2（承認済み）
 *   https://app.notion.com/p/39f70c9d064c815f8316f458e173d770
 *
 * 何を注入するか（positive/neutral に限定）:
 *   - 診断ペルソナ（serenity/explorer/sensory）
 *   - +1 評価した銘柄（おいしかったと言われたお茶）
 *   - 入口（marche=マルシェ / online=オンライン / other=その他）
 *   - tasteProfile（好みのカテゴリ・フレーバー・シーン）
 *
 * 何を注入しないか: -1 評価・休眠・離脱は「内部の選定材料」にとどめ、応答文脈へ出さない
 *   （呼び出し側も -1 事実をこのビルダーへ渡さない。ビルダーは渡された事実のみを扱う）。
 *
 * 併せて「境界 4 ルール」をプロンプト制約として必ず明文化して注入する（下記 BOUNDARY_RULES）。
 * この断片は system プロンプトの可変ブロックに連結する（core.ts）。
 */

import type { PersonaType, TasteProfile } from "./firestore";

/** 入口（welcome.source）の正規値。 */
export type EntrySource = "marche" | "online" | "other";

/** A-1 が注入する positive/neutral 事実（呼び出し側が組み立てる）。 */
export interface PersonalizationFacts {
  /** 診断ペルソナ（null=未判定）。 */
  persona: PersonaType | null;
  /** 入口（marche/online/other）。未知・不明は null。 */
  entrySource: EntrySource | null;
  /** +1 評価した銘柄の表示ラベル（例: "40101｜銘柄名"）。0 件可。 */
  ratedGoodLabels: string[];
  /** 会話由来の好み（null 可）。 */
  tasteProfile: TasteProfile | null;
}

export const PERSONA_LABEL: Record<PersonaType, string> = {
  serenity: "穏やか（静けさ・ゆとりを好む）",
  explorer: "探求（新しいお茶・産地の物語を好む）",
  sensory: "感覚（味わい・香り・ペアリングを楽しむ）",
};

export const ENTRY_LABEL: Record<EntrySource, string> = {
  marche: "マルシェ（対面イベント）で elxea を知った",
  online: "オンラインで elxea を知った",
  other: "その他の経路で elxea を知った",
};

/**
 * 記憶参照の境界 4 ルール（設計 v2・プロンプト制約として明文化）。
 * どの事実を注入するときも必ず添える（この 4 行が A-1 の安全弁）。
 */
export const BOUNDARY_RULES = [
  "1. マイナス評価・休眠・離脱には一切言及しない（内部の判断材料にとどめ、言葉にしない）。",
  "2. いまの話題に隣接するときだけ過去の事実に触れる（脈絡なく過去を持ち出さない）。",
  "3. 過去セッションの話題は、お客様が自分から持ち出したときだけ触れる。",
  "4. 「覚えています」「記録があります」等のメタ発言はしない（記憶は挙動でさりげなく示す）。",
] as const;

/** 事実が 1 つでもあるか（空なら断片を注入しない）。 */
export function hasAnyFact(facts: PersonalizationFacts): boolean {
  return (
    facts.persona !== null ||
    facts.entrySource !== null ||
    facts.ratedGoodLabels.length > 0 ||
    hasTaste(facts.tasteProfile)
  );
}

function hasTaste(tp: TasteProfile | null): boolean {
  if (!tp) return false;
  return (
    (tp.preferredCategories?.length ?? 0) > 0 ||
    (tp.flavorPreferences?.length ?? 0) > 0 ||
    !!tp.scenePref
  );
}

/**
 * A-1 のプロンプト断片を組む（純粋）。事実が無ければ空文字（何も注入しない）。
 * 事実が 1 つでもあれば「参考事実」＋「境界 4 ルール」を必ずセットで出す。
 */
export function buildPersonalizationContext(facts: PersonalizationFacts): string {
  if (!hasAnyFact(facts)) return "";

  const factLines: string[] = [];
  if (facts.persona) factLines.push(`- 診断で見えた傾向: ${PERSONA_LABEL[facts.persona]}`);
  if (facts.entrySource) factLines.push(`- 入口: ${ENTRY_LABEL[facts.entrySource]}`);
  if (facts.ratedGoodLabels.length > 0) {
    factLines.push(`- 「おいしかった」と言われたお茶: ${facts.ratedGoodLabels.join(" / ")}`);
  }
  const tp = facts.tasteProfile;
  if (tp) {
    if (tp.preferredCategories?.length) factLines.push(`- 好みのカテゴリ: ${tp.preferredCategories.join(", ")}`);
    if (tp.flavorPreferences?.length) factLines.push(`- 好みのフレーバー: ${tp.flavorPreferences.join(", ")}`);
    if (tp.scenePref) factLines.push(`- 好みのシーン: ${tp.scenePref}`);
  }

  return (
    "\n\n## このお客様について（個別最適化の参考事実・positive/neutral のみ）\n" +
    "以下は、これまでの診断・評価・入口から分かっている前向きな事実です。" +
    "提案の精度を上げるための内部材料として使い、押し付けにはしないでください。\n" +
    factLines.join("\n") +
    "\n\n### 参照の境界（必ず守る）\n" +
    BOUNDARY_RULES.join("\n")
  );
}
