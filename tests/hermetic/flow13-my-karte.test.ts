/**
 * ハーメティック L1 — 動線13: マイカルテ（UX②）。
 *
 * オーナー承認済みデザイン ② をロードベアリングにガードする:
 *   - 「マイカルテ」→ 3 枚の Flex カルーセル（あなた / これまで / だから）が **人間の言葉** で返る。
 *   - 3 枚目「だから」に **なぜ** この一杯かの理由文が入る。
 *   - **生スコアは一切漏れない**（"sensory: 6" / persona slug / affinity / コロン+数字 を可視テキストから regex 排除）。
 *   - **未連携 LINE のみのユーザーでも完全動作**（購入セクションは省かれるだけ）。
 *   - **空カルテ → 診断 CTA**（行き止まりにしない）。
 *   - **read-only**: 既定パス（注入なし）で seed 済みの行数が一切増えない（write-count = 0）。
 *
 * カルテは handleMyKarteFlow の deps シーム（loadKarte）で注入する（Firestore 非接触）。既定パスの
 * 1 ケースだけは注入せず、seed した Supabase を実際に読ませて「読むだけで書かない」ことを示す。
 * 実送信ゼロ・グローバルガード下（tests/lib/hermetic）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { synthLineUserId } from "../lib/synthetic";
import { _resetTeaCache } from "../../src/lib/tea-menu";
import { handleMyKarteFlow, MY_KARTE_TRIGGER } from "../../src/lib/my-karte";
import type { KarteDisplay } from "../../src/lib/customer-karte";
import { DIAGNOSIS_TRIGGER } from "../../src/lib/preference-diagnosis";
import type { LineResponder, QuickReplyItem } from "../../src/lib/line";

let h: Hermetic;

beforeEach(() => {
  _resetTeaCache();
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

/** text / flex（+ quickReply）を捕捉する Responder（LINE 非接触で handleMyKarteFlow を直接駆動する）。 */
type FlexCall = { altText: string; contents: Record<string, unknown>; quickReplies?: QuickReplyItem[] };
type TextCall = { text: string; quickReplies?: QuickReplyItem[] };
function captureResponder(): {
  responder: LineResponder;
  texts: () => TextCall[];
  flexCalls: () => FlexCall[];
} {
  const texts: TextCall[] = [];
  const flexes: FlexCall[] = [];
  const responder: LineResponder = {
    async text(text: string, quickReplies?: QuickReplyItem[]): Promise<void> {
      texts.push({ text, quickReplies });
    },
    async flex(altText, contents, quickReplies): Promise<void> {
      flexes.push({ altText, contents, quickReplies });
    },
  };
  return { responder, texts: () => texts, flexCalls: () => flexes };
}

/** Flex 構造から **ユーザーに見える文字列だけ** を集める（type:"text" の text + button label + altText）。 */
function collectVisibleText(node: unknown, acc: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectVisibleText(n, acc);
    return;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.type === "text" && typeof o.text === "string") acc.push(o.text);
    if (o.type === "button" && o.action && typeof o.action === "object") {
      const a = o.action as Record<string, unknown>;
      if (typeof a.label === "string") acc.push(a.label);
    }
    for (const v of Object.values(o)) collectVisibleText(v, acc);
  }
}

function visibleTextOf(view: { altText: string; contents: Record<string, unknown>; quickReplies?: QuickReplyItem[] }): string {
  const acc: string[] = [view.altText];
  collectVisibleText(view.contents, acc);
  for (const q of view.quickReplies ?? []) {
    const a = (q as { action?: { label?: string } }).action;
    if (a?.label) acc.push(a.label);
  }
  return acc.join("\n");
}

/**
 * 生スコア漏洩ガード（可視テキストに対して評価する）。
 *   - persona slug（sensory/serenity/explorer）・scores・affinity を禁止。
 *   - コロン+数字（"sensory: 6" 等の生スコア表記）を禁止。
 * `名前（No.11301）` の数字は「No.」直後で ':' を伴わないため許容される（設計どおり）。
 */
const SCORE_LEAK_RE = /\bscores?\b|\b(sensory|serenity|explorer)\b|affinity|[:：]\s*\d/i;

const LINE_ONLY_KARTE: KarteDisplay = {
  linked: false,
  persona: "sensory",
  tasteProfile: { preferredCategories: ["oolong"], flavorPreferences: ["rich"], scenePref: "夜のひととき" },
  entrySource: "marche",
  ratedGoodLabels: ["煎茶 やまなみ（No.11301）"],
  diagnosisDone: true,
  recentOrders: [],
  lastNextCupLabel: "和烏龍茶 香駿（No.40101）",
};

