/**
 * Unit Tests — computeTasteProfileUpdates（P0-6 users/lineUsers 共有マージ）
 *
 * 純粋関数のみ検証（I/O なし）。users と lineUsers が同一ロジックで書けることの土台。
 *   - taste の union マージ（重複排除・上限50）
 *   - persona 加算（weight 反映・別軸累積）
 *   - persona_signals ゼロなら persona フィールドを付けない
 *   - lastActiveAt を必ず返す
 *
 * 使用: npx tsx tests/unit/taste-profile.test.ts
 */

import { computeTasteProfileUpdates } from "../../src/lib/firestore";
import type { PreferenceSignals } from "../../src/lib/preference-extractor";

let total = 0;
let passed = 0;
const queue: Array<{ name: string; fn: () => void }> = [];
function it(name: string, fn: () => void) {
  queue.push({ name, fn });
}
function assertEqual<T>(a: T, e: T, label = "") {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertTrue(v: boolean, label = "") {
  if (!v) throw new Error(`${label}: expected true`);
}

const sig = (over: Partial<PreferenceSignals> = {}): PreferenceSignals => ({
  preferred_categories: [],
  flavor_preferences: [],
  scene_preferences: [],
  persona_signals: [],
  explicit_statements: [],
  ...over,
});

it("taste: 既存 + 新規を union（重複排除）", () => {
  const r = computeTasteProfileUpdates(
    sig({ preferred_categories: ["sencha", "hojicha"], flavor_preferences: ["mellow"] }),
    { preferredCategories: ["sencha"], flavorPreferences: [], scenePref: null },
    undefined,
  );
  assertEqual(r.tasteProfile.preferredCategories.join(","), "sencha,hojicha", "union dedup");
  assertEqual(r.tasteProfile.flavorPreferences.join(","), "mellow", "flavor");
});

it("persona: signals があれば weight で加算（別軸累積）", () => {
  const r = computeTasteProfileUpdates(
    sig({ persona_signals: ["serenity"] }),
    undefined,
    { primary: null, scores: { serenity: 0, explorer: 2, sensory: 0 }, lastUpdated: "t" },
    1,
  );
  assertTrue(!!r.persona, "persona 生成");
  assertEqual(r.persona!.scores.serenity, 1, "serenity +1");
  assertEqual(r.persona!.scores.explorer, 2, "explorer 据え置き（別軸）");
});

it("persona: weight=2（評価相当）で加算", () => {
  const r = computeTasteProfileUpdates(sig({ persona_signals: ["explorer"] }), undefined, undefined, 2);
  assertEqual(r.persona!.scores.explorer, 2, "explorer +2");
});

it("persona_signals ゼロなら persona フィールドを付けない", () => {
  const r = computeTasteProfileUpdates(sig({ preferred_categories: ["sencha"] }), undefined, undefined);
  assertTrue(r.persona === undefined, "persona なし");
});

it("lastActiveAt を必ず返す", () => {
  const r = computeTasteProfileUpdates(sig(), undefined, undefined);
  assertTrue(typeof r.lastActiveAt === "string" && r.lastActiveAt.length > 0, "lastActiveAt");
});

it("preferredCategories は上限50件に丸める", () => {
  const many = Array.from({ length: 60 }, (_, i) => `c${i}`);
  const r = computeTasteProfileUpdates(sig({ preferred_categories: many }), undefined, undefined);
  assertEqual(r.tasteProfile.preferredCategories.length, 50, "上限50");
});

for (const t of queue) {
  total++;
  try {
    t.fn();
    passed++;
    console.log(`  [PASS] ${t.name}`);
  } catch (err) {
    console.log(`  [FAIL] ${t.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log("\n============================================================");
console.log("taste-profile Test Results");
console.log("============================================================");
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${total - passed}`);
if (passed < total) process.exit(1);
