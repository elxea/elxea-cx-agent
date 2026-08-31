/**
 * Unit Tests — 送付台帳を L0 の出来事にする（roji マスタースペック 第4章 / CDP §5 E1）
 *
 * Supabase には触れない（fake クライアント注入）。検証範囲:
 *   - 台帳の行（038）→ L0 の 1 件（`shipment.sent`）の組み立てが決定的であること
 *   - 冪等キーの元が **注文の参照 1 本**（発送日が後から確かになっても 2 行目を作らない）
 *   - payload に生の識別子・宛名・住所が 1 つも入らないこと（E5 / roji 正本 第4章）
 *   - 形が壊れた payload は schema_ok = false に落ち、履歴に混ざらないこと（E1）
 *   - 月別の送付履歴が JST の暦で畳まれ、銘柄ごとに合算されること
 *   - 読み口が **決して throw しない**こと（読めなければ空で戻る）
 *
 * 使用: npx tsx tests/unit/cdp-shipment.test.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isKnownEventType,
  isWellFormedEventType,
  isWellFormedPayload,
  KNOWN_EVENT_TYPES,
  SHIPMENT_SENT_EVENT_TYPE,
} from "../../src/lib/cdp/event-vocabulary";
import {
  buildShipmentFact,
  foldShipmentHistory,
  identifierForDelivery,
  isWellFormedShipmentPayload,
  readShipmentHistory,
  type ShipmentEventRow,
} from "../../src/lib/cdp/shipment";
import {
  extractDeliveryRecords,
  type DeliveryRecord,
} from "../../src/lib/delivery-ledger";

let total = 0;
let passed = 0;
const failures: string[] = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function it(name: string, fn: () => void | Promise<void>) {
  queue.push({ name, fn });
}
function assertEqual<T>(a: T, e: T, label = "") {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertTrue(v: boolean, label = "") {
  if (!v) throw new Error(`${label}: expected true`);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const LINE_UID = "U0123456789abcdef0123456789abcdef";

function row(over: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    shopifyCustomerId: "7654321",
    lineUserId: null,
    deliveredOn: "2026-08-05",
    dateBasis: "fulfilled",
    itemKind: "tea",
    itemRef: "111",
    itemVariantRef: null,
    itemName: "煎茶 やぶきた",
    quantity: 1,
    source: "shopify_order",
    sourceRef: "order:999",
    sourceLineRef: "1",
    note: null,
    ...over,
  };
}

/** L0 の行（PostgREST の返り値の形）。 */
function l0(
  shippedOn: string,
  items: Array<{ ref: string; kind?: string; quantity?: number }>,
  extra: Record<string, unknown> = {},
  schemaOk = true,
): ShipmentEventRow {
  return {
    occurred_at: `${shippedOn}T00:00:00+09:00`,
    schema_ok: schemaOk,
    payload: {
      shipped_on: shippedOn,
      items: items.map((i) => ({ ref: i.ref, kind: i.kind ?? "tea", quantity: i.quantity ?? 1 })),
      ...extra,
    },
  };
}

/**
 * fake Supabase — .from().select().in().eq().eq().order().limit() の連鎖だけを持つ。
 * 実クライアントと同じく「最後に await すると {data,error} が返る」形にする。
 */
