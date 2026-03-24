/**
 * Unit Tests -- purchase-signals
 *
 * 商品タグ → ペルソナシグナル/カテゴリ/フレーバー抽出のテスト。
 *
 * 使用方法:
 *   npx tsx tests/unit/purchase-signals.test.ts
 */

// ---------------------------------------------------------------------------
// テストハーネス（run-unit-tests.ts と同じ構造）
// ---------------------------------------------------------------------------

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];

function describe(suiteName: string, fn: () => void) {
  console.log(`\n--- ${suiteName} ---`);
  fn();
}

function it(testName: string, fn: () => void) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  [PASS] ${testName}`);
  } catch (err) {
    failedTests++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${testName}: ${msg}`);
    failures.push({ name: testName, error: msg });
  }
}

function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertIncludes(arr: string[], item: string, label = "") {
  if (!arr.includes(item)) {
    throw new Error(
      `${label ? label + ": " : ""}expected array to include "${item}", got [${arr.join(", ")}]`,
    );
  }
}

function assertNull<T>(value: T | null, label = "") {
  if (value !== null) {
    throw new Error(
      `${label ? label + ": " : ""}expected null, got ${JSON.stringify(value)}`,
    );
  }
}

function assertNotNull<T>(value: T | null | undefined, label = "") {
  if (value === null || value === undefined) {
    throw new Error(`${label ? label + ": " : ""}expected non-null value`);
  }
}

// ---------------------------------------------------------------------------
// テスト対象のインポート
// ---------------------------------------------------------------------------

import {
  extractPersonaSignalsFromTags,
  extractCategoriesFromTags,
  extractFlavorsFromTags,
  buildPurchaseSignals,
  PURCHASE_SIGNAL_WEIGHT,
} from "../../src/lib/purchase-signals";

// ---------------------------------------------------------------------------
// extractPersonaSignalsFromTags テスト
// ---------------------------------------------------------------------------

describe("extractPersonaSignalsFromTags", () => {
  it("ほうじ茶タグから serenity シグナルを抽出する", () => {
    const signals = extractPersonaSignalsFromTags(["hojicha", "organic"]);
    assertIncludes(signals, "serenity");
    assertEqual(signals.length, 1);
  });

  it("日本語タグも認識する", () => {
    const signals = extractPersonaSignalsFromTags(["ほうじ茶"]);
    assertIncludes(signals, "serenity");
  });

  it("玉露タグから explorer シグナルを抽出する", () => {
    const signals = extractPersonaSignalsFromTags(["gyokuro", "premium"]);
    assertIncludes(signals, "explorer");
  });

  it("フレーバーティータグから sensory シグナルを抽出する", () => {
    const signals = extractPersonaSignalsFromTags(["flavored", "fruity"]);
    assertIncludes(signals, "sensory");
  });

  it("複数ペルソナに該当するタグから重複排除して返す", () => {
    const signals = extractPersonaSignalsFromTags([
      "hojicha",     // serenity
      "herbal",      // serenity
      "gyokuro",     // explorer
      "flavored",    // sensory
    ]);
    assertEqual(signals.length, 3);
    assertIncludes(signals, "serenity");
    assertIncludes(signals, "explorer");
    assertIncludes(signals, "sensory");
  });

  it("マッピングにないタグは無視する", () => {
    const signals = extractPersonaSignalsFromTags(["organic", "sale", "new"]);
    assertEqual(signals.length, 0);
  });

  it("空の配列では空を返す", () => {
    const signals = extractPersonaSignalsFromTags([]);
    assertEqual(signals.length, 0);
  });

  it("大文字小文字を区別しない", () => {
    const signals = extractPersonaSignalsFromTags(["HOJICHA", "Gyokuro"]);
    assertEqual(signals.length, 2);
    assertIncludes(signals, "serenity");
    assertIncludes(signals, "explorer");
  });
});

// ---------------------------------------------------------------------------
// extractCategoriesFromTags テスト
// ---------------------------------------------------------------------------

