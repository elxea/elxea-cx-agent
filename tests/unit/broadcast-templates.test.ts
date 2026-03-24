/**
 * Unit Tests -- broadcast-templates
 *
 * テンプレート選択ロジック、季節判定のテスト。
 *
 * 使用方法:
 *   npx tsx tests/unit/broadcast-templates.test.ts
 */

// ---------------------------------------------------------------------------
// テストハーネス
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

function assertTrue(value: boolean, label = "") {
  if (!value) {
    throw new Error(`${label ? label + ": " : ""}expected true`);
  }
}

// ---------------------------------------------------------------------------
// テスト対象のインポート
// ---------------------------------------------------------------------------

import {
  getCurrentSeason,
  selectTemplate,
  BROADCAST_TEMPLATES,
} from "../../src/lib/broadcast-templates";

// ---------------------------------------------------------------------------
// getCurrentSeason テスト
// ---------------------------------------------------------------------------

describe("getCurrentSeason", () => {
  it("3月は spring を返す", () => {
    assertEqual(getCurrentSeason(3), "spring");
  });

  it("4月は spring を返す", () => {
    assertEqual(getCurrentSeason(4), "spring");
  });

  it("5月は spring を返す", () => {
    assertEqual(getCurrentSeason(5), "spring");
  });

  it("6月は summer を返す", () => {
    assertEqual(getCurrentSeason(6), "summer");
  });

  it("8月は summer を返す", () => {
    assertEqual(getCurrentSeason(8), "summer");
  });

  it("9月は autumn を返す", () => {
    assertEqual(getCurrentSeason(9), "autumn");
  });

  it("11月は autumn を返す", () => {
    assertEqual(getCurrentSeason(11), "autumn");
  });

  it("12月は winter を返す", () => {
    assertEqual(getCurrentSeason(12), "winter");
  });

  it("1月は winter を返す", () => {
    assertEqual(getCurrentSeason(1), "winter");
  });

  it("2月は winter を返す", () => {
    assertEqual(getCurrentSeason(2), "winter");
  });
});

// ---------------------------------------------------------------------------
// BROADCAST_TEMPLATES バリデーション
// ---------------------------------------------------------------------------

describe("BROADCAST_TEMPLATES", () => {
  it("各ペルソナに少なくとも1つのテンプレートがある", () => {
    const personas = ["serenity", "explorer", "sensory"] as const;
    for (const persona of personas) {
      const count = BROADCAST_TEMPLATES.filter((t) => t.persona === persona).length;
      assertTrue(count > 0, `${persona} should have at least 1 template`);
    }
  });

  it("各ペルソナに all 季節テンプレートがある", () => {
    const personas = ["serenity", "explorer", "sensory"] as const;
    for (const persona of personas) {
      const allCount = BROADCAST_TEMPLATES.filter(
        (t) => t.persona === persona && t.season === "all",
      ).length;
      assertTrue(allCount > 0, `${persona} should have at least 1 'all' season template`);
    }
  });

  it("全テンプレートの text が空でない", () => {
    for (const t of BROADCAST_TEMPLATES) {
      assertTrue(t.text.length > 0, `template ${t.id} should have non-empty text`);
    }
  });

  it("全テンプレートの text が LINE の5000文字制限内", () => {
    for (const t of BROADCAST_TEMPLATES) {
      assertTrue(t.text.length <= 5000, `template ${t.id} exceeds 5000 chars: ${t.text.length}`);
    }
  });

  it("全テンプレートの id がユニーク", () => {
    const ids = BROADCAST_TEMPLATES.map((t) => t.id);
    const uniqueIds = new Set(ids);
    assertEqual(ids.length, uniqueIds.size, "template IDs should be unique");
  });

  it("テンプレートが購入を直接参照していない", () => {
    const forbiddenPhrases = [
      "お茶はいかがでしたか",
      "ご購入いただいた",
      "お買い上げ",
      "注文",
      "購入",
    ];
    for (const t of BROADCAST_TEMPLATES) {
      for (const phrase of forbiddenPhrases) {
        assertTrue(
          !t.text.includes(phrase),
          `template ${t.id} should not reference purchase: "${phrase}"`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// selectTemplate テスト
// ---------------------------------------------------------------------------

describe("selectTemplate", () => {
  it("serenity ペルソナでテンプレートを返す", () => {
    const t = selectTemplate("serenity", "spring");
    assertEqual(t.persona, "serenity", "persona should match");
  });

  it("explorer ペルソナでテンプレートを返す", () => {
    const t = selectTemplate("explorer", "summer");
    assertEqual(t.persona, "explorer", "persona should match");
  });

  it("sensory ペルソナでテンプレートを返す", () => {
    const t = selectTemplate("sensory", "autumn");
    assertEqual(t.persona, "sensory", "persona should match");
  });

  it("選択されたテンプレートが対象季節または all である", () => {
    const t = selectTemplate("serenity", "winter");
    assertTrue(
      t.season === "winter" || t.season === "all",
      `season should be winter or all, got ${t.season}`,
    );
  });

  it("全季節で全ペルソナのテンプレートが選択可能", () => {
    const personas = ["serenity", "explorer", "sensory"] as const;
    const seasons = ["spring", "summer", "autumn", "winter"] as const;
    for (const persona of personas) {
      for (const season of seasons) {
        const t = selectTemplate(persona, season);
        assertEqual(t.persona, persona, `${persona}-${season}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 結果サマリー
// ---------------------------------------------------------------------------

console.log("\n" + "=".repeat(60));
console.log("Broadcast Templates Test Results");
console.log("=".repeat(60));
console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);

if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}

process.exit(failedTests > 0 ? 1 : 0);
