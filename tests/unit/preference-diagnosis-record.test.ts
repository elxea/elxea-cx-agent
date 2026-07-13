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
  type RecordDiagnosisDeps,
} from "../../src/lib/preference-diagnosis";
import type { CustomerProfile, LineUserProfile, PersonaScores } from "../../src/lib/firestore";

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
