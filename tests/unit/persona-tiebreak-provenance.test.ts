/**
 * Unit Tests — 好みタイプの「同点のときの決め方」と「点の出所の記録」
 *
 * ■ 何を守るテストか
 *   (1) 同点のとき、**いまの primary を維持する**（人のタイプが理由なく入れ替わらない）。
 *   (2) いまの primary が同点集合に居ないときは、**固定順で決定的に**決まる
 *       （キーの並び順を変えて何度実行しても同じ答えになる）。
 *   (3) 点の**出所（診断 / アンケート / 購入 / 会話）の内訳**が正しく積み上がる。
 *   (4) 内訳を足しても、**既存の合計 `persona.scores` は 1 点も変わらない**。
 *   (5) 合流（未連携カルテ → 本カルテ）で内訳が落ちず、合計と同じ足し方で足される。
 *   (6) 変異テスト — 同点処理を直す前の実装に戻すと、(1)(2) のテストが**赤くなる**こと。
 *
 * ■ なぜ (2) が要るか（元の壊れ方）
 *   従来 primary は `Object.entries(scores)` の並び順で決めていた。Firestore から読み直した
 *   scores のキー順は保証されず（本番で同一ドキュメントを 3 回読んで 3 回とも順序が違った）、
 *   同点の人はタイプ判定が読むたびに変わりうる状態だった。
 *
 * 実 Firestore / 実 Supabase / 外部送信には一切触れない（純粋関数 + 注入 fake のみ）。
 * 使用: npx tsx tests/unit/persona-tiebreak-provenance.test.ts
 */

import {
  PERSONA_AXES,
  pickPrimaryPersona,
  mergePersonaScores,
  mergePersonaScoresWithSource,
  addPersonaScoreSourceDeltas,
  unattributedPersonaScores,
  computeTasteProfileUpdates,
  toFirestoreValue,
  fromFirestoreValue,
  type PersonaScores,
  type PersonaScoreSources,
  type PersonaType,
  type CustomerProfile,
  type LineUserProfile,
} from "../../src/lib/firestore";
import { computeKarteCarryover, type SpecialFolders } from "../../src/lib/karte-merge-rules";
import {
  recordDiagnosisPersonaWith,
  DIAGNOSIS_WEIGHT,
  type RecordDiagnosisDeps,
} from "../../src/lib/preference-diagnosis";
import { surveyKarteUpdates, SURVEY_PERSONA_WEIGHT } from "../../src/lib/roji-survey-record";

let total = 0;
let passed = 0;
const failures: Array<{ name: string; error: string }> = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function it(name: string, fn: () => void | Promise<void>) {
  queue.push({ name, fn });
}
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

const LINE_ID = "U" + "9".repeat(32);
const NOW = "2026-08-09T00:00:00.000Z";

/** 指定した**キーの並び順**で scores を作る（並び順への依存を炙り出すため）。 */
function scoresInOrder(order: readonly PersonaType[], values: Record<PersonaType, number>): PersonaScores {
  const out: Record<string, number> = {};
  for (const k of order) out[k] = values[k];
  return out as PersonaScores;
}

/** 3 軸の並び順の全 6 通り。 */
const KEY_ORDERS: PersonaType[][] = [
  ["serenity", "explorer", "sensory"],
  ["serenity", "sensory", "explorer"],
  ["explorer", "serenity", "sensory"],
  ["explorer", "sensory", "serenity"],
  ["sensory", "serenity", "explorer"],
  ["sensory", "explorer", "serenity"],
];

// ===========================================================================
// (1) 同点 → いまの primary を維持
// ===========================================================================

it("同点: いまの primary が同点集合に居れば、それを維持する", () => {
  // アンケート explorer+3 済みの人が、好み診断で serenity+3 → 3 対 3 の同点。
  const tie: PersonaScores = { serenity: 3, explorer: 3, sensory: 0 };
  assertEqual(pickPrimaryPersona(tie, "explorer"), "explorer", "explorer を維持");
  assertEqual(pickPrimaryPersona(tie, "serenity"), "serenity", "serenity を維持");
});

it("同点: 3 軸すべて同点でも、いまの primary を維持する", () => {
  const tie: PersonaScores = { serenity: 3, explorer: 3, sensory: 3 };
  for (const axis of PERSONA_AXES) {
    assertEqual(pickPrimaryPersona(tie, axis), axis, `${axis} を維持`);
  }
});

