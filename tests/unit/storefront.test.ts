/**
 * Unit Tests -- storefront（購入先の 1 か所化）と D1 の文の対（C-1〜C-8, C-18〜C-20）
 *
 * 設計: 実装設計 rev2 第9章 テスト1（storefront）/ テスト2（文言の完全一致・D1 分）/ テスト5（system-prompt）
 *   https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 * 文言の正本: 文言 v2（elxea-ccs）https://app.notion.com/p/3e770c9d064c818eb5eee425b35dba90
 *   - 閉店中の文は文言 v2 の「新しい文」との完全一致（`${PURCHASE_URL}` は storefront.ts の PURCHASE_URL を差し込む）
 *   - 開店時の文は master（788baac）の今の文との完全一致
 *   文言が変わったらテストを文言に合わせる（文言が正）。
 *
 * C-1 / C-20 / C-8 の行き先は cx-review-fixes.test.ts、C-2 の受け皿は sales-surface.test.ts でも固定している。
 *
 * 使用方法: npx tsx tests/unit/storefront.test.ts
 */

import {
  EC_SITE_OPEN,
  EC_STORE_URL,
  AMAZON_STORE_URL,
  PURCHASE_URL,
  purchaseUrlFor,
  byStore,
  isClosedSiteLink,
  stripClosedLinks,
  collectLinks,
} from "../../src/lib/storefront";
import {
  SITE_URL_JA,
  SUPPORT_EMAIL,
  TEA_SHOP_REFERRAL_LINE,
  TEA_SHOP_REFERRAL_LINE_OPEN,
  TEA_SHOP_REFERRAL_LINE_CLOSED,
} from "../../src/lib/brand-copy";
import {
  SALES_TOOL_DISABLED_RESULT,
  SALES_TOOL_DISABLED_RESULT_OPEN,
  SALES_TOOL_DISABLED_RESULT_CLOSED,
} from "../../src/lib/sales-surface";
import {
  SYSTEM_PROMPT,
  SALES_PROMPT_SECTION,
  buildSystemPrompt,
  buildSalesPromptSection,
  buildPersonaPromptFragment,
  PROMPT_PRICE_UNKNOWN_OPEN,
  PROMPT_PRICE_UNKNOWN_CLOSED,
  PROMPT_PURCHASE_GUIDE_OPEN,
  PROMPT_PURCHASE_GUIDE_CLOSED,
  PROMPT_SUBSCRIPTION_GUIDE_OPEN,
  PROMPT_SUBSCRIPTION_GUIDE_CLOSED,
  PROMPT_SITE_INFO_OPEN,
  PROMPT_SITE_INFO_CLOSED,
  PROMPT_SHIPPING_TERMS_CLOSED,
  PROMPT_PRODUCT_URL_FALLBACK_OPEN,
  PROMPT_PRODUCT_URL_FALLBACK_CLOSED,
} from "../../src/agent/system-prompt";
import {
  SALES_TOOLS,
  PRODUCT_URL_DESCRIPTION_OPEN,
  PRODUCT_URL_DESCRIPTION_CLOSED,
} from "../../src/agent/tools";
import {
  teaRecommendCard,
  TEA_CARD_BUTTON_LABEL_OPEN,
  TEA_CARD_BUTTON_LABEL_CLOSED,
} from "../../src/lib/flex-templates";

let total = 0,
  passed = 0,
  failed = 0;
const failures: Array<{ name: string; error: string }> = [];

