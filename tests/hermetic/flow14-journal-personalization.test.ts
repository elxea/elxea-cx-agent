/**
 * ハーメティック L1 — 動線14: 読みものの出し分け（UX④）。
 *
 * オーナー承認済みデザイン ④ をロードベアリングにガードする:
 *   - 「読みもの」→ persona（穏やか/探求/感覚）に合う記事が **③ 共有の Flex カルーセル** で返る。
 *   - **別 persona → 別記事**（A/B 排他）: persona=serenity は serenity 記事が先頭、
 *     persona=sensory は sensory 記事が先頭。**別 persona 記事は先頭を奪わない**（break-proof）。
 *   - **カルテ無し → 最新順フォールバック**（行き止まりにしない）。
 *   - **本文は一切出さない**（title/excerpt/thumbnail/url のみ）。
 *   - **ダミー**: URL/サムネ空 → プレースホルダで動作（カードは崩れない）。
 *   - **最大 3 枚**。
 *   - **Draft は staging/test の表示経路に含まれる**（プールが空にならない）。
 *   - **read-only**: Firestore/Notion 非接触（deps 注入）。実送信ゼロ（グローバルガード下）。
 *
 * カルテ・記事は handleJournalFlow の deps シーム（loadKarte / loadArticles）で注入する。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { synthLineUserId } from "../lib/synthetic";
import {
  handleJournalFlow,
  mapArticlePage,
  READING_TRIGGER,
  DUMMY_ARTICLE_THUMB,
  DUMMY_ARTICLE_URL_BASE,
  type ArticleItem,
  type JournalKarte,
} from "../../src/lib/journal";
import type { LineResponder, QuickReplyItem } from "../../src/lib/line";

let h: Hermetic;

beforeEach(() => {
  h = installHermeticFetch(env);
});
afterEach(() => {
  h.restore();
});

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
    async text(text, quickReplies): Promise<void> {
      texts.push({ text, quickReplies });
    },
    async flex(altText, contents, quickReplies): Promise<void> {
      flexes.push({ altText, contents, quickReplies });
    },
  };
  return { responder, texts: () => texts, flexCalls: () => flexes };
}

/** Flex ノードから全 button uri / image url / text を集める（順序保持）。 */
function collectByType(node: unknown, type: string, key: string, acc: string[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectByType(n, type, key, acc);
    return;
  }
  if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.type === type && typeof o[key] === "string") acc.push(o[key] as string);
    for (const v of Object.values(o)) collectByType(v, type, key, acc);
  }
}
/** 記事タイトル（bubble body の先頭 text・weight:bold）を出現順に集める。 */
function cardTitlesInOrder(contents: Record<string, unknown>): string[] {
  const carousel = contents as { type?: string; contents?: Array<Record<string, unknown>> };
  const bubbles = carousel.type === "carousel" ? (carousel.contents ?? []) : [contents];
  const titles: string[] = [];
  for (const b of bubbles) {
    const body = (b as { body?: { contents?: Array<Record<string, unknown>> } }).body;
    const first = body?.contents?.find((c) => c.type === "text");
    if (first && typeof first.text === "string") titles.push(first.text);
  }
  return titles;
}

/** 記事フィクスチャ（distinct な content_persona）。 */
function art(over: Partial<ArticleItem>): ArticleItem {
  return {
    id: over.id ?? "id",
    title: over.title ?? "記事",
    url: over.url ?? DUMMY_ARTICLE_URL_BASE + "/" + (over.id ?? "id"),
    excerpt: over.excerpt ?? "抜粋",
    thumbnailUrl: over.thumbnailUrl ?? DUMMY_ARTICLE_THUMB,
    persona: over.persona ?? null,
    targetLayer: over.targetLayer ?? null,
    tags: over.tags ?? [],
    publishedAt: over.publishedAt ?? null,
  };
}

const ARTICLE_BODY = "これは記事の本文全文でありカードに載ってはならない内容";

const POOL: ArticleItem[] = [
  art({ id: "s", persona: "serenity", title: "静けさと一杯", publishedAt: "2026-01-01" }),
  art({ id: "e", persona: "explorer", title: "産地をめぐる", publishedAt: "2026-01-02" }),
  // sensory は最も新しい → persona 一致が効かなければ常に先頭に来てしまう（break-proof の相手役）。
  art({ id: "n", persona: "sensory", title: "余韻を味わう", publishedAt: "2026-01-03" }),
];