it("同点でない: 最大軸が 1 つなら、いまの primary に関係なく最大軸を採る", () => {
  const scores: PersonaScores = { serenity: 3, explorer: 6, sensory: 0 };
  assertEqual(pickPrimaryPersona(scores, "serenity"), "explorer", "維持ではなく最大軸");
  assertEqual(pickPrimaryPersona(scores, null), "explorer", "primary 未設定でも最大軸");
});

it("mergePersonaScores 経由でも同点はいまの primary を維持する（診断 +3 で 3 対 3）", () => {
  const existing: PersonaScores = { serenity: 0, explorer: 3, sensory: 0 };
  const { scores, primary } = mergePersonaScores(existing, ["serenity"], DIAGNOSIS_WEIGHT, "explorer");
  assertEqual(scores, { serenity: 3, explorer: 3, sensory: 0 }, "合計は両方 3");
  assertEqual(primary, "explorer", "同点なので explorer のまま");
});

// ===========================================================================
// (2) 同点集合に居ない / primary 無し → 固定順で決定的（キー順を変えても不変）
// ===========================================================================

it("同点かつ既存 primary が同点集合に無い: 固定順（serenity→explorer→sensory）で決まる", () => {
  const tie: PersonaScores = { serenity: 3, explorer: 3, sensory: 0 };
  assertEqual(pickPrimaryPersona(tie, "sensory"), "serenity", "同点集合外 → 固定順の先頭");
  assertEqual(pickPrimaryPersona(tie, null), "serenity", "primary 無し → 固定順の先頭");
});

it("決定性: キーの並び順 6 通り × 各 3 回、答えが 1 つも揺れない", () => {
  const values: Record<PersonaType, number> = { serenity: 3, explorer: 3, sensory: 0 };
  const results: string[] = [];
  for (const order of KEY_ORDERS) {
    for (let i = 0; i < 3; i++) {
      results.push(pickPrimaryPersona(scoresInOrder(order, values), null));
    }
  }
  assertEqual(new Set(results).size, 1, `18 回の結果が割れた: ${JSON.stringify(results)}`);
  assertEqual(results[0], "serenity", "固定順の先頭に決まる");
});

it("決定性: いまの primary を維持する経路も、キーの並び順に左右されない", () => {
  const values: Record<PersonaType, number> = { serenity: 3, explorer: 3, sensory: 3 };
  const results = KEY_ORDERS.map((order) => pickPrimaryPersona(scoresInOrder(order, values), "sensory"));
  assertEqual(new Set(results).size, 1, `結果が割れた: ${JSON.stringify(results)}`);
  assertEqual(results[0], "sensory", "いまの primary を維持");
});

// ===========================================================================
// (6) 変異テスト — 同点処理を戻すと、上のテストが赤くなること
// ===========================================================================

type PickImpl = (scores: PersonaScores, currentPrimary: PersonaType | null) => PersonaType;

/** 変異体A = 直す**前**の実装（`Object.entries` の並び順で決める・いまの primary を見ない）。 */
const mutantKeyOrder: PickImpl = (scores) =>
  (Object.entries(scores) as Array<[PersonaType, number]>).reduce((a, b) => (b[1] > a[1] ? b : a))[0];

/** 変異体B = 決定的だが「いまの primary を維持」だけ落としたもの（固定順のみ）。 */
const mutantFixedOrderOnly: PickImpl = (scores) => {
  let winner: PersonaType = PERSONA_AXES[0];
  for (const axis of PERSONA_AXES) {
    if ((scores[axis] ?? 0) > (scores[winner] ?? 0)) winner = axis;
  }
  return winner;
};

/** 性質1「同点はいまの primary を維持」を満たすか。満たさなければ理由を返す。 */
function violatesTieKeepsCurrent(pick: PickImpl): string | null {
  const tie: PersonaScores = { serenity: 3, explorer: 3, sensory: 0 };
  const got = pick(tie, "explorer");
  return got === "explorer" ? null : `同点で primary が ${got} に入れ替わった`;
}

/** 性質2「キーの並び順に依らず決定的」を満たすか。満たさなければ理由を返す。 */
function violatesKeyOrderIndependence(pick: PickImpl): string | null {
  const values: Record<PersonaType, number> = { serenity: 3, explorer: 3, sensory: 0 };
  const results = KEY_ORDERS.map((order) => pick(scoresInOrder(order, values), null));
  return new Set(results).size === 1 ? null : `並び順で答えが割れた: ${JSON.stringify(results)}`;
}

