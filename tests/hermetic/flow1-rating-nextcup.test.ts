/**
 * ハーメティック L1 — 動線1: 感想（rate-good / rate-bad）→ 次の一杯 / DB 効果。
 *
 * 署名付き webhook → Worker インプロセス dispatch → LINE 送信モックで返答本文を捕捉 → 中身を assert。
 *   - rate-good（感想よい）: お礼 + 次の一杯 1 件（同軸・番号最小 = 11401）が提案される。
 *   - rate-bad（感想いまいち）: 静かな受け止め・提案ゼロ（評価対象以外の No が出ない）。
 *   - DB 効果（モック Supabase）: product_ratings に +1 / -1 行が実際に記録される。
 *
 * 昇格元: tests/staging/_demo_flow1_rating_nextcup.ts（staging 実走行版）を、ハーメティックかつ
 *   webhook 経路・返答本文自動判定に置き換えたもの。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { dispatchLineWebhook, settle } from "../lib/webhook";
import { messageEvent, synthLineUserId } from "../lib/synthetic";
import { _resetTeaCache } from "../../src/lib/tea-menu";
import { NEXT_CUP_DECLINE_MESSAGE, NEXT_CUP_GOOD_THANKS } from "../../src/lib/brand-copy";

let h: Hermetic;

beforeEach(() => {
  _resetTeaCache(); // Notion TTL キャッシュを毎テストで初期化（フィクスチャの決定性を担保）。
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

describe("hermetic L1 — 動線1: 感想 → 次の一杯", () => {
  it("rate-good → お礼 + 次の一杯を1件提案（返答本文を assert）", async () => {
    const user = synthLineUserId("f1a");

    const { status } = await dispatchLineWebhook({
      env,
      channelSecret: String(env.LINE_CHANNEL_SECRET),
      events: [messageEvent(user, "感想よい｜11301")],
    });
    expect(status).toBe(200);

    // UX③: rate-good は Flex カードで返る（実送信はモック＝OFF）。
    const flexes = h.line.flexes();
    expect(flexes.length, "rate-good は Flex カードで返る（UX③）").toBeGreaterThan(0);
    // altText（テキスト fallback）に お礼文 + 次の一杯 = 同軸番号最小 11401 が入っている。
    const altText = flexes.map((f) => String(f.altText ?? "")).join("\n---\n");
    expect(altText).toContain(NEXT_CUP_GOOD_THANKS);
    expect(altText).toContain("11401｜");
    // カード構造: bubble で、見出しが `番号｜名前` に統一（① がカード見出しにも効く）。
    const card = flexes[0].contents as Record<string, unknown>;
    expect(card.type, "bubble カード").toBe("bubble");
    expect(JSON.stringify(card), "カード見出しが 番号｜名前(11401)").toContain("11401｜");
    // 画像なし銘柄（フィクスチャに画像なし）→ hero を出さない graceful カード。
    expect(card.hero, "画像なしは hero を省く（graceful）").toBeUndefined();

    // DB 効果（モック Supabase）: product_ratings に rating=1 行が記録される。
    await settle(); // fire-and-forget の void 記録を落ち着かせる。
    const ratings = h.supabase.all("product_ratings");
    const goodRow = ratings.find((r) => r.user_ref === user && r.product_no === "11301");
    expect(goodRow, "product_ratings に評価行が入る").toBeTruthy();
    expect(goodRow?.rating).toBe(1);
  });

  it("rate-bad → 静かな受け止め・提案ゼロ（別銘柄 No を出さない）", async () => {
    const user = synthLineUserId("f1b");

    await dispatchLineWebhook({
      env,
      channelSecret: String(env.LINE_CHANNEL_SECRET),
      events: [messageEvent(user, "感想いまいち｜11301")],
    });

    const reply = h.line.texts().join("\n---\n");
    // 静かな受け止め文が返っている。
    expect(reply).toContain(NEXT_CUP_DECLINE_MESSAGE);
    // 評価対象 11301 以外の 5 桁 No（別銘柄提案）は出さない。
    const otherNos = reply.replace(/No\.11301/g, "").match(/No\.\d{5}/g);
    expect(otherNos, "別銘柄提案は出さない").toBeNull();

    // DB 効果: product_ratings に rating=-1 行が記録される。
    await settle(); // fire-and-forget の void 記録を落ち着かせる。
    const ratings = h.supabase.all("product_ratings");
    const badRow = ratings.find((r) => r.user_ref === user && r.product_no === "11301");
    expect(badRow?.rating).toBe(-1);
  });
});
