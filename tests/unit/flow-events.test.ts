/**
 * Unit Tests — flow_events 記録（P0-1 / P0-2）
 *
 * Supabase には触れない（fake クライアント注入）。検証範囲:
 *   - buildFlowEventRow の正規化（slug/番号のサニタイズ・channel 既定）
 *   - PII ガード（自由文 value/step は null に落ちる・5桁以外の product_no は null）
 *   - logFlowEvent の fire-and-forget（insert 失敗でも throw しない）
 *   - user_ref 空は記録しない
 *
 * 使用: npx tsx tests/unit/flow-events.test.ts
 */

import {
  buildFlowEventRow,
  sanitizeSlug,
  sanitizeProductNo,
  logFlowEvent,
  FLOW_EVENTS_TABLE,
  type FlowEventRow,
} from "../../src/lib/flow-events";
import { diagnosisFlowEvents } from "../../src/lib/preference-diagnosis";
import { menuTapValue, BREW_RICH_MENU_TRIGGER } from "../../src/lib/menu-tap";
import { DIAGNOSIS_TRIGGER } from "../../src/lib/preference-diagnosis";
import { ABOUT_TRIGGER, consultEntryValue, CONSULT_ENTRY_TEXTS } from "../../src/lib/menu-actions";

let total = 0;
let passed = 0;
const failures: string[] = [];
function it(name: string, fn: () => void | Promise<void>) {
  queue.push({ name, fn });
}
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function assertEqual<T>(a: T, e: T, label = "") {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertTrue(v: boolean, label = "") {
  if (!v) throw new Error(`${label}: expected true`);
}

// fake Supabase: insert を記録し、error を任意で返す。
function makeFakeSupabase(opts?: { failWith?: string; throwOnInsert?: boolean }) {
  const inserts: FlowEventRow[] = [];
  const client = {
    from(table: string) {
      assertEqual(table, FLOW_EVENTS_TABLE, "table");
      return {
        async insert(row: FlowEventRow) {
          if (opts?.throwOnInsert) throw new Error("network down");
          inserts.push(row);
          return { error: opts?.failWith ? { message: opts.failWith } : null };
        },
      };
    },
  };
  return { client, inserts };
}

it("buildFlowEventRow: 正常入力を DB 行に正規化（channel 既定 line）", () => {
  const row = buildFlowEventRow({
    eventName: "diag.answer",
    userRef: "U123",
    step: "q1",
    value: "q1_1",
  });
  assertEqual(row.event_name, "diag.answer", "event_name");
  assertEqual(row.user_ref, "U123", "user_ref");
  assertEqual(row.channel, "line", "channel 既定");
  assertEqual(row.step, "q1", "step");
  assertEqual(row.value, "q1_1", "value");
  assertEqual(row.product_no, null, "product_no null");
});

it("buildFlowEventRow: tea.card_view は5桁 product_no を保持", () => {
  const row = buildFlowEventRow({
    eventName: "tea.card_view",
    userRef: "U1",
    value: "number",
    productNo: "10234",
  });
  assertEqual(row.product_no, "10234", "5桁保持");
});

it("PII ガード: 自由文 value/step は null に落とす（slug のみ許可）", () => {
  const row = buildFlowEventRow({
    eventName: "diag.answer",
    userRef: "U1",
    step: "これは自由文の段です",
    value: "山田太郎 taro@example.com",
  });
  assertEqual(row.step, null, "自由文 step は null");
  assertEqual(row.value, null, "自由文 value は null");
});

it("sanitizeSlug / sanitizeProductNo の境界", () => {
  assertEqual(sanitizeSlug("serenity"), "serenity", "slug ok");
  assertEqual(sanitizeSlug("entry=menu"), null, "= を含む自由文は null");
  assertEqual(sanitizeSlug("  q1_1  "), "q1_1", "トリム");
  assertEqual(sanitizeSlug(undefined), null, "undefined");
  assertEqual(sanitizeProductNo("10234"), "10234", "5桁 ok");
  assertEqual(sanitizeProductNo("1234"), null, "4桁は null");
  assertEqual(sanitizeProductNo("abcde"), null, "非数字は null");
});

it("logFlowEvent: 正常時に 1 行 insert する", async () => {
  const { client, inserts } = makeFakeSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await logFlowEvent(client as any, { eventName: "menu.tap", userRef: "U1", value: "brew" });
  assertEqual(inserts.length, 1, "1 行");
  assertEqual(inserts[0].event_name, "menu.tap", "event_name");
  assertEqual(inserts[0].value, "brew", "value");
});

it("logFlowEvent: insert error でも throw しない（fire-and-forget）", async () => {
  const { client } = makeFakeSupabase({ failWith: "relation flow_events does not exist" });
  let threw = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await logFlowEvent(client as any, { eventName: "diag.start", userRef: "U1", value: "menu" });
  } catch {
    threw = true;
  }
  assertTrue(!threw, "insert error を握りつぶす");
});