it("変異テスト: 本実装は 2 つの性質を両方満たす", () => {
  assertEqual(violatesTieKeepsCurrent(pickPrimaryPersona), null, "性質1");
  assertEqual(violatesKeyOrderIndependence(pickPrimaryPersona), null, "性質2");
});

it("変異テスト: 直す前の実装（並び順で決める）に戻すと、両方の性質が破れる", () => {
  assert(
    violatesTieKeepsCurrent(mutantKeyOrder) !== null,
    "変異体Aが性質1を破らなかった = このテストは同点処理の退行を検知できない",
  );
  assert(
    violatesKeyOrderIndependence(mutantKeyOrder) !== null,
    "変異体Aが性質2を破らなかった = このテストは非決定の退行を検知できない",
  );
});

it("変異テスト: 「いまの primary を維持」だけ落とすと、性質1 だけが破れる", () => {
  assert(
    violatesTieKeepsCurrent(mutantFixedOrderOnly) !== null,
    "変異体Bが性質1を破らなかった = 維持の実装を消しても気づけない",
  );
  assertEqual(
    violatesKeyOrderIndependence(mutantFixedOrderOnly),
    null,
    "変異体Bは決定的なはず（2 つの性質が別物であることの確認）",
  );
});

// ===========================================================================
// (3)(4) 出所の内訳が積み上がる / 合計は 1 点も変わらない
// ===========================================================================

it("内訳: 診断 +3 と アンケート +3 が別々のバケツに積まれる（合計は 6 でなく軸ごと 3・3）", () => {
  const step1 = mergePersonaScoresWithSource({
    existingScores: { serenity: 0, explorer: 0, sensory: 0 },
    existingSources: undefined,
    currentPrimary: null,
    signals: ["serenity"],
    weight: DIAGNOSIS_WEIGHT,
    source: "diagnosis",
    now: NOW,
  });
  const step2 = mergePersonaScoresWithSource({
    existingScores: step1.scores,
    existingSources: step1.sources,
    currentPrimary: step1.primary,
    signals: ["explorer"],
    weight: SURVEY_PERSONA_WEIGHT,
    source: "survey",
    now: NOW,
  });
  assertEqual(step2.scores, { serenity: 3, explorer: 3, sensory: 0 }, "合計");
  assertEqual(step2.sources.diagnosis, { serenity: 3, explorer: 0, sensory: 0 }, "診断のバケツ");
  assertEqual(step2.sources.survey, { serenity: 0, explorer: 3, sensory: 0 }, "アンケートのバケツ");
  assertEqual(step2.primary, "serenity", "同点なので step1 の primary を維持");
});

it("合計は 1 点も変わらない: 出所つきの計算が、従来の足し算と完全に一致する", () => {
  const cases: Array<{ existing: PersonaScores; signals: PersonaType[]; weight: number }> = [
    { existing: { serenity: 0, explorer: 0, sensory: 0 }, signals: ["serenity"], weight: 3 },
    { existing: { serenity: 1, explorer: 2, sensory: 3 }, signals: ["explorer"], weight: 3 },
    { existing: { serenity: 9, explorer: 0, sensory: 0 }, signals: ["sensory"], weight: 3 },
    { existing: { serenity: 1, explorer: 0, sensory: 0 }, signals: ["serenity", "explorer"], weight: 1 },
    { existing: { serenity: 2, explorer: 2, sensory: 2 }, signals: [], weight: 3 },
  ];
  for (const c of cases) {
    // 従来の足し算（この 3 行が改修前の scores の作り方そのもの）。
    const reference: PersonaScores = { ...c.existing };
    for (const s of c.signals) reference[s] = (reference[s] ?? 0) + c.weight;

    const withSource = mergePersonaScoresWithSource({
      existingScores: c.existing,
      existingSources: undefined,
      currentPrimary: null,
      signals: c.signals,
      weight: c.weight,
      source: "diagnosis",
      now: NOW,
    });
    assertEqual(withSource.scores, reference, `合計が変わった: ${JSON.stringify(c)}`);
  }
});

