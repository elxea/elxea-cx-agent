/**
 * Unit Tests -- recordDiagnosisPersonaWith（診断結果カルテ記録の分岐・UX レビュー指摘 #2）
 *
 * 検証範囲:
 *   (a) 連携済み: users/{shopifyId} に加算（従来挙動）。lineUsers は触らない。
 *   (b) 未連携・新規: lineUsers/{lineUserId} に作成（createdAt 刻む・winner +3・primary=winner）。
 *   (c) 未連携・既存: 既存 LINE カルテに別軸で累積加算（上書きしない・履歴尊重の tiebreak）。
 *   (d) weight=3 が両経路で一貫（購入と同格）。
 *
 * 実 Firestore / 実 Supabase には触れない（deps 注入で fake）。
 * 使用方法: npx tsx tests/unit/preference-diagnosis-record.test.ts
 */
import {
  recordDiagnosisPersonaWith,
  runDiagnosisSideEffects,
  diagnosisTasteSignals,
  tasteFromDiagnosisQ2,
  type RecordDiagnosisDeps,
} from "../../src/lib/preference-diagnosis";
import type {
  CustomerProfile,
  LineUserProfile,
  PersonaScores,
  TasteProfile,
} from "../../src/lib/firestore";

let total = 0,
  passed = 0,
  failed = 0;
const failures: Array<{ name: string; error: string }> = [];
const queue: Array<{ name: string; fn: () => Promise<void> }> = [];
function it(name: string, fn: () => Promise<void>) {
  queue.push({ name, fn });
}
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const LINE_ID = "U" + "1".repeat(32);

/** 呼び出しを記録する fake deps を作る。 */
function makeDeps(opts: {
  shopifyId?: string | null;
  shopifyProfile?: CustomerProfile | null;
  lineProfile?: LineUserProfile | null;
}) {
  const captured = {
    shopifyUpdate: null as { id: string; updates: Partial<CustomerProfile> } | null,
    lineUpdate: null as { id: string; updates: Partial<LineUserProfile> } | null,
    getLineCalled: false,
    getShopifyCalled: false,
  };
  const deps: RecordDiagnosisDeps = {
    resolveShopifyId: async () => opts.shopifyId ?? null,
    getShopifyProfile: async () => {
      captured.getShopifyCalled = true;
      return opts.shopifyProfile ?? null;
    },
    updateShopifyProfile: async (id, updates) => {
      captured.shopifyUpdate = { id, updates };
    },
    getLineProfile: async () => {
      captured.getLineCalled = true;
      return opts.lineProfile ?? null;
    },
    updateLineProfile: async (id, updates) => {
      captured.lineUpdate = { id, updates };
    },
  };
  return { deps, captured };
}

/**
 * 状態を持つ fake deps（書いた値をそのまま読み返す）。
 * 「同じ人が診断を複数回やる」を実際に再現するために使う（差分計算だけでは冪等を確認できない）。
 */
function makeStatefulDeps(opts: { shopifyId?: string | null; initial?: LineUserProfile | null }) {
  const state = {
    shopify: null as CustomerProfile | null,
    line: (opts.initial ?? null) as LineUserProfile | null,
    writes: 0,
  };
  const deps: RecordDiagnosisDeps = {
    resolveShopifyId: async () => opts.shopifyId ?? null,
    getShopifyProfile: async () => state.shopify,
    updateShopifyProfile: async (_id, updates) => {
      state.writes++;
      state.shopify = { ...(state.shopify ?? {}), ...updates } as CustomerProfile;
    },
    getLineProfile: async () => state.line,
    updateLineProfile: async (_id, updates) => {
      state.writes++;
      state.line = { ...(state.line ?? {}), ...updates } as LineUserProfile;
    },
  };
  return { deps, state };
}

it("(a) 連携済み → users に加算・lineUsers は触らない", async () => {
  const { deps, captured } = makeDeps({ shopifyId: "12345", shopifyProfile: null });
  const path = await recordDiagnosisPersonaWith(LINE_ID, "explorer", deps);
  assertEqual(path, "shopify", "path=shopify");
  assert(captured.shopifyUpdate !== null, "shopify updated");
  assert(captured.lineUpdate === null, "line NOT updated");
  assert(!captured.getLineCalled, "getLineProfile not called");
  const persona = captured.shopifyUpdate!.updates.persona!;
  assertEqual(persona.primary, "explorer", "primary=winner");
  assertEqual((persona.scores as PersonaScores).explorer, 3, "winner +3 (weight=3)");
  assertEqual(captured.shopifyUpdate!.id, "12345", "keyed by shopifyId");
});

