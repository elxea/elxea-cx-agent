/**
 * Unit Tests -- shopify-webhook（T1: 注文 webhook 受け口）
 *
 * カバー範囲:
 *   - HMAC 署名検証（正しい署名→処理 / 不正署名→拒否 / secret 欠落→fail-closed / 改竄→拒否）
 *   - payload 解析（冪等キー / 顧客 ID / 商品 ID）
 *   - 冪等性（同一注文の二重 webhook → 2 回目は claim されない）
 *   - handleShopifyOrder（注文→pipeline 呼び出し＋lastPurchaseAt 更新 / 定期便フラグ伝播 /
 *     guest checkout スキップ / Firebase 未設定スキップ）
 *   - ペルソナスコア整合（購入 +3 が会話 +1 を上書きせず別軸に加算）
 *
 * 実 Shopify / ネットワーク非接触（すべて fake 注入）。
 *
 * 使用方法:
 *   npx tsx tests/unit/shopify-webhook.test.ts
 */

import type { Env } from "../../src/index";
import {
  verifyShopifyWebhookSignature,
  orderIdempotencyKey,
  extractCustomerId,
  extractProductIds,
  handleShopifyOrder,
  type WebhookIdempotencyStore,
  type ShopifyOrderDeps,
  type ShopifyOrderPayload,
} from "../../src/lib/shopify-order-webhook";
import { mergePersonaScores } from "../../src/lib/firestore";

