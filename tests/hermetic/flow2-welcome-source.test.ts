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
  buildSourceResponse,
} from "../../src/lib/welcome-onboarding";

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
});
