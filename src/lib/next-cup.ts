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
 */

import type { TeaItem } from "./tea-menu";

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

/**
 * 評価された銘柄に対する「次の一杯」を 1 本選ぶ（純粋・A-2a）。
 *
 * @param ratedTea    評価された銘柄（+1 が付いた銘柄）。
 * @param allTeas     販売中の全銘柄（候補母集団）。
 * @param excludedNos 候補から除外する 5 桁番号（評価済み +1/-1 の銘柄）。ratedTea 自身は常に除外。
 * @returns 提案する 1 本。候補ゼロなら null（無理に出さない）。
 */
export function selectNextCup(
  ratedTea: TeaItem,
  allTeas: TeaItem[],
  excludedNos: Iterable<string>,
): TeaItem | null {
  const excluded = new Set<string>(excludedNos);
  excluded.add(ratedTea.number); // 評価対象そのものは常に除外

  const pool = allTeas.filter((t) => !excluded.has(t.number));
  if (pool.length === 0) return null;

  const axes = classifyAxes(ratedTea);

  // (1) 同じ軸の組（香り極 × 味わい極が一致・かつ unknown でない）から。
  if (axes.aroma !== "unknown" && axes.body !== "unknown") {
    const sameAxisPair = pool
      .filter((t) => {
        const a = classifyAxes(t);
        return a.aroma === axes.aroma && a.body === axes.body;
      })
      .sort(byNumber);
    if (sameAxisPair.length > 0) return sameAxisPair[0];
  }

  // (2) 同組が無ければ同 Category から。
  if (ratedTea.category) {
    const sameCategory = pool
      .filter((t) => t.category === ratedTea.category)
      .sort(byNumber);
    if (sameCategory.length > 0) return sameCategory[0];
  }

  // (3) 候補ゼロ → 提案なし（別系統への飛び出しはしない・設計 v2）。
  return null;
}