function it(name: string, fn: () => void) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    const error = e instanceof Error ? e.message : String(e);
    failures.push({ name, error });
    console.log(`  [FAIL] ${name}: ${error}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

/** 第9章の判定式: collectLinks で取り出したリンクに isClosedSiteLink（閉店中）を当てる。 */
const closedLinksIn = (m: unknown): string[] => collectLinks(m).filter((l) => isClosedSiteLink(l, false));

/** 文字列置換（置換文字列の `$` を特別扱いしない）。 */
const replaceOnce = (s: string, from: string, to: string): string => s.replace(from, () => to);

// ---------------------------------------------------------------------------
console.log("\n--- テスト1: storefront（開店フラグ・購入先・閉じたリンクの判定）---");

it("AMAZON_STORE_URL は Corporate Info「ECサイト」行の値と完全一致", () => {
  assertEqual(
    AMAZON_STORE_URL,
    "https://www.amazon.co.jp/stores/page/0C75602F-4851-4957-8D54-9A17590AF63C",
    "AMAZON_STORE_URL",
  );
});

it("EC_STORE_URL は master の購入先（SITE_URL_JA・旧 EC_SITE_URL）と同じ値", () => {
  assertEqual(EC_STORE_URL, "https://elxea.com/ja", "EC_STORE_URL");
  assertEqual(EC_STORE_URL, SITE_URL_JA, "SITE_URL_JA と同値");
});

it("purchaseUrlFor / PURCHASE_URL は開店フラグ 1 か所で行き先を選ぶ", () => {
  assertEqual(purchaseUrlFor(true), EC_STORE_URL, "開店時 = 公式 EC");
  assertEqual(purchaseUrlFor(false), AMAZON_STORE_URL, "閉店中 = Amazon ストア");
  assertEqual(PURCHASE_URL, purchaseUrlFor(EC_SITE_OPEN), "いまの行き先");
});

it("byStore は開店時 / 閉店中の文を選ぶ（既定は EC_SITE_OPEN）", () => {
  assertEqual(byStore("open", "closed", true), "open", "true → open");
  assertEqual(byStore("open", "closed", false), "closed", "false → closed");
  assertEqual(byStore("open", "closed"), EC_SITE_OPEN ? "open" : "closed", "既定");
});

it("isClosedSiteLink: 閉店中は elxea.com / *.elxea.com / *.myshopify.com / スキーム無し / 解析不能に当たる", () => {
  for (const l of [
    "https://elxea.com/ja",
    "http://elxea.com",
    "https://www.elxea.com/ja/products",
    "https://shop.elxea.com/x",
    "https://xxx.myshopify.com/cart/1:1",
    "elxea.com/ja",
    "elxea.com/ja/subscription",
    "www.elxea.com",
    "HTTPS://ELXEA.COM/JA",
    "https://elxea.com./ja",
    "https://user@elxea.com/ja",
    "http://[::1",
    // QA M1: スキーム無し + ポート付き (コロンの直後が数字 = ポート)
    "elxea.com:443/ja",
    "www.elxea.com:8080",
    "elxea.com:443",
    // QA m4: mailto / tel / line 以外のスキームはホストで判定する
    "intent://elxea.com/ja#Intent;scheme=https;end",
  ]) {
    assert(isClosedSiteLink(l, false), `当たるべき: ${l}`);
  }
});

it("isClosedSiteLink: メールアドレス・mailto・Amazon・workers.dev・liff.line.me・tel・似た別ドメインは当たらない", () => {
  for (const l of [
    "info@elxea.com",
    "mailto:info@elxea.com",
    AMAZON_STORE_URL,
    "https://www.amazon.co.jp/",
    "https://elxea-cx-agent.example.workers.dev/go/store",
    "https://liff.line.me/1234567890-abcdefgh",
    "tel:0120000000",
    "MAILTO:info@elxea.com",
    "line://ti/p/@elxea",
    "sms:+81312345678",
    "intent://www.amazon.co.jp/x#Intent;end",
    "https://elxea.com.example.org/",
    "https://notelxea.com/",
    "",
  ]) {
    assert(!isClosedSiteLink(l, false), `当たらないべき: ${l}`);
  }
});

it("isClosedSiteLink: 開店中は何にも当たらない", () => {
  for (const l of ["https://elxea.com/ja", "elxea.com/ja", "https://xxx.myshopify.com/cart", "http://[::1"]) {
    assert(!isClosedSiteLink(l, true), `開店中: ${l}`);
  }
});

it("stripClosedLinks: 閉じたリンクだけを消し、メール・Amazon は残す（消した数を返す）", () => {
  const src =
    `くわしくは https://elxea.com/ja と elxea.com/ja/subscription をご覧ください。\n` +
    `お問い合わせは info@elxea.com まで。\n${AMAZON_STORE_URL}`;
  const r = stripClosedLinks(src, false);
  assertEqual(r.removed, 2, "消した数");
  assert(!r.text.includes("elxea.com/ja"), "閉じたリンクが残っている");
  assert(r.text.includes("info@elxea.com"), "メールアドレスが消えた");
  assert(r.text.includes(AMAZON_STORE_URL), "Amazon の URL が消えた");
  assertEqual(closedLinksIn(r.text).length, 0, "消した後の閉じたリンク");
});

