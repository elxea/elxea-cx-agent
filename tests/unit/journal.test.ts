/**
 * Unit Tests — journal（UX④ 記事の出し分け）
 *
 * Notion / Firestore には触れない（純粋関数のみ）。検証範囲:
 *   - mapArticlePage: Notion ページ → ArticleItem・Channel/Status ゲート・**本文なし**
 *   - ダミー: Published URL 空 → ダミー URL / Featured Image 空 → ダミーサムネ
 *   - Draft ゲート: includeDrafts=false（本番）は Draft を捨て、true（staging）は残す
 *   - articleAffinity: persona 一致 +3・二次（interestTags）
 *   - pickArticles: persona 別に別記事（A/B 排他）・no-karte → 最新順・max 3・決定的
 *   - break-proof: 別 persona の記事は先頭にならない
 *
 * 使用: npx tsx tests/unit/journal.test.ts
 */

import {
  mapArticlePage,
  articleAffinity,
  pickArticles,
  buildJournalView,
  isReadingTrigger,
  READING_TRIGGER,
  DUMMY_ARTICLE_THUMB,
  DUMMY_ARTICLE_URL_BASE,
  type ArticleItem,
  type JournalKarte,
} from "../../src/lib/journal";

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
function assert(cond: boolean, label = "") {
  if (!cond) throw new Error(label || "assertion failed");
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(`${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// フィクスチャ（Notion ページ / ArticleItem）
// ---------------------------------------------------------------------------

/** Notion ページ生成ヘルパ（プロパティ型を最小限で組む）。 */
function notionPage(id: string, props: Record<string, unknown>): { id: string; properties: Record<string, unknown> } {
  return { id, properties: props };
}
function sel(name: string) {
  return { type: "select", select: { name } };
}
/** Notion "status" 型（Content Hub の `Status` の実型）。 */
function status(name: string) {
  return { type: "status", status: { name } };
}
/** Notion "multi_select" 型（`content_persona` / `target_layer` の実型）。 */
function multi(...names: string[]) {
  return { type: "multi_select", multi_select: names.map((name) => ({ name })) };
}
function title(text: string) {
  return { type: "title", title: [{ plain_text: text }] };
}
function rich(text: string) {
  return { type: "rich_text", rich_text: [{ plain_text: text }] };
}
function urlProp(url: string | null) {
  return { type: "url", url };
}
function fileProp(url: string | null) {
  return { type: "files", files: url ? [{ file: { url } }] : [] };
}
function dateProp(start: string | null) {
  return { type: "date", date: start ? { start } : null };
}

/** テスト用 ArticleItem（過不足なく組む・本文フィールドは存在しない）。 */
function article(over: Partial<ArticleItem>): ArticleItem {
  return {
    id: over.id ?? "id",
    title: over.title ?? "記事",
    url: over.url ?? "https://elxea.com/ja/blogs/journal/id",
    excerpt: over.excerpt ?? "抜粋",
    thumbnailUrl: over.thumbnailUrl ?? DUMMY_ARTICLE_THUMB,
    persona: over.persona ?? null,
    targetLayer: over.targetLayer ?? null,
    tags: over.tags ?? [],
    publishedAt: over.publishedAt ?? null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyMap = (p: ReturnType<typeof notionPage>) => p as any;

// ---------------------------------------------------------------------------
// mapArticlePage
// ---------------------------------------------------------------------------

describe("mapArticlePage — Channel/Status ゲート + ダミー + 本文なし", () => {
  it("Channel!=Roji は対象外（null）", () => {
    const p = notionPage("a", { Channel: sel("LINE CRM"), Title: title("x"), Status: sel("Published") });
    assertEqual(mapArticlePage(anyMap(p), { includeDrafts: true }), null, "non-Roji dropped");
  });

  it("本番（includeDrafts=false）は Draft を捨てる / Published は通す", () => {
    const draft = notionPage("d", { Channel: sel("Roji"), Title: title("下書き"), Status: sel("Draft") });
    const pub = notionPage("p", { Channel: sel("Roji"), Title: title("公開"), Status: sel("Published") });
    assertEqual(mapArticlePage(anyMap(draft), { includeDrafts: false }), null, "prod drops Draft");
    assert(mapArticlePage(anyMap(pub), { includeDrafts: false }) !== null, "prod keeps Published");
  });

  it("staging（includeDrafts=true）は Draft も残す（プールが空にならない）", () => {
    const draft = notionPage("d", { Channel: sel("Roji"), Title: title("下書き"), Status: sel("Draft") });
    assert(mapArticlePage(anyMap(draft), { includeDrafts: true }) !== null, "staging keeps Draft");
  });

  it("Published URL 空 → ダミー URL（slug 優先 / なければ id）", () => {
    const noSlug = notionPage("pg1", {
      Channel: sel("Roji"), Title: title("t"), Status: sel("Draft"), "Published URL": urlProp(null),
    });
    const a1 = mapArticlePage(anyMap(noSlug), { includeDrafts: true })!;
    assertEqual(a1.url, `${DUMMY_ARTICLE_URL_BASE}/pg1`, "dummy url uses page id when no slug");

    const withSlug = notionPage("pg2", {
      Channel: sel("Roji"), Title: title("t"), Status: sel("Draft"),
      "Published URL": urlProp(null), "🌐 Roji: Slug": rich("shizukesa"),
    });
    const a2 = mapArticlePage(anyMap(withSlug), { includeDrafts: true })!;
    assertEqual(a2.url, `${DUMMY_ARTICLE_URL_BASE}/shizukesa`, "dummy url uses slug when present");
  });

  it("Published URL 実値 → 実値を採用（ダミーにしない）", () => {
    const real = notionPage("pg", {
      Channel: sel("Roji"), Title: title("t"), Status: sel("Published"),
      "Published URL": urlProp("https://elxea.com/ja/blogs/journal/real"),
    });
    const a = mapArticlePage(anyMap(real), { includeDrafts: false })!;
    assertEqual(a.url, "https://elxea.com/ja/blogs/journal/real", "real url wins");
  });

  it("Featured Image 空 → ダミーサムネ / 実値 → 実値", () => {
    const empty = notionPage("pg", { Channel: sel("Roji"), Title: title("t"), Status: sel("Draft"), "Featured Image": fileProp(null) });
    assertEqual(mapArticlePage(anyMap(empty), { includeDrafts: true })!.thumbnailUrl, DUMMY_ARTICLE_THUMB, "dummy thumb");
    const withImg = notionPage("pg", { Channel: sel("Roji"), Title: title("t"), Status: sel("Draft"), "Featured Image": fileProp("https://cdn/x.png") });
    assertEqual(mapArticlePage(anyMap(withImg), { includeDrafts: true })!.thumbnailUrl, "https://cdn/x.png", "real thumb");
  });

  it("content_persona / target_layer / Published Date を写す・**本文フィールドは持たない**", () => {
    const p = notionPage("pg", {
      Channel: sel("Roji"), Title: title("t"), Status: sel("Draft"),
      content_persona: sel("serenity"), target_layer: sel("wellbeing"),
      "🌐 Roji: Meta Description": rich("メタ説明"), "Published Date": dateProp("2026-07-01"),
    });
    const a = mapArticlePage(anyMap(p), { includeDrafts: true })!;
    assertEqual(a.persona, "serenity", "persona");
    assertEqual(a.targetLayer, "wellbeing", "target_layer");
    assertEqual(a.excerpt, "メタ説明", "excerpt");
    assertEqual(a.publishedAt, "2026-07-01", "publishedAt");
    assert(!("body" in a) && !("content" in a), "ArticleItem に本文フィールドが存在しない");
  });

  it("未知の content_persona 値は null に落とす（内部語彙の混入防止）", () => {
    const p = notionPage("pg", { Channel: sel("Roji"), Title: title("t"), Status: sel("Draft"), content_persona: sel("weird") });
    assertEqual(mapArticlePage(anyMap(p), { includeDrafts: true })!.persona, null, "unknown persona → null");
  });
});

// ---------------------------------------------------------------------------
// mapArticlePage — 実スキーマの型（2026-08-11 QA 検出の回帰防止）
//
// Content Hub の実型を Notion API で実測した結果、select 前提で読んでいた 3 つが別型だった:
//   content_persona = multi_select / Status = status / target_layer = multi_select
// この形で読めることを固定する。select 形の既存フィクスチャは上の describe が引き続き通す
// （= 既存の select 読みを壊していないことの担保）。
// ---------------------------------------------------------------------------

describe("mapArticlePage — 実スキーマの型（multi_select / status）を読む", () => {
  it("content_persona が multi_select（値あり）→ persona を読む", () => {
    const p = notionPage("pg", {
      Channel: sel("Roji"), Title: title("t"), Status: status("Published"),
      content_persona: multi("explorer"),
    });
    assertEqual(mapArticlePage(anyMap(p), { includeDrafts: false })!.persona, "explorer", "multi_select persona");
  });

  it("content_persona が multi_select（空配列）→ null（落ちない）", () => {
    const p = notionPage("pg", {
      Channel: sel("Roji"), Title: title("t"), Status: status("Published"),
      content_persona: multi(),
    });
    assertEqual(mapArticlePage(anyMap(p), { includeDrafts: false })!.persona, null, "empty multi_select → null");
  });

  it("content_persona プロパティ自体が無い → null（落ちない）", () => {
    const p = notionPage("pg", { Channel: sel("Roji"), Title: title("t"), Status: status("Published") });
    assertEqual(mapArticlePage(anyMap(p), { includeDrafts: false })!.persona, null, "missing prop → null");
  });

  it("content_persona が multi_select で複数値 → 最初の有効値（決定的）", () => {
    const p = notionPage("pg", {
      Channel: sel("Roji"), Title: title("t"), Status: status("Published"),
      content_persona: multi("sensory", "serenity"),
    });
    assertEqual(mapArticlePage(anyMap(p), { includeDrafts: false })!.persona, "sensory", "first valid wins");
  });

  it("content_persona の先頭が未知語でも、後続の有効値を拾う", () => {
    const p = notionPage("pg", {
      Channel: sel("Roji"), Title: title("t"), Status: status("Published"),
      content_persona: multi("weird", "serenity"),
    });
    assertEqual(mapArticlePage(anyMap(p), { includeDrafts: false })!.persona, "serenity", "skip unknown");
  });

  it("Status が status 型 → 本番ゲートが正しく効く（Published は通り Draft は落ちる）", () => {
    const pub = notionPage("p", { Channel: sel("Roji"), Title: title("公開"), Status: status("Published") });
    const draft = notionPage("d", { Channel: sel("Roji"), Title: title("下書き"), Status: status("Draft") });
    assert(mapArticlePage(anyMap(pub), { includeDrafts: false }) !== null, "status型 Published が本番で残る");
    assertEqual(mapArticlePage(anyMap(draft), { includeDrafts: false }), null, "status型 Draft は本番で落ちる");
  });

  it("target_layer が multi_select → 先頭値を読む / 空なら null", () => {
    const withLayer = notionPage("pg", {
      Channel: sel("Roji"), Title: title("t"), Status: status("Published"), target_layer: multi("wellbeing"),
    });
    assertEqual(mapArticlePage(anyMap(withLayer), { includeDrafts: false })!.targetLayer, "wellbeing", "multi layer");
    const empty = notionPage("pg", {
      Channel: sel("Roji"), Title: title("t"), Status: status("Published"), target_layer: multi(),
    });
    assertEqual(mapArticlePage(anyMap(empty), { includeDrafts: false })!.targetLayer, null, "empty → null");
  });
});

// ---------------------------------------------------------------------------
// articleAffinity
// ---------------------------------------------------------------------------

describe("articleAffinity — persona 一次 +3 / 二次", () => {
  it("persona 一致 → +3", () => {
    assertEqual(articleAffinity(article({ persona: "sensory" }), { persona: "sensory" }), 3, "match +3");
  });
  it("persona 不一致 → 0", () => {
    assertEqual(articleAffinity(article({ persona: "serenity" }), { persona: "sensory" }), 0, "mismatch 0");
  });
  it("カルテ無し（null）→ 0", () => {
    assertEqual(articleAffinity(article({ persona: "sensory" }), null), 0, "no karte 0");
  });
  it("persona null カルテ → 0（最新順フォールバックに倒れる）", () => {
    assertEqual(articleAffinity(article({ persona: "sensory" }), { persona: null }), 0, "null persona 0");
  });
  it("二次: interestTags が target_layer に一致 → +2（v1.1）", () => {
    const a = article({ persona: "sensory", targetLayer: "wellbeing" });
    assertEqual(articleAffinity(a, { persona: "sensory", interestTags: ["wellbeing"] }), 5, "persona +3 & layer +2");
  });
});

// ---------------------------------------------------------------------------
// pickArticles（出し分けの核心）
// ---------------------------------------------------------------------------

describe("pickArticles — persona 別に別記事（A/B 排他）・no-karte 最新順・max 3", () => {
  const serenityArt = article({ id: "s", persona: "serenity", title: "静", publishedAt: "2026-01-01" });
  const explorerArt = article({ id: "e", persona: "explorer", title: "探", publishedAt: "2026-01-02" });
  const sensoryArt = article({ id: "n", persona: "sensory", title: "感", publishedAt: "2026-01-03" });
  const pool = [serenityArt, explorerArt, sensoryArt];

  it("persona=serenity → serenity 記事が先頭 / sensory 記事は先頭でない（A/B 排他）", () => {
    const top = pickArticles(pool, { persona: "serenity" }, 3);
    assertEqual(top[0].id, "s", "serenity first");
    assert(top[0].id !== "n", "sensory not first for serenity user");
  });

  it("persona=sensory → sensory 記事が先頭（別 persona は別記事）", () => {
    const top = pickArticles(pool, { persona: "sensory" }, 3);
    assertEqual(top[0].id, "n", "sensory first");
  });

  it("break-proof: persona=serenity のとき、より新しい別 persona 記事が先頭を奪わない", () => {
    // sensory 記事(1/03)は serenity 記事(1/01)より新しいが、persona 一致の serenity が +3 で勝つ。
    const top = pickArticles(pool, { persona: "serenity" }, 3);
    assert(top[0].persona === "serenity", `wrong-persona article ranked first: ${top[0].id}`);
    assert(top[0].id !== "n" && top[0].id !== "e", "explorer/sensory must not be first for serenity user");
  });

  it("no-karte（persona=null）→ 最新順フォールバック（1/03 が先頭）", () => {
    const top = pickArticles(pool, { persona: null }, 3);
    assertEqual(top[0].id, "n", "newest first when no karte");
    assertEqual(top[1].id, "e", "then next newest");
  });

  it("max 3 に切る", () => {
    const big = Array.from({ length: 6 }, (_, i) => article({ id: `x${i}`, publishedAt: `2026-01-0${i + 1}` }));
    assertEqual(pickArticles(big, null, 3).length, 3, "capped to 3");
  });

  it("同点は publishedAt 新しい順 → id 昇順で決定的", () => {
    const a = article({ id: "b", persona: "serenity", publishedAt: "2026-01-05" });
    const b = article({ id: "a", persona: "serenity", publishedAt: "2026-01-05" });
    const top = pickArticles([a, b], { persona: "serenity" }, 2);
    assertEqual(top[0].id, "a", "id asc tiebreak (same date)");
  });

  it("URL 無し記事は除外（行き止まり防止）", () => {
    const withUrl = article({ id: "u", url: "https://x/u" });
    const noUrl = article({ id: "z", url: "" });
    const top = pickArticles([withUrl, noUrl], null, 3);
    assertEqual(top.length, 1, "url-less excluded");
    assertEqual(top[0].id, "u", "kept the one with url");
  });
});

// ---------------------------------------------------------------------------
// buildJournalView / トリガー
// ---------------------------------------------------------------------------

describe("buildJournalView / トリガー", () => {
  it("記事あり → cards（本文非露出・「読む」導線）", () => {
    const view = buildJournalView([article({ title: "T", excerpt: "E", url: "https://x/a" })]);
    assertEqual(view.kind, "cards", "cards view");
    if (view.kind === "cards") {
      const s = JSON.stringify(view.contents);
      assert(s.includes("T") && s.includes("E"), "title/excerpt present");
      assert(s.includes("記事を読む"), "read button");
    }
  });
  it("記事 0 件 → empty（テキストで graceful・行き止まりにしない）", () => {
    const view = buildJournalView([]);
    assertEqual(view.kind, "empty", "empty view when no articles");
  });
  it("isReadingTrigger は完全一致のみ", () => {
    assert(isReadingTrigger(READING_TRIGGER), "exact trigger");
    assert(isReadingTrigger("ジャーナル"), "alt trigger");
    assert(!isReadingTrigger("読みものを教えて"), "partial not matched");
  });
});

// ---------------------------------------------------------------------------
// 結果サマリー
// ---------------------------------------------------------------------------

console.log("\n" + "=".repeat(60));
console.log("Journal (UX④) Unit Test Results");
console.log("=".repeat(60));
console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
}
process.exit(failedTests > 0 ? 1 : 0);