// ---------------------------------------------------------------------------
// 非同期テストハーネス
// ---------------------------------------------------------------------------
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
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

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** テスト用: raw body を secret で HMAC-SHA256 → base64（Shopify と同一計算）。 */
async function sign(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** Firebase creds を満たす最小 Env（実接続はしない: deps を注入するため）。 */
function fakeEnv(withFirebase = true): Env {
  const base: Record<string, unknown> = {};
  if (withFirebase) {
    base.FIREBASE_PROJECT_ID = "test-project";
    base.FIREBASE_CLIENT_EMAIL = "svc@test.iam.gserviceaccount.com";
    base.FIREBASE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nfake\\n-----END PRIVATE KEY-----";
  }
  return base as unknown as Env;
}

/** 呼び出しを記録する fake deps。 */
function makeRecordingDeps(tagMap: Map<string, string[]> = new Map()) {
  const calls = {
    updateProfile: [] as Array<{ id: string; updates: Record<string, unknown> }>,
    pipeline: [] as Array<{ id: string; lineItems: Array<{ productTags: string[] }> }>,
    fetchTags: [] as string[][],
    // 配送台帳（038）へ書いた行。誰に・いつ・何が届いたかの記録。
    deliveries: [] as Array<Record<string, unknown>>,
  };
  const deps: ShopifyOrderDeps = {
    fetchProductTags: async (ids) => {
      calls.fetchTags.push(ids);
      return tagMap;
    },
    recordDeliveries: async (rows) => {
      for (const r of rows) calls.deliveries.push(r as unknown as Record<string, unknown>);
      return { inserted: rows.length, updated: 0, kept: 0 };
    },
    runPurchasePipeline: async (id, lineItems) => {
      calls.pipeline.push({ id, lineItems });
    },
    updateProfile: async (id, updates) => {
      calls.updateProfile.push({ id, updates });
    },
  };
  return { deps, calls };
}

/** claim 一意性を持つインメモリ冪等ストア（processed_events の契約を模す）。 */
function makeMemoryStore(): WebhookIdempotencyStore {
  const seen = new Set<string>();
  return {
    async claim(key: string) {
      if (seen.has(key)) return { claimed: false };
      seen.add(key);
      return { claimed: true };
    },
  };
}

// ===========================================================================
// 署名検証
// ===========================================================================
const SECRET = "shpss_test_secret_value";
const SAMPLE = JSON.stringify({ id: 111, customer: { id: 222 } });

it("正しい署名 → 検証 true（処理へ進む）", async () => {
  const hmac = await sign(SAMPLE, SECRET);
  assertEqual(await verifyShopifyWebhookSignature(SAMPLE, hmac, SECRET), true);
});

it("不正署名 → false（拒否）", async () => {
  assertEqual(
    await verifyShopifyWebhookSignature(SAMPLE, "not-a-valid-signature", SECRET),
    false,
  );
});

it("secret 未設定 → false（fail-closed）", async () => {
  const hmac = await sign(SAMPLE, SECRET);
  assertEqual(await verifyShopifyWebhookSignature(SAMPLE, hmac, undefined), false);
  assertEqual(await verifyShopifyWebhookSignature(SAMPLE, hmac, ""), false);
});

it("署名ヘッダ欠落 → false（fail-closed）", async () => {
  assertEqual(await verifyShopifyWebhookSignature(SAMPLE, null, SECRET), false);
  assertEqual(await verifyShopifyWebhookSignature(SAMPLE, undefined, SECRET), false);
});

it("ボディ改竄 → false（署名は元ボディに対して計算されている）", async () => {
  const hmac = await sign(SAMPLE, SECRET);
  const tampered = JSON.stringify({ id: 111, customer: { id: 999 } });
  assertEqual(await verifyShopifyWebhookSignature(tampered, hmac, SECRET), false);
});

it("誤った secret で計算した署名 → false", async () => {
  const hmac = await sign(SAMPLE, "wrong-secret");
  assertEqual(await verifyShopifyWebhookSignature(SAMPLE, hmac, SECRET), false);
});

// ===========================================================================
// payload 解析
// ===========================================================================
it("orderIdempotencyKey: 注文 ID → shopify:order:<id>", () => {
  assertEqual(orderIdempotencyKey({ id: 12345 }), "shopify:order:12345");
  assertEqual(orderIdempotencyKey({ id: "9" }), "shopify:order:9");
  assertEqual(orderIdempotencyKey({}), null);
});

it("extractCustomerId: 数値 / GID / guest", () => {
  assertEqual(extractCustomerId({ customer: { id: 8899 } }), "8899");
  assertEqual(
    extractCustomerId({ customer: { id: "gid://shopify/Customer/8899" } }),
    "8899",
  );
  assertEqual(extractCustomerId({ customer: null }), null);
  assertEqual(extractCustomerId({}), null);
});

it("extractProductIds: 重複排除・空除去", () => {
  const ids = extractProductIds({
    line_items: [
      { product_id: 1 },
      { product_id: 2 },
      { product_id: 1 },
      { product_id: null },
    ],
  });
  assertEqual(JSON.stringify(ids), JSON.stringify(["1", "2"]));
});

// ===========================================================================
// 冪等性（二重 webhook）
// ===========================================================================
it("同一注文の二重 claim → 2 回目は claimed:false", async () => {
  const store = makeMemoryStore();
  const key = orderIdempotencyKey({ id: 555 })!;
  assertEqual((await store.claim(key)).claimed, true, "1回目");
  assertEqual((await store.claim(key)).claimed, false, "2回目(再送)");
});

it("異なる注文 → それぞれ claim される", async () => {
  const store = makeMemoryStore();
  assertEqual((await store.claim("shopify:order:1")).claimed, true);
  assertEqual((await store.claim("shopify:order:2")).claimed, true);
});

// ===========================================================================
// handleShopifyOrder（オーケストレーション）
// ===========================================================================
it("注文 → pipeline 呼び出し + lastPurchaseAt 更新", async () => {
  const tagMap = new Map<string, string[]>([["632910392", ["matcha", "rare"]]]);
  const { deps, calls } = makeRecordingDeps(tagMap);
  const order: ShopifyOrderPayload = {
    id: 100,
    created_at: "2026-07-01T10:00:00Z",
    customer: { id: 42 },
    line_items: [{ product_id: 632910392 }],
  };
  const res = await handleShopifyOrder(order, fakeEnv(), deps);

  assertEqual(res.status, "processed");
  assertEqual(res.shopifyCustomerId, "42");
  assertEqual(res.pipelineInvoked, true);
  // pipeline が正しい customer と解決済みタグで呼ばれた
  assertEqual(calls.pipeline.length, 1, "pipeline 呼び出し回数");
  assertEqual(calls.pipeline[0].id, "42");
  assertEqual(
    JSON.stringify(calls.pipeline[0].lineItems),
    JSON.stringify([{ productTags: ["matcha", "rare"] }]),
  );
  // lastPurchaseAt が注文日時で更新された
  assertEqual(calls.updateProfile.length, 1, "updateProfile 回数");
  assertEqual(calls.updateProfile[0].updates.lastPurchaseAt, "2026-07-01T10:00:00Z");
});

it("定期便注文 → isSubscriber:true が伝播", async () => {
  const { deps, calls } = makeRecordingDeps();
  const order: ShopifyOrderPayload = {
    id: 101,
    customer: { id: 43 },
    tags: "subscription",
    line_items: [{ product_id: 1, selling_plan_id: 77 }],
  };
  const res = await handleShopifyOrder(order, fakeEnv(), deps);
  assertEqual(res.status, "processed");
  assertEqual(res.isSubscriber, true);
  assertEqual(calls.updateProfile[0].updates.isSubscriber, true);
  assertTrue(
    typeof calls.updateProfile[0].updates.subscriberUpdatedAt === "string",
    "subscriberUpdatedAt セット",
  );
});

it("通常注文 → isSubscriber は更新しない（false のまま触らない）", async () => {
  const { deps, calls } = makeRecordingDeps();
  const order: ShopifyOrderPayload = {
    id: 102,
    customer: { id: 44 },
    line_items: [{ product_id: 1 }],
  };
  const res = await handleShopifyOrder(order, fakeEnv(), deps);
  assertEqual(res.isSubscriber, false);
  assertEqual("isSubscriber" in calls.updateProfile[0].updates, false);
});

it("guest checkout（顧客 ID 無し）→ スキップ（pipeline も profile も触らない）", async () => {
  const { deps, calls } = makeRecordingDeps();
  const order: ShopifyOrderPayload = {
    id: 103,
    customer: null,
    line_items: [{ product_id: 1 }],
  };
  const res = await handleShopifyOrder(order, fakeEnv(), deps);
  assertEqual(res.status, "skipped_no_customer");
  assertEqual(calls.pipeline.length, 0);
  assertEqual(calls.updateProfile.length, 0);
});

it("Firebase 未設定 → スキップ（属性経路は成立しない）", async () => {
  const { deps, calls } = makeRecordingDeps();
  const order: ShopifyOrderPayload = { id: 104, customer: { id: 45 } };
  const res = await handleShopifyOrder(order, fakeEnv(false), deps);
  assertEqual(res.status, "skipped_firebase_unset");
  assertEqual(calls.pipeline.length, 0);
});

it("タグ解決 0 件でも pipeline は呼ぶ（空タグは pipeline 内で安全にスキップ）", async () => {
  const { deps, calls } = makeRecordingDeps(new Map());
  const order: ShopifyOrderPayload = {
    id: 105,
    customer: { id: 46 },
    line_items: [{ product_id: 9 }],
  };
  const res = await handleShopifyOrder(order, fakeEnv(), deps);
  assertEqual(res.status, "processed");
  assertEqual(calls.pipeline.length, 1);
  assertEqual(
    JSON.stringify(calls.pipeline[0].lineItems),
    JSON.stringify([{ productTags: [] }]),
  );
});

// ===========================================================================
// ペルソナスコア整合（購入 +3 が会話 +1 を上書きしない）
// ===========================================================================
it("会話 serenity+1 済みに explorer 購入 +3 → serenity 保持・explorer 加算", () => {
  // 会話由来の既存スコア
  const existing = { serenity: 1, explorer: 0, sensory: 0 };
  const { scores, primary } = mergePersonaScores(existing, ["explorer"], 3, "serenity");
  assertEqual(scores.serenity, 1, "会話 serenity は消えない（上書きされない）");
  assertEqual(scores.explorer, 3, "購入 explorer は +3");
  assertEqual(scores.sensory, 0);
  assertEqual(primary, "explorer", "primary は最大軸に再計算");
});

it("同一軸は累積加算（会話 +1 の上に購入 +3 = 4）", () => {
  const { scores } = mergePersonaScores({ serenity: 1, explorer: 0, sensory: 0 }, ["serenity"], 3, "serenity");
  assertEqual(scores.serenity, 4);
});

it("既存が優勢なら購入後も primary は据え置き（別軸加算のため）", () => {
  const existing = { serenity: 10, explorer: 0, sensory: 0 };
  const { primary } = mergePersonaScores(existing, ["explorer"], 3, "serenity");
  assertEqual(primary, "serenity", "explorer+3 では serenity(10) を超えない");
});

it("入力を変更しない（純粋・非破壊）", () => {
  const existing = { serenity: 1, explorer: 2, sensory: 3 };
  mergePersonaScores(existing, ["explorer"], 3, null);
  assertEqual(existing.explorer, 2, "元オブジェクトは不変");
});

// ---------------------------------------------------------------------------
// ランナー
// ---------------------------------------------------------------------------
(async () => {
  console.log("\n--- shopify-webhook (T1) ---");
  for (const { name, fn } of queue) {
    totalTests++;
    try {
      await fn();
      passedTests++;
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      failedTests++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${name}: ${msg}`);
      failures.push({ name, error: msg });
    }
  }
  console.log("\n" + "=".repeat(60));
  console.log("Shopify Webhook Unit Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failedTests > 0 ? 1 : 0);
})();