it("stripClosedLinks: 括弧の中の URL を消すと空の括弧も消す / 閉じたリンクが無ければ元の文のまま", () => {
  assertEqual(
    stripClosedLinks("elxea のサイト（https://elxea.com/ja）でご覧いただけます。", false).text,
    "elxea のサイトでご覧いただけます。",
    "空の括弧",
  );
  const plain = `よろしければ。\n${AMAZON_STORE_URL}\n`;
  const r = stripClosedLinks(plain, false);
  assertEqual(r.removed, 0, "消した数 0");
  assertEqual(r.text, plain, "元の文のまま（末尾の改行も）");
});

it("stripClosedLinks: スキーム無し + ポート付き・直前が英数字のスキームつき・大文字のスキームも消す (QA M1・m1・m2)", () => {
  assertEqual(
    JSON.stringify(stripClosedLinks("ポート無しスキーム elxea.com:443/ja です", false)),
    JSON.stringify({ text: "ポート無しスキーム  です", removed: 1 }),
    "elxea.com:443/ja",
  );
  assertEqual(
    JSON.stringify(stripClosedLinks("www.elxea.com:8080 と elxea.com:443", false)),
    JSON.stringify({ text: " と", removed: 2 }),
    "www.elxea.com:8080 / elxea.com:443",
  );
  assertEqual(
    JSON.stringify(stripClosedLinks("LINEhttps://elxea.com/ja", false)),
    JSON.stringify({ text: "LINE", removed: 1 }),
    "直前が英数字のスキームつき",
  );
  assertEqual(
    JSON.stringify(stripClosedLinks("URL: HTTPS://ELXEA.COM/JA です", false)),
    JSON.stringify({ text: "URL:  です", removed: 1 }),
    "大文字のスキームごと消す",
  );
});

it("stripClosedLinks: 消した数 0 なら入力とまったく同じ文字列を返す (元の括弧・空白・空行を変えない。QA m3)", () => {
  const src = `元の（ ）と ( ) はそのまま。  \n\n\n\n行末の空白 \t\ninfo@elxea.com\n${AMAZON_STORE_URL}\n`;
  const r = stripClosedLinks(src, false);
  assertEqual(r.removed, 0, "消した数");
  assert(r.text === src, "入力と同じ文字列ではない");
});

it("stripClosedLinks: 後始末は消した箇所の周りだけ (QA m3)", () => {
  const cases: Array<[string, string]> = [
    ["元の（ ）はそのまま。  \n\n\n\nくわしくは（https://elxea.com/ja）へ。", "元の（ ）はそのまま。  \n\n\n\nくわしくはへ。"],
    ["A\nhttps://elxea.com/ja\nB", "A\nB"],
    ["A\n\nhttps://elxea.com/ja\n\nB", "A\n\nB"],
    ["よろしければ。\nhttps://elxea.com/ja", "よろしければ。"],
    ["see https://elxea.com/ja \nnext  \n", "see\nnext  \n"],
    ["( ) と https://elxea.com/ja", "( ) と"],
  ];
  for (const [inp, exp] of cases) {
    const r = stripClosedLinks(inp, false);
    assertEqual(r.text, exp, JSON.stringify(inp));
    assertEqual(r.removed, 1, `消した数: ${JSON.stringify(inp)}`);
  }
});

it("stripClosedLinks: 開店中は何も変えない", () => {
  const src = "くわしくは https://elxea.com/ja をご覧ください。";
  const r = stripClosedLinks(src, true);
  assertEqual(r.removed, 0, "消した数");
  assertEqual(r.text, src, "不変");
});

