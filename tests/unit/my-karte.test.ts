/**
 * Unit Tests — マイカルテ（UX②・buildKarteSummary / isEmptyKarte / loadKarteForDisplay）
 *
 * Firestore / Supabase / Shopify には触れない（純粋関数 + 依存注入 fake）。検証範囲:
 *   - buildKarteSummary: 3 枚カード（あなた/これまで/だから）・人間語・生スコア非漏洩・なぜ理由
 *   - 空カルテ → 診断 CTA
 *   - 連携ユーザー → 「これまで」に最近のお届けが入る
 *   - loadKarteForDisplay: 注入 fake で組み立て正しさ + **書き込みゼロ**（read-only）
 *
 * 使用: npx tsx tests/unit/my-karte.test.ts
 */

import {
  buildKarteSummary,
  isEmptyKarte,
  isMyKarteTrigger,
  MY_KARTE_TRIGGER,
  type KarteView,
} from "../../src/lib/my-karte";
import { loadKarteForDisplay, type KarteDisplay, type KarteDisplayDeps } from "../../src/lib/customer-karte";
import { DIAGNOSIS_TRIGGER } from "../../src/lib/preference-diagnosis";
import type { Env } from "../../src/index";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TeaItem } from "../../src/lib/tea-menu";
import type { OrderSummary } from "../../src/lib/shopify";

let total = 0;
let passed = 0;
const failures: string[] = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function it(name: string, fn: () => void | Promise<void>) {
  queue.push({ name, fn });
}
function assert(cond: boolean, label = "") {
  if (!cond) throw new Error(`assertion failed: ${label}`);
}
function assertEqual<T>(a: T, e: T, label = "") {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

/** 生スコア漏洩ガード（可視テキストに対して）。No.XXXXX の数字は ':' を伴わないため許容。 */
const SCORE_LEAK_RE = /\bscores?\b|\b(sensory|serenity|explorer)\b|affinity|[:：]\s*\d/i;

/** KarteView から可視テキストを集める（text / button label / altText / quickReply label）。 */
function collect(node: unknown, acc: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collect(n, acc);
    return;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.type === "text" && typeof o.text === "string") acc.push(o.text);
    if (o.type === "button" && o.action && typeof o.action === "object") {
      const a = o.action as Record<string, unknown>;
      if (typeof a.label === "string") acc.push(a.label);
    }
    for (const v of Object.values(o)) collect(v, acc);
  }
}
function visible(view: KarteView): string {
  const acc: string[] = [];
  if (view.kind === "empty") {
    acc.push(view.text);
  } else {
    acc.push(view.altText);
    collect(view.carousel, acc);
  }
  for (const q of view.quickReplies) {
    const a = (q as { action?: { label?: string } }).action;
    if (a?.label) acc.push(a.label);
  }
  return acc.join("\n");
}

const LINE_ONLY: KarteDisplay = {
  linked: false,
  persona: "sensory",
  tasteProfile: { preferredCategories: ["oolong"], flavorPreferences: ["rich", "sweet"], scenePref: "夜のひととき" },
  entrySource: "marche",
  ratedGoodLabels: ["煎茶 やまなみ（No.11301）"],
  diagnosisDone: true,
  recentOrders: [],
  lastNextCupLabel: "和烏龍茶 香駿（No.40101）",
};

it("トリガー完全一致のみ true（部分一致は false）", () => {
  assert(isMyKarteTrigger(MY_KARTE_TRIGGER), "マイカルテ");
  assert(isMyKarteTrigger("わたしの好み"), "予備");
  assert(!isMyKarteTrigger("マイカルテを見たい"), "部分一致は false");
});

it("未連携+カルテあり → 3 枚カード・人間語・なぜ理由・生スコア非漏洩", () => {
  const view = buildKarteSummary(LINE_ONLY);
  assertEqual(view.kind, "cards", "kind");
  if (view.kind !== "cards") return;
  const carousel = view.carousel as { type: string; contents: unknown[] };
  assertEqual(carousel.type, "carousel", "carousel");
  assertEqual(carousel.contents.length, 3, "3 枚");

  const v = visible(view);
  assert(v.includes("味わいを深く愉しむ人"), "persona 人間語");
  assert(!v.includes("sensory"), "persona slug 非露出");
  assert(v.includes("青茶"), "カテゴリ人間語（oolong→青茶）");
  assert(v.includes("コク"), "flavor 人間語（rich→コク）");
  assert(!v.includes("rich"), "flavor slug 非露出");
  assert(v.includes("（No.11301）"), "評価済みお茶が 名前（No.）表記");
  assert(v.includes("だから、次の一杯"), "3 枚目のなぜカード");
  assert(v.includes("（No.40101）"), "直近の次の一杯を根拠に");
  assert(/ふまえ|合わせて|寄り添って/.test(v), "なぜ理由文");
  assert(!SCORE_LEAK_RE.test(v), `生スコア漏洩: ${v}`);
});

it("空カルテ → 診断 CTA（quickReply=DIAGNOSIS_TRIGGER）", () => {
  const empty: KarteDisplay = {
    linked: false,
    persona: null,
    tasteProfile: null,
    entrySource: null,
    ratedGoodLabels: [],
    diagnosisDone: false,
    recentOrders: [],
    lastNextCupLabel: null,
  };
  assert(isEmptyKarte(empty), "isEmptyKarte");
  const view = buildKarteSummary(empty);
  assertEqual(view.kind, "empty", "kind");
  if (view.kind !== "empty") return;
  assert(/診断/.test(view.text), "診断 CTA");
  const qrTexts = view.quickReplies.map((q) => (q as { action?: { text?: string } }).action?.text);
  assert(qrTexts.includes(DIAGNOSIS_TRIGGER), "診断トリガーへ誘導");
});