it("入力を壊さない（純粋・非破壊）: 既存の scores / sources オブジェクトを書き換えない", () => {
  const existing: PersonaScores = { serenity: 1, explorer: 2, sensory: 3 };
  const sources: PersonaScoreSources = { diagnosis: { serenity: 1, explorer: 0, sensory: 0 } };
  mergePersonaScoresWithSource({
    existingScores: existing,
    existingSources: sources,
    currentPrimary: "sensory",
    signals: ["explorer"],
    weight: 3,
    source: "survey",
    now: NOW,
  });
  assertEqual(existing, { serenity: 1, explorer: 2, sensory: 3 }, "scores が書き換わった");
  assertEqual(sources.diagnosis, { serenity: 1, explorer: 0, sensory: 0 }, "内訳が書き換わった");
  assertEqual(sources.survey, undefined, "元の内訳に survey が生えた");
});

it("内訳: 増減が無いときは lastUpdated も動かさない（意味のない書き込みを作らない）", () => {
  const before: PersonaScoreSources = { survey: { serenity: 3, explorer: 0, sensory: 0 } };
  const after = addPersonaScoreSourceDeltas(before, "survey", {}, NOW);
  assertEqual(after, before, "何も動いていないのに書き換わった");
});

it("出所不明分: 記録開始前に貯まっていた点は、遡って割り振らず残差として見える", () => {
  // 記録が無い状態で serenity=5（昔の会話・購入で貯まった分）。
  const legacy: PersonaScores = { serenity: 5, explorer: 0, sensory: 0 };
  assertEqual(
    unattributedPersonaScores(legacy, undefined),
    { serenity: 5, explorer: 0, sensory: 0 },
    "全部が出所不明",
  );
  // そこへ診断 +3。増えた分だけが診断のバケツに入り、昔の 5 点は不明のまま。
  const r = mergePersonaScoresWithSource({
    existingScores: legacy,
    existingSources: undefined,
    currentPrimary: "serenity",
    signals: ["serenity"],
    weight: DIAGNOSIS_WEIGHT,
    source: "diagnosis",
    now: NOW,
  });
  assertEqual(r.scores.serenity, 8, "合計 8");
  assertEqual(r.sources.diagnosis, { serenity: 3, explorer: 0, sensory: 0 }, "診断は 3 点だけ");
  assertEqual(
    unattributedPersonaScores(r.scores, r.sources),
    { serenity: 5, explorer: 0, sensory: 0 },
    "昔の 5 点は出所不明のまま（遡って割り振らない）",
  );
});

it("会話・購入も内訳に積む（computeTasteProfileUpdates 経由）", () => {
  const conv = computeTasteProfileUpdates(
    {
      preferred_categories: [],
      flavor_preferences: [],
      scene_preferences: [],
      persona_signals: ["serenity"],
      explicit_statements: [],
    },
    undefined,
    undefined,
    1,
  );
  assertEqual(conv.personaScoreSources?.conversation, { serenity: 1, explorer: 0, sensory: 0 }, "会話 +1");

  const purchase = computeTasteProfileUpdates(
    {
      preferred_categories: [],
      flavor_preferences: [],
      scene_preferences: [],
      persona_signals: ["explorer"],
      explicit_statements: [],
    },
    undefined,
    conv.persona,
    3,
    { source: "purchase", existingSources: conv.personaScoreSources },
  );
  assertEqual(purchase.personaScoreSources?.conversation, { serenity: 1, explorer: 0, sensory: 0 }, "会話分は残る");
  assertEqual(purchase.personaScoreSources?.purchase, { serenity: 0, explorer: 3, sensory: 0 }, "購入 +3");
  assertEqual(purchase.persona?.scores, { serenity: 1, explorer: 3, sensory: 0 }, "合計");
});

// ===========================================================================
// 呼び出し元の一貫性 — 診断 / アンケート
// ===========================================================================

it("診断の記録: 同点になっても既存 primary を維持し、出所 diagnosis を残す（連携済み）", async () => {
  let written: Partial<CustomerProfile> | null = null;
  const existing: CustomerProfile = {
    persona: { primary: "explorer", scores: { serenity: 0, explorer: 3, sensory: 0 }, lastUpdated: NOW },
    personaScoreSources: { survey: { serenity: 0, explorer: 3, sensory: 0 } },
  };
  const deps: RecordDiagnosisDeps = {
    resolveShopifyId: async () => "9999",
    getShopifyProfile: async () => existing,
    updateShopifyProfile: async (_id, updates) => {
      written = updates;
    },
    getLineProfile: async () => null,
    updateLineProfile: async () => {},
  };
  const path = await recordDiagnosisPersonaWith(LINE_ID, "serenity", deps);
  assertEqual(path, "shopify", "連携済み経路");
  assert(written !== null, "書き込みが起きていない");
  const w = written as Partial<CustomerProfile>;
  assertEqual(w.persona?.scores, { serenity: 3, explorer: 3, sensory: 0 }, "3 対 3 の同点");
  assertEqual(w.persona?.primary, "explorer", "同点なので explorer のまま（読むたびに変わらない）");
  assertEqual(w.personaScoreSources?.diagnosis, { serenity: 3, explorer: 0, sensory: 0 }, "診断の内訳");
  assertEqual(w.personaScoreSources?.survey, { serenity: 0, explorer: 3, sensory: 0 }, "アンケートの内訳は保持");
});