it("collectLinks: 本文・Flex の入れ子の uri・quickReply・altText を拾い、メールと画像 URL は拾わない", () => {
  const msg = [
    {
      type: "text",
      text: "こちら elxea.com/ja/x と info@elxea.com",
      quickReply: {
        items: [{ type: "action", action: { type: "uri", label: "a", uri: "https://shop.elxea.com/q" } }],
      },
    },
    {
      type: "flex",
      altText: "代替 https://elxea.com/alt",
      contents: {
        type: "carousel",
        contents: [
          {
            type: "bubble",
            hero: { type: "image", url: "https://elxea.com/cdn/img.jpg" },
            footer: {
              type: "box",
              layout: "vertical",
              contents: [{ type: "button", action: { type: "uri", label: "見る", uri: "https://elxea.com/ja/deep" } }],
            },
          },
        ],
      },
    },
  ];
  const links = collectLinks(msg);
  for (const l of ["elxea.com/ja/x", "https://shop.elxea.com/q", "https://elxea.com/alt", "https://elxea.com/ja/deep"]) {
    assert(links.includes(l), `拾うべき: ${l}`);
  }
  assert(!links.includes("elxea.com"), "メールアドレスのドメイン部を拾った");
  assert(!links.includes("https://elxea.com/cdn/img.jpg"), "画像 URL を拾った");
  assertEqual(closedLinksIn(msg).length, 4, "閉じたリンクの本数");
});

// ---------------------------------------------------------------------------
console.log("\n--- テスト2: 文言の完全一致（D1 分: C-1〜C-8, C-18〜C-20・開店時 / 閉店中の両方）---");

interface Pair {
  id: string;
  open: string;
  closed: string;
  /** master（788baac）の今の文。 */
  openExpected: string;
  /** 文言 v2 の「新しい文」（`${PURCHASE_URL}` を差し込んだもの）。 */
  closedExpected: string;
  /** いま使われている値（byStore で選ばれたもの）。無ければ省略。 */
  selected?: string;
}

