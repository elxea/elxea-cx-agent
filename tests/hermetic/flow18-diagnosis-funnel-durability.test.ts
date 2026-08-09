/**
 * ハーメティック L1 — 動線18: 好み診断のファネル記録が「応答が終わる前に」書き終わっていること。
 *
 * ─ なぜこの試験が要るか（実測で確定した事実） ─
 *   本番 flow_events には診断の途中段が 1 件も残っていなかった:
 *     menu.tap(value=diagnosis) 12 件 / diag.start 0 件 / diag.answer(q1) 0 件 / diag.answer(q2) 0 件
 *     diag.answer(q3) 2 件 / diag.result 2 件
 *   同一人物 U5c51... の足跡でも、menu.tap(14:48:51) → q3(14:49:27) → result(14:49:27) と並び、
 *   その間に必ず起きたはずの q1 / q2 の回答だけが欠けている（event_name への CHECK 制約は無い＝
 *   弾かれたのではない）。
 *
 *   原因は「投げっぱなし（void）で書いた後に、同じリクエストで待つものが何も無い」こと。
 *   結果段だけはカルテ記録（Firestore 往復）を await するので生き残り、
 *   start / q1 / q2 は書き込みを投げた直後に処理が終わり、Worker が畳まれて書き込みが消えていた。
 *
 * ─ この試験が測るもの ─
 *   `waitOnExecutionContext(ctx)` は「ctx.waitUntil に渡された処理が全部終わった」瞬間で返る。
 *   本番の Worker が生かされるのもちょうどそこまでなので、**その時点で行が無い＝本番では消える**。
 *   よって微小待ち（settle()）を **わざと使わず**、dispatch 直後に flow_events を見る。
 *   （settle() を使うと、消えるはずの書き込みまで拾ってしまい、この欠陥が見えなくなる。）
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { dispatchLineWebhook } from "../lib/webhook";
import { messageEvent, synthLineUserId } from "../lib/synthetic";
import { _resetTeaCache } from "../../src/lib/tea-menu";
import { DIAGNOSIS_TRIGGER } from "../../src/lib/preference-diagnosis";
import { FLOW_EVENTS_TABLE } from "../../src/lib/flow-events";

let h: Hermetic;

beforeEach(() => {
  _resetTeaCache();
  h = installHermeticFetch(env);
  h.supabase.reset();
});

afterEach(() => {
  h.restore();
});

/** flow_events の行を (event_name, step, value) で拾う。 */
function events(): Array<{ event_name: string; step: string | null; value: string | null }> {
  return h.supabase.all(FLOW_EVENTS_TABLE) as Array<{
    event_name: string;
    step: string | null;
    value: string | null;
  }>;
}

describe("hermetic L1 — 動線18: 診断ファネルが応答完了時点で書き終わっている", () => {
  const CASES: Array<[string, string, { event: string; step: string | null; value: string }]> = [
    [
      "診断の入口（メニュー文言）→ diag.start",
      DIAGNOSIS_TRIGGER,
      { event: "diag.start", step: null, value: "menu" },
    ],
    [
      "Q1 に答えた → diag.answer(step=q1)",
      "診断｜2",
      { event: "diag.answer", step: "q1", value: "q1_2" },
    ],
    [
      "Q2 に答えた → diag.answer(step=q2)",
      "診断｜2｜3",
      { event: "diag.answer", step: "q2", value: "q2_3" },
    ],
  ];

  for (const [label, text, expected] of CASES) {
    it(`${label}（settle なし＝本番で消えない）`, async () => {
      const user = synthLineUserId("f18" + expected.value.replace(/[^0-9a-f]/g, ""));
      const { status } = await dispatchLineWebhook({
        env,
        channelSecret: String(env.LINE_CHANNEL_SECRET),
        events: [messageEvent(user, text)],
      });
      expect(status).toBe(200);

      // ⚠ ここで settle() を呼ばない。呼ぶと「本番なら消えている書き込み」まで通ってしまう。
      const hit = events().find(
        (r) =>
          r.event_name === expected.event &&
          (r.step ?? null) === expected.step &&
          r.value === expected.value,
      );
      expect(
        hit,
        `${expected.event}(${expected.step ?? "-"}=${expected.value}) が応答完了時点で残っている`,
      ).toBeTruthy();
    });
  }

  it("結果段は従来どおり残る（q3 の回答 + 結果）", async () => {
    const user = synthLineUserId("f18r");
    const { status } = await dispatchLineWebhook({
      env,
      channelSecret: String(env.LINE_CHANNEL_SECRET),
      events: [messageEvent(user, "診断｜1｜1｜1")],
    });
    expect(status).toBe(200);

    const names = events().map((r) => `${r.event_name}:${r.step ?? "-"}:${r.value}`);
    expect(names).toContain("diag.answer:q3:q3_1");
    // diag.result の value は winner（この回答なら serenity）。
    expect(names.some((n) => n.startsWith("diag.result:-:"))).toBe(true);
  });

  it("診断は 1 通も LINE へ送信しない（返信のみ・配信台帳を増やさない）", async () => {
    const user = synthLineUserId("f18s");
    await dispatchLineWebhook({
      env,
      channelSecret: String(env.LINE_CHANNEL_SECRET),
      events: [messageEvent(user, DIAGNOSIS_TRIGGER)],
    });
    // push は 0 件（診断は reply だけを使う）。配信台帳の行も増えない。
    expect(h.line.sends.filter((s) => s.kind === "push").length, "push 0 件").toBe(0);
    expect(h.supabase.all("line_message_ledger").length, "配信台帳は増えない").toBe(0);
  });
});
