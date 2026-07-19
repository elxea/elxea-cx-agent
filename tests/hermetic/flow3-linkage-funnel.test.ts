/**
 * ハーメティック L1 — 動線3: 連携ファネル（トーク内入り口の便益+連携ボタン）。
 *
 * 署名付き webhook（連携トリガー）→ Worker dispatch → LINE 送信モックで応答を捕捉 → 中身を assert。
 *   - 未連携 + トリガー: 便益+連携ボタン（Flex）が出る & flow_events(link.invite_shown, surface=trigger)。
 *   - 連携済み + トリガー: 便益+連携ボタンは出ない（Flex なし）& link.invite_shown も出ない。
 *     （連携済み非定期便は丁寧なお断りテキストに着地する）。
 *
 * 昇格元: tests/staging/linkage-funnel-e2e.ts（staging 実走行版）のハーメティック化（ケース A / D）。
 *   連携の「好み引き継ぎ」本体（mergeLineUserIntoShopify）は Firestore 側で、UI 2タップは別リポ
 *   （elxea-web-app）。本 Phase の webhook 観測点は「招待ボタン提示の有無」と link.invite_shown。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { dispatchLineWebhook, settle } from "../lib/webhook";
import { messageEvent, synthLineUserId } from "../lib/synthetic";
import { LINKAGE_TRIGGER } from "../../src/lib/subscriber-linkage";

let h: Hermetic;

beforeEach(() => {
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

describe("hermetic L1 — 動線3: 連携ファネル（便益+連携ボタン）", () => {
  it("未連携 + トリガー → 連携ボタン(Flex) + flow_events(link.invite_shown surface=trigger)", async () => {
    const user = synthLineUserId("f3a"); // customer_linkages に seed しない = 未連携。

    const { status } = await dispatchLineWebhook({
      env,
      channelSecret: String(env.LINE_CHANNEL_SECRET),
      events: [messageEvent(user, LINKAGE_TRIGGER)],
    });
    expect(status).toBe(200);

    // 便益+連携ボタン（Flex）が送られる。
    const flexes = h.line.flexes();
    expect(flexes.length, "連携招待の Flex が送られる").toBeGreaterThanOrEqual(1);
    // Flex の中に LIFF 遷移ボタン（モック LIFF URL）が含まれる。
    const flexJson = JSON.stringify(flexes[0]);
    expect(flexJson).toContain("liff.line.me/e2e-mock-liff");

    // DB 効果: flow_events に link.invite_shown（metadata.surface=trigger）。
    await settle();
    const events = h.supabase.all("flow_events");
    const invite = events.find(
      (e) => e.user_ref === user && e.event_name === "link.invite_shown",
    );
    expect(invite, "link.invite_shown が記録される").toBeTruthy();
    expect((invite?.metadata as { surface?: string } | undefined)?.surface).toBe("trigger");
  });

  it("連携済み + トリガー → 連携ボタンは出ない（Flex なし・invite_shown なし）", async () => {
    const user = synthLineUserId("f3d");
    // 連携済みにする（customer_linkages に seed）。
    h.supabase.seed("customer_linkages", [
      { line_user_id: user, shopify_customer_id: "900800400778" },
    ]);

    await dispatchLineWebhook({
      env,
      channelSecret: String(env.LINE_CHANNEL_SECRET),
      events: [messageEvent(user, LINKAGE_TRIGGER)],
    });

    // 連携済みには便益+ボタン（Flex）を出さない。
    expect(h.line.flexes().length, "連携済みには Flex を出さない").toBe(0);
    // テキスト応答（丁寧なお断り等）には着地する（沈黙にはしない）。
    expect(h.line.texts().length).toBeGreaterThanOrEqual(1);

    // link.invite_shown も記録されない。
    await settle();
    const events = h.supabase.all("flow_events");
    const invite = events.find(
      (e) => e.user_ref === user && e.event_name === "link.invite_shown",
    );
    expect(invite, "連携済みには link.invite_shown を出さない").toBeUndefined();
  });
});