const PAIRS: Pair[] = [
  {
    id: "C-1 TEA_SHOP_REFERRAL_LINE",
    open: TEA_SHOP_REFERRAL_LINE_OPEN,
    closed: TEA_SHOP_REFERRAL_LINE_CLOSED,
    openExpected: "よろしければ、こちらからもご覧いただけます。\nhttps://elxea.com/ja",
    closedExpected: `よろしければ、Amazon の elxea ストアで、いまお取り扱いしているお茶もご覧いただけます。\n${PURCHASE_URL}`,
    selected: TEA_SHOP_REFERRAL_LINE,
  },
  {
    id: "C-2 SALES_TOOL_DISABLED_RESULT",
    open: SALES_TOOL_DISABLED_RESULT_OPEN,
    closed: SALES_TOOL_DISABLED_RESULT_CLOSED,
    openExpected:
      "この道具は現在使用できません。商品カード・カートリンクは提示せず、購入や在庫のご相談は elxea のサイト（https://elxea.com/ja）でご覧いただける旨を、控えめに一度だけ案内してください。",
    closedExpected: `この道具は現在使用できません。商品カード・カートリンクは提示せず、購入や在庫のご相談には、Amazon の elxea ストア（${PURCHASE_URL}）で、いまのお取り扱いをご覧いただける旨を、控えめに一度だけ案内してください。尋ねられたお茶がストアにあるとは言い切らず、ストアそのものを案内してください。公式サイトは開店準備中のため、購入先として案内しないでください。`,
    selected: SALES_TOOL_DISABLED_RESULT,
  },
  {
    id: "C-3 system-prompt:155",
    open: PROMPT_PRICE_UNKNOWN_OPEN,
    closed: PROMPT_PRICE_UNKNOWN_CLOSED,
    openExpected:
      "価格が不明だが商品の特徴は説明できる場合 → 特徴を伝え、価格は「サイトでご確認いただけます」と案内する",
    closedExpected:
      "価格が不明だが商品の特徴は説明できる場合 → 特徴を伝え、価格は「Amazon の elxea ストアで、いまのお取り扱いをご覧いただけます」と案内する。そのお茶がストアにあるとは言い切らない",
  },
  {
    id: "C-4 system-prompt:194",
    open: PROMPT_PURCHASE_GUIDE_OPEN,
    closed: PROMPT_PURCHASE_GUIDE_CLOSED,
    openExpected:
      "価格・在庫・購入手続きを尋ねられたときだけ、elxea のサイト（https://elxea.com/ja）でご覧いただける旨を**控えめに一度だけ**案内する。繰り返さない。",
    closedExpected: `価格・在庫・購入手続きを尋ねられたときだけ、Amazon の elxea ストア（${PURCHASE_URL}）で、いまのお取り扱いをご覧いただける旨を**控えめに一度だけ**案内する。繰り返さない。尋ねられたお茶がストアにあるとは言い切らず、ストアそのものを案内する。公式サイトは開店準備中のため、購入先として案内しない。`,
  },
  {
    id: "C-5 system-prompt:196",
    open: PROMPT_SUBSCRIPTION_GUIDE_OPEN,
    closed: PROMPT_SUBSCRIPTION_GUIDE_CLOSED,
    openExpected: "定期便をこちらから案内しない。尋ねられたときにサイトの案内先を伝えるだけにとどめる。",
    closedExpected:
      "定期便をこちらから案内しない。尋ねられたときは、定期便はいま準備を進めていることだけを伝える。案内先のページはまだ開いていないのでURLを出さない。Amazon の elxea ストアを定期便の代わりとして案内しない。",
  },
  {
    id: "C-6 system-prompt:240",
    open: PROMPT_SITE_INFO_OPEN,
    closed: PROMPT_SITE_INFO_CLOSED,
    openExpected: "**サイト**: https://elxea.com/ja",
    closedExpected: `**公式サイト**: 開店準備中（URLは案内しない）\n- **購入先（公式サイトの開店まで）**: Amazon の elxea ストア ${PURCHASE_URL}`,
  },
  {
    id: "C-7 system-prompt:269",
    open: PROMPT_PRODUCT_URL_FALLBACK_OPEN,
    closed: PROMPT_PRODUCT_URL_FALLBACK_CLOSED,
    openExpected: "URLが不明な場合は https://elxea.com/ja/products （商品一覧ページ）を使用する",
    closedExpected: `URLが不明な場合は Amazon の elxea ストア（${PURCHASE_URL}）を使用する（公式サイトの開店まで）`,
  },
  {
    id: "C-8 flex-templates:924 ボタン名",
    open: TEA_CARD_BUTTON_LABEL_OPEN,
    closed: TEA_CARD_BUTTON_LABEL_CLOSED,
    openExpected: "見る",
    closedExpected: "Amazon ストアを見る",
  },
  {
    id: "C-18 tools.ts:109",
    open: PRODUCT_URL_DESCRIPTION_OPEN,
    closed: PRODUCT_URL_DESCRIPTION_CLOSED,
    openExpected: "商品ページURL（elxea.com のURL。不明な場合は https://elxea.com/ja/products を使用）",
    closedExpected: `商品ページURL（不明な場合は ${PURCHASE_URL} を使用）`,
  },
];

for (const p of PAIRS) {
  it(`${p.id}: 開店時 = master の文 / 閉店中 = 文言 v2 と完全一致`, () => {
    assertEqual(p.open, p.openExpected, "開店時の文");
    assertEqual(p.closed, p.closedExpected, "閉店中の文");
    if (p.selected !== undefined) assertEqual(p.selected, byStore(p.open, p.closed), "いまの文は対から選ぶ");
  });
}

it("C-19: 閉店中だけ足す 1 行が文言 v2 と完全一致（開店時は足さない）", () => {
  assertEqual(
    PROMPT_SHIPPING_TERMS_CLOSED,
    "**配送・送料・決済・返品**: 上の配送・送料・決済・返品は、公式サイトの開店後の条件。いまのご購入先は Amazon の elxea ストアのため、送料・配送・決済・返品を尋ねられたら、上の条件をいまの条件として伝えず、Amazon の商品ページや Amazon の注文履歴でご確認いただけるよう案内する。",
    "C-19",
  );
  assert(buildSystemPrompt(false).includes(`- ${PROMPT_SHIPPING_TERMS_CLOSED}\n`), "閉店中は行頭「- 」つきで入る");
  assert(!buildSystemPrompt(true).includes(PROMPT_SHIPPING_TERMS_CLOSED), "開店時は入らない");
});

