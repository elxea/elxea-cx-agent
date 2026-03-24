/**
 * Unit Tests -- flex-templates (Phase-3)
 *
 * 新規追加された Flex Message テンプレート3種のユニットテスト。
 * - productIntroCard: 商品紹介カード（マッチ度付き）
 * - recommendCarousel: レコメンドカルーセル（マッチ理由付き）
 * - feedbackCard: フィードバック UI
 *
 * 使用方法:
 *   npx tsx tests/unit/flex-templates.test.ts
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

function assertDefined<T>(value: T | undefined, label = "") {
  if (value === undefined) {
    throw new Error(`${label ? label + ": " : ""}expected defined value`);
  }
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  productIntroCard,
  recommendCarousel,
  feedbackCard,
} from "../../src/lib/flex-templates";

// ---------------------------------------------------------------------------
// productIntroCard テスト
// ---------------------------------------------------------------------------

describe("productIntroCard", () => {
  it("基本的な商品カードを生成する（マッチ度なし）", () => {
    const result = productIntroCard({
      name: "ほうじ茶 クラシック",
      description: "香ばしい香りとまろやかな味わい",
      price: "1,200円",
      productUrl: "https://elxea.jp/products/hojicha-classic",
    }) as Record<string, Record<string, unknown>>;

    assertEqual(result.type as string, "bubble");
    assertEqual(result.size as string, "mega");
    assertDefined(result.body, "body");
    assertDefined(result.footer, "footer");
  });

  it("画像付きの場合 hero セクションを含む", () => {
    const result = productIntroCard({
      name: "煎茶",
      description: "鮮やかな緑",
      price: "1,500円",
      imageUrl: "https://example.com/img.jpg",
      productUrl: "https://elxea.jp/products/sencha",
    }) as Record<string, Record<string, unknown>>;

    assertDefined(result.hero, "hero");
  });

  it("画像なしの場合 hero セクションを含まない", () => {
    const result = productIntroCard({
      name: "煎茶",
      description: "鮮やかな緑",
      price: "1,500円",
      productUrl: "https://elxea.jp/products/sencha",
    }) as Record<string, Record<string, unknown>>;

    assertEqual(result.hero, undefined, "hero should be undefined");
  });

  it("マッチ度付きの場合 separator + マッチ情報を含む", () => {
    const result = productIntroCard({
      name: "ほうじ茶",
      description: "テスト",
      price: "1,000円",
      productUrl: "https://elxea.jp/products/hojicha",
      matchScore: 85,
      matchReason: "あなたが好む穏やかな味わい",
    }) as Record<string, Record<string, unknown>>;

    const body = result.body as Record<string, unknown>;
    const contents = body.contents as Record<string, unknown>[];
    // マッチ度付きの場合、contents の末尾に separator + match box が追加される
    const lastItem = contents[contents.length - 1] as Record<string, unknown>;
    assertEqual(lastItem.layout as string, "horizontal", "match box layout");
  });

  it("産地・品種を表示する", () => {
    const result = productIntroCard({
      name: "煎茶 さえみどり",
      origin: "鹿児島県",
      variety: "さえみどり",
      description: "テスト",
      price: "1,800円",
      productUrl: "https://elxea.jp/products/sencha-saemidori",
    }) as Record<string, Record<string, unknown>>;

    const body = result.body as Record<string, unknown>;
    const contents = body.contents as Record<string, unknown>[];
    // 2番目の要素が産地・品種テキスト
    const metaItem = contents[1] as Record<string, unknown>;
    assertEqual(metaItem.text as string, "鹿児島県 / さえみどり");
  });
});

// ---------------------------------------------------------------------------
// recommendCarousel テスト
// ---------------------------------------------------------------------------

describe("recommendCarousel", () => {
  it("カルーセルを生成する", () => {
    const result = recommendCarousel([
      {
        name: "ほうじ茶",
        description: "香ばしい",
        price: "1,000円",
        productUrl: "https://elxea.jp/products/hojicha",
        matchReason: "リラックスしたい時にぴったり",
      },
      {
        name: "煎茶",
        description: "爽やか",
        price: "1,200円",
        productUrl: "https://elxea.jp/products/sencha",
        matchReason: "探究心を満たす味わい",
      },
    ]) as Record<string, unknown>;

    assertEqual(result.type as string, "carousel");
    const contents = result.contents as Record<string, unknown>[];
    assertEqual(contents.length, 2, "should have 2 bubbles");
  });

  it("最大10件に制限される", () => {
    const products = Array.from({ length: 15 }, (_, i) => ({
      name: `商品${i}`,
      description: "テスト",
      price: "1,000円",
      productUrl: `https://elxea.jp/products/${i}`,
      matchReason: "テスト理由",
    }));

    const result = recommendCarousel(products) as Record<string, unknown>;
    const contents = result.contents as Record<string, unknown>[];
    assertEqual(contents.length, 10, "max 10 bubbles");
  });

  it("各カードにマッチ理由を含む", () => {
    const result = recommendCarousel([
      {
        name: "玉露",
        description: "旨味",
        price: "3,000円",
        productUrl: "https://elxea.jp/products/gyokuro",
        matchReason: "深い味わいを好むあなたに",
      },
    ]) as Record<string, unknown>;

    const contents = result.contents as Record<string, unknown>[];
    const bubble = contents[0] as Record<string, Record<string, unknown>>;
    const body = bubble.body as Record<string, unknown>;
    const bodyContents = body.contents as Record<string, unknown>[];
    // 2番目の要素がマッチ理由
    const matchItem = bodyContents[1] as Record<string, unknown>;
    assertEqual(matchItem.text as string, "深い味わいを好むあなたに");
  });
});

// ---------------------------------------------------------------------------
// feedbackCard テスト
// ---------------------------------------------------------------------------

describe("feedbackCard", () => {
  it("デフォルトタイトルのフィードバックカードを生成する", () => {
    const result = feedbackCard({}) as Record<string, Record<string, unknown>>;

    assertEqual(result.type as string, "bubble");
    assertDefined(result.body, "body");
    assertDefined(result.footer, "footer");

    const body = result.body as Record<string, unknown>;
    const contents = body.contents as Record<string, unknown>[];
    const title = contents[0] as Record<string, unknown>;
    assertEqual(
      title.text as string,
      "今月のお茶はいかがでしたか？",
      "default title",
    );
  });

  it("商品名付きのタイトルを生成する", () => {
    const result = feedbackCard({
      productName: "ほうじ茶 クラシック",
    }) as Record<string, Record<string, unknown>>;

    const body = result.body as Record<string, unknown>;
    const contents = body.contents as Record<string, unknown>[];
    const title = contents[0] as Record<string, unknown>;
    assertEqual(
      title.text as string,
      "ほうじ茶 クラシックはいかがでしたか？",
      "product-specific title",
    );
  });

  it("4段階評価ボタンを含む", () => {
    const result = feedbackCard({}) as Record<string, Record<string, unknown>>;

    const footer = result.footer as Record<string, unknown>;
    const contents = footer.contents as Record<string, unknown>[];
    // 4ボタン + 1テキスト = 5要素
    assertEqual(contents.length, 5, "4 buttons + 1 text");

    // postback data を検証
    const btn0 = contents[0] as Record<string, Record<string, unknown>>;
    const action0 = btn0.action as Record<string, unknown>;
    assertEqual(action0.data as string, "feedback:love", "first button data");

    const btn3 = contents[3] as Record<string, Record<string, unknown>>;
    const action3 = btn3.action as Record<string, unknown>;
    assertEqual(action3.data as string, "feedback:dislike", "last button data");
  });

  it("カスタム callbackPrefix を使用する", () => {
    const result = feedbackCard({
      callbackPrefix: "monthly_feedback",
    }) as Record<string, Record<string, unknown>>;

    const footer = result.footer as Record<string, unknown>;
    const contents = footer.contents as Record<string, unknown>[];
    const btn0 = contents[0] as Record<string, Record<string, unknown>>;
    const action0 = btn0.action as Record<string, unknown>;
    assertEqual(
      action0.data as string,
      "monthly_feedback:love",
      "custom prefix",
    );
  });
});

// ---------------------------------------------------------------------------
// 結果サマリー
// ---------------------------------------------------------------------------

console.log("\n" + "=".repeat(60));
console.log("Flex Templates Unit Test Results");
console.log("=".repeat(60));
console.log(
  `Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`,
);

if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`);
  }
}

process.exit(failedTests > 0 ? 1 : 0);
