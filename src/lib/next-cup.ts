/**
 * A-2a 評価後の「次の一杯」— 2 軸データ活用版の選定ロジック（純粋・状態レス）。
 *
 * 設計正本: 個別最適化(出し分け)設計案 v2（承認済み）
 *   https://app.notion.com/p/39f70c9d064c815f8316f458e173d770
 * データ根拠: Phase 0 as-built（docs/personalization-phase0-inventory.md §2・§3）
 *   Notion Tea Menu List の `Flavor Profile` multi_select は 4 値・実は 2 つの直交軸 × 2 極で、
 *   販売中 30 銘柄が「香り 1 タグ + 味わい 1 タグ」を 100% 保有する（軸写像はデータ側で完成）。
 *
 * 軸（タグ実値・2026-07-17 Notion スキーマで確認済み）:
 *   香り(aroma): 「甘い、熟した香り | リッチ」= rich / 「青い、爽やかな香り | ドライ」= dry
 *   味わい(body): 「しっかりした味わい | フルボディ」= full / 「すっきりした味わい | ライトボディ」= light
 *   ※ セパレータ・末尾スペースの揺れに強いよう、極の特徴語（リッチ/ドライ/フルボディ等）の
 *     部分一致で分類する（完全一致に依存しない）。
 *
 * 選定規則（設計 v2・A-2a）:
 *   1. 評価された銘柄と「同じ軸の組（香り極 × 味わい極が一致）」の別銘柄から 1 本。
 *   2. 同組が無ければ、同 Category（緑茶/紅茶/青茶）から 1 本。
 *   3. 候補ゼロなら提案なし（無理に出さない → null）。
 *   除外: 評価済み（+1・-1 いずれも）の銘柄・評価対象そのもの。
 *   選定は決定的（候補を番号昇順で並べ先頭を採る）。テスト再現性のため。
 *
 * カルテ活用（監査 punch-list #2・2026-07 追加）:
 *   従来は「直近 +1 した銘柄の 2 軸」だけで選び、診断ペルソナ・会話/購入由来の好み(tasteProfile)を
 *   無視していた（会話側 core.ts buildPersonalizationBlock はカルテを読むのに次の提案は読まない非対称）。
 *   本版は selectNextCup に任意で NextCupKarte（persona / tasteProfile）を渡せる。カルテがあるとき、
 *   各段の候補プールを「カルテ親和度（大きいほど好みに近い）→ 番号昇順」で並べ替える（tiebreak）。
 *   - 段構成（同軸ペア→同カテゴリ）と「似た 1 本を出す」核は不変。カルテは並べ替えだけに効く（安全）。
 *   - カルテ空・未指定は全親和度 0 ＝ 従来の番号昇順に一致（no-karte 後方互換・決定的）。
 *   - 読む面は会話側と同じ persona / tasteProfile（購入シグナルは上流で tasteProfile/persona へ畳込済）。
 */

import type { TeaItem } from "./tea-menu";
import type { PersonaType, TasteProfile } from "./firestore";

export type AromaAxis = "rich" | "dry" | "unknown";
export type BodyAxis = "full" | "light" | "unknown";

/** 銘柄の Flavor Profile タグから香り軸を判定する（部分一致・純粋）。 */
export function classifyAroma(flavorProfiles: string[]): AromaAxis {
  const joined = flavorProfiles.join(" ");
  // 「リッチ」/「甘い、熟した」= rich、「ドライ」/「青い、爽やか」= dry。
  if (joined.includes("リッチ") || joined.includes("甘い、熟した")) return "rich";
  if (joined.includes("ドライ") || joined.includes("青い、爽やか")) return "dry";
  return "unknown";
}

/** 銘柄の Flavor Profile タグから味わい（ボディ）軸を判定する（部分一致・純粋）。 */
export function classifyBody(flavorProfiles: string[]): BodyAxis {
  const joined = flavorProfiles.join(" ");
  // 「フルボディ」/「しっかり」= full、「ライトボディ」/「すっきり」= light。
  if (joined.includes("フルボディ") || joined.includes("しっかり")) return "full";
  if (joined.includes("ライトボディ") || joined.includes("すっきり")) return "light";
  return "unknown";
}

/** 2 軸の組（同組判定に使う）。 */
export interface FlavorAxes {
  aroma: AromaAxis;
  body: BodyAxis;
}

