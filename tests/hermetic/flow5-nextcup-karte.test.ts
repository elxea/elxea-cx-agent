/**
 * ハーメティック L1 — 動線5: 「次の一杯」がカルテ（persona / tasteProfile）を読む（監査 punch-list #2）。
 *
 * 監査 #2 の是正をロードベアリングにガードする:
 *   従来 selectNextCup は「直近 +1 した銘柄の 2 軸」だけで選び、診断ペルソナ・会話/購入由来の好みを
 *   無視していた（会話側 AI はカルテを読むのに次の提案は読まない非対称）。本フローは:
 *     - handleTeaMenuFlow が rate-good 時にカルテを読み、selectNextCup へ渡すことを検証する。
 *     - 青茶を好むカルテ（tasteProfile.preferredCategories=["oolong"]）を注入すると、同軸プール
 *       {11401,11501(緑茶), 40101(青茶)} の次の一杯が baseline の 11401 → 40101 に変わる。
 *     - カルテ無し（本番既定ローダは Firebase 未設定で fail-safe 空）なら従来どおり 11401。
 *   さらに selectNextCup 単体で、persona（sensory→フルボディ寄り）が同カテゴリ内の並びを変えることも示す。
 *
 * カルテ注入は handleTeaMenuFlow の deps シーム（loadKarte）で行う（Firestore 非接触・実ネットワーク不使用）。
 * teas はモック Notion（tests/lib/tea-fixtures.ts TEA_FIXTURE）由来。実送信ゼロ・グローバルガード下。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { synthLineUserId } from "../lib/synthetic";
import { AROMA_DRY, AROMA_RICH, BODY_FULL, BODY_LIGHT } from "../lib/tea-fixtures";
import { _resetTeaCache, handleTeaMenuFlow } from "../../src/lib/tea-menu";
import type { TeaItem } from "../../src/lib/tea-menu";
import { selectNextCup, type NextCupKarte } from "../../src/lib/next-cup";
import type { LineResponder, QuickReplyItem } from "../../src/lib/line";
import { NEXT_CUP_GOOD_THANKS } from "../../src/lib/brand-copy";

let h: Hermetic;

beforeEach(() => {
  _resetTeaCache(); // Notion TTL キャッシュを毎テストで初期化（フィクスチャの決定性を担保）。
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

/**
 * 送信を捕捉する Responder（Firestore/LINE に触れず handleTeaMenuFlow を直接駆動する）。
 * UX③: rate-good は Flex カードで返るため flex も捕捉する。reply() は本文（テキスト + Flex の altText）を返す。
 */
type FlexCall = {
  altText: string;
  contents: Record<string, unknown>;
  quickReplies?: QuickReplyItem[];
};
function captureResponder(): {
  responder: LineResponder;
  reply: () => string;
  flexCalls: () => FlexCall[];
} {
  const texts: string[] = [];
  const flexes: FlexCall[] = [];
  const responder: LineResponder = {
    async text(t: string, _qr?: QuickReplyItem[]): Promise<void> {
      texts.push(t);
    },
    async flex(
      altText: string,
      contents: Record<string, unknown>,
      quickReplies?: QuickReplyItem[],
    ): Promise<void> {
      flexes.push({ altText, contents, quickReplies });
    },
  };
  return {
    responder,
    // 返答本文の総体（テキスト本文 + Flex の altText fallback）。No.XXXXX は altText に入る。
    reply: () => [...texts, ...flexes.map((f) => f.altText)].join("\n---\n"),
    flexCalls: () => flexes,
  };
}

/** 画像なしローダ（既定・Notion 非接触で画像なし graceful を検証する）。 */
const noImages = async (): Promise<Map<string, string>> => new Map<string, string>();

/** テスト用 TeaItem 生成（全フィールド充足）。 */
function mk(number: string, category: string, flavorProfiles: string[]): TeaItem {
  return {
    number,
    name: `お茶${number}`,
    category,
    flavorProfiles,
    descShort: "",
    howToBrew: "",
    temp: "",
    time: "",
    water: "",
    enjoy: "",
    story: "",
  };
}

