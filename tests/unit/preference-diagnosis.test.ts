/**
 * Unit Tests -- preference-diagnosis（好み診断・リッチメニュー②・タップ主体・状態レス・LLM 不使用）
 *
 * 検証範囲（Spec 39c70c9d-064c-81bc-aa53-f95733ccee97 準拠）:
 *   (a) トリガー完全一致で起動 / 近似文言は誤爆しない（素通り）
 *   (b) Q1→Q2→Q3→結果 の段階遷移（トークン形式・quick reply）
 *   (c) 採点: §5-3 検算7行 + 全36組み合わせの分布（14/11/11）+ tiebreak（S→E→G 先勝ち）
 *   (d) 範囲外・欠損トークンは安全側で再提示（invalid → イントロ+Q1・素通りしない）
 *   (e) 記録: weight=3・mergePersonaScores 連携（新規=表示一致 / 既存=履歴尊重で乖離許容）
 *   (f) 回帰: feedback pending が診断より先（インターセプタ順序）→ 診断トークンが feedback に吸われる
 *   (g) 結果 quick reply が 13 以下・ラベル20字以内・お茶カードトークンに接続
 *
 * 使用方法: npx tsx tests/unit/preference-diagnosis.test.ts
 */

import { readFileSync } from "node:fs";
import {
  parsePreferenceAction,
  planPreferenceFlow,
  scoreDiagnosis,
  buildResultWithTeas,
  buildResultFallback,
  pickDiagnosisRecommendations,
  diagnosisRecommendationKarte,
  buildIntroAndQ1,
  DIAGNOSIS_TRIGGER,
  DIAGNOSIS_WEIGHT,
} from "../../src/lib/preference-diagnosis";
import { mergePersonaScores, type PersonaType, type PersonaScores } from "../../src/lib/firestore";
import type { TeaItem } from "../../src/lib/tea-menu";
import { AROMA_RICH, AROMA_DRY, BODY_FULL, BODY_LIGHT } from "../lib/tea-fixtures";

/** 診断相談導線の発話（preference-diagnosis CONSULT_MORE_TEXT と一致）。 */
const CONSULT_MORE = "お茶選びを相談したいです";

/** TeaItem を最小フィールドで組む（動的おすすめのカタログ・フィクスチャ用）。 */
function mkTea(
  number: string,
  name: string,
  category: string,
  flavorProfiles: string[],
  descShort = "",
): TeaItem {
  return {
    number,
    name,
    category,
    flavorProfiles,
    descShort,
    howToBrew: "",
    temp: "",
    time: "",
    water: "",
    enjoy: "",
    story: "",
  };
}

let total = 0,
  passed = 0,
  failed = 0;
const failures: Array<{ name: string; error: string }> = [];

