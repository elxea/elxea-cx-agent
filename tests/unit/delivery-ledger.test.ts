/**
 * Unit Tests -- delivery-ledger（配送台帳: 誰に・いつ・何が届いたか）
 *
 * 仕様の正本: elxea CX Agent機能定義 v1.5  https://www.notion.so/3b970c9d064c81ddb60ff08c23152929
 * 器: src/db/migrations/038_tea_delivery_ledger.sql
 *
 * カバー範囲:
 *   - 注文 → 台帳の行（銘柄ごとに 1 行 / 数量 / 明細の参照 / 変種名の合成）
 *   - 届いた日（発送の記録があればそれ・無ければ注文日で代用）と JST 変換
 *   - 誰の記録か分からない注文（guest checkout）は 0 行
 *   - 分類は推測しない（タグが無ければ 'unknown'・'tea' と決めつけない）
 *   - 手動投入の検証（鍵・日付の形・空の中身・数量）と再実行での鍵の安定
 *   - RPC への写し（snake_case）と store のエラー扱い
 *   - webhook が「台帳を最優先で書く」こと（Firebase 未設定でも書かれる）
 *   - 置かないと決めたもの（住所・宛名・金額）が台帳の行に混ざらないこと
 *
 * 実 DB / ネットワーク非接触（すべて純粋関数と fake）。
 *
 * 使用方法:
 *   npx tsx tests/unit/delivery-ledger.test.ts
 */

import type { Env } from "../../src/index";
import {
  buildManualDeliveryRecords,
  classifyItemKind,
  createSupabaseDeliveryLedgerStore,
  extractDeliveryRecords,
  toJstDate,
  toLedgerPayload,
  type DeliveryRecord,
} from "../../src/lib/delivery-ledger";
import {
  handleShopifyOrder,
  type ShopifyOrderDeps,
  type ShopifyOrderPayload,
} from "../../src/lib/shopify-order-webhook";