/** 銘柄を 2 軸へ分類する（純粋）。 */
export function classifyAxes(tea: TeaItem): FlavorAxes {
  return { aroma: classifyAroma(tea.flavorProfiles), body: classifyBody(tea.flavorProfiles) };
}

/** 候補を決定的順序（番号昇順）に並べる。 */
function byNumber(a: TeaItem, b: TeaItem): number {
  return a.number.localeCompare(b.number);
}

// ---------------------------------------------------------------------------
// カルテ（好み）活用（監査 #2）— 会話側と同じ persona / tasteProfile を選定の tiebreak に使う。
// ---------------------------------------------------------------------------

/**
 * 「次の一杯」選定に渡すカルテ（好み）。会話側 core.ts が AI 文脈へ注入するのと同じ
 * persona / tasteProfile を、選定の並べ替えに使う（読む面を会話側と一致させて一貫性を保つ）。
 * どちらも null 可（未診断・未収集）。空カルテは選定を従来（番号昇順）に戻す。
 */
export interface NextCupKarte {
  persona: PersonaType | null;
  tasteProfile: TasteProfile | null;
}

/**
 * tea.category（緑茶/青茶/紅茶）を tasteProfile.preferredCategories の語彙へ対応づける族テーブル。
 * preferredCategories は購入シグナル（purchase-signals.ts TAG_CATEGORY_MAP の値）・会話由来の
 * カテゴリ slug（green/oolong/black 等）で入るため、日本語カテゴリと slug の双方を族に含める。
 */
const CATEGORY_FAMILY: Record<string, string[]> = {
  緑茶: ["緑茶", "green", "sencha", "煎茶", "gyokuro", "玉露", "matcha", "抹茶", "genmaicha", "玄米茶", "hojicha", "ほうじ茶", "kabuse", "かぶせ茶"],
  青茶: ["青茶", "oolong", "烏龍茶", "ウーロン茶", "ウーロン"],
  紅茶: ["紅茶", "black", "black-tea", "紅"],
};

/** preferredCategories が tea の category 族に一致するか（純粋・大小無視・トリム）。 */
function categoryMatches(teaCategory: string, preferred: string[] | undefined | null): boolean {
  if (!preferred || preferred.length === 0) return false;
  const family = CATEGORY_FAMILY[teaCategory];
  if (!family) return false;
  const fam = new Set(family.map((s) => s.toLowerCase()));
  return preferred.some((p) => fam.has(String(p).trim().toLowerCase()));
}

/**
 * flavorPreferences から香り軸(aroma)の希望を導く（純粋）。classifyAroma と同語彙で対応づける。
 *   甘い/sweet/まろやか/mellow → rich。dry 側は flavor 語彙に明確な対応がないため導出しない（null）。
 */
function aromaPreferenceFromFlavors(flavors: string[] | undefined | null): AromaAxis | null {
  const set = new Set((flavors ?? []).map((f) => String(f).trim().toLowerCase()));
  if (["sweet", "甘い", "mellow", "まろやか"].some((k) => set.has(k))) return "rich";
  return null;
}

/**
 * flavorPreferences から味わい軸(body)の希望を導く（純粋）。classifyBody と同語彙で対応づける。
 *   rich/コク/深み → full（しっかり側）。refreshing/すっきり/軽い → light。相反・未指定は null。
 */
function bodyPreferenceFromFlavors(flavors: string[] | undefined | null): BodyAxis | null {
  const set = new Set((flavors ?? []).map((f) => String(f).trim().toLowerCase()));
  const full = ["rich", "コク", "深み"].some((k) => set.has(k));
  const light = ["refreshing", "すっきり", "さっぱり", "軽い"].some((k) => set.has(k));
  if (full && !light) return "full";
  if (light && !full) return "light";
  return null;
}

/**
 * persona → 軸の弱い傾き（純粋）。診断 Q2（味の好み→persona 加点表・preference-diagnosis.ts SCORE_TABLE.q2）を
 * 反転した保守的マップ。強いアンカー taste を持つ 2 ペルソナのみ軸に写し、explorer は中立（動機/新規性軸のため）。
 *   serenity → aroma=rich（Q2-1「まろやかな甘み」）／ sensory → body=full（Q2-3「コク・余韻がしっかり」）。
 */
function personaAromaLean(persona: PersonaType | null): AromaAxis | null {
  return persona === "serenity" ? "rich" : null;
}
function personaBodyLean(persona: PersonaType | null): BodyAxis | null {
  return persona === "sensory" ? "full" : null;
}