it("logFlowEvent: insert 例外でも throw しない", async () => {
  const { client } = makeFakeSupabase({ throwOnInsert: true });
  let threw = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await logFlowEvent(client as any, { eventName: "diag.result", userRef: "U1", value: "serenity" });
  } catch {
    threw = true;
  }
  assertTrue(!threw, "例外を握りつぶす");
});

it("logFlowEvent: user_ref 空は記録しない", async () => {
  const { client, inserts } = makeFakeSupabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await logFlowEvent(client as any, { eventName: "menu.tap", userRef: "", value: "brew" });
  assertEqual(inserts.length, 0, "空 user_ref は記録なし");
});

// --- diagnosisFlowEvents（P0-2 診断ファネル導出） ---
it("diagnosisFlowEvents: トリガーで diag.start(value=menu)", () => {
  const evs = diagnosisFlowEvents("好みに合うお茶を診断してほしいです", "U1", null);
  assertEqual(evs.length, 1, "1 件");
  assertEqual(evs[0].eventName, "diag.start", "start");
  assertEqual(evs[0].value, "menu", "entry=menu");
});
it("diagnosisFlowEvents: Q1 回答（診断｜1）で diag.answer(q1, q1_1)", () => {
  const evs = diagnosisFlowEvents("診断｜1", "U1", null);
  assertEqual(evs[0].eventName, "diag.answer", "answer");
  assertEqual(evs[0].step, "q1", "step q1");
  assertEqual(evs[0].value, "q1_1", "value q1_1");
});
it("diagnosisFlowEvents: Q3 回答完了で diag.answer(q3) + diag.result(winner)", () => {
  const evs = diagnosisFlowEvents("診断｜1｜1｜1", "U1", "serenity");
  assertEqual(evs.length, 2, "answer + result");
  assertEqual(evs[0].eventName, "diag.answer", "answer");
  assertEqual(evs[0].step, "q3", "step q3");
  assertEqual(evs[1].eventName, "diag.result", "result");
  assertEqual(evs[1].value, "serenity", "winner");
});
it("diagnosisFlowEvents: 不正トークンは diag.invalid", () => {
  const evs = diagnosisFlowEvents("診断｜9", "U1", null);
  assertEqual(evs[0].eventName, "diag.invalid", "invalid");
});
it("diagnosisFlowEvents: 診断と無関係な発話は空（素通り）", () => {
  assertEqual(diagnosisFlowEvents("こんにちは", "U1", null).length, 0, "空");
});
it("diagnosisFlowEvents で導出した値は buildFlowEventRow の PII ガードを通過する（slug 正当）", () => {
  const evs = diagnosisFlowEvents("診断｜1｜1｜1", "U1", "explorer");
  for (const ev of evs) {
    const row = buildFlowEventRow(ev);
    // value/step が null に落ちない = slug として正当（自由文でない）
    if (ev.value !== undefined) assertTrue(row.value !== null, `value 保持: ${ev.value}`);
  }
});

// --- menuTapValue（P0-1 リッチメニュー 5 枠） ---
it("menuTapValue: 5 枠トリガー完全一致で value スラッグ", () => {
  assertEqual(menuTapValue(BREW_RICH_MENU_TRIGGER), "brew", "brew");
  assertEqual(menuTapValue(DIAGNOSIS_TRIGGER), "diagnosis", "diagnosis");
  assertEqual(menuTapValue(ABOUT_TRIGGER), "about", "about");
});
it("menuTapValue: サブトークン・自由発話は null（横取りしない）", () => {
  assertEqual(menuTapValue("診断｜1"), null, "診断トークンは menu.tap でない");
  assertEqual(menuTapValue("お茶を選ぶ｜2"), null, "tea サブトークン");
  assertEqual(menuTapValue("こんにちは"), null, "自由発話");
});
it("menuTapValue で導出した値は PII ガードを通過（slug 正当）", () => {
  const row = buildFlowEventRow({ eventName: "menu.tap", userRef: "U1", value: menuTapValue(ABOUT_TRIGGER)! });
  assertEqual(row.value, "about", "about slug 保持");
});

// --- consultEntryValue（P0-1 ③相談初手 3 択） ---
it("consultEntryValue: order/tea/other を判定", () => {
  assertEqual(consultEntryValue(CONSULT_ENTRY_TEXTS.order), "order", "order");
  assertEqual(consultEntryValue(CONSULT_ENTRY_TEXTS.tea), "tea", "tea");
  assertEqual(consultEntryValue(CONSULT_ENTRY_TEXTS.other), "other", "other");
});
it("consultEntryValue: 無関係な発話は null", () => {
  assertEqual(consultEntryValue("こんにちは"), null, "null");
});

(async () => {
  for (const t of queue) {
    total++;
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failures.push(`${t.name}: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  [FAIL] ${t.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("\n============================================================");
  console.log("flow-events Test Results");
  console.log("============================================================");
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${total - passed}`);
  if (failures.length > 0) process.exit(1);
})();