// ---------------------------------------------------------------------------
// ハーネス
// ---------------------------------------------------------------------------
let total = 0;
let passed = 0;
let failed = 0;
const failures: Array<{ name: string; error: string }> = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function it(name: string, fn: () => void | Promise<void>) {
  queue.push({ name, fn });
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assertTrue(v: boolean, label = "") {
  if (!v) throw new Error(`${label}: expected true`);
}
function assertThrows(fn: () => unknown, label = "") {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(`${label}: 例外が投げられなかった`);
}

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------

function order(overrides: Partial<ShopifyOrderPayload> = {}): ShopifyOrderPayload {
  return {
    id: 5001,
    created_at: "2026-08-05T02:30:00Z", // JST 2026-08-05 11:30
    customer: { id: 777 },
    line_items: [
      {
        id: 9001,
        product_id: 111,
        variant_id: 222,
        title: "煎茶 やぶきた",
        variant_title: "50g",
        quantity: 2,
      },
      { id: 9002, product_id: 333, title: "和紅茶", quantity: 1 },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 注文 → 台帳の行
// ---------------------------------------------------------------------------

it("注文 → 銘柄ごとに 1 行（数量は列で持つ・行を増やさない）", () => {
  const rows = extractDeliveryRecords(order());
  assertEqual(rows.length, 2, "行数");
  assertEqual(rows[0].itemRef, "111");
  assertEqual(rows[0].quantity, 2, "数量");
  assertEqual(rows[0].itemVariantRef, "222");
  assertEqual(rows[0].itemName, "煎茶 やぶきた / 50g", "変種名の合成");
  assertEqual(rows[0].sourceRef, "order:5001");
  assertEqual(rows[0].sourceLineRef, "9001", "明細の参照 = 二重計上を防ぐ鍵");
  assertEqual(rows[0].shopifyCustomerId, "777");
  assertEqual(rows[1].itemRef, "333");
});

it("届いた日: 発送の記録が無ければ注文日で代用し basis=ordered", () => {
  const rows = extractDeliveryRecords(order());
  assertEqual(rows[0].deliveredOn, "2026-08-05", "JST の暦日");
  assertEqual(rows[0].dateBasis, "ordered");
});

it("届いた日: 発送の記録があればそれを採り basis=fulfilled（より確か）", () => {
  const rows = extractDeliveryRecords(
    order({ fulfillments: [{ created_at: "2026-08-07T23:00:00Z", status: "success" }] }),
  );
  assertEqual(rows[0].deliveredOn, "2026-08-08", "UTC 23:00 は JST では翌日");
  assertEqual(rows[0].dateBasis, "fulfilled");
});

it("取り消された発送は採らない（注文日に落ちる）", () => {
  const rows = extractDeliveryRecords(
    order({ fulfillments: [{ created_at: "2026-08-07T23:00:00Z", status: "cancelled" }] }),
  );
  assertEqual(rows[0].dateBasis, "ordered");
});

it("誰の記録か分からない注文（guest checkout）は 0 行", () => {
  const rows = extractDeliveryRecords(order({ customer: null }));
  assertEqual(rows.length, 0);
});

it("EC 顧客番号が無くても LINE の ID があれば書ける（EC 開店前の経路）", () => {
  const rows = extractDeliveryRecords(order({ customer: null }), { lineUserId: "U123" });
  assertEqual(rows.length, 2);
  assertEqual(rows[0].shopifyCustomerId, null);
  assertEqual(rows[0].lineUserId, "U123");
});

it("銘柄の参照が全く取れない明細は書かない（空の記録を作らない）", () => {
  const rows = extractDeliveryRecords(
    order({ line_items: [{ id: 9003, title: "何か", quantity: 1 }] }),
  );
  assertEqual(rows.length, 0);
});

it("明細 ID が無い payload でも安定した鍵になる（順番を混ぜる）", () => {
  const o = order({ line_items: [{ product_id: 111, quantity: 1 }, { product_id: 111, quantity: 1 }] });
  const rows = extractDeliveryRecords(o);
  assertEqual(rows[0].sourceLineRef, "111#0");
  assertEqual(rows[1].sourceLineRef, "111#1");
  assertTrue(rows[0].sourceLineRef !== rows[1].sourceLineRef, "同じ商品でも鍵が衝突しない");
});

// ---------------------------------------------------------------------------
// 分類は推測しない
// ---------------------------------------------------------------------------

it("タグが無ければ分類は unknown（tea と決めつけない）", () => {
  assertEqual(classifyItemKind(undefined), "unknown");
  assertEqual(classifyItemKind([]), "unknown");
  const rows = extractDeliveryRecords(order());
  assertEqual(rows[0].itemKind, "unknown");
});

it("タグがあれば茶と雑貨を分ける", () => {
  assertEqual(classifyItemKind(["煎茶", "定期便"]), "tea");
  assertEqual(classifyItemKind(["茶器", "goods"]), "goods");
  const rows = extractDeliveryRecords(order(), {
    productTags: new Map([["111", ["煎茶"]]]),
  });
  assertEqual(rows[0].itemKind, "tea");
  assertEqual(rows[1].itemKind, "unknown", "タグが無い方は unknown のまま");
});

it("toJstDate は読めない値を黙って通さない", () => {
  assertThrows(() => toJstDate("not-a-date"));
});

// ---------------------------------------------------------------------------
// 置かないと決めたもの
// ---------------------------------------------------------------------------

it("住所・宛名・金額は台帳の行に混ざらない", () => {
  const rows = extractDeliveryRecords(order());
  const keys = Object.keys(rows[0]);
  for (const banned of ["address", "shippingAddress", "email", "name", "price", "total", "amount"]) {
    assertTrue(!keys.includes(banned), `禁止列 ${banned} が混ざっている`);
  }
});

// ---------------------------------------------------------------------------
// 手動投入
// ---------------------------------------------------------------------------

const manualBase = {
  lineUserId: "U999",
  deliveredOn: "2026-08-05",
  sourceRef: "marche-2026-08-05",
  note: "手渡し",
  items: [{ itemRef: "roji-sencha-01", itemName: "煎茶", itemKind: "tea" as const, quantity: 1 }],
};

it("手動投入: 正しい入力は行になり basis=manual（人が確認した日付が最も強い）", () => {
  const rows = buildManualDeliveryRecords(manualBase);
  assertEqual(rows.length, 1);
  assertEqual(rows[0].dateBasis, "manual");
  assertEqual(rows[0].source, "manual");
  assertEqual(rows[0].sourceLineRef, "1", "既定は 1 始まりの連番");
  assertEqual(rows[0].lineUserId, "U999");
});

it("手動投入: 同じ入力を再実行しても鍵が変わらない（二重計上しない）", () => {
  const a = buildManualDeliveryRecords(manualBase);
  const b = buildManualDeliveryRecords(manualBase);
  assertEqual(a[0].sourceRef, b[0].sourceRef);
  assertEqual(a[0].sourceLineRef, b[0].sourceLineRef);
});

it("手動投入: 誰に届いたかが無い / 日付の形が違う / 中身が空 / 数量が不正 は弾く", () => {
  assertThrows(() => buildManualDeliveryRecords({ ...manualBase, lineUserId: null }), "鍵なし");
  assertThrows(() => buildManualDeliveryRecords({ ...manualBase, deliveredOn: "2026/08/05" }), "日付の形");
  assertThrows(() => buildManualDeliveryRecords({ ...manualBase, items: [] }), "中身が空");
  assertThrows(
    () => buildManualDeliveryRecords({ ...manualBase, items: [{ itemRef: "x", quantity: 0 }] }),
    "数量 0",
  );
});

// ---------------------------------------------------------------------------
// RPC への写しと store
// ---------------------------------------------------------------------------

it("RPC への写しは snake_case（DB の列名と 1:1）", () => {
  const rows = extractDeliveryRecords(order());
  const payload = toLedgerPayload(rows)[0];
  assertEqual(payload.shopify_customer_id, "777");
  assertEqual(payload.delivered_on, "2026-08-05");
  assertEqual(payload.date_basis, "ordered");
  assertEqual(payload.source_line_ref, "9001");
  assertTrue("item_ref" in payload && "item_kind" in payload, "銘柄の列がある");
});

it("store: 0 行なら RPC を呼ばない", async () => {
  let called = 0;
  const store = createSupabaseDeliveryLedgerStore({
    rpc: async () => {
      called++;
      return { data: null, error: null };
    },
  });
  const res = await store.record([]);
  assertEqual(called, 0);
  assertEqual(res.inserted, 0);
});

it("store: RPC の件数をそのまま返す / エラーは握りつぶさない", async () => {
  const ok = createSupabaseDeliveryLedgerStore({
    rpc: async (fn, args) => {
      assertEqual(fn, "record_tea_deliveries");
      assertTrue(Array.isArray(args.p_rows), "配列を渡している");
      return { data: { inserted: 2, updated: 1, kept: 3 }, error: null };
    },
  });
  const res = await ok.record(extractDeliveryRecords(order()));
  assertEqual(res.inserted, 2);
  assertEqual(res.kept, 3);

  const ng = createSupabaseDeliveryLedgerStore({
    rpc: async () => ({ data: null, error: { message: "boom" } }),
  });
  let threw = false;
  try {
    await ng.record(extractDeliveryRecords(order()));
  } catch (err) {
    threw = true;
    assertTrue((err as Error).message.includes("boom"), "原因が残る");
  }
  assertTrue(threw, "エラーを握りつぶしていない");
});

// ---------------------------------------------------------------------------
// webhook との配線（台帳は最優先）
// ---------------------------------------------------------------------------

function fakeEnv(withFirebase = true): Env {
  const env: Record<string, string> = {};
  if (withFirebase) {
    env.FIREBASE_PROJECT_ID = "p";
    env.FIREBASE_CLIENT_EMAIL = "a@b.c";
    env.FIREBASE_PRIVATE_KEY = "k";
  }
  return env as unknown as Env;
}

function makeDeps(opts: { tagsThrow?: boolean; ledgerThrows?: boolean } = {}) {
  const calls = { deliveries: [] as DeliveryRecord[], pipeline: 0, profile: 0 };
  const deps: ShopifyOrderDeps = {
    fetchProductTags: async () => {
      if (opts.tagsThrow) throw new Error("shopify down");
      return new Map<string, string[]>([["111", ["煎茶"]]]);
    },
    recordDeliveries: async (rows) => {
      if (opts.ledgerThrows) throw new Error("ledger down");
      calls.deliveries.push(...rows);
      return { inserted: rows.length, updated: 0, kept: 0 };
    },
    runPurchasePipeline: async () => {
      calls.pipeline++;
    },
    updateProfile: async () => {
      calls.profile++;
    },
  };
  return { deps, calls };
}

it("webhook: 注文を受けたら配送台帳に書く", async () => {
  const { deps, calls } = makeDeps();
  const res = await handleShopifyOrder(order(), fakeEnv(), deps);
  assertEqual(res.status, "processed");
  assertEqual(res.deliveriesRecorded, 2);
  assertEqual(calls.deliveries.length, 2);
  assertEqual(calls.deliveries[0].itemKind, "tea", "取得したタグが分類に効く");
});

it("webhook: Firebase 未設定でも台帳は書かれる（遡って作れない記録を落とさない）", async () => {
  const { deps, calls } = makeDeps();
  const res = await handleShopifyOrder(order(), fakeEnv(false), deps);
  assertEqual(res.status, "skipped_firebase_unset");
  assertEqual(calls.deliveries.length, 2, "台帳は書かれている");
  assertEqual(calls.pipeline, 0, "属性経路は走っていない");
});

it("webhook: タグが引けなくても台帳は書く（分類は unknown のまま）", async () => {
  const { deps, calls } = makeDeps({ tagsThrow: true });
  const res = await handleShopifyOrder(order(), fakeEnv(), deps);
  assertEqual(res.status, "error", "ペルソナ加算の材料が無いことは異常として返す");
  assertEqual(calls.deliveries.length, 2);
  assertEqual(calls.deliveries[0].itemKind, "unknown");
});

it("webhook: 台帳が書けなくても他の経路は止めない（理由は返す）", async () => {
  const { deps, calls } = makeDeps({ ledgerThrows: true });
  const res = await handleShopifyOrder(order(), fakeEnv(), deps);
  assertEqual(res.status, "processed");
  assertEqual(res.deliveriesRecorded, 0);
  assertTrue((res.deliveryLedgerError ?? "").includes("ledger down"), "失敗の理由が残る");
  assertEqual(calls.pipeline, 1);
});

it("webhook: guest checkout は台帳にも書かない", async () => {
  const { deps, calls } = makeDeps();
  const res = await handleShopifyOrder(order({ customer: null }), fakeEnv(), deps);
  assertEqual(res.status, "skipped_no_customer");
  assertEqual(calls.deliveries.length, 0);
});

// ---------------------------------------------------------------------------
// ランナー
// ---------------------------------------------------------------------------
(async () => {
  console.log("\n--- delivery-ledger (配送台帳) ---");
  for (const { name, fn } of queue) {
    total++;
    try {
      await fn();
      passed++;
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${name}: ${msg}`);
      failures.push({ name, error: msg });
    }
  }
  console.log("\n" + "=".repeat(60));
  console.log("Delivery Ledger Unit Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
