/**
 * Unit Tests -- elxea-cx-agent
 *
 * 外部依存なしでテスト可能な純粋関数のユニットテスト。
 * 対象: query-classifier, web-auth (validation), utils
 *
 * 使用方法:
 *   npx tsx tests/unit/run-unit-tests.ts
 */

// ---------------------------------------------------------------------------
// テストハーネス（外部依存なし）
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

function assertNotNull<T>(value: T | null | undefined, label = "") {
  if (value === null || value === undefined) {
    throw new Error(`${label ? label + ": " : ""}expected non-null value`);
  }
}

function assertNull<T>(value: T | null, label = "") {
  if (value !== null) {
    throw new Error(
      `${label ? label + ": " : ""}expected null, got ${JSON.stringify(value)}`,
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

// ---------------------------------------------------------------------------
// query-classifier テスト
// ---------------------------------------------------------------------------

import { classifyQuery, debugClassifyQuery } from "../../src/lib/query-classifier";

describe("classifyQuery", () => {
  it("商品関連クエリを set_menu に分類する（おすすめ = set_menu キーワード）", () => {
    assertEqual(classifyQuery("おすすめのお茶を教えてください"), "set_menu");
  });

  it("茶種 + 価格クエリを set_menu に分類する（値段 = set_menu キーワード）", () => {
    assertEqual(classifyQuery("ほうじ茶の値段はいくらですか？"), "set_menu");
  });

  it("配送関連クエリは null を返す（source_type に faq は存在しない）", () => {
    // 「配送」はどのキーワードリストにもないため null
    assertNull(classifyQuery("配送について教えてください"));
  });

  it("返品関連クエリは null を返す（source_type に faq は存在しない）", () => {
    assertNull(classifyQuery("返品したいのですが"));
  });

  it("支払い関連クエリは null を返す（source_type に faq は存在しない）", () => {
    // 「買いたい」は set_menu にヒットするが「クレジットカード」「支払い」はどこにもない
    assertNull(classifyQuery("クレジットカードで支払いたい"));
  });

  it("淹れ方関連クエリを tea に分類する（温度・蒸らし = tea キーワード）", () => {
    // 「お茶」は tea にもヒット、「淹れ方」は article、「温度」「蒸らし」は tea
    // tea: 3 (茶, 温度, 蒸らし) vs article: 1 (淹れ方) -> tea が勝つ
    assertEqual(classifyQuery("お茶の淹れ方の温度と蒸らし時間"), "tea");
  });

  it("健康・効能関連クエリを article に分類する", () => {
    assertEqual(classifyQuery("カテキンの効能について"), "article");
  });

  it("該当なしクエリは null を返す", () => {
    assertNull(classifyQuery("こんにちは"));
  });

  it("空文字は null を返す", () => {
    assertNull(classifyQuery(""));
  });

  it("送料クエリは null を返す（どのキーワードにも該当しない）", () => {
    // 「送料」はどのキーワードリストにもないため null
    const result = classifyQuery("送料");
    assertNull(result);
  });

  it("debugClassifyQuery がスコアを含むオブジェクトを返す", () => {
    const debug = debugClassifyQuery("おすすめのお茶を教えて");
    assertEqual(debug.result, "set_menu");
    if (debug.scores.set_menu <= 0) {
      throw new Error("set_menu score should be > 0");
    }
  });
});

// ---------------------------------------------------------------------------
// web-auth テスト
// ---------------------------------------------------------------------------

import {
  validateSessionId,
  checkRateLimit,
  validateShopifyCustomerId,
  getClientIp,
} from "../../src/lib/web-auth";

describe("validateSessionId", () => {
  it("有効な UUID v4 を受け入れる", () => {
    assertNull(validateSessionId("550e8400-e29b-41d4-a716-446655440000"));
  });

  it("空文字を拒否する", () => {
    assertNotNull(validateSessionId(""));
  });

  it("undefined を拒否する", () => {
    assertNotNull(validateSessionId(undefined));
  });

  it("null を拒否する", () => {
    assertNotNull(validateSessionId(null));
  });

  it("不正な形式を拒否する", () => {
    assertNotNull(validateSessionId("not-a-uuid"));
  });

  it("UUID v1 形式を拒否する（v4 のみ許可）", () => {
    // UUID v1: 3rd group starts with 1
    assertNotNull(validateSessionId("550e8400-e29b-11d4-a716-446655440000"));
  });

  it("数値を拒否する", () => {
    assertNotNull(validateSessionId(12345));
  });
});

describe("validateShopifyCustomerId", () => {
  it("正しい Shopify GID 形式を受け入れる", () => {
    assertNull(validateShopifyCustomerId("gid://shopify/Customer/12345"));
  });

  it("未指定 (undefined) を受け入れる", () => {
    assertNull(validateShopifyCustomerId(undefined));
  });

  it("未指定 (null) を受け入れる", () => {
    assertNull(validateShopifyCustomerId(null));
  });

  it("空文字を受け入れる（未ログイン扱い）", () => {
    assertNull(validateShopifyCustomerId(""));
  });

  it("不正な形式を拒否する", () => {
    assertNotNull(validateShopifyCustomerId("12345"));
  });

  it("Shopify Product GID を拒否する（Customer のみ許可）", () => {
    assertNotNull(
      validateShopifyCustomerId("gid://shopify/Product/12345"),
    );
  });

  it("数値型を拒否する", () => {
    assertNotNull(validateShopifyCustomerId(12345));
  });
});

describe("checkRateLimit", () => {
  it("初回リクエストを許可する", () => {
    const uniqueIp = `test-ip-${Date.now()}-${Math.random()}`;
    assertNull(checkRateLimit(uniqueIp));
  });

  it("10回目までのリクエストを許可する", () => {
    const uniqueIp = `test-ip-rate-${Date.now()}`;
    for (let i = 0; i < 10; i++) {
      assertNull(checkRateLimit(uniqueIp), `request ${i + 1}`);
    }
  });

  it("11回目のリクエストをブロックする", () => {
    const uniqueIp = `test-ip-block-${Date.now()}`;
    for (let i = 0; i < 10; i++) {
      checkRateLimit(uniqueIp);
    }
    assertNotNull(checkRateLimit(uniqueIp), "11th request should be blocked");
  });
});

describe("getClientIp", () => {
  it("CF-Connecting-IP ヘッダーからIPを取得する", () => {
    const req = new Request("https://example.com", {
      headers: { "cf-connecting-ip": "1.2.3.4" },
    });
    assertEqual(getClientIp(req), "1.2.3.4");
  });

  it("ヘッダーがない場合は unknown を返す", () => {
    const req = new Request("https://example.com");
    assertEqual(getClientIp(req), "unknown");
  });
});

// ---------------------------------------------------------------------------
// utils テスト
// ---------------------------------------------------------------------------

import { withTimeout } from "../../src/lib/utils";

describe("withTimeout", () => {
  it("タイムアウト前に resolve した Promise を返す", async () => {
    const result = await withTimeout(
      Promise.resolve("ok"),
      1000,
      "test-resolve",
    );
    assertEqual(result, "ok");
  });

  it("タイムアウトした場合にエラーを throw する", async () => {
    try {
      await withTimeout(
        new Promise(() => {
          /* never resolves */
        }),
        50,
        "test-timeout",
      );
      throw new Error("Should have thrown");
    } catch (err) {
      if (err instanceof Error && err.message.includes("Timeout")) {
        // expected
      } else {
        throw err;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// shopify-metafield テスト
// ---------------------------------------------------------------------------

import { buildTasteProfileMetafield } from "../../src/sync/shopify-metafield";
import type { CustomerProfile } from "../../src/lib/firestore";

describe("buildTasteProfileMetafield", () => {
  it("persona + tasteProfile がある場合に JSON を返す", () => {
    const profile: CustomerProfile = {
      persona: {
        primary: "serenity",
        scores: { serenity: 5, explorer: 2, sensory: 1 },
        lastUpdated: "2026-03-24T00:00:00Z",
      },
      depthLevel: "explore",
      tasteProfile: {
        preferredCategories: ["oolong", "green"],
        flavorPreferences: ["floral", "light"],
        scenePref: "evening",
      },
    };

    const result = buildTasteProfileMetafield(profile);
    assertNotNull(result, "should return JSON string");

    const parsed = JSON.parse(result!);
    assertEqual(parsed.persona, "serenity", "persona");
    assertEqual(parsed.depthLevel, "explore", "depthLevel");
    assertEqual(parsed.preferredCategories.length, 2, "categories count");
    assertEqual(parsed.flavorPreferences.length, 2, "flavors count");
    assertEqual(parsed.scenePref, "evening", "scenePref");
  });

  it("persona のみの場合も JSON を返す", () => {
    const profile: CustomerProfile = {
      persona: {
        primary: "explorer",
        scores: { serenity: 1, explorer: 5, sensory: 2 },
        lastUpdated: "2026-03-24T00:00:00Z",
      },
    };

    const result = buildTasteProfileMetafield(profile);
    assertNotNull(result, "should return JSON string");

    const parsed = JSON.parse(result!);
    assertEqual(parsed.persona, "explorer", "persona");
  });

  it("tasteProfile のみの場合も JSON を返す", () => {
    const profile: CustomerProfile = {
      tasteProfile: {
        preferredCategories: ["hojicha"],
        flavorPreferences: ["smoky"],
        scenePref: "morning",
      },
    };

    const result = buildTasteProfileMetafield(profile);
    assertNotNull(result, "should return JSON string");

    const parsed = JSON.parse(result!);
    assertIncludes(parsed.preferredCategories, "hojicha", "categories");
  });

  it("persona も tasteProfile も未設定の場合は null を返す", () => {
    const profile: CustomerProfile = {
      email: "test@example.com",
      displayName: "Test User",
    };

    const result = buildTasteProfileMetafield(profile);
    assertNull(result as string | null, "should return null");
  });

  it("空のプロファイルは null を返す", () => {
    const result = buildTasteProfileMetafield({});
    assertNull(result as string | null, "should return null for empty profile");
  });
});

// ---------------------------------------------------------------------------
// 結果サマリー
// ---------------------------------------------------------------------------

// async テストの完了を待つ
setTimeout(() => {
  console.log("\n" + "=".repeat(60));
  console.log("Unit Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);

  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }

  process.exit(failedTests > 0 ? 1 : 0);
}, 500);
