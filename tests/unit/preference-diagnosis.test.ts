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
  buildResult,
  buildIntroAndQ1,
  DIAGNOSIS_TRIGGER,
  DIAGNOSIS_WEIGHT,
} from "../../src/lib/preference-diagnosis";
import { mergePersonaScores, type PersonaType, type PersonaScores } from "../../src/lib/firestore";

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
    const { scores, primary } = mergePersonaScores(zero, [w], DIAGNOSIS_WEIGHT);
    assertEqual(primary, w, `new user primary=${w}`);
    assertEqual(scores[w], 3, `winner +3`);
  }
});

it("既存ユーザー（履歴が上回る）: primary は履歴側のまま（乖離許容・仕様）", () => {
  // 購入履歴で serenity=9 のユーザーが診断で sensory になっても、記録 primary は serenity のまま。
  const existing: PersonaScores = { serenity: 9, explorer: 0, sensory: 0 };
  const { scores, primary } = mergePersonaScores(existing, ["sensory"], DIAGNOSIS_WEIGHT);
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

console.log("\n--- (g) 結果 quick reply 制約・お茶カード接続 ---");

it("全 winner 結果: quick reply 4個・13以下・ラベル≤20字・お茶カード/相談導線", () => {
  for (const w of ["serenity", "explorer", "sensory"] as PersonaType[]) {
    const m = buildResult(w);
    assertEqual(m.quickReplies.length, 4, `${w}: 4 buttons`);
    assert(m.quickReplies.length <= QR_MAX, `${w}: <=13`);
    for (const q of m.quickReplies) {
      assert(q.action.label.length <= LABEL_MAX, `${w}: label<=20 (${q.action.label})`);
    }
    // 先頭3つはお茶カードトークン（tea-menu の「このお茶｜{番号}」へ接続）
    const teaButtons = m.quickReplies.slice(0, 3);
    assert(
      teaButtons.every((q) => /^このお茶｜\d{5}$/.test(q.action.text)),
      `${w}: 3 tea card tokens`,
    );
    // 4つ目は「もっと相談する」→ ③相談入口テキスト
    assertEqual(
      m.quickReplies[3].action.text,
      "お茶選びを相談したいです",
      `${w}: consult more`,
    );
  }
});

it("イントロ+Q1: ラベル≤20字・3択・トークン形式", () => {
  const m = buildIntroAndQ1();
  assertEqual(m.quickReplies.length, 3, "Q1 3 choices");
  for (const q of m.quickReplies) {
    assert(q.action.label.length <= LABEL_MAX, `label<=20 (${q.action.label})`);
    assert(/^診断｜[1-3]$/.test(q.action.text), `Q1 token (${q.action.text})`);
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
