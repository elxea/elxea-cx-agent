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

function assert(cond: boolean, label = "") {
  if (!cond) throw new Error(label || "assertion failed");
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  productIntroCard,
  recommendCarousel,
  feedbackCard,
  teaRecommendCard,
  teaRecommendCarousel,
  preferDirectR2,
  articleCard,
  articleCarousel,
} from "../../src/lib/flex-templates";

/** Flex ノードから全文字列を集める（本文非露出ガード用・深い再帰）。 */
function collectStrings(node: unknown, acc: string[]): void {
  if (typeof node === "string") {
    acc.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const n of node) collectStrings(n, acc);
    return;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) collectStrings(v, acc);
  }
}

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
// teaRecommendCard / teaRecommendCarousel / preferDirectR2 テスト（UX③）
// ---------------------------------------------------------------------------

describe("teaRecommendCard (UX③)", () => {
  it("画像あり → hero.url に画像 URL を載せる", () => {
    const r = teaRecommendCard({
      name: "11301｜玉露",
      description: "まろやかなうまみ。",
      imageUrl: "https://pub-xxxx.r2.dev/cdn/11301.jpg",
      productUrl: "https://elxea.com/ja",
    }) as Record<string, Record<string, unknown>>;
    assertDefined(r.hero, "hero");
    assertEqual((r.hero as { url?: string }).url, "https://pub-xxxx.r2.dev/cdn/11301.jpg", "hero.url");
  });

  it("画像なし → hero を含まない（graceful・現況の主経路）", () => {
    const r = teaRecommendCard({
      name: "11301｜玉露",
      description: "まろやかなうまみ。",
      productUrl: "https://elxea.com/ja",
    }) as Record<string, unknown>;
    assertEqual(r.hero, undefined, "no hero when imageUrl omitted");
  });

  it("body 見出しに `番号｜` を含む（① とカードの連結）+ footer は uri ボタン「見る」", () => {
    const r = teaRecommendCard({
      name: "11301｜玉露",
      description: "説明",
      productUrl: "https://elxea.com/ja/x",
    }) as Record<string, Record<string, unknown>>;
    const body = r.body as Record<string, unknown>;
    const contents = body.contents as Record<string, unknown>[];
    assert(String(contents[0].text).includes("11301｜"), "見出しに 番号｜");
    const footer = r.footer as Record<string, unknown>;
    const btn = (footer.contents as Record<string, Record<string, unknown>>[])[0];
    const action = btn.action as Record<string, unknown>;
    assertEqual(action.type as string, "uri", "uri button");
    assertEqual(action.label as string, "見る", "button label");
    assertEqual(action.uri as string, "https://elxea.com/ja/x", "button uri");
  });
});

describe("teaRecommendCarousel (UX③)", () => {
  it("carousel を生成し最大10件に制限", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      name: `1${String(i).padStart(4, "0")}｜お茶${i}`,
      description: "x",
      productUrl: "https://elxea.com/ja",
    }));
    const r = teaRecommendCarousel(items) as Record<string, unknown>;
    assertEqual(r.type as string, "carousel");
    assertEqual((r.contents as unknown[]).length, 10, "max 10 bubbles");
  });
});

describe("preferDirectR2 (UX③ 画像 URL 正規化)", () => {
  it("wsrv.nl ラップ → 直 r2.dev を decode して返す", () => {
    const wrapped =
      "https://wsrv.nl/?url=" + encodeURIComponent("https://pub-abc.r2.dev/cdn/x.jpg") + "&w=2000";
    assertEqual(preferDirectR2(wrapped), "https://pub-abc.r2.dev/cdn/x.jpg", "unwrapped direct r2.dev");
  });
  it("素の r2.dev はそのまま", () => {
    assertEqual(
      preferDirectR2("https://pub-abc.r2.dev/cdn/x.jpg"),
      "https://pub-abc.r2.dev/cdn/x.jpg",
      "passthrough",
    );
  });
  it("空 / null / 非 https は null（hero を出さない graceful）", () => {
    assertEqual(preferDirectR2(""), null, "empty");
    assertEqual(preferDirectR2(null), null, "null");
    assertEqual(preferDirectR2("ftp://x"), null, "non-https");
  });
  it("http は https に昇格", () => {
    assertEqual(preferDirectR2("http://pub-abc.r2.dev/x.jpg"), "https://pub-abc.r2.dev/x.jpg", "upgrade");
  });
});