function fakeClient(result: {
  data?: unknown;
  error?: { message: string } | null;
  throws?: boolean;
}) {
  const calls: Record<string, unknown> = {};
  const builder: Record<string, unknown> = {};
  const chain = (key: string) => (...args: unknown[]) => {
    calls[key] = args;
    return builder;
  };
  builder.select = chain("select");
  builder.in = chain("in");
  builder.eq = (col: string, val: unknown) => {
    calls[`eq:${col}`] = val;
    return builder;
  };
  builder.order = chain("order");
  builder.limit = (n: number) => {
    calls.limit = n;
    if (result.throws) throw new Error("boom");
    return Promise.resolve({ data: result.data ?? null, error: result.error ?? null });
  };
  const client = {
    from(table: string) {
      calls.table = table;
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

// ---------------------------------------------------------------------------
// 語彙
// ---------------------------------------------------------------------------

it("語彙: shipment.sent が登録簿に載っている（未知扱いにならない）", () => {
  assertEqual(SHIPMENT_SENT_EVENT_TYPE, "shipment.sent");
  assertTrue(isWellFormedEventType(SHIPMENT_SENT_EVENT_TYPE), "形が L0 の CHECK を通る");
  assertTrue(isKnownEventType(SHIPMENT_SENT_EVENT_TYPE), "既知の語彙");
  assertTrue(KNOWN_EVENT_TYPES.has(SHIPMENT_SENT_EVENT_TYPE), "全集合に入っている");
});

it("語彙: 購入と送付は別の型名（届いていない注文を「送った」と数えない）", () => {
  assertTrue(SHIPMENT_SENT_EVENT_TYPE !== "purchase.order_paid", "同じ型名に畳まない");
  assertTrue(isKnownEventType("purchase.order_paid"), "購入の側も残っている");
});

// ---------------------------------------------------------------------------
// payload の形（schema_ok の判定）
// ---------------------------------------------------------------------------

it("形: 届いた日と中身があれば読める形", () => {
  assertTrue(
    isWellFormedShipmentPayload({ shipped_on: "2026-08-05", items: [{ ref: "111", quantity: 1 }] }),
    "最小形",
  );
});

it("形: 号が無くても読める形（EC の注文には号が無い）", () => {
  const ok = isWellFormedShipmentPayload({
    shipped_on: "2026-08-05",
    items: [{ ref: "111", quantity: 2 }],
  });
  assertTrue(ok, "issue_ref を必須にすると号が始まる前の送付が全部落ちる");
});

it("形: 届いた日が無い / 形が違う / 中身が空 は読めない形", () => {
  assertEqual(isWellFormedShipmentPayload(undefined), false, "payload 自体が無い");
  assertEqual(isWellFormedShipmentPayload({ items: [{ ref: "1", quantity: 1 }] }), false, "日が無い");
  assertEqual(
    isWellFormedShipmentPayload({ shipped_on: "2026-8-5", items: [{ ref: "1", quantity: 1 }] }),
    false,
    "日の形が違う",
  );
  assertEqual(isWellFormedShipmentPayload({ shipped_on: "2026-08-05", items: [] }), false, "中身が空");
});

it("形: 銘柄が空文字 / 数量が数値でない行は読めない形（静かに歪めない）", () => {
  assertEqual(
    isWellFormedShipmentPayload({ shipped_on: "2026-08-05", items: [{ ref: "  ", quantity: 1 }] }),
    false,
    "銘柄が空",
  );
  assertEqual(
    isWellFormedShipmentPayload({
      shipped_on: "2026-08-05",
      items: [{ ref: "111", quantity: "2" }],
    }),
    false,
    "数量が文字列",
  );
  assertEqual(
    isWellFormedShipmentPayload({ shipped_on: "2026-08-05", items: [{ ref: "111", quantity: 0 }] }),
    false,
    "数量が 0",
  );
});

it("形: gateway の schema_ok 判定が shipment.sent を見る（E1: 捨てはしない）", () => {
  assertEqual(
    isWellFormedPayload(SHIPMENT_SENT_EVENT_TYPE, { shipped_on: "2026-08-05", items: [{ ref: "1", quantity: 1 }] }),
    true,
  );
  assertEqual(isWellFormedPayload(SHIPMENT_SENT_EVENT_TYPE, { items: [] }), false, "壊れた形は false");
  // 他の出来事の判定は変わっていない。
  assertEqual(isWellFormedPayload("behavior.purchase", undefined), true, "行動ログは形を問わない");
});

// ---------------------------------------------------------------------------
// 書く側 — 台帳の行 → L0 の 1 件
// ---------------------------------------------------------------------------

it("組み立て: 1 注文 = 1 件。銘柄は payload の items に畳まれる", () => {
  const fact = buildShipmentFact(
    [row(), row({ itemRef: "222", itemKind: "goods", quantity: 3, sourceLineRef: "2" })],
    { source: "cx-agent.shopify-order", channel: "shopify" },
  );
  assertTrue(fact !== null, "組み立てられる");
  assertEqual(fact!.eventType, "shipment.sent");
  assertEqual(fact!.channel, "shopify");
  const items = fact!.payload!.items as Array<Record<string, unknown>>;
  assertEqual(items.length, 2, "1 件の中に 2 銘柄");
  assertEqual(items[1].ref, "222");
  assertEqual(items[1].kind, "goods");
  assertEqual(items[1].quantity, 3);
  assertEqual(fact!.payload!.item_count, 2);
});

it("組み立て: 冪等の元は注文の参照 1 本（発送日が上がっても 2 行目を作らない）", () => {
  const ordered = buildShipmentFact([row({ dateBasis: "ordered", deliveredOn: "2026-08-05" })], {
    source: "cx-agent.shopify-order",
    channel: "shopify",
  });
  const fulfilled = buildShipmentFact([row({ dateBasis: "fulfilled", deliveredOn: "2026-08-07" })], {
    source: "cx-agent.shopify-order",
    channel: "shopify",
  });
  assertEqual(ordered!.dedupe, "order:999");
  assertEqual(fulfilled!.dedupe, ordered!.dedupe, "同じ注文なら同じ dedupe = L0 は 1 行のまま");
});

it("組み立て: 届いた日は JST の 0 時に固定される（受け取り時刻を推測しない）", () => {
  const fact = buildShipmentFact([row({ deliveredOn: "2026-08-05" })], {
    source: "cx-agent.shopify-order",
    channel: "shopify",
  });
  assertEqual(fact!.occurredAt, "2026-08-05T00:00:00+09:00");
  assertEqual(fact!.payload!.shipped_on, "2026-08-05");
  // JST の 0 時は UTC では前日 15:00。月の判定は shipped_on 側が正本である。
  assertEqual(new Date(fact!.occurredAt!).toISOString(), "2026-08-04T15:00:00.000Z");
});

it("組み立て: EC の顧客番号が本命。無ければ LINE の ID で書ける（EC 開店前）", () => {
  const byShopify = buildShipmentFact([row()], { source: "s", channel: "shopify" });
  assertEqual(byShopify!.identifier.kind, "shopify_customer_id");
  assertEqual(byShopify!.identifier.value, "7654321");

  const byLine = buildShipmentFact(
    [row({ shopifyCustomerId: null, lineUserId: LINE_UID, source: "manual", sourceRef: "marche-2026-08-05" })],
    { source: "s", channel: "line" },
  );
  assertEqual(byLine!.identifier.kind, "line_messaging_uid");
  assertEqual(byLine!.identifier.value, LINE_UID);
  assertEqual(byLine!.dedupe, "marche-2026-08-05");
});

it("組み立て: payload に生の識別子・宛名・住所が 1 つも入らない（E5 / roji 正本 第4章）", () => {
  const fact = buildShipmentFact(
    [row({ shopifyCustomerId: null, lineUserId: LINE_UID, itemName: "煎茶 やぶきた" })],
    { source: "s", channel: "line" },
  );
  const dumped = JSON.stringify(fact!.payload);
  assertTrue(!dumped.includes(LINE_UID), "生の LINE userId が payload に無い");
  assertTrue(!dumped.includes("7654321"), "顧客番号が payload に無い");
  assertTrue(!dumped.includes("やぶきた"), "表示名の写しを持たない（名前の正本は台帳と商品マスタ）");
});

it("組み立て: 号は渡されたときだけ載る（推測で埋めない）", () => {
  const without = buildShipmentFact([row()], { source: "s", channel: "shopify" });
  assertTrue(!("issue_ref" in (without!.payload ?? {})), "EC の注文には号が無い");

  const withIssue = buildShipmentFact([row()], {
    source: "s",
    channel: "shopify",
    issueRef: "issue-001",
  });
  assertEqual(withIssue!.payload!.issue_ref, "issue-001");
});

it("組み立て: 数えられない束は組み立てない（null で返す）", () => {
  assertEqual(buildShipmentFact([], { source: "s", channel: "shopify" }), null, "行が 0 件");
  assertEqual(
    buildShipmentFact([row({ shopifyCustomerId: null, lineUserId: null })], { source: "s", channel: "shopify" }),
    null,
    "誰に届いたかが無い",
  );
  assertEqual(
    buildShipmentFact([row({ sourceRef: "  " })], { source: "s", channel: "shopify" }),
    null,
    "出所の参照が空 = 冪等キーが作れない",
  );
  assertEqual(
    buildShipmentFact([row({ deliveredOn: "2026/08/05" })], { source: "s", channel: "shopify" }),
    null,
    "届いた日の形が違う",
  );
});

it("組み立て: 日付や出所が混ざった束は 1 件に畳まない（どちらとも違う出来事を作らない）", () => {
  assertEqual(
    buildShipmentFact([row(), row({ deliveredOn: "2026-08-09", sourceLineRef: "2" })], {
      source: "s",
      channel: "shopify",
    }),
    null,
    "日付が混ざっている",
  );
  assertEqual(
    buildShipmentFact([row(), row({ sourceRef: "order:1000", sourceLineRef: "2" })], {
      source: "s",
      channel: "shopify",
    }),
    null,
    "出所が混ざっている",
  );
});

it("組み立て: 注文 payload から台帳の行を経由して 1 件が作れる（実経路の形）", () => {
  const rows = extractDeliveryRecords({
    id: 999,
    created_at: "2026-08-05T01:00:00+09:00",
    customer: { id: 7654321 },
    line_items: [
      { id: 1, product_id: 111, title: "煎茶", quantity: 2 },
      { id: 2, product_id: 222, title: "茶さじ", quantity: 1 },
    ],
  });
  const fact = buildShipmentFact(rows, { source: "cx-agent.shopify-order", channel: "shopify" });
  assertEqual(fact!.dedupe, "order:999");
  assertEqual((fact!.payload!.items as unknown[]).length, 2);
  assertEqual(fact!.payload!.date_basis, "ordered", "発送の記録が無いので注文日で代用");
  assertTrue(isWellFormedShipmentPayload(fact!.payload), "組み立てた payload は必ず読める形");
});

it("鍵: 台帳の行から鍵を引く（両方無ければ null）", () => {
  assertEqual(identifierForDelivery(row())!.kind, "shopify_customer_id");
  assertEqual(
    identifierForDelivery(row({ shopifyCustomerId: null, lineUserId: LINE_UID }))!.kind,
    "line_messaging_uid",
  );
  assertEqual(identifierForDelivery(row({ shopifyCustomerId: "", lineUserId: null })), null);
});

// ---------------------------------------------------------------------------
// 読む側 — 月別の送付履歴
// ---------------------------------------------------------------------------

it("履歴: 月ごとに畳まれ、新しい月が先頭に来る", () => {
  const months = foldShipmentHistory([
    l0("2026-07-10", [{ ref: "111" }]),
    l0("2026-08-05", [{ ref: "222" }]),
    l0("2026-06-01", [{ ref: "333" }]),
  ]);
  assertEqual(months.length, 3);
  assertEqual(months[0].period, "2026-08");
  assertEqual(months[1].period, "2026-07");
  assertEqual(months[2].period, "2026-06");
});

it("履歴: 同じ月の同じ銘柄は数量が合算される（送付回数は別に数える）", () => {
  const months = foldShipmentHistory([
    l0("2026-08-05", [{ ref: "111", quantity: 2 }, { ref: "222", quantity: 1 }]),
    l0("2026-08-20", [{ ref: "111", quantity: 3 }]),
  ]);
  assertEqual(months.length, 1);
  assertEqual(months[0].shipments, 2, "その月に 2 回送った");
  assertEqual(months[0].items.length, 2, "銘柄は 2 種");
  assertEqual(months[0].items[0].ref, "111");
  assertEqual(months[0].items[0].quantity, 5, "2 + 3");
  assertEqual(months[0].items[1].quantity, 1);
});

it("履歴: 分類は「分かった方向」にだけ動く（unknown で上書きしない）", () => {
  const months = foldShipmentHistory([
    l0("2026-08-05", [{ ref: "111", kind: "unknown" }]),
    l0("2026-08-06", [{ ref: "111", kind: "tea" }]),
    l0("2026-08-07", [{ ref: "111", kind: "unknown" }]),
  ]);
  assertEqual(months[0].items[0].kind, "tea");
});

it("履歴: その月に送った号が拾える（重複は 1 つに）", () => {
  const months = foldShipmentHistory([
    l0("2026-08-05", [{ ref: "111" }], { issue_ref: "issue-002" }),
    l0("2026-08-20", [{ ref: "111" }], { issue_ref: "issue-002" }),
    l0("2026-07-05", [{ ref: "111" }]),
  ]);
  assertEqual(months[0].issueRefs.length, 1);
  assertEqual(months[0].issueRefs[0], "issue-002");
  assertEqual(months[1].issueRefs.length, 0, "号が無い月は空");
});

it("履歴: schema_ok = false の行は畳まない（壊れた入力が履歴に混ざらない）", () => {
  const months = foldShipmentHistory([
    l0("2026-08-05", [{ ref: "111" }]),
    l0("2026-08-06", [{ ref: "222" }], {}, false),
  ]);
  assertEqual(months[0].shipments, 1);
  assertEqual(months[0].items.length, 1);
});

it("履歴: 届いた日が読めない行は occurred_at の JST 暦日に落ちる（無言で捨てない）", () => {
  const months = foldShipmentHistory([
    {
      // JST では 2026-09-01。UTC の暦日（08-31）で数えると月がずれる。
      occurred_at: "2026-08-31T16:00:00.000Z",
      schema_ok: true,
      payload: { items: [{ ref: "111", quantity: 1 }] },
    },
  ]);
  assertEqual(months.length, 1);
  assertEqual(months[0].period, "2026-09");
});

it("履歴: 月も日も無い行は数に入れない（推測で月を作らない）", () => {
  const months = foldShipmentHistory([
    { occurred_at: null, schema_ok: true, payload: { items: [{ ref: "111", quantity: 1 }] } },
  ]);
  assertEqual(months.length, 0);
});

it("履歴: 入力が空でも落ちない", () => {
  assertEqual(foldShipmentHistory([]).length, 0);
});

// ---------------------------------------------------------------------------
// 読み口（fake クライアント）
// ---------------------------------------------------------------------------

it("読み口: 送付の出来事だけを、主体を指定して引く", async () => {
  const { client, calls } = fakeClient({ data: [l0("2026-08-05", [{ ref: "111", quantity: 2 }])] });
  const months = await readShipmentHistory(client, "01J0000000000000000000000A");
  assertEqual(calls.table, "customer_events");
  assertEqual(calls["eq:event_type"], "shipment.sent");
  assertEqual(calls["eq:schema_ok"], true, "壊れた行は DB 側で外す");
  assertEqual(months.length, 1);
  assertEqual(months[0].items[0].quantity, 2);
});

it("読み口: 連携済みの人は主体をまとめて渡せる（canonical の解決はここに作らない）", async () => {
  const { client, calls } = fakeClient({ data: [] });
  await readShipmentHistory(client, ["A", "B"]);
  const inArgs = calls.in as unknown[];
  assertEqual(inArgs[0], "subject_id");
  assertEqual((inArgs[1] as string[]).length, 2);
});

it("読み口: 主体が空なら DB を引かない", async () => {
  const { client, calls } = fakeClient({ data: [] });
  const months = await readShipmentHistory(client, ["  ", ""]);
  assertEqual(months.length, 0);
  assertEqual(calls.table, undefined, "問い合わせ自体が起きない");
});

it("読み口: DB が失敗しても throw せず空で戻る（呼び出し側を止めない）", async () => {
  const failed = await readShipmentHistory(fakeClient({ error: { message: "down" } }).client, "A");
  assertEqual(failed.length, 0);
  const threw = await readShipmentHistory(fakeClient({ throws: true }).client, "A");
  assertEqual(threw.length, 0);
});

// --- runner -----------------------------------------------------------------

async function run() {
  console.log("\n=== cdp-shipment.test ===\n");
  for (const { name, fn } of queue) {
    total += 1;
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  [FAIL] ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n=== cdp-shipment.test: ${passed}/${total} passed, ${failures.length} failed ===`);
  if (failures.length > 0) process.exit(1);
}

void run();
