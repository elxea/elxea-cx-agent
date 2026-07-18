/**
 * 3 レンズ・クロスレビュー確定 6 件（staging）の新規ロジックの単体テスト。
 *
 * 対象（cx-agent 側の純粋・分岐ロジックのみ・ネットワーク非依存）:
 *   ① 好み引き継ぎ  : mergePersonaProfiles / mergeTasteProfiles（累積加算・union）+ merge の冪等短絡
 *   ① 便益コピー是正: LINKAGE_BENEFIT_LINE / LINKAGE_INVITE_BODY から注文/お届け約束を除去
 *   ② 空振り連携    : isMarcheSourceUser（source=marche 判定・best-effort false）+ お断りコピーの静けさ
 *   ③-a 世帯共有500 : upsertCustomerLinkage が shopify_customer_id UNIQUE 衝突を conflict で返す
 *   ④ 購入導線      : TEA_SHOP_REFERRAL_LINE がカード末尾 / 次の一杯に載る
 *
 * ③-b（列名）は line.ts の実 DB 依存のため本ファイル対象外（grep/デプロイ検証）。
 * ③-c（iss/exp）は web-app 側 vitest（__tests__/verify-liff-token.test.ts）で検証。
 */
import {
  mergePersonaProfiles,
  mergeTasteProfiles,
  mergeLineUserIntoShopify,
  type PersonaProfile,
  type TasteProfile,
  type CustomerProfile,
  type LineUserProfile,
  type FirestoreEnv,
} from "../../src/lib/firestore";
import {
  LINKAGE_BENEFIT_LINE,
  LINKAGE_INVITE_BODY,
  NON_SUBSCRIBER_DECLINE_BODY,
  TEA_SHOP_REFERRAL_LINE,
  MARCHE_LINKAGE_SOFT_ACK,
  SITE_URL_JA,
} from "../../src/lib/brand-copy";
import { buildTeaCard, buildRateThanksGood, type TeaItem } from "../../src/lib/tea-menu";
import { upsertCustomerLinkage } from "../../src/lib/customer-linkage";
import { isMarcheSourceUser } from "../../src/lib/subscriber-linkage";
import type { Env } from "../../src/index";
import type { SupabaseClient } from "@supabase/supabase-js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) passed++;
  else {
    failed++;
    failures.push(msg);
  }
}
async function it(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e instanceof Error ? e.message : e}`);
    console.log(`  [FAIL] ${name}: ${e instanceof Error ? e.message : e}`);
  }
}

function tea(number: string, overrides: Partial<TeaItem> = {}): TeaItem {
  return {
    number,
    name: `お茶${number}`,
    category: "緑茶",
    flavorProfiles: ["リッチ", "フルボディ"],
    descShort: "やさしい甘み",
    howToBrew: "80℃",
    temp: "",
    time: "",
    water: "",
    enjoy: "",
    story: "",
    ...overrides,
  };
}

async function run() {
  console.log("\n=== ① persona/taste マージ（累積加算・union・上書きしない）===");
  await it("mergePersonaProfiles: scores を軸ごとに加算し primary を再計算", () => {
    const base: PersonaProfile = {
      primary: "serenity",
      scores: { serenity: 2, explorer: 1, sensory: 0 },
      lastUpdated: "t0",
    };
    const incoming: PersonaProfile = {
      primary: "explorer",
      scores: { serenity: 0, explorer: 3, sensory: 1 },
      lastUpdated: "t1",
    };
    const m = mergePersonaProfiles(base, incoming)!;
    assert(m.scores.serenity === 2 && m.scores.explorer === 4 && m.scores.sensory === 1, "加算");
    assert(m.primary === "explorer", "primary=最大軸");
  });
  await it("mergePersonaProfiles: 片方 undefined → もう一方をそのまま返す", () => {
    const base: PersonaProfile = { primary: "serenity", scores: { serenity: 1, explorer: 0, sensory: 0 }, lastUpdated: "t" };
    assert(mergePersonaProfiles(base, undefined) === base, "incoming なし→base");
    assert(mergePersonaProfiles(undefined, base) === base, "base なし→incoming");
  });
  await it("mergeTasteProfiles: 配列は union・scenePref は base 優先", () => {
    const base: TasteProfile = { preferredCategories: ["緑茶"], flavorPreferences: ["甘い"], scenePref: "朝" };
    const incoming: TasteProfile = { preferredCategories: ["紅茶", "緑茶"], flavorPreferences: ["渋い"], scenePref: "夜" };
    const m = mergeTasteProfiles(base, incoming)!;
    assert(m.preferredCategories.length === 2 && m.preferredCategories.includes("紅茶"), "union categories");
    assert(m.flavorPreferences.includes("甘い") && m.flavorPreferences.includes("渋い"), "union flavors");
    assert(m.scenePref === "朝", "scenePref base 優先");
  });

  console.log("\n=== ① merge の冪等短絡（mergedToShopify=true → 書き込まず既存 users を返す）===");
  await it("mergeLineUserIntoShopify: 既にマージ済みなら I/O せず existingShopify を返す", async () => {
    const existingShopify = { persona: { primary: "serenity", scores: { serenity: 5, explorer: 0, sensory: 0 }, lastUpdated: "t" } } as CustomerProfile;
    const existingLine = { mergedToShopify: true, persona: { primary: "explorer", scores: { serenity: 0, explorer: 9, sensory: 0 }, lastUpdated: "t" } } as LineUserProfile;
    const out = await mergeLineUserIntoShopify("Uxxxx", "123", {} as FirestoreEnv, { existingShopify, existingLine });
    // 冪等短絡: 書き込みなし・二重加算なし（explorer=9 が混ざらない）。
    assert(out === existingShopify, "既存 users をそのまま返す（書き込みなし）");
  });

  console.log("\n=== ① 便益コピー是正（注文/お届けの過大約束を外す・好みは残す）===");
  await it("LINKAGE_BENEFIT_LINE: 「お届け」「ご注文」を含まず「好み」を含む", () => {
    assert(!LINKAGE_BENEFIT_LINE.includes("お届け"), "お届け約束を外した");
    assert(!LINKAGE_BENEFIT_LINE.includes("ご注文"), "ご注文約束を外した");
    assert(LINKAGE_BENEFIT_LINE.includes("好み"), "好みの案内は残す");
  });
  await it("LINKAGE_INVITE_BODY: 「ご注文」「定期便の状況」を含まず「好み」を含む", () => {
    assert(!LINKAGE_INVITE_BODY.includes("ご注文"), "ご注文約束を外した");
    assert(!LINKAGE_INVITE_BODY.includes("定期便の状況"), "定期便状況約束を外した");
    assert(LINKAGE_INVITE_BODY.includes("好み"), "好みの案内は残す");
  });
  await it("NON_SUBSCRIBER_DECLINE_BODY: 突き放し表現を含まず好みの案内で着地", () => {
    assert(!NON_SUBSCRIBER_DECLINE_BODY.includes("定期便をご契約のお客さまにお届け"), "突き放し表現を撤去");
    assert(NON_SUBSCRIBER_DECLINE_BODY.includes("好み"), "好みの案内で受け止める");
  });

  console.log("\n=== ② 空振り連携（marche 判定 + 静かなお断り）===");
  const envFs = { FIREBASE_PROJECT_ID: "p", FIREBASE_CLIENT_EMAIL: "e", FIREBASE_PRIVATE_KEY: "k" } as unknown as Env;
  await it("isMarcheSourceUser: onboarding.source=marche → true", async () => {
    const r = await isMarcheSourceUser("Uabc", envFs, { getLineProfile: async () => ({ onboarding: { completedAt: null, initialAction: null, source: "marche" } }) as LineUserProfile });
    assert(r === true, "marche → true");
  });
  await it("isMarcheSourceUser: source=online → false（連携導線は従来どおり出す）", async () => {
    const r = await isMarcheSourceUser("Uabc", envFs, { getLineProfile: async () => ({ onboarding: { completedAt: null, initialAction: null, source: "online" } }) as LineUserProfile });
    assert(r === false, "online → false");
  });
  await it("isMarcheSourceUser: 取得失敗 → false（best-effort・安全側）", async () => {
    const r = await isMarcheSourceUser("Uabc", envFs, { getLineProfile: async () => { throw new Error("boom"); } });
    assert(r === false, "throw → false");
  });
  await it("MARCHE_LINKAGE_SOFT_ACK: 押し売り語を含まない", () => {
    for (const w of ["限定", "今だけ", "セール", "割引", "お得", "急いで"]) assert(!MARCHE_LINKAGE_SOFT_ACK.includes(w), `banned: ${w}`);
    assert(MARCHE_LINKAGE_SOFT_ACK.includes("マルシェ"), "マルシェ文脈");
  });

  console.log("\n=== ③-a 世帯共有 500 → conflict で返す（N:1・UNIQUE 衝突）===");
  await it("upsertCustomerLinkage: shopify_customer_id UNIQUE 衝突(23505) → conflict フラグ", async () => {
    const mock = {
      from: () => ({
        upsert: async () => ({
          error: { code: "23505", message: 'duplicate key value violates unique constraint "customer_linkages_shopify_customer_id_key"' },
        }),
      }),
    } as unknown as SupabaseClient;
    const r = await upsertCustomerLinkage(mock, { lineUserId: "U" + "a".repeat(32), shopifyCustomerId: "123" });
    assert(r.ok === false, "ok:false");
    assert(r.ok === false && r.conflict === "shopify_customer_id", "conflict=shopify_customer_id");
  });

  console.log("\n=== ④ 購入導線（送客リンクをカード末尾 / 次の一杯に載せる）===");
  await it("TEA_SHOP_REFERRAL_LINE: 静かなトーン + 既存 URL 再利用", () => {
    assert(TEA_SHOP_REFERRAL_LINE.includes("よろしければ"), "よろしければ添え");
    assert(TEA_SHOP_REFERRAL_LINE.includes(SITE_URL_JA), "既存 URL 再利用");
  });
  await it("buildTeaCard: カード末尾に送客リンクが載る", () => {
    assert(buildTeaCard(tea("11301")).text.includes(TEA_SHOP_REFERRAL_LINE), "card 末尾に referral");
  });
  await it("buildRateThanksGood: 提案ありは送客リンクを載せ、提案なしは載せない", () => {
    const withSug = buildRateThanksGood(tea("11301"), tea("22202"));
    const noSug = buildRateThanksGood(tea("11301"), null);
    assert(withSug.text.includes(TEA_SHOP_REFERRAL_LINE), "提案あり→referral");
    assert(!noSug.text.includes(TEA_SHOP_REFERRAL_LINE), "提案なし→referral なし（静けさ維持）");
  });

  console.log("\n============================================================");
  console.log(`cx-review-fixes.test Results`);
  console.log(`Total: ${passed + failed}, Passed: ${passed}, Failed: ${failed}`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

run();