describe("hermetic L1 — 動線14: 読みものの出し分け（UX④）", () => {
  it("persona=serenity → serenity 記事が先頭・Flex カルーセル・本文非露出・ダミー URL/サムネ", async () => {
    const user = synthLineUserId("f14s");
    const cap = captureResponder();

    const handled = await handleJournalFlow(user, READING_TRIGGER, env, cap.responder, {
      loadKarte: async (): Promise<JournalKarte> => ({ persona: "serenity" }),
      loadArticles: async () => POOL,
    });
    expect(handled).toBe(true);
    expect(cap.texts().length, "記事があるのでテキストにならない").toBe(0);

    const flexes = cap.flexCalls();
    expect(flexes.length, "Flex で 1 回返る").toBe(1);

    const titles = cardTitlesInOrder(flexes[0].contents);
    expect(titles[0], "serenity ユーザーには serenity 記事が先頭").toBe("静けさと一杯");
    expect(titles[0], "別 persona（sensory）記事は先頭を奪わない").not.toBe("余韻を味わう");

    // 本文は一切含まれない。
    const s = JSON.stringify(flexes[0]);
    expect(s.includes(ARTICLE_BODY), "本文がカードに漏れてはいけない").toBe(false);

    // ダミー URL / サムネがカードに載る（空データでもカードが成立）。
    const uris: string[] = [];
    collectByType(flexes[0].contents, "image", "url", uris);
    expect(uris.some((u) => u === DUMMY_ARTICLE_THUMB), "ダミーサムネが hero に載る").toBe(true);

    const buttonUris: string[] = [];
    collectByType(flexes[0].contents, "uri", "uri", buttonUris);
    expect(buttonUris.some((u) => u.startsWith(DUMMY_ARTICLE_URL_BASE)), "ダミー記事 URL が「読む」に載る").toBe(true);
  });

  it("persona=sensory → sensory 記事が先頭（別 persona → 別記事・A/B 排他）", async () => {
    const user = synthLineUserId("f14n");
    const cap = captureResponder();
    await handleJournalFlow(user, READING_TRIGGER, env, cap.responder, {
      loadKarte: async (): Promise<JournalKarte> => ({ persona: "sensory" }),
      loadArticles: async () => POOL,
    });
    const titles = cardTitlesInOrder(cap.flexCalls()[0].contents);
    expect(titles[0], "sensory ユーザーには sensory 記事が先頭").toBe("余韻を味わう");
    expect(titles[0], "serenity 記事ではない").not.toBe("静けさと一杯");
  });

  it("カルテ無し（persona=null）→ 最新順フォールバック（最新の sensory 記事が先頭）", async () => {
    const user = synthLineUserId("f14x");
    const cap = captureResponder();
    await handleJournalFlow(user, READING_TRIGGER, env, cap.responder, {
      loadKarte: async (): Promise<JournalKarte> => ({ persona: null }),
      loadArticles: async () => POOL,
    });
    const titles = cardTitlesInOrder(cap.flexCalls()[0].contents);
    expect(titles[0], "no-karte は最新順（2026-01-03）").toBe("余韻を味わう");
  });

  it("最大 3 枚に切る", async () => {
    const many: ArticleItem[] = Array.from({ length: 6 }, (_, i) =>
      art({ id: `m${i}`, title: `記事${i}`, publishedAt: `2026-02-0${i + 1}` }),
    );
    const cap = captureResponder();
    await handleJournalFlow(synthLineUserId("f14c"), READING_TRIGGER, env, cap.responder, {
      loadKarte: async (): Promise<JournalKarte> => ({ persona: null }),
      loadArticles: async () => many,
    });
    const carousel = cap.flexCalls()[0].contents as { contents?: unknown[] };
    expect(carousel.contents?.length, "最大 3 枚").toBe(3);
  });

  it("Draft は staging/test の表示経路に含まれる（mapArticlePage includeDrafts=true）", () => {
    const draftPage = {
      id: "d1",
      properties: {
        Channel: { type: "select", select: { name: "Roji" } },
        Title: { type: "title", title: [{ plain_text: "下書き記事" }] },
        Status: { type: "select", select: { name: "Draft" } },
      },
    };
    // staging（includeDrafts=true）は残す / 本番（false）は捨てる。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mapArticlePage(draftPage as any, { includeDrafts: true }), "staging は Draft を表示").not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mapArticlePage(draftPage as any, { includeDrafts: false }), "本番は Draft を除外").toBeNull();
  });

  it("記事 0 件 → テキストで graceful（行き止まりにしない）・Flex は出さない", async () => {
    const cap = captureResponder();
    const handled = await handleJournalFlow(synthLineUserId("f14e"), READING_TRIGGER, env, cap.responder, {
      loadKarte: async (): Promise<JournalKarte> => ({ persona: "serenity" }),
      loadArticles: async () => [],
    });
    expect(handled).toBe(true);
    expect(cap.flexCalls().length, "0 件は空/壊れたカードを出さない").toBe(0);
    expect(cap.texts().length).toBe(1);
  });

  it("非トリガー発話 → 素通り（false・AI 会話を壊さない）", async () => {
    const cap = captureResponder();
    const handled = await handleJournalFlow(synthLineUserId("f14p"), "おすすめのお茶は？", env, cap.responder, {
      loadKarte: async (): Promise<JournalKarte> => ({ persona: "serenity" }),
      loadArticles: async () => POOL,
    });
    expect(handled).toBe(false);
    expect(cap.flexCalls().length + cap.texts().length, "何も応答しない").toBe(0);
  });
});