describe("extractCategoriesFromTags", () => {
  it("茶種タグからカテゴリを抽出する", () => {
    const categories = extractCategoriesFromTags(["hojicha", "organic"]);
    assertIncludes(categories, "hojicha");
    assertEqual(categories.length, 1);
  });

  it("複数の茶種タグを抽出する", () => {
    const categories = extractCategoriesFromTags(["hojicha", "matcha", "sencha"]);
    assertEqual(categories.length, 3);
    assertIncludes(categories, "hojicha");
    assertIncludes(categories, "matcha");
    assertIncludes(categories, "sencha");
  });

  it("日本語タグも認識する", () => {
    const categories = extractCategoriesFromTags(["ほうじ茶", "抹茶"]);
    assertEqual(categories.length, 2);
    assertIncludes(categories, "hojicha");
    assertIncludes(categories, "matcha");
  });

  it("マッピングにないタグは無視する", () => {
    const categories = extractCategoriesFromTags(["sale", "new-arrival"]);
    assertEqual(categories.length, 0);
  });
});

// ---------------------------------------------------------------------------
// extractFlavorsFromTags テスト
// ---------------------------------------------------------------------------

describe("extractFlavorsFromTags", () => {
  it("フレーバータグを抽出する", () => {
    const flavors = extractFlavorsFromTags(["floral", "fruity"]);
    assertEqual(flavors.length, 2);
    assertIncludes(flavors, "floral");
    assertIncludes(flavors, "fruity");
  });

  it("日本語フレーバータグも認識する", () => {
    const flavors = extractFlavorsFromTags(["フローラル", "スモーキー"]);
    assertEqual(flavors.length, 2);
    assertIncludes(flavors, "floral");
    assertIncludes(flavors, "smoky");
  });
});

// ---------------------------------------------------------------------------
// buildPurchaseSignals テスト
// ---------------------------------------------------------------------------

describe("buildPurchaseSignals", () => {
  it("単一商品のタグからシグナルを構築する", () => {
    const signals = buildPurchaseSignals([["hojicha", "floral", "relaxation"]]);
    assertNotNull(signals);
    assertIncludes(signals!.preferred_categories, "hojicha");
    assertIncludes(signals!.flavor_preferences, "floral");
    assertIncludes(signals!.persona_signals, "serenity");
  });

  it("複数商品のタグを統合する", () => {
    const signals = buildPurchaseSignals([
      ["hojicha", "herbal"],       // serenity
      ["gyokuro", "single-origin"], // explorer
    ]);
    assertNotNull(signals);
    assertEqual(signals!.persona_signals.length, 2);
    assertIncludes(signals!.persona_signals, "serenity");
    assertIncludes(signals!.persona_signals, "explorer");
    assertIncludes(signals!.preferred_categories, "hojicha");
    assertIncludes(signals!.preferred_categories, "gyokuro");
  });

  it("空のタグリストで null を返す", () => {
    const signals = buildPurchaseSignals([]);
    assertNull(signals);
  });

  it("マッピングにないタグのみの場合 null を返す", () => {
    const signals = buildPurchaseSignals([["organic", "sale", "new"]]);
    assertNull(signals);
  });

  it("scene_preferences と explicit_statements は常に空", () => {
    const signals = buildPurchaseSignals([["hojicha"]]);
    assertNotNull(signals);
    assertEqual(signals!.scene_preferences.length, 0);
    assertEqual(signals!.explicit_statements.length, 0);
  });
});

// ---------------------------------------------------------------------------
// PURCHASE_SIGNAL_WEIGHT テスト
// ---------------------------------------------------------------------------

describe("PURCHASE_SIGNAL_WEIGHT", () => {
  it("購入シグナルの重みは 3", () => {
    assertEqual(PURCHASE_SIGNAL_WEIGHT, 3);
  });
});

// ---------------------------------------------------------------------------
// 結果サマリー
// ---------------------------------------------------------------------------

console.log("\n" + "=".repeat(60));
console.log("Purchase Signals Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);

if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}

process.exit(failedTests > 0 ? 1 : 0);