describe("hermetic L1 — 動線13: マイカルテ（UX②）", () => {
  it("未連携 + カルテあり → 3 枚カルーセル（あなた/これまで/だから）・人間語・なぜ理由・生スコア非漏洩・write=0", async () => {
    const user = synthLineUserId("f13");
    const cap = captureResponder();

    const handled = await handleMyKarteFlow(user, MY_KARTE_TRIGGER, env, cap.responder, {
      loadKarte: async () => LINE_ONLY_KARTE,
    });
    expect(handled).toBe(true);

    // テキストではなく Flex カルーセルで返る。
    expect(cap.texts().length, "空でないカルテはテキストCTAを出さない").toBe(0);
    const flexes = cap.flexCalls();
    expect(flexes.length, "Flex で 1 回返る").toBe(1);

    const carousel = flexes[0].contents as { type?: string; contents?: unknown[] };
    expect(carousel.type).toBe("carousel");
    expect(carousel.contents?.length, "3 枚カード").toBe(3);

    const visible = visibleTextOf(flexes[0]);
    // 1 枚目「あなた」= persona 受け止め（人間語）＋ 好み。
    expect(visible).toContain("あなたのこと");
    expect(visible).toContain("味わいを深く愉しむ人"); // sensory の人間語（生 slug ではない）
    expect(visible).toContain("青茶"); // preferredCategories=oolong → 人間語ラベル
    // 2 枚目「これまで」= ①の 名前（No.）表記の評価済みお茶 + 診断状況。
    expect(visible).toContain("これまで");
    expect(visible).toContain("（No.11301）");
    // 3 枚目「だから」= なぜ薦めるかの理由文。
    expect(visible).toContain("だから、次の一杯");
    expect(visible).toContain("（No.40101）"); // 直近の次の一杯を根拠に
    expect(visible, "なぜ（理由）を語る").toMatch(/ふまえ|合わせて|寄り添って/);

    // 生スコア非漏洩（可視テキスト）。
    expect(SCORE_LEAK_RE.test(visible), `生スコアが漏れている: ${visible}`).toBe(false);

    // 好みを更新する CTA（診断へ）が quickReply か footer に必ずある。
    expect(visible).toContain("好みを更新する");

    // read-only: 注入ローダは I/O しない → Supabase へ 1 行も書かれない。
    const written = Object.values(h.supabase.store).reduce((n, rows) => n + rows.length, 0);
    expect(written, "write-count = 0（read-only）").toBe(0);
  });

  it("空カルテ → 診断 CTA（テキスト + quickReply=DIAGNOSIS_TRIGGER）・カードは出さない", async () => {
    const user = synthLineUserId("f13e");
    const cap = captureResponder();

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
    const handled = await handleMyKarteFlow(user, MY_KARTE_TRIGGER, env, cap.responder, {
      loadKarte: async () => empty,
    });
    expect(handled).toBe(true);

    expect(cap.flexCalls().length, "空カルテは壊れた/空カードを出さない").toBe(0);
    const t = cap.texts();
    expect(t.length).toBe(1);
    expect(t[0].text).toMatch(/診断/);
    const qrTexts = (t[0].quickReplies ?? []).map((q) => (q as { action?: { text?: string } }).action?.text);
    expect(qrTexts, "診断トリガーへ誘導").toContain(DIAGNOSIS_TRIGGER);
  });

  it("既定パス（注入なし）: seed した評価/イベントを読むだけ → カード生成・行数不変（read-only）", async () => {
    const user = synthLineUserId("f13ro");
    // 実 read を発火させる seed（+1 評価と直近の次の一杯）。
    h.supabase.seed("product_ratings", [{ user_ref: user, product_no: "11301", rating: 1 }]);
    h.supabase.seed("flow_events", [
      { user_ref: user, event_name: "next_cup_shown", product_no: "20101", value: "karte" },
    ]);
    const before = Object.values(h.supabase.store).reduce((n, rows) => n + rows.length, 0);

    const cap = captureResponder();
    const handled = await handleMyKarteFlow(user, MY_KARTE_TRIGGER, env, cap.responder);
    expect(handled).toBe(true);

    const flexes = cap.flexCalls();
    expect(flexes.length, "評価があるのでカードが返る").toBe(1);
    const visible = visibleTextOf(flexes[0]);
    expect(visible).toContain("（No.11301）"); // seed した +1 評価が銘柄名に解決される
    expect(SCORE_LEAK_RE.test(visible), `生スコアが漏れている: ${visible}`).toBe(false);

    // read-only: 既定パスでも書き込みゼロ（seed した行数から増えない）。
    const after = Object.values(h.supabase.store).reduce((n, rows) => n + rows.length, 0);
    expect(after, "write-count = 0（既定パスも read-only）").toBe(before);
  });

  it("非トリガー発話 → 素通り（false・AI 会話を壊さない）", async () => {
    const user = synthLineUserId("f13p");
    const cap = captureResponder();
    const handled = await handleMyKarteFlow(user, "おすすめのお茶を教えて", env, cap.responder, {
      loadKarte: async () => LINE_ONLY_KARTE,
    });
    expect(handled).toBe(false);
    expect(cap.flexCalls().length + cap.texts().length, "何も応答しない").toBe(0);
  });
});