describe("hermetic L1 — 動線5: 次の一杯がカルテを読む（監査 #2）", () => {
  it("カルテ(青茶を好む)を注入 → 次の一杯が baseline(11401) から 40101(青茶) に変わる", async () => {
    const user = synthLineUserId("f5k");
    const cap = captureResponder();
    const karte: NextCupKarte = {
      persona: null,
      tasteProfile: { preferredCategories: ["oolong"], flavorPreferences: [], scenePref: null },
    };

    const handled = await handleTeaMenuFlow(user, `感想よい${"｜"}11301`, env, cap.responder, {
      loadKarte: async () => karte,
      loadProductImages: noImages,
    });
    expect(handled).toBe(true);

    // UX③: rate-good は Flex カードで返る（text ではなく flex が呼ばれる）。
    expect(cap.flexCalls().length, "Flex カードで返る（UX③）").toBeGreaterThan(0);
    const reply = cap.reply();
    expect(reply).toContain(NEXT_CUP_GOOD_THANKS); // お礼は従来どおり（altText fallback）
    expect(reply).toContain("40101｜"); // カルテ（青茶）を反映した次の一杯
    expect(reply).not.toContain("11401｜"); // baseline の同軸最小は選ばれない
    // カード見出しも 番号｜名前 に統一（① がカードに効く）。
    expect(JSON.stringify(cap.flexCalls()[0].contents)).toContain("40101｜");
  });

  it("画像あり(正規化 r2.dev をモック注入) → カードの hero.url に直 r2.dev（UX③ 写真つき）", async () => {
    const user = synthLineUserId("f5img");
    const cap = captureResponder();
    const karte: NextCupKarte = {
      persona: null,
      tasteProfile: { preferredCategories: ["oolong"], flavorPreferences: [], scenePref: null },
    };
    const R2 = "https://pub-90a0485599904fee8228ef56bb51c2e6.r2.dev/cdn/40101.jpg";
    // 画像マップは 5 桁番号キー（ハーメティックの合成 TeaItem は page id を持たないため番号で join）。
    const handled = await handleTeaMenuFlow(user, `感想よい${"｜"}11301`, env, cap.responder, {
      loadKarte: async () => karte,
      loadProductImages: async () => new Map([["40101", R2]]),
    });
    expect(handled).toBe(true);

    const calls = cap.flexCalls();
    expect(calls.length, "Flex カードで返る").toBeGreaterThan(0);
    const hero = (calls[0].contents as { hero?: { url?: string } }).hero;
    expect(hero?.url, "hero に正規化済み直 r2.dev URL が載る（送信はモック=OFF）").toBe(R2);
  });

  it("カルテ空 → 従来どおり同軸最小 11401（青茶カルテとの A/B 対照）", async () => {
    const user = synthLineUserId("f5e");
    const cap = captureResponder();

    await handleTeaMenuFlow(user, `感想よい${"｜"}11301`, env, cap.responder, {
      loadKarte: async () => ({ persona: null, tasteProfile: null }),
      loadProductImages: noImages,
    });

    const reply = cap.reply();
    expect(reply).toContain("11401｜"); // baseline
    expect(reply).not.toContain("40101｜"); // カルテ無しでは青茶に寄らない
  });

  it("deps 未指定(本番既定ローダ) → Firebase 未設定で fail-safe、baseline 11401 に着地", async () => {
    const user = synthLineUserId("f5d");
    const cap = captureResponder();

    // deps を渡さない = 本番と同じ経路（loadCustomerKarte + fetchProductImages）。ハーメティック env は
    // Firebase 未設定なので getFirestoreEnv が throw → 空カルテ → 従来挙動。画像は Notion モックが空 Map を返す
    // （＝画像なし graceful）。カルテ/画像配線が本番でも fail-safe なことを示す。
    await handleTeaMenuFlow(user, `感想よい${"｜"}11301`, env, cap.responder);

    const reply = cap.reply();
    expect(reply).toContain("11401｜");
  });

  it("selectNextCup 単体: persona=sensory が同カテゴリ内でフルボディ寄りに並べ替える", () => {
    // rated=緑茶 dry+full → 同軸(dry+full)プールは空 → 同カテゴリ(緑茶)へ。
    const rated = mk("30001", "緑茶", [AROMA_DRY, BODY_FULL]);
    const teas = [
      rated,
      mk("30002", "緑茶", [AROMA_RICH, BODY_LIGHT]), // 番号最小・ライトボディ
      mk("30003", "緑茶", [AROMA_RICH, BODY_FULL]), // 番号大・フルボディ
    ];

    // カルテ無し = 番号昇順 → 30002（ライト）。
    expect(selectNextCup(rated, teas, [], null)?.number).toBe("30002");

    // sensory は body=full 寄り（診断 Q2-3 由来）→ 30003（フル）を上位に。
    const sensory: NextCupKarte = { persona: "sensory", tasteProfile: null };
    expect(selectNextCup(rated, teas, [], sensory)?.number).toBe("30003");
  });
});