/**
 * カルテ親和度（純粋・非負整数・大きいほど好みに近い）。決定的順序を壊さないため同点は必ず番号昇順で解く。
 *
 * 重み（explainable・小さく保つ・明示シグナル > 弱い prior）:
 *   +2  preferredCategories 一致（購入/会話由来の明示カテゴリ）
 *   +2  flavorPreferences → 軸一致（香り/味わいそれぞれ最大 +2）
 *   +1  persona → 軸の傾き一致（香り/味わいそれぞれ最大 +1・弱い prior）
 * カルテ null・空は 0（＝従来の番号昇順に一致）。
 */
export function karteAffinity(tea: TeaItem, karte: NextCupKarte | null | undefined): number {
  if (!karte) return 0;
  const axes = classifyAxes(tea);
  let score = 0;

  const tp = karte.tasteProfile;
  if (tp) {
    if (categoryMatches(tea.category, tp.preferredCategories)) score += 2;
    const aromaPref = aromaPreferenceFromFlavors(tp.flavorPreferences);
    const bodyPref = bodyPreferenceFromFlavors(tp.flavorPreferences);
    if (aromaPref && axes.aroma === aromaPref) score += 2;
    if (bodyPref && axes.body === bodyPref) score += 2;
  }

  if (personaAromaLean(karte.persona) && axes.aroma === personaAromaLean(karte.persona)) score += 1;
  if (personaBodyLean(karte.persona) && axes.body === personaBodyLean(karte.persona)) score += 1;

  return score;
}

/**
 * 評価された銘柄に対する「次の一杯」を 1 本選ぶ（純粋・A-2a）。
 *
 * @param ratedTea    評価された銘柄（+1 が付いた銘柄）。
 * @param allTeas     販売中の全銘柄（候補母集団）。
 * @param excludedNos 候補から除外する 5 桁番号（評価済み +1/-1 の銘柄）。ratedTea 自身は常に除外。
 * @param karte       任意のカルテ（persona / tasteProfile）。渡すと各段の候補を親和度→番号で並べ替える。
 *                    未指定・空カルテは全親和度 0 ＝ 従来の番号昇順（no-karte 後方互換・決定的）。
 * @returns 提案する 1 本。候補ゼロなら null（無理に出さない）。
 */
export function selectNextCup(
  ratedTea: TeaItem,
  allTeas: TeaItem[],
  excludedNos: Iterable<string>,
  karte?: NextCupKarte | null,
): TeaItem | null {
  const excluded = new Set<string>(excludedNos);
  excluded.add(ratedTea.number); // 評価対象そのものは常に除外

  const pool = allTeas.filter((t) => !excluded.has(t.number));
  if (pool.length === 0) return null;

  // カルテ親和度（大きいほど好みに近い）→ 番号昇順の決定的順序。
  //   カルテ空・未指定なら karteAffinity は全 0 で、従来の byNumber と完全に一致する。
  const byKarteThenNumber = (a: TeaItem, b: TeaItem): number => {
    const d = karteAffinity(b, karte) - karteAffinity(a, karte);
    return d !== 0 ? d : byNumber(a, b);
  };

  const axes = classifyAxes(ratedTea);

  // (1) 同じ軸の組（香り極 × 味わい極が一致・かつ unknown でない）から。
  //     同軸プール内は軸が揃うため、カルテはカテゴリ好みで並べ替える（軸親和は定数）。
  if (axes.aroma !== "unknown" && axes.body !== "unknown") {
    const sameAxisPair = pool
      .filter((t) => {
        const a = classifyAxes(t);
        return a.aroma === axes.aroma && a.body === axes.body;
      })
      .sort(byKarteThenNumber);
    if (sameAxisPair.length > 0) return sameAxisPair[0];
  }

  // (2) 同組が無ければ同 Category から。
  //     同カテゴリ内は軸がばらつくため、カルテは軸(味わい/香り)の好みで並べ替える。
  if (ratedTea.category) {
    const sameCategory = pool
      .filter((t) => t.category === ratedTea.category)
      .sort(byKarteThenNumber);
    if (sameCategory.length > 0) return sameCategory[0];
  }

  // (3) 候補ゼロ → 提案なし（別系統への飛び出しはしない・設計 v2）。
  return null;
}