it("system-prompt: 開店時と閉店中の差は購入先まわりの行（C-3〜C-6・C-19）だけ", () => {
  const open = buildSystemPrompt(true);
  let converted = open;
  for (const [o, c] of [
    [PROMPT_PRICE_UNKNOWN_OPEN, PROMPT_PRICE_UNKNOWN_CLOSED],
    [PROMPT_PURCHASE_GUIDE_OPEN, PROMPT_PURCHASE_GUIDE_CLOSED],
    [PROMPT_SUBSCRIPTION_GUIDE_OPEN, PROMPT_SUBSCRIPTION_GUIDE_CLOSED],
    [PROMPT_SITE_INFO_OPEN, PROMPT_SITE_INFO_CLOSED],
  ]) {
    assertEqual(open.split(`- ${o}\n`).length, 2, `開店時に「- ${o}」の行が 1 回だけある`);
    converted = replaceOnce(converted, `- ${o}\n`, `- ${c}\n`);
  }
  converted = replaceOnce(
    converted,
    "（不良品は送料当社負担）\n",
    `（不良品は送料当社負担）\n- ${PROMPT_SHIPPING_TERMS_CLOSED}\n`,
  );
  assertEqual(converted, buildSystemPrompt(false), "対の行を差し替えると閉店中のプロンプトに一致する");
  assertEqual(SYSTEM_PROMPT, buildSystemPrompt(EC_SITE_OPEN), "SYSTEM_PROMPT はいまの開店状態で組み立てた不変の文字列");
});

it("売り込み面の節: 開店時と閉店中の差は C-7 の行だけ", () => {
  const open = buildSalesPromptSection(true);
  assertEqual(open.split(`- ${PROMPT_PRODUCT_URL_FALLBACK_OPEN}\n`).length, 2, "開店時に C-7 の行が 1 回だけある");
  assertEqual(
    replaceOnce(open, `- ${PROMPT_PRODUCT_URL_FALLBACK_OPEN}\n`, `- ${PROMPT_PRODUCT_URL_FALLBACK_CLOSED}\n`),
    buildSalesPromptSection(false),
    "C-7 を差し替えると閉店中の節に一致する",
  );
  assertEqual(SALES_PROMPT_SECTION, buildSalesPromptSection(EC_SITE_OPEN), "いまの節");
});

it("C-8: お茶カードのボタン名は開店時「見る」/ 閉店中「Amazon ストアを見る」、行き先は渡した URL", () => {
  const base = { name: "11301｜玉露", description: "説明", productUrl: PURCHASE_URL };
  const label = (siteOpen?: boolean): string => {
    const card = teaRecommendCard(siteOpen === undefined ? base : { ...base, siteOpen }) as {
      footer: { contents: Array<{ action: { label: string; uri: string } }> };
    };
    assertEqual(card.footer.contents[0].action.uri, PURCHASE_URL, "行き先");
    return card.footer.contents[0].action.label;
  };
  assertEqual(label(true), "見る", "開店時");
  assertEqual(label(false), "Amazon ストアを見る", "閉店中");
  assertEqual(label(), byStore(TEA_CARD_BUTTON_LABEL_OPEN, TEA_CARD_BUTTON_LABEL_CLOSED), "既定はいまの開店状態");
});

it("C-18: recommend_product の product_url の説明は対から選ぶ", () => {
  const json = JSON.stringify(SALES_TOOLS);
  const selected = byStore(PRODUCT_URL_DESCRIPTION_OPEN, PRODUCT_URL_DESCRIPTION_CLOSED);
  const other = EC_SITE_OPEN ? PRODUCT_URL_DESCRIPTION_CLOSED : PRODUCT_URL_DESCRIPTION_OPEN;
  assert(json.includes(JSON.stringify(selected).slice(1, -1)), "いまの説明が道具の定義に入っている");
  assert(!json.includes(JSON.stringify(other).slice(1, -1)), "もう一方の説明が入っている");
});

// ---------------------------------------------------------------------------
console.log("\n--- テスト5: system-prompt（閉店中に閉じたリンクを持たない・開店時は戻る）---");