it("連携ユーザー → 「これまで」に最近のお届けが入る（未連携は入らない）", () => {
  const linked: KarteDisplay = {
    ...LINE_ONLY,
    linked: true,
    recentOrders: [
      { name: "#1001", status: "支払い済み", fulfillmentStatus: "発送済み", createdAt: "2026/6/28", totalPrice: "¥3,000" },
    ],
  };
  const view = buildKarteSummary(linked);
  const v = visible(view);
  assert(v.includes("最近のお届け"), "お届けセクション");
  assert(v.includes("#1001"), "注文名");
  assert(v.includes("発送済み"), "配送状況（人間語）");
  assert(!SCORE_LEAK_RE.test(v), `生スコア漏洩: ${v}`);

  // 未連携は最近のお届けを出さない。
  const v2 = visible(buildKarteSummary(LINE_ONLY));
  assert(!v2.includes("最近のお届け"), "未連携はお届けセクションを省く");
});

it("loadKarteForDisplay: 注入 fake で組み立て + 書き込みゼロ（read-only）", async () => {
  let writes = 0;
  // supabase への書き込みが起きたら即検知する spy（read-only 破りを捕捉）。
  const spySupabase = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "from") {
          return () =>
            new Proxy(
              {},
              {
                get(_t2, p2) {
                  if (["insert", "update", "upsert", "delete"].includes(String(p2))) {
                    writes++;
                    return () => ({});
                  }
                  return () => ({});
                },
              },
            );
        }
        return () => ({});
      },
    },
  ) as unknown as SupabaseClient;

  const teas: TeaItem[] = [
    { id: "p1", number: "11301", name: "煎茶 やまなみ", category: "緑茶", flavorProfiles: [], descShort: "", howToBrew: "", temp: "", time: "", water: "", enjoy: "", story: "" },
    { id: "p2", number: "40101", name: "和烏龍茶 香駿", category: "青茶", flavorProfiles: [], descShort: "", howToBrew: "", temp: "", time: "", water: "", enjoy: "", story: "" },
  ];
  const orders: OrderSummary[] = [
    { name: "#1001", status: "支払い済み", fulfillmentStatus: "発送済み", createdAt: "2026/6/28", totalPrice: "¥3,000" },
  ];

  const deps: KarteDisplayDeps = {
    resolveShopifyId: async () => "900800400778", // 連携済み
    getShopifyProfile: async () => ({
      persona: { primary: "sensory", scores: { serenity: 0, explorer: 0, sensory: 5 }, lastUpdated: "x" },
      tasteProfile: { preferredCategories: ["oolong"], flavorPreferences: ["rich"], scenePref: "夜" },
      onboarding: { completedAt: null, initialAction: null, source: "marche" },
    }),
    getLineProfile: async () => {
      throw new Error("連携済みなので lineUsers は引かない");
    },
    getRatings: async () => [{ product_no: "11301", rating: 1 }],
    fetchTeas: async () => teas,
    getOrders: async () => orders,
    getLastNextCup: async () => ({ productNo: "40101", value: "karte" }),
  };

  // Firebase 設定あり相当（getFirestoreEnv が成功する最小・実 I/O は fake が肩代わり）。
  const ENV_FB = { FIREBASE_PROJECT_ID: "p", FIREBASE_CLIENT_EMAIL: "e@x.com", FIREBASE_PRIVATE_KEY: "d" } as unknown as Env;

  const d = await loadKarteForDisplay("U" + "a".repeat(32), ENV_FB, spySupabase, deps);
  assertEqual(d.linked, true, "linked");
  assertEqual(d.persona, "sensory", "persona");
  assertEqual(d.diagnosisDone, true, "diagnosisDone");
  assertEqual(d.entrySource, "marche", "entrySource");
  assertEqual(d.ratedGoodLabels.join("|"), "煎茶 やまなみ（No.11301）", "rated label");
  assertEqual(d.recentOrders.length, 1, "orders");
  assertEqual(d.lastNextCupLabel, "和烏龍茶 香駿（No.40101）", "last next cup");
  assertEqual(writes, 0, "書き込みゼロ（read-only）");
});

it("loadKarteForDisplay: 未連携（LINEのみ）でも動作・購入は空", async () => {
  const deps: KarteDisplayDeps = {
    resolveShopifyId: async () => null, // 未連携
    getLineProfile: async () => ({
      persona: { primary: "serenity", scores: { serenity: 4, explorer: 0, sensory: 0 }, lastUpdated: "x" },
      tasteProfile: { preferredCategories: ["green"], flavorPreferences: [], scenePref: null },
    }),
    getShopifyProfile: async () => {
      throw new Error("未連携なので users は引かない");
    },
    getRatings: async () => [],
    fetchTeas: async () => [],
    getOrders: async () => {
      throw new Error("未連携は注文を取りに行かない");
    },
    getLastNextCup: async () => null,
  };
  const ENV_FB = { FIREBASE_PROJECT_ID: "p", FIREBASE_CLIENT_EMAIL: "e@x.com", FIREBASE_PRIVATE_KEY: "d" } as unknown as Env;
  const d = await loadKarteForDisplay("U" + "b".repeat(32), ENV_FB, {} as unknown as SupabaseClient, deps);
  assertEqual(d.linked, false, "linked=false");
  assertEqual(d.persona, "serenity", "persona");
  assertEqual(d.recentOrders.length, 0, "未連携は購入なし");
});

(async () => {
  for (const t of queue) {
    total++;
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failures.push(`${t.name}`);
      console.log(`  [FAIL] ${t.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("\n============================================================");
  console.log("my-karte Test Results");
  console.log("============================================================");
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${total - passed}`);
  if (failures.length > 0) process.exit(1);
})();