it("(b) 未連携・新規 → lineUsers 作成（createdAt・winner +3・primary=winner・lineUserId 保持）", async () => {
  const { deps, captured } = makeDeps({ shopifyId: null, lineProfile: null });
  const path = await recordDiagnosisPersonaWith(LINE_ID, "sensory", deps);
  assertEqual(path, "line", "path=line");
  assert(captured.lineUpdate !== null, "line updated");
  assert(captured.shopifyUpdate === null, "shopify NOT updated");
  const u = captured.lineUpdate!.updates;
  assertEqual(captured.lineUpdate!.id, LINE_ID, "keyed by lineUserId");
  assertEqual(u.lineUserId, LINE_ID, "lineUserId field mirrored");
  assert(typeof u.createdAt === "string", "createdAt set on new record");
  assertEqual(u.persona!.primary, "sensory", "primary=winner");
  assertEqual((u.persona!.scores as PersonaScores).sensory, 3, "winner +3");
});

it("(c) 未連携・既存 → 別軸に累積加算・上書きしない・tiebreak 履歴尊重", async () => {
  // 既存 LINE カルテ serenity=3。診断 winner=explorer(+3) → 両軸 3 の同点は先勝ちで serenity。
  const existing: LineUserProfile = {
    persona: { primary: "serenity", scores: { serenity: 3, explorer: 0, sensory: 0 }, lastUpdated: "x" },
  };
  const { deps, captured } = makeDeps({ shopifyId: null, lineProfile: existing });
  const path = await recordDiagnosisPersonaWith(LINE_ID, "explorer", deps);
  assertEqual(path, "line", "path=line");
  const u = captured.lineUpdate!.updates;
  const scores = u.persona!.scores as PersonaScores;
  assertEqual(scores.serenity, 3, "既存 serenity 保持（上書きしない）");
  assertEqual(scores.explorer, 3, "explorer に +3 累積");
  assertEqual(u.persona!.primary, "serenity", "同点は先勝ち serenity（履歴尊重）");
  assert(u.createdAt === undefined, "既存レコードには createdAt を再設定しない");
});

it("(d) 未連携でも既存スコアが上回れば primary は据え置き（乖離許容・仕様）", async () => {
  const existing: LineUserProfile = {
    persona: { primary: "serenity", scores: { serenity: 9, explorer: 0, sensory: 0 }, lastUpdated: "x" },
  };
  const { deps, captured } = makeDeps({ shopifyId: null, lineProfile: existing });
  await recordDiagnosisPersonaWith(LINE_ID, "sensory", deps);
  const scores = captured.lineUpdate!.updates.persona!.scores as PersonaScores;
  assertEqual(scores.serenity, 9, "serenity 保持");
  assertEqual(scores.sensory, 3, "sensory +3 累積");
  assertEqual(captured.lineUpdate!.updates.persona!.primary, "serenity", "primary 据え置き");
});

// ---------------------------------------------------------------------------
// Spec §7 の保存漏れ修正（2026-08-09）: 味わい（Q2）と場面（Q1）を tasteProfile に残す。
//   §7 原文: Q1→scenePref（1=relaxation, 2=explore, 3=taste）、
//            Q2→flavorPreferences（1=mellow/sweet, 2=floral, 3=rich, 4=refreshing）
//   3 タイプ（persona.scores +3）は別項目なので一切変更していないことも併せて固定する。
// ---------------------------------------------------------------------------

it("(e) Q1 → scenePref / Q2 → flavorPreferences が Spec §7 の語彙で写る [pure]", async () => {
  assertEqual(diagnosisTasteSignals(1, 1).scene_preferences.join(","), "relaxation", "Q1-1");
  assertEqual(diagnosisTasteSignals(2, 1).scene_preferences.join(","), "explore", "Q1-2");
  assertEqual(diagnosisTasteSignals(3, 1).scene_preferences.join(","), "taste", "Q1-3");
  assertEqual(diagnosisTasteSignals(1, 1).flavor_preferences.join(","), "mellow,sweet", "Q2-1");
  assertEqual(diagnosisTasteSignals(1, 2).flavor_preferences.join(","), "floral", "Q2-2");
  assertEqual(diagnosisTasteSignals(1, 3).flavor_preferences.join(","), "rich", "Q2-3");
  assertEqual(diagnosisTasteSignals(1, 4).flavor_preferences.join(","), "refreshing", "Q2-4");
  // 保存経路は persona に一切触れない（3 タイプの記録は mergePersonaScores 側だけが持つ）。
  assertEqual(diagnosisTasteSignals(2, 2).persona_signals.length, 0, "persona_signals は常に空");
});

it("(f) Q2-2「香り高く、個性を感じる」は floral として保存される（並べ替え用は null のまま）", async () => {
  const { deps, state } = makeStatefulDeps({ shopifyId: null });
  await recordDiagnosisPersonaWith(LINE_ID, "explorer", deps, { q1: 2, q2: 2 });
  const t = state.line!.tasteProfile!;
  assertEqual(t.flavorPreferences.join(","), "floral", "Q2-2 は floral で残る");
  assertEqual(t.scenePref, "explore", "Q1-2 は explore");
  // 並べ替え用（karteAffinity 用）は一切変更していない = 銘柄の並びは回帰しない。
  assertEqual(tasteFromDiagnosisQ2(2), null, "並べ替え用 tasteFromDiagnosisQ2(2) は null のまま");
});