it("閉店中のプロンプト（本体 + 売り込み面の節）と D1 の閉店中の文に閉じたリンクが無い（メールは対象外）", () => {
  if (EC_SITE_OPEN) {
    // 開店後は閉店中の文の差し込み先（PURCHASE_URL）が公式 EC になるため、この検査は閉店中だけ意味を持つ。
    console.log("    (EC_SITE_OPEN=true: 閉店中の文は使われないため省略)");
    return;
  }
  const texts: Record<string, string> = {
    prompt: buildSystemPrompt(false),
    sales: buildSalesPromptSection(false),
    disabledResult: SALES_TOOL_DISABLED_RESULT_CLOSED,
    productUrlDescription: PRODUCT_URL_DESCRIPTION_CLOSED,
    referral: TEA_SHOP_REFERRAL_LINE_CLOSED,
  };
  for (const [k, t] of Object.entries(texts)) assertEqual(closedLinksIn(t).join(" "), "", k);
  assert(buildSystemPrompt(false).includes(SUPPORT_EMAIL), "問い合わせメールは残る");
  assert(buildSystemPrompt(false).includes(AMAZON_STORE_URL), "購入先（Amazon ストア）を案内する");
});

it("ペルソナ断片にも閉じたリンクが無い", () => {
  for (const p of ["serenity", "explorer", "sensory", null] as const) {
    assertEqual(closedLinksIn(buildPersonaPromptFragment(p)).length, 0, String(p));
  }
});

it("開店時のプロンプトは master と同じく公式 EC を案内し、Amazon を含まない（開店時に戻る）", () => {
  assert(buildSystemPrompt(true).includes("- **サイト**: https://elxea.com/ja\n"), "サイトの行");
  assert(!buildSystemPrompt(true).includes(AMAZON_STORE_URL), "本体に Amazon が残っている");
  assert(!buildSalesPromptSection(true).includes(AMAZON_STORE_URL), "売り込み面の節に Amazon が残っている");
});

// ---------------------------------------------------------------------------
// D1 QA n1: メールアドレスのドメイン部の後ろ (パス・クエリ) に埋まった URL も検査する (D2b)
// ---------------------------------------------------------------------------

it("n1: mailto の body に埋まった閉じたリンクは消え、メールアドレスは残る", () => {
  const text = "ご連絡は mailto:info@elxea.com?body=https://elxea.com/ja から";
  const r = stripClosedLinks(text, false);
  assertEqual(r.removed, 1, "消した数");
  assert(!r.text.includes("https://elxea.com/ja"), `埋まった URL が残っている: ${r.text}`);
  assert(r.text.includes("info@elxea.com"), "メールアドレスが消えた");
  assertEqual(stripClosedLinks(text, true).text, text, "開店中は何も変えない");
});

it("n1: メールアドレスの後ろのクエリに埋まったスキーム無しの URL も拾う", () => {
  const links = collectLinks("info@elxea.com?next=https://shop.elxea.com/cart と elxea.com/ja");
  assert(links.includes("https://shop.elxea.com/cart"), `クエリ内の URL を拾っていない: ${links.join(",")}`);
  assert(links.includes("elxea.com/ja"), "後ろの URL を拾っていない");
  assert(!links.some((l) => l.startsWith("elxea.com?") || l === "elxea.com"), "ドメイン部を URL として拾った");
});

it("n1: Flex の uri が mailto でも、その中に埋まった閉じたリンクは collectLinks で拾う", () => {
  const flex = { type: "button", action: { type: "uri", uri: "mailto:info@elxea.com?body=https://elxea.com/ja" } };
  const closed = collectLinks(flex).filter((l) => isClosedSiteLink(l, false));
  assertEqual(closed.join(" "), "https://elxea.com/ja", "埋まった閉じたリンク");
  assertEqual(collectLinks({ uri: "mailto:info@elxea.com" }).filter((l) => isClosedSiteLink(l, false)).length, 0, "ただの mailto は対象外");
});

it("n1: ただのメールアドレス・サブドメインのメールアドレスは今までどおり対象外", () => {
  for (const t of ["info@elxea.com", "info@mail.elxea.com まで", "（info@elxea.com）"]) {
    assertEqual(stripClosedLinks(t, false).removed, 0, t);
  }
});

// ---------------------------------------------------------------------------
console.log("\n============================================================");
console.log("storefront.test Results");
console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