it("診断の記録: 未連携カルテでも同じ扱い（同点維持 + 出所 diagnosis）", async () => {
  let written: Partial<LineUserProfile> | null = null;
  const existingLine: LineUserProfile = {
    lineUserId: LINE_ID,
    persona: { primary: "sensory", scores: { serenity: 0, explorer: 0, sensory: 3 }, lastUpdated: NOW },
    personaScoreSources: { survey: { serenity: 0, explorer: 0, sensory: 3 } },
  };
  const deps: RecordDiagnosisDeps = {
    resolveShopifyId: async () => null,
    getShopifyProfile: async () => null,
    updateShopifyProfile: async () => {},
    getLineProfile: async () => existingLine,
    updateLineProfile: async (_id, updates) => {
      written = updates;
    },
  };
  const path = await recordDiagnosisPersonaWith(LINE_ID, "explorer", deps);
  assertEqual(path, "line", "未連携経路");
  const w = written as unknown as Partial<LineUserProfile>;
  assertEqual(w.persona?.primary, "sensory", "同点なので sensory のまま");
  assertEqual(w.personaScoreSources?.diagnosis, { serenity: 0, explorer: 3, sensory: 0 }, "診断の内訳");
});

it("アンケート問い3: 出所 survey に積み、同点なら既存 primary を維持する", () => {
  const existing = {
    persona: { primary: "serenity" as PersonaType, scores: { serenity: 3, explorer: 0, sensory: 0 }, lastUpdated: NOW },
    personaScoreSources: { diagnosis: { serenity: 3, explorer: 0, sensory: 0 } },
  };
  const out = surveyKarteUpdates({ step: "q3", slug: "explorer" }, existing, { isFirstTap: true, now: NOW });
  assertEqual(out.persona?.scores, { serenity: 3, explorer: 3, sensory: 0 }, "3 対 3");
  assertEqual(out.persona?.primary, "serenity", "同点なので serenity のまま");
  assertEqual(out.personaScoreSources?.survey, { serenity: 0, explorer: 3, sensory: 0 }, "アンケートの内訳");
  assertEqual(out.personaScoreSources?.diagnosis, { serenity: 3, explorer: 0, sensory: 0 }, "診断の内訳は保持");
});

it("アンケート押し替え: 合計と内訳が同じだけ戻る（積み上がらない）", () => {
  // アンケートで serenity を選んだ後、explorer に押し替える。
  const first = surveyKarteUpdates({ step: "q3", slug: "serenity" }, {}, { isFirstTap: true, now: NOW });
  assertEqual(first.persona?.scores, { serenity: 3, explorer: 0, sensory: 0 }, "1 回目");
  assertEqual(first.personaScoreSources?.survey, { serenity: 3, explorer: 0, sensory: 0 }, "1 回目の内訳");

  const second = surveyKarteUpdates(
    { step: "q3", slug: "explorer", replaces: "serenity" },
    { persona: first.persona, personaScoreSources: first.personaScoreSources },
    { isFirstTap: false, now: NOW },
  );
  assertEqual(second.persona?.scores, { serenity: 0, explorer: 3, sensory: 0 }, "前の分が戻っている");
  assertEqual(
    second.personaScoreSources?.survey,
    { serenity: 0, explorer: 3, sensory: 0 },
    "内訳も同じだけ戻る（合計とずれない）",
  );
  assertEqual(second.persona?.primary, "explorer", "最大軸は explorer");
  assertEqual(SURVEY_PERSONA_WEIGHT, 3, "重みは 3 のまま（この修正で変えていない）");
});

