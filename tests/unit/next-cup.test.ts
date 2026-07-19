/**
 * Unit Tests — A-2a 評価後の「次の一杯」選定ロジック（2 軸データ活用版）
 *
 * 検証範囲（設計 v2・A-2a）:
 *   - classifyAroma / classifyBody: タグ実値の 2 軸分類（部分一致・セパレータ揺れ耐性）
 *   - selectNextCup: 同軸選定 / 評価済み除外 / 同組ゼロ→同 Category / 候補ゼロ→null
 *   - buildRateResponse: +1 は提案付き / -1 は提案ゼロ（静かな受け止め・suggestion 無視）
 *
 * 使用: npx tsx tests/unit/next-cup.test.ts
 */

import {
  classifyAroma,
  classifyBody,
  selectNextCup,
  karteAffinity,
  type AromaAxis,
  type BodyAxis,
  type NextCupKarte,
} from "../../src/lib/next-cup";
import { buildRateResponse } from "../../src/lib/tea-menu";
import type { TeaItem } from "../../src/lib/tea-menu";
import { NEXT_CUP_DECLINE_MESSAGE, NEXT_CUP_GOOD_THANKS } from "../../src/lib/brand-copy";

let total = 0;
let passed = 0;
const failures: string[] = [];
function it(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  [FAIL] ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}
function assertEqual<T>(a: T, e: T, label = "") {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

// 実タグ値（2026-07-17 Notion スキーマ確認済み）。
const AROMA_RICH = "甘い、熟した香り | リッチ";
const AROMA_DRY = "青い、爽やかな香り | ドライ";
const BODY_FULL = "しっかりした味わい | フルボディ";
const BODY_LIGHT = "すっきりした味わい | ライトボディ";

function tea(
  number: string,
  category: string,
  flavorProfiles: string[],
  name = `お茶${number}`,
): TeaItem {
  return {
    number,
    name,
    category,
    flavorProfiles,
    descShort: "",
    howToBrew: "",
    temp: "",
    time: "",
    water: "",
    enjoy: "",
    story: "",
  };
}

// --- classify ---
it("classifyAroma: リッチ=rich / ドライ=dry / 不明=unknown", () => {
  assertEqual<AromaAxis>(classifyAroma([AROMA_RICH]), "rich", "rich");
  assertEqual<AromaAxis>(classifyAroma([AROMA_DRY]), "dry", "dry");
  assertEqual<AromaAxis>(classifyAroma([]), "unknown", "empty");
  assertEqual<AromaAxis>(classifyAroma(["謎タグ"]), "unknown", "unknown");
});

it("classifyBody: フルボディ=full / ライトボディ=light / 不明=unknown", () => {
  assertEqual<BodyAxis>(classifyBody([BODY_FULL]), "full", "full");
  assertEqual<BodyAxis>(classifyBody([BODY_LIGHT]), "light", "light");
  assertEqual<BodyAxis>(classifyBody([]), "unknown", "empty");
});

it("classify: セパレータ・末尾スペースの揺れに強い（部分一致）", () => {
  assertEqual<AromaAxis>(classifyAroma(["甘い、熟した香り｜リッチ "]), "rich", "全角区切り+末尾空白");
  assertEqual<BodyAxis>(classifyBody(["しっかり"]), "full", "極語のみ");
});

// --- selectNextCup ---
it("同軸選定: 同じ香り極×味わい極の別銘柄を 1 本選ぶ（番号昇順で決定的）", () => {
  const rated = tea("11301", "緑茶", [AROMA_RICH, BODY_FULL]);
  const teas = [
    rated,
    tea("11401", "緑茶", [AROMA_RICH, BODY_FULL]), // 同軸・候補
    tea("11501", "緑茶", [AROMA_RICH, BODY_FULL]), // 同軸・より大きい番号
    tea("20101", "紅茶", [AROMA_DRY, BODY_LIGHT]), // 別軸
  ];
  const picked = selectNextCup(rated, teas, []);
  assert(picked !== null, "picked non-null");
  assertEqual(picked!.number, "11401", "同軸・番号最小");
});

it("除外: 評価済み（+1/-1）と評価対象そのものは候補から外す", () => {
  const rated = tea("11301", "緑茶", [AROMA_RICH, BODY_FULL]);
  const teas = [
    rated,
    tea("11401", "緑茶", [AROMA_RICH, BODY_FULL]), // 既評価 → 除外
    tea("11501", "緑茶", [AROMA_RICH, BODY_FULL]), // 未評価 → これが選ばれる
  ];
  const picked = selectNextCup(rated, teas, ["11401", "11301"]);
  assertEqual(picked!.number, "11501", "既評価をスキップ");
});

it("同組ゼロ→同 Category にフォールバック", () => {
  const rated = tea("11301", "緑茶", [AROMA_RICH, BODY_FULL]);
  const teas = [
    rated,
    tea("11402", "緑茶", [AROMA_DRY, BODY_LIGHT]), // 同 Category だが別軸
    tea("20101", "紅茶", [AROMA_RICH, BODY_FULL]), // 同軸だが別 Category
  ];
  // 同軸の 20101 が優先されるべき（軸が Category より先）。
  assertEqual(selectNextCup(rated, teas, [])!.number, "20101", "同軸優先");
  // 同軸を除外すると同 Category（緑茶 11402）にフォールバック。
  assertEqual(selectNextCup(rated, teas, ["20101"])!.number, "11402", "同 Category");
});

it("候補ゼロ→null（無理に出さない）", () => {
  const rated = tea("11301", "緑茶", [AROMA_RICH, BODY_FULL]);
  // 自分以外に候補が無い。
  assert(selectNextCup(rated, [rated], []) === null, "候補ゼロ");
  // 全て評価済み。
  const teas = [rated, tea("11401", "緑茶", [AROMA_RICH, BODY_FULL])];
  assert(selectNextCup(rated, teas, ["11401"]) === null, "全除外");
});

it("軸 unknown の評価銘柄でも同 Category で救済する", () => {
  const rated = tea("50601", "青茶", []); // 軸タグ欠落（number 軸 6 銘柄欠の類）
  const teas = [rated, tea("50701", "青茶", [AROMA_RICH, BODY_FULL])];
  assertEqual(selectNextCup(rated, teas, [])!.number, "50701", "同 Category 救済");
});

// --- カルテ活用（監査 #2）: persona / tasteProfile が選定を並べ替える ---
it("no-karte 後方互換: karte 未指定・null・空は従来の番号昇順に一致", () => {
  const rated = tea("11301", "緑茶", [AROMA_RICH, BODY_FULL]);
  const teas = [
    rated,
    tea("11401", "緑茶", [AROMA_RICH, BODY_FULL]),
    tea("40101", "青茶", [AROMA_RICH, BODY_FULL]),
  ];
  const baseline = selectNextCup(rated, teas, [])!.number;
  assertEqual(baseline, "11401", "baseline=番号最小");
  assertEqual(selectNextCup(rated, teas, [], null)!.number, "11401", "null カルテ=baseline");
  const empty: NextCupKarte = { persona: null, tasteProfile: null };
  assertEqual(selectNextCup(rated, teas, [], empty)!.number, "11401", "空カルテ=baseline");
  // 空カルテの親和度は常に 0（従来順序を壊さない機械的担保）。
  assertEqual(karteAffinity(teas[2], null), 0, "affinity(null)=0");
  assertEqual(karteAffinity(teas[2], empty), 0, "affinity(empty)=0");
});

it("preferredCategories(青茶) が同軸プールを並べ替える（40101 を選ぶ）", () => {
  const rated = tea("11301", "緑茶", [AROMA_RICH, BODY_FULL]);
  const teas = [
    rated,
    tea("11401", "緑茶", [AROMA_RICH, BODY_FULL]), // baseline（番号最小・緑茶）
    tea("40101", "青茶", [AROMA_RICH, BODY_FULL]), // 青茶（同軸・番号大）
  ];
  const karte: NextCupKarte = {
    persona: null,
    tasteProfile: { preferredCategories: ["oolong"], flavorPreferences: [], scenePref: null },
  };
  assertEqual(selectNextCup(rated, teas, [], karte)!.number, "40101", "青茶好みで 40101");
  assertEqual(selectNextCup(rated, teas, [])!.number, "11401", "カルテ無しは 11401");
});

it("persona=sensory は同カテゴリ内でフルボディ寄りに並べ替える", () => {
  const rated = tea("30001", "緑茶", [AROMA_DRY, BODY_FULL]); // 同軸プール空 → 同カテゴリへ
  const teas = [
    rated,
    tea("30002", "緑茶", [AROMA_RICH, BODY_LIGHT]), // 番号最小・ライト
    tea("30003", "緑茶", [AROMA_RICH, BODY_FULL]), // 番号大・フル
  ];
  assertEqual(selectNextCup(rated, teas, [])!.number, "30002", "baseline=ライト（番号最小）");
  const sensory: NextCupKarte = { persona: "sensory", tasteProfile: null };
  assertEqual(selectNextCup(rated, teas, [], sensory)!.number, "30003", "sensory→フル");
});

it("persona=serenity は同カテゴリ内で甘い香り(rich)寄りに並べ替える", () => {
  const rated = tea("31001", "緑茶", [AROMA_DRY, BODY_FULL]); // 同軸プール空 → 同カテゴリへ
  const teas = [
    rated,
    tea("31002", "緑茶", [AROMA_DRY, BODY_LIGHT]), // 番号最小・ドライ
    tea("31003", "緑茶", [AROMA_RICH, BODY_LIGHT]), // 番号大・リッチ（甘い香り）
  ];
  assertEqual(selectNextCup(rated, teas, [])!.number, "31002", "baseline=ドライ（番号最小）");
  const serenity: NextCupKarte = { persona: "serenity", tasteProfile: null };
  assertEqual(selectNextCup(rated, teas, [], serenity)!.number, "31003", "serenity→リッチ");
});

it("flavorPreferences(すっきり) は同カテゴリ内でライトボディ寄りに並べ替える", () => {
  const rated = tea("32001", "緑茶", [AROMA_DRY, BODY_FULL]); // 同軸プール空 → 同カテゴリへ
  const teas = [
    rated,
    tea("32002", "緑茶", [AROMA_RICH, BODY_FULL]), // 番号最小・フル
    tea("32003", "緑茶", [AROMA_RICH, BODY_LIGHT]), // 番号大・ライト
  ];
  assertEqual(selectNextCup(rated, teas, [])!.number, "32002", "baseline=フル（番号最小）");
  const light: NextCupKarte = {
    persona: null,
    tasteProfile: { preferredCategories: [], flavorPreferences: ["すっきり"], scenePref: null },
  };
  assertEqual(selectNextCup(rated, teas, [], light)!.number, "32003", "すっきり→ライト");
});

it("karteAffinity: カテゴリ+香り+persona の重みが加算される（+2/+2/+1）", () => {
  const oolongRichFull = tea("40101", "青茶", [AROMA_RICH, BODY_FULL]);
  const karte: NextCupKarte = {
    persona: "serenity", // aroma=rich 寄り → +1
    tasteProfile: {
      preferredCategories: ["oolong"], // 青茶一致 → +2
      flavorPreferences: ["甘い"], // aroma=rich → +2
      scenePref: null,
    },
  };
  assertEqual(karteAffinity(oolongRichFull, karte), 5, "2+2+1=5");
  // 別軸・別カテゴリの銘柄は 0（好みに寄らない）。
  const greenDryLight = tea("11301", "緑茶", [AROMA_DRY, BODY_LIGHT]);
  assertEqual(karteAffinity(greenDryLight, karte), 0, "不一致=0");
});

// --- buildRateResponse ---
it("buildRateResponse(+1, suggestion): お礼 + 提案 1 本を添える", () => {
  const rated = tea("11301", "緑茶", [AROMA_RICH, BODY_FULL]);
  const sug = tea("11401", "緑茶", [AROMA_RICH, BODY_FULL], "次の一杯");
  const out = buildRateResponse(rated, "rate-good", sug);
  assert(out.text.includes(NEXT_CUP_GOOD_THANKS), "お礼文");
  assert(out.text.includes("次の一杯（No.11401）"), "提案銘柄");
  assert(out.quickReplies.some((q) => q.action.text.includes("11401")), "提案カード導線");
});

it("buildRateResponse(+1, null): 候補ゼロならお礼のみ（提案文なし）", () => {
  const rated = tea("11301", "緑茶", [AROMA_RICH, BODY_FULL]);
  const out = buildRateResponse(rated, "rate-good", null);
  assert(out.text.includes(NEXT_CUP_GOOD_THANKS), "お礼文");
  assert(!out.text.includes("次はこんな一杯"), "提案文を出さない");
});

it("buildRateResponse(-1): 提案ゼロ・静かな受け止めのみ（suggestion は無視）", () => {
  const rated = tea("11301", "緑茶", [AROMA_RICH, BODY_FULL]);
  const sug = tea("11401", "緑茶", [AROMA_RICH, BODY_FULL], "別の一杯");
  const out = buildRateResponse(rated, "rate-bad", sug);
  assert(out.text.includes(NEXT_CUP_DECLINE_MESSAGE), "静かな一文");
  assert(!out.text.includes("別の一杯"), "-1 は提案を出さない");
  assert(!out.text.includes("No.11401"), "-1 は銘柄提案なし");
});

console.log("\n============================================================");
console.log("next-cup Test Results");
console.log("============================================================");
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${total - passed}`);
if (failures.length > 0) process.exit(1);