function it(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${name}: ${msg}`);
    failures.push({ name, error: msg });
  }
}
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const QR_MAX = 13;
const LABEL_MAX = 20;

console.log("\n--- (a) トリガー完全一致 / 誤爆なし ---");

it("トリガー完全一致 → start（イントロ+Q1）", () => {
  const a = parsePreferenceAction(DIAGNOSIS_TRIGGER);
  assert(a !== null && a.kind === "start", "trigger → start");
  assertEqual(DIAGNOSIS_TRIGGER, "好みに合うお茶を診断してほしいです", "trigger literal");
});

it("近似・部分一致は誤爆しない（null で素通り）", () => {
  for (const s of [
    "好みに合うお茶を診断して", // 部分
    "診断してほしいです", // 別文
    "診断", // 単体（SEP なし）
    "お茶を診断したい", // 自由発話
    "こんにちは",
    "玉露のおすすめはありますか？",
    "注文状況を確認したいです",
  ]) {
    assertEqual(parsePreferenceAction(s), null, `no misfire: ${s}`);
  }
});

console.log("\n--- (b) 段階遷移（トークン形式・quick reply） ---");

it("診断｜1 → Q2（4択・text=診断｜1｜n）", () => {
  const a = parsePreferenceAction("診断｜1");
  assert(a !== null && a.kind === "q2" && a.q1 === 1, "→ q2 with q1=1");
  const plan = planPreferenceFlow("診断｜1")!;
  assert(plan !== null && plan.winner === null, "q2 no winner yet");
  assertEqual(plan.message.quickReplies.length, 4, "Q2 has 4 choices");
  assert(
    plan.message.quickReplies.every((q) => q.action.text.startsWith("診断｜1｜")),
    "Q2 tokens carry q1",
  );
});

it("診断｜1｜3 → Q3（3択・text=診断｜1｜3｜n）", () => {
  const a = parsePreferenceAction("診断｜1｜3");
  assert(a !== null && a.kind === "q3" && a.q1 === 1 && a.q2 === 3, "→ q3");
  const plan = planPreferenceFlow("診断｜1｜3")!;
  assertEqual(plan.message.quickReplies.length, 3, "Q3 has 3 choices");
  assert(
    plan.message.quickReplies.every((q) => q.action.text.startsWith("診断｜1｜3｜")),
    "Q3 tokens carry q1,q2",
  );
});

it("診断｜1｜1｜1 → result（採点・winner）", () => {
  const a = parsePreferenceAction("診断｜1｜1｜1");
  assert(a !== null && a.kind === "result", "→ result");
  const plan = planPreferenceFlow("診断｜1｜1｜1")!;
  assertEqual(plan.winner, "serenity", "1,1,1 → serenity");
  assert(plan.message.text.includes("静けさを愉しむ人"), "serenity result body");
});

console.log("\n--- (c) 採点: §5-3 検算7行 ---");

const CHECK_ROWS: Array<[number, number, number, PersonaType]> = [
  [1, 1, 1, "serenity"],
  [2, 2, 2, "explorer"],
  [3, 3, 3, "sensory"],
  [1, 3, 3, "sensory"], // refiner が上書き（S3 vs G4）
  [2, 4, 2, "explorer"],
  [1, 2, 2, "serenity"], // S3,E3,G1 同点 → tiebreak serenity
  [3, 4, 2, "explorer"], // G3,E3,S1 同点 → tiebreak explorer（E が G に優先）
];

it("§5-3 検算7行が全て一致", () => {
  for (const [q1, q2, q3, expected] of CHECK_ROWS) {
    assertEqual(scoreDiagnosis(q1, q2, q3), expected, `(${q1},${q2},${q3})`);
  }
});

console.log("\n--- (c') 全36組み合わせの分布 + tiebreak ---");

it("全36組み合わせ: 分布 serenity14 / explorer11 / sensory11", () => {
  const dist: Record<PersonaType, number> = { serenity: 0, explorer: 0, sensory: 0 };
  for (let q1 = 1; q1 <= 3; q1++)
    for (let q2 = 1; q2 <= 4; q2++)
      for (let q3 = 1; q3 <= 3; q3++) dist[scoreDiagnosis(q1, q2, q3)]++;
  assertEqual(dist.serenity + dist.explorer + dist.sensory, 36, "total 36");
  assertEqual(dist.serenity, 14, "serenity count");
  assertEqual(dist.explorer, 11, "explorer count");
  assertEqual(dist.sensory, 11, "sensory count");
});

it("tiebreak は S→E→G 先勝ち（同点は必ずこの順で確定）", () => {
  // (1,2,2): S3 E3 G1 → serenity（S が E に勝つ）
  assertEqual(scoreDiagnosis(1, 2, 2), "serenity", "S beats E on tie");
  // (3,4,2): S1 E3 G3 → explorer（E が G に勝つ）
  assertEqual(scoreDiagnosis(3, 4, 2), "explorer", "E beats G on tie");
});

console.log("\n--- (d) 範囲外・欠損は安全側で再提示（invalid） ---");

it("範囲外・欠損トークンは invalid（素通りせず・イントロ+Q1 を再提示）", () => {
  for (const s of ["診断｜9", "診断｜0", "診断｜1｜9", "診断｜1｜1｜9", "診断｜", "診断｜1｜2｜3｜4"]) {
    const a = parsePreferenceAction(s);
    assert(a !== null && a.kind === "invalid", `invalid: ${s}`);
    const plan = planPreferenceFlow(s)!;
    assert(plan !== null, `intercepted (not fall-through): ${s}`);
    assertEqual(plan.winner, null, `no winner on invalid: ${s}`);
    // 再提示はイントロ+Q1（3択）
    assertEqual(plan.message.quickReplies.length, 3, `re-ask Q1: ${s}`);
  }
});

it("無関係発話 → planPreferenceFlow=null（AI 自由対話へ素通り）", () => {
  assertEqual(planPreferenceFlow("おすすめのお茶を教えて"), null, "free question");
  assertEqual(planPreferenceFlow("私の番号は12345"), null, "5-digit unrelated");
});

console.log("\n--- (e) 記録: weight=3・mergePersonaScores 連携 ---");

it("DIAGNOSIS_WEIGHT は 3（Boss 確定値・購入と同格）", () => {
  assertEqual(DIAGNOSIS_WEIGHT, 3, "weight");
});

it("新規ユーザー（scores=0）: 記録後 primary = winner（表示=記録 一致）", () => {
  const zero: PersonaScores = { serenity: 0, explorer: 0, sensory: 0 };
  for (const w of ["serenity", "explorer", "sensory"] as PersonaType[]) {
    const { scores, primary } = mergePersonaScores(zero, [w], DIAGNOSIS_WEIGHT, null);
    assertEqual(primary, w, `new user primary=${w}`);
    assertEqual(scores[w], 3, `winner +3`);
  }
});

it("既存ユーザー（履歴が上回る）: primary は履歴側のまま（乖離許容・仕様）", () => {
  // 購入履歴で serenity=9 のユーザーが診断で sensory になっても、記録 primary は serenity のまま。
  const existing: PersonaScores = { serenity: 9, explorer: 0, sensory: 0 };
  const { scores, primary } = mergePersonaScores(existing, ["sensory"], DIAGNOSIS_WEIGHT, "serenity");
  assertEqual(primary, "serenity", "history-dominant primary unchanged");
  assertEqual(scores.sensory, 3, "sensory still accrues +3 (別軸に累積)");
  assertEqual(scores.serenity, 9, "serenity preserved (上書きしない)");
});

console.log("\n--- (f) 回帰: feedback pending が診断より先（インターセプタ順序） ---");

it("handleTextMessage は onboarding/feedback/tea-menu/menu-action を診断より先に呼ぶ", () => {
  // feedback「改善希望」タップ後のコメント待ち中に `診断｜…` を送ると、その入力が
  // feedback コメントとして吸収され診断は始まらない（既存優先順の正しい挙動）。
  // これをソース順序で固定し、診断を feedback より前に差し込む回帰を防ぐ。
  const src = readFileSync(new URL("../../src/routes/line.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function handleTextMessage"));
  const iOnboarding = fn.indexOf("handleOnboardingMessage(lineUserId");
  const iFeedback = fn.indexOf("handleFeedbackMessage(lineUserId");
  const iTea = fn.indexOf("handleTeaMenuFlow(lineUserId");
  const iMenu = fn.indexOf("handleMenuActionFlow(lineUserId");
  const iDiag = fn.indexOf("handlePreferenceDiagnosis(lineUserId");
  assert(iOnboarding > -1 && iFeedback > -1 && iDiag > -1, "handlers present");
  assert(iFeedback < iDiag, `feedback(${iFeedback}) must precede diagnosis(${iDiag})`);
  assert(iOnboarding < iDiag, `onboarding(${iOnboarding}) must precede diagnosis(${iDiag})`);
  assert(iTea < iDiag, `tea-menu(${iTea}) must precede diagnosis(${iDiag})`);
  assert(iMenu < iDiag, `menu-action(${iMenu}) must precede diagnosis(${iDiag})`);
});

console.log("\n--- (g) 結果おすすめは販売中カタログから動的解決（監査 #6） ---");

// 販売中カタログのフィクスチャ。旧ハードコード RESULTS の番号（40601 / 10501 / 50401 等）は含めない
//   ＝「動的解決していないと番号が必ず外れる」状態を作り、ハードコード残留を機械検出する（break-proof）。
const CATALOG: TeaItem[] = [
  mkTea("11301", "煎茶 やまなみ", "緑茶", [AROMA_RICH, BODY_FULL], "コクのある旨味と甘い余韻。"),
  mkTea("11401", "深蒸し煎茶 みどり", "緑茶", [AROMA_RICH, BODY_FULL], "濃厚で香ばしい。"),
  mkTea("20101", "和紅茶 あかね", "紅茶", [AROMA_DRY, BODY_LIGHT], "軽やかで爽やかな渋み。"),
  mkTea("40101", "和烏龍茶 香駿", "青茶", [AROMA_RICH, BODY_FULL], "華やかな香りとまろやかな甘み。"),
];
const AVAILABLE = new Set(CATALOG.map((t) => t.number));
const LEGACY_HARDCODED = ["40601", "10501", "10201", "40201", "11601", "50401", "10801"];

it("結果おすすめは全て販売中カタログの番号（ハードコード 5 桁に依存しない・break-proof）", () => {
  for (const w of ["serenity", "explorer", "sensory"] as PersonaType[]) {
    const m = buildResultWithTeas(w, CATALOG, diagnosisRecommendationKarte(w, 1));
    // お茶ボタンは診断出所つきカードトークン、番号は必ずカタログ内。
    const teaButtons = m.quickReplies.filter((q) => /^このお茶｜\d{5}｜診断$/.test(q.action.text));
    assert(teaButtons.length >= 1, `${w}: 1件以上の動的お茶ボタン`);
    for (const q of teaButtons) {
      const no = q.action.text.match(/\d{5}/)![0];
      assert(AVAILABLE.has(no), `${w}: おすすめ ${no} は販売中カタログ内であること`);
      assert(q.action.label.length <= LABEL_MAX, `${w}: label<=20 (${q.action.label})`);
    }
    // 本文に出る 5 桁もすべてカタログ内（旧ハードコード挙動なら 40601 等が出て失敗する＝break-proof）。
    for (const no of m.text.match(/\d{5}/g) ?? []) {
      assert(AVAILABLE.has(no), `${w}: 本文番号 ${no} は在庫内（ハードコード漏れ無し）`);
    }
    for (const legacy of LEGACY_HARDCODED) {
      assert(!m.text.includes(legacy), `${w}: 旧ハードコード ${legacy} が出ない`);
    }
    // 末尾は相談導線・総数 13 以下。
    assertEqual(
      m.quickReplies[m.quickReplies.length - 1].action.text,
      CONSULT_MORE,
      `${w}: 相談導線が末尾`,
    );
    assert(m.quickReplies.length <= QR_MAX, `${w}: <=13`);
  }
});

it("カタログが変わればおすすめも変わる（単一在庫 → 単一提案・動的）", () => {
  const one = buildResultWithTeas("serenity", [CATALOG[0]], diagnosisRecommendationKarte("serenity"));
  const teaButtons = one.quickReplies.filter((q) => /^このお茶｜\d{5}｜診断$/.test(q.action.text));
  assertEqual(teaButtons.length, 1, "単一在庫 → おすすめ 1 件");
  assertEqual(teaButtons[0].action.text, "このお茶｜11301｜診断", "在るお茶に解決");
});

it("カタログ空 → graceful フォールバック（persona 受け止め + 相談導線・5 桁ボタン無し）", () => {
  for (const w of ["serenity", "explorer", "sensory"] as PersonaType[]) {
    const m = buildResultWithTeas(w, [], diagnosisRecommendationKarte(w));
    assertEqual(m.text.match(/\d{5}/g), null, `${w}: フォールバックに 5 桁の死番号なし`);
    assert(m.quickReplies.some((q) => q.action.text === CONSULT_MORE), `${w}: 相談導線を提示`);
    const reveal = { serenity: "静けさを愉しむ人", explorer: "旅する人", sensory: "深く愉しむ人" }[w];
    assert(m.text.includes(reveal), `${w}: persona の受け止めは必ず届く`);
  }
});

it("buildResultFallback も同じ graceful 契約（5 桁ボタン無し・相談導線）", () => {
  const m = buildResultFallback("serenity");
  assertEqual(m.text.match(/\d{5}/g), null, "fallback: 死番号なし");
  assert(m.quickReplies.some((q) => q.action.text === CONSULT_MORE), "fallback: 相談導線");
});

it("味の好み(Q2)がカタログ内の軸親和で並ぶ（sensory+コク → full ボディ上位・light 末尾）", () => {
  // sensory + Q2-3（コク）→ full ボディ寄り。全 4 件並べると light の 20101 が末尾。
  const picks = pickDiagnosisRecommendations(CATALOG, diagnosisRecommendationKarte("sensory", 3), 4);
  assertEqual(picks.length, 4, "4 件全て並ぶ");
  assertEqual(picks[picks.length - 1].number, "20101", "light ボディ(20101)は full 志向で最下位");
});

it("イントロ+Q1: ラベル≤20字・3択・トークン形式", () => {
  const m = buildIntroAndQ1();
  assertEqual(m.quickReplies.length, 3, "Q1 3 choices");
  for (const q of m.quickReplies) {
    assert(q.action.label.length <= LABEL_MAX, `label<=20 (${q.action.label})`);
    assert(/^診断｜[1-3]$/.test(q.action.text), `Q1 token (${q.action.text})`);
  }
});

console.log("\n--- (UX①) 診断結果ラベルの番号｜名前統一 ---");

it("診断結果: 本文行が `番号｜名前`（番号先頭・全角パイプ・break-proof）", () => {
  const m = buildResultWithTeas("sensory", CATALOG, diagnosisRecommendationKarte("sensory", 3));
  // 本文に `番号｜名前` 形式（5桁番号 + 全角パイプ）が現れる（① 統一・番号は必ず残る）。
  assert(/\d{5}｜/.test(m.text), "本文に 番号｜名前形式");
  // 旧・`名前（No.XXXXX）` 形式は撲滅（従来コードなら (No. で失敗する = break-proof）。
  assert(!/（No\.\d{5}）/.test(m.text), "旧・`名前（No.）` 形式を撲滅");
});

it("診断結果 QR: お茶ボタン label が `番号｜名前`・≤20（番号保全 truncate）", () => {
  const m = buildResultWithTeas("sensory", CATALOG, diagnosisRecommendationKarte("sensory", 3));
  const teaBtns = m.quickReplies.filter((q) => /^このお茶｜\d{5}｜診断$/.test(q.action.text));
  assert(teaBtns.length >= 1, "お茶ボタンがある");
  for (const q of teaBtns) {
    assert(/^\d{5}｜/.test(q.action.label), `QR 番号｜名前 (${q.action.label})`);
    assert(q.action.label.length <= LABEL_MAX, `≤20 (${q.action.label})`);
  }
});

console.log("\n" + "=".repeat(60));
console.log("Preference Diagnosis Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failed > 0 ? 1 : 0);