it("アンケート押し替え: 合計の作り方は従来（Math.max(0, x - 3)）と一致する", () => {
  // 他の出所で貯まった 1 点しか無い軸を押し替えても、合計は 0 未満にならない。
  const existing = {
    persona: { primary: "serenity" as PersonaType, scores: { serenity: 1, explorer: 0, sensory: 0 }, lastUpdated: NOW },
  };
  const out = surveyKarteUpdates(
    { step: "q3", slug: "explorer", replaces: "serenity" },
    existing,
    { isFirstTap: false, now: NOW },
  );
  assertEqual(out.persona?.scores.serenity, Math.max(0, 1 - SURVEY_PERSONA_WEIGHT), "0 未満にしない");
  assertEqual(out.personaScoreSources?.survey?.serenity, 0, "内訳も 0 未満にしない");
});

// ===========================================================================
// (5) 合流（未連携カルテ → 本カルテ）で内訳が落ちない
// ===========================================================================

it("合流: 点の内訳が出所ごと・軸ごとに足される（落ちない・上書きしない）", () => {
  const folders: SpecialFolders = {
    foldPersona: () => undefined, // 合計側は別テスト（本テストの関心は内訳の規則）
    foldTaste: () => undefined,
  };
  const lineProfile: LineUserProfile = {
    lineUserId: LINE_ID,
    personaScoreSources: {
      survey: { serenity: 3, explorer: 0, sensory: 0 },
      diagnosis: { serenity: 0, explorer: 3, sensory: 0 },
      lastUpdated: "2026-08-01T00:00:00.000Z",
    },
  };
  const customerProfile: CustomerProfile = {
    personaScoreSources: {
      purchase: { serenity: 0, explorer: 0, sensory: 6 },
      survey: { serenity: 1, explorer: 0, sensory: 0 },
    },
  };
  const { updates, record } = computeKarteCarryover(
    lineProfile,
    customerProfile,
    { lineUserId: LINE_ID, shopifyCustomerId: "9999", now: NOW },
    folders,
  );
  assertEqual(updates.personaScoreSources?.survey, { serenity: 4, explorer: 0, sensory: 0 }, "同じ出所は足す");
  assertEqual(updates.personaScoreSources?.diagnosis, { serenity: 0, explorer: 3, sensory: 0 }, "未連携側だけの出所も入る");
  assertEqual(updates.personaScoreSources?.purchase, { serenity: 0, explorer: 0, sensory: 6 }, "本カルテ側の出所は消えない");
  assertEqual(updates.personaScoreSources?.lastUpdated, NOW, "lastUpdated は合流時刻");
  assert(record.carried.includes("personaScoreSources"), "持ち越した記録に載っていない");
  assert(
    !record.carriedByDefaultRule.includes("personaScoreSources"),
    "既定規則で拾われている = 規則の表に宣言が無い",
  );
});

it("保存の形: 2 段の入れ子（出所 → 軸 → 点）が Firestore の形に往復できる", () => {
  // 既存のカルテ項目（窓への傾き等）は 1 段の表しか無く、内訳は初めての 2 段。
  // 変換が 1 段しか対応していないと、保存できるのに読み戻すと空、という形で静かに壊れる。
  const sources: PersonaScoreSources = {
    diagnosis: { serenity: 3, explorer: 0, sensory: 0 },
    survey: { serenity: 0, explorer: 3, sensory: 0 },
    lastUpdated: NOW,
  };
  const roundTripped = fromFirestoreValue(toFirestoreValue(sources));
  assertEqual(roundTripped, sources, "往復で形が変わった");
});

it("合流: 未連携側に内訳が無ければ、本カルテ側を触らない", () => {
  const folders: SpecialFolders = { foldPersona: () => undefined, foldTaste: () => undefined };
  const { updates } = computeKarteCarryover(
    { lineUserId: LINE_ID } as LineUserProfile,
    { personaScoreSources: { purchase: { serenity: 0, explorer: 0, sensory: 6 } } },
    { lineUserId: LINE_ID, shopifyCustomerId: "9999", now: NOW },
    folders,
  );
  assertEqual(updates.personaScoreSources, undefined, "空更新を起こしている");
});

// ---------------------------------------------------------------------------
// ランナー
// ---------------------------------------------------------------------------
(async () => {
  console.log("\n--- persona tiebreak / provenance ---");
  for (const t of queue) {
    total++;
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ name: t.name, error: msg });
      console.log(`  [FAIL] ${t.name}: ${msg}`);
    }
  }
  console.log("\n============================================================");
  console.log("persona-tiebreak-provenance Test Results");
  console.log("============================================================");
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${total - passed}`);
  if (passed < total) process.exit(1);
})();
