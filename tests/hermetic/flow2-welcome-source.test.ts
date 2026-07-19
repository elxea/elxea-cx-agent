/**
 * ハーメティック L1 — 動線2: 入口質問（welcome source）→ 流入元の記録と分岐応答。
 *
 * 署名付き webhook（回答テキスト）→ Worker dispatch → LINE 送信モックで分岐応答を捕捉 → 中身を assert。
 *   - マルシェ回答: buildSourceResponse("marche") の分岐文（袋の5桁番号案内）が返る。
 *   - オンライン回答: buildSourceResponse("online") の分岐文（何から始めるか）が返る。
 *   - DB 効果（モック Supabase）: flow_events に welcome.source（value=marche/online）が記録される。
 *
 * 昇格元: tests/staging/_demo_flow2_welcome_source.ts（staging 実走行版）のハーメティック化。
 *   Firestore 記録は fire-and-forget（.catch 済み）なので、未設定でも会話は止まらず分岐応答は成立する。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { dispatchLineWebhook, settle } from "../lib/webhook";
import { messageEvent, synthLineUserId } from "../lib/synthetic";
import {
  WELCOME_SOURCE_MARCHE_TEXT,
  WELCOME_SOURCE_ONLINE_TEXT,
  ONBOARDING_EXPLORE_TEXT,
  buildSourceResponse,
} from "../../src/lib/welcome-onboarding";
import { DIAGNOSIS_TRIGGER } from "../../src/lib/preference-diagnosis";

let h: Hermetic;

beforeEach(() => {
  h = installHermeticFetch(env);
});

afterEach(() => {
  h.restore();
});

describe("hermetic L1 — 動線2: 入口質問（welcome source）", () => {
  it("マルシェ回答 → 分岐応答（袋の5桁案内）+ flow_events(welcome.source=marche)", async () => {
    const user = synthLineUserId("f2a");

    const { status } = await dispatchLineWebhook({
      env,
      channelSecret: String(env.LINE_CHANNEL_SECRET),
      events: [messageEvent(user, WELCOME_SOURCE_MARCHE_TEXT)],
    });
    expect(status).toBe(200);

    // 分岐応答（本番ビルダーと逐語一致）。
    const reply = h.line.texts().join("\n---\n");
    expect(reply).toContain(buildSourceResponse("marche").text);

    // DB 効果: flow_events に welcome.source（value=marche）が記録される。
    await settle();
    const events = h.supabase.all("flow_events");
    const row = events.find(
      (e) => e.user_ref === user && e.event_name === "welcome.source",
    );
    expect(row, "welcome.source が記録される").toBeTruthy();
    expect(row?.value).toBe("marche");
  });

  it("オンライン回答 → 分岐応答（何から始めるか）+ flow_events(welcome.source=online)", async () => {
    const user = synthLineUserId("f2b");

    await dispatchLineWebhook({
      env,
      channelSecret: String(env.LINE_CHANNEL_SECRET),
      events: [messageEvent(user, WELCOME_SOURCE_ONLINE_TEXT)],
    });

    const reply = h.line.texts().join("\n---\n");
    expect(reply).toContain(buildSourceResponse("online").text);
    // marche 分岐の固有文（袋の5桁案内）は出ない＝分岐が効いている。
    expect(reply).not.toContain(buildSourceResponse("marche").text);

    await settle();
    const events = h.supabase.all("flow_events");
    const row = events.find(
      (e) => e.user_ref === user && e.event_name === "welcome.source",
    );
    expect(row?.value).toBe("online");
  });

  // spec drift④（personalization-spec §6 優先4 / Table A #15 / 監査 #8・設計案 v2 A-3）:
  //   オンライン入口は好み診断を主線に。診断が 4 択末尾に埋没していたドリフトを是正し、
  //   応答 quickReply の「先頭 action」が好み診断トリガーであることを load-bearing にガードする。
  //   これが赤くなる = オンライン入口の診断主線化が壊れた（診断が先頭でない）。
  it("オンライン回答 → 好み診断が主線（応答 quickReply の先頭が診断トリガー）", async () => {
    const user = synthLineUserId("f2c");

    await dispatchLineWebhook({
      env,
      channelSecret: String(env.LINE_CHANNEL_SECRET),
      events: [messageEvent(user, WELCOME_SOURCE_ONLINE_TEXT)],
    });

    // オンライン分岐の応答（quickReply 付きテキスト message）を捕捉。
    const msg = h.line
      .allMessages()
      .find((m) => m.type === "text" && (m as { quickReply?: unknown }).quickReply);
    expect(msg, "quickReply 付きの分岐応答が返る").toBeTruthy();

    const items = (
      msg as { quickReply: { items: Array<{ action: { text?: string } }> } }
    ).quickReply.items;

    // ── load-bearing: 好み診断が主線 = quickReply の先頭 action（4 択末尾ではない）。
    expect(items[0]?.action?.text, "先頭の quick reply が好み診断トリガー").toBe(
      DIAGNOSIS_TRIGGER,
    );

    // 回帰ガード: ほかの入り口（お茶を探す）は副次として残す（選択肢は削らない）。
    const actionTexts = items.map((i) => i.action?.text);
    expect(actionTexts, "従来の入り口も副次として残る").toContain(ONBOARDING_EXPLORE_TEXT);
  });
});