it("(g) 既存の好み（購入・会話由来）を壊さず union で足す", async () => {
  const existingTaste: TasteProfile = {
    preferredCategories: ["green", "hojicha"],
    flavorPreferences: ["smoky"],
    scenePref: "morning",
  };
  const { deps, state } = makeStatefulDeps({
    shopifyId: null,
    initial: { tasteProfile: existingTaste },
  });
  await recordDiagnosisPersonaWith(LINE_ID, "sensory", deps, { q1: 1, q2: 3 });
  const t = state.line!.tasteProfile!;
  assertEqual(t.preferredCategories.join(","), "green,hojicha", "カテゴリは触らない");
  assertEqual(t.flavorPreferences.join(","), "smoky,rich", "既存 smoky を残して rich を足す");
  assertEqual(t.scenePref, "relaxation", "場面は今回の答えを代表値に置く");
});

it("(h) 冪等: 同じ診断を 3 回やっても好みが重複蓄積しない（3 タイプは仕様どおり累積）", async () => {
  const { deps, state } = makeStatefulDeps({ shopifyId: null });
  for (let i = 0; i < 3; i++) {
    await recordDiagnosisPersonaWith(LINE_ID, "serenity", deps, { q1: 1, q2: 1 });
  }
  assertEqual(state.writes, 3, "3 回書き込んだ（実際に 3 回叩いている）");
  const t = state.line!.tasteProfile!;
  assertEqual(t.flavorPreferences.join(","), "mellow,sweet", "味わいは重複しない（2 件のまま）");
  assertEqual(t.flavorPreferences.length, 2, "3 回でも 2 件");
  assertEqual(t.scenePref, "relaxation", "場面も同じ値のまま");
  // 3 タイプは「別軸への累積加算」が既存仕様（今回変更していない）。ここで固定して混同を防ぐ。
  assertEqual(
    (state.line!.persona!.scores as PersonaScores).serenity,
    9,
    "persona は既存仕様どおり 3 回分累積（3×3=9・今回の修正対象外）",
  );
});

it("(i) 回答を渡さないときは tasteProfile を書かない（既存呼び出しの後方互換）", async () => {
  const { deps, captured } = makeDeps({ shopifyId: null, lineProfile: null });
  await recordDiagnosisPersonaWith(LINE_ID, "serenity", deps);
  assert(
    captured.lineUpdate!.updates.tasteProfile === undefined,
    "answers なし → tasteProfile を含めない",
  );
});

// ---------------------------------------------------------------------------
// ブロック1 堅牢化（2026-07-16・QA 指摘②）: 返信失敗が persona 記録を道連れにしない。
//   旧実装は reply throw で record 未到達だった。runDiagnosisSideEffects が
//   返信失敗を捕捉→記録完遂→元の例外を再送出することを保証する。
// ---------------------------------------------------------------------------
it("(堅牢化) 返信が throw しても persona 記録は完遂し、記録後に元の例外を再送出", async () => {
  const order: string[] = [];
  let recorded = false;
  let rethrown: unknown = null;
  try {
    await runDiagnosisSideEffects({
      reply: async () => {
        order.push("reply");
        throw new Error("Invalid reply token");
      },
      logFlowEvents: () => order.push("flow"),
      record: async () => {
        order.push("record");
        recorded = true;
      },
    });
  } catch (err) {
    rethrown = err;
  }
  assert(recorded, "返信失敗でも record が実行される");
  assertEqual(order.join(","), "reply,flow,record", "reply→flow→record の順で完遂");
  assert(rethrown instanceof Error, "返信失敗は記録完遂後に元の例外として再送出される");
  assertEqual(
    (rethrown as Error).message,
    "Invalid reply token",
    "元の返信例外がそのまま伝播",
  );
});

it("(正常系) 返信成功時は reply→flow→record 実行・再送出なし", async () => {
  const order: string[] = [];
  let rethrown: unknown = null;
  try {
    await runDiagnosisSideEffects({
      reply: async () => order.push("reply"),
      logFlowEvents: () => order.push("flow"),
      record: async () => order.push("record"),
    });
  } catch (err) {
    rethrown = err;
  }
  assertEqual(order.join(","), "reply,flow,record", "reply→flow→record 順");
  assert(rethrown === null, "正常時は再送出しない");
});

it("(正常系) winner なし（record=null）でも返信・ファネル記録は走る", async () => {
  const order: string[] = [];
  await runDiagnosisSideEffects({
    reply: async () => order.push("reply"),
    logFlowEvents: () => order.push("flow"),
    record: null,
  });
  assertEqual(order.join(","), "reply,flow", "record 無しでも reply→flow");
});

(async () => {
  console.log("\n--- recordDiagnosisPersonaWith Unit Tests ---");
  for (const t of queue) {
    total++;
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${t.name}: ${msg}`);
      failures.push({ name: t.name, error: msg });
    }
  }
  console.log("\n" + "=".repeat(60));
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
