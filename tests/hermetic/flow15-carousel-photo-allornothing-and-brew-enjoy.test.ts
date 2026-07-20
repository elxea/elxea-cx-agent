/**
 * ハーメティック L1 — UX②（カルーセル写真の all-or-nothing）+ UX③（淹れ方 + 楽しみ方 併記）。
 *
 * いずれも純粋関数レベルで機械検証する（ネットワーク不使用・決定的）:
 *   UX②: レコメンドカルーセルは「全カードに実写真がある時だけ hero を出す」。1 枚でも欠ければ
 *        全カードを hero 抜き（テキスト調）に揃える。placeholder（穴埋め画像）は一切挿さない。
 *        - break-proof: 混在セット（1 枚だけ写真なし）で旧挙動なら写真ありカードに hero が残る。
 *          新挙動では hero 総数 0 でなければ失敗する。
 *   UX③: 🌡淹れ方の回答に、淹れ方（How to Brew）に加えて「楽しみ方」（既存 30/30 充足列）を併記する。
 *        - break-proof: 淹れ方だけを返していた旧挙動なら楽しみ方本文を含まず失敗する。
 */

import { describe, expect, it } from "vitest";
import {
  teaRecommendCarousel,
  hasRealPhoto,
} from "../../src/lib/flex-templates";
import { diagnosisRecommendCarousel } from "../../src/lib/preference-diagnosis";
import { buildBrewAnswer } from "../../src/lib/tea-menu";
import type { TeaItem } from "../../src/lib/tea-menu";

/** 最小 TeaItem を組む（テスト用・列は必要分だけ埋める）。 */
function teaOf(over: Partial<TeaItem> & { number: string }): TeaItem {
  return {
    id: over.id ?? `page-${over.number}`,
    number: over.number,
    name: over.name ?? `茶${over.number}`,
    category: over.category ?? "緑茶",
    flavorProfiles: over.flavorProfiles ?? [],
    descShort: over.descShort ?? "やわらかな旨味。",
    howToBrew: over.howToBrew ?? "",
    temp: over.temp ?? "",
    time: over.time ?? "",
    water: over.water ?? "",
    enjoy: over.enjoy ?? "",
    story: over.story ?? "",
  };
}

const PHOTO_A = "https://pub-xxxx.r2.dev/cdn/a.jpg";
const PHOTO_B = "https://pub-xxxx.r2.dev/cdn/b.jpg";
const PHOTO_C = "https://pub-xxxx.r2.dev/cdn/c.jpg";

type Bubble = { hero?: { type?: string; url?: string } };

/** カルーセル bubbles を取り出す。 */
function bubblesOf(carousel: Record<string, unknown>): Bubble[] {
  return (carousel.contents as Bubble[]) ?? [];
}

/** hero を持つ bubble 数。 */
function heroCount(carousel: Record<string, unknown>): number {
  return bubblesOf(carousel).filter((b) => b.hero != null).length;
}

describe("UX② カルーセル写真 all-or-nothing", () => {
  it("hasRealPhoto: https のみ真（null / 空 / 非 https は偽）", () => {
    expect(hasRealPhoto(PHOTO_A)).toBe(true);
    expect(hasRealPhoto("  https://x/y.jpg")).toBe(true);
    expect(hasRealPhoto(undefined)).toBe(false);
    expect(hasRealPhoto(null)).toBe(false);
    expect(hasRealPhoto("")).toBe(false);
    expect(hasRealPhoto("http://x/y.jpg")).toBe(false);
  });

  it("全カードに実写真 → 全 bubble に hero が出る", () => {
    const carousel = teaRecommendCarousel([
      { name: "a", description: "d", imageUrl: PHOTO_A, productUrl: "u" },
      { name: "b", description: "d", imageUrl: PHOTO_B, productUrl: "u" },
      { name: "c", description: "d", imageUrl: PHOTO_C, productUrl: "u" },
    ]);
    const bubbles = bubblesOf(carousel);
    expect(bubbles.length).toBe(3);
    expect(heroCount(carousel)).toBe(3);
    // hero は実写真 URL そのもの（placeholder ではない）。
    for (const b of bubbles) {
      expect(b.hero?.type).toBe("image");
      expect([PHOTO_A, PHOTO_B, PHOTO_C]).toContain(b.hero?.url);
    }
  });

  it("break-proof: 1 枚でも実写真が欠ける → 全カード hero なし・placeholder も出ない", () => {
    const carousel = teaRecommendCarousel([
      { name: "a", description: "d", imageUrl: PHOTO_A, productUrl: "u" },
      { name: "b", description: "d", imageUrl: undefined, productUrl: "u" }, // 写真なし
      { name: "c", description: "d", imageUrl: PHOTO_C, productUrl: "u" },
    ]);
    // 旧挙動なら a と c に hero が残る（heroCount>0）→ このアサーションで失敗する。
    expect(heroCount(carousel)).toBe(0);
    // placeholder 画像を差し込んでいない（hero キー自体が存在しない）。
    for (const b of bubblesOf(carousel)) {
      expect(b.hero).toBeUndefined();
    }
  });

  it("diagnosisRecommendCarousel も all-or-nothing に従う（写真マップ経由）", () => {
    const picks = [teaOf({ number: "11301" }), teaOf({ number: "11401" }), teaOf({ number: "11501" })];

    // 全銘柄に写真 → 全 hero。
    const full = new Map<string, string>([
      ["11301", PHOTO_A],
      ["11401", PHOTO_B],
      ["11501", PHOTO_C],
    ]);
    expect(heroCount(diagnosisRecommendCarousel(picks, full))).toBe(3);

    // 1 銘柄だけ欠ける → 全 hero なし（混在させない）。
    const mixed = new Map<string, string>([
      ["11301", PHOTO_A],
      ["11501", PHOTO_C],
    ]);
    expect(heroCount(diagnosisRecommendCarousel(picks, mixed))).toBe(0);

    // 全銘柄 写真なし（現況の主経路）→ hero なし。
    expect(heroCount(diagnosisRecommendCarousel(picks, new Map()))).toBe(0);
  });
});

describe("UX③ 淹れ方 + 楽しみ方 併記", () => {
  const BREW = "70℃のお湯で90秒、ゆっくりと。";
  const ENJOY = "冷茶にしても、和菓子と合わせても。レモンをひとしずくも。";

  it("break-proof: 淹れ方と楽しみ方の両方が本文に含まれる", () => {
    const tea = teaOf({ number: "11301", howToBrew: BREW, enjoy: ENJOY });
    const out = buildBrewAnswer(tea);
    // 旧挙動なら楽しみ方本文を含まない → このアサーションで失敗する。
    expect(out.text).toContain(BREW);
    expect(out.text).toContain(ENJOY);
    // 楽しみ方であることが分かる見出しが付く。
    expect(out.text).toContain("楽しみ方");
  });

  it("楽しみ方が空なら淹れ方だけ（従来挙動を壊さない）", () => {
    const tea = teaOf({ number: "11401", howToBrew: BREW, enjoy: "" });
    const out = buildBrewAnswer(tea);
    expect(out.text).toContain(BREW);
    expect(out.text).not.toContain("楽しみ方");
  });

  it("既存の次の1手（quickReplies）は維持する", () => {
    const tea = teaOf({
      number: "11301",
      howToBrew: BREW,
      enjoy: ENJOY,
      descShort: "コクのある旨味。",
    });
    const out = buildBrewAnswer(tea);
    // お茶の一覧導線は常に残る（nextStepQuickReplies の末尾）。
    expect(out.quickReplies.some((q) => q.action.text.includes("お茶を選ぶ"))).toBe(true);
  });
});