// ---------------------------------------------------------------------------
// articleCard / articleCarousel テスト（UX④・本文非露出）
// ---------------------------------------------------------------------------

describe("articleCard (UX④)", () => {
  const ARTICLE_BODY = "これは記事の本文全文であり、カードには絶対に含めてはいけない内容です。";
  it("画像あり → hero を持ち title/excerpt/url ボタンを組む", () => {
    const card = articleCard({
      title: "静けさと、一杯のこと",
      description: "慌ただしい日々に、お茶がくれる余白について。",
      imageUrl: "https://placehold.co/1024x576/png",
      articleUrl: "https://elxea.com/ja/blogs/journal/x",
    }) as Record<string, unknown>;
    assertDefined(card.hero, "hero present when imageUrl given");
    const strings: string[] = [];
    collectStrings(card, strings);
    const joined = strings.join("\n");
    assert(joined.includes("静けさと、一杯のこと"), "title present");
    assert(joined.includes("余白について"), "excerpt present");
    assert(joined.includes("記事を読む"), "read button label present");
    assert(joined.includes("https://elxea.com/ja/blogs/journal/x"), "url present");
  });
  it("画像なし → hero を省略（graceful）", () => {
    const card = articleCard({
      title: "T",
      description: "D",
      articleUrl: "https://elxea.com/ja/blogs/journal/y",
    }) as Record<string, unknown>;
    assertEqual(card.hero as unknown, undefined, "no hero without imageUrl");
  });
  it("本文（body 全文）を一切含まない — title/excerpt/thumbnail/url のみ", () => {
    const card = articleCard({
      title: "静けさと、一杯のこと",
      description: "慌ただしい日々に、お茶がくれる余白について。",
      imageUrl: "https://placehold.co/1024x576/png",
      articleUrl: "https://elxea.com/ja/blogs/journal/x",
    });
    const strings: string[] = [];
    collectStrings(card, strings);
    const joined = strings.join("\n");
    assert(!joined.includes(ARTICLE_BODY), "記事本文がカードに漏れてはいけない");
  });
  it("excerpt は maxLines:2（1〜2 行）", () => {
    const card = articleCard({
      title: "T",
      description: "長い抜粋テキスト",
      articleUrl: "https://elxea.com/ja/blogs/journal/z",
    }) as { body?: { contents?: Array<Record<string, unknown>> } };
    const excerptNode = card.body?.contents?.find(
      (c) => c.text === "長い抜粋テキスト",
    );
    assertDefined(excerptNode, "excerpt node present");
    assertEqual((excerptNode as Record<string, unknown>).maxLines as number, 2, "excerpt maxLines=2");
  });
});

describe("articleCarousel (UX④)", () => {
  it("最大 3 件のカードを carousel に束ね、各カードが本文を含まない", () => {
    const carousel = articleCarousel([
      { title: "A", description: "a", imageUrl: "https://placehold.co/1x1/png", articleUrl: "https://x/a" },
      { title: "B", description: "b", articleUrl: "https://x/b" },
      { title: "C", description: "c", articleUrl: "https://x/c" },
    ]) as { type: string; contents: unknown[] };
    assertEqual(carousel.type, "carousel", "carousel type");
    assertEqual(carousel.contents.length, 3, "3 bubbles");
    const strings: string[] = [];
    collectStrings(carousel, strings);
    const joined = strings.join("\n");
    assert(joined.includes("記事を読む"), "read button in carousel");
    assert(!joined.includes("本文"), "no body text token in carousel");
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
