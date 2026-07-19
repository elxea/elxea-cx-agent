/**
 * Unit Tests — loadCustomerKarte（「次の一杯」用カルテのローダ・監査 #2）
 *
 * Firestore / Supabase には触れない（依存注入で fake を注入）。検証範囲:
 *   - 連携済み: resolveShopifyId 解決 → users(getShopifyProfile) の persona/tasteProfile を返す
 *   - 未連携 LINE: resolveShopifyId=null かつ U+32hex → lineUsers(getLineProfile) を返す
 *   - fail-safe: Firebase 未設定（getFirestoreEnv throw）→ 空カルテ
 *   - fail-safe: 読取失敗（getShopifyProfile throw）→ 空カルテ
 *   - 非 LINE ID かつ未連携 → 空カルテ（lineUsers を引かない）
 *
 * 使用: npx tsx tests/unit/customer-karte.test.ts
 */

import { loadCustomerKarte, type CustomerKarteDeps } from "../../src/lib/customer-karte";
import type { Env } from "../../src/index";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerProfile, LineUserProfile } from "../../src/lib/firestore";

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

/** Firebase 設定あり相当の env（getFirestoreEnv が成功する最小・PEM 検証は getAccessToken 側で本テストは非到達）。 */
const ENV_WITH_FIREBASE = {
  FIREBASE_PROJECT_ID: "p",
  FIREBASE_CLIENT_EMAIL: "e@example.com",
  FIREBASE_PRIVATE_KEY: "dummy",
} as unknown as Env;

/** Firebase 未設定の env（getFirestoreEnv が throw する）。 */
const ENV_NO_FIREBASE = {} as unknown as Env;

const SB = {} as unknown as SupabaseClient;
const LINE_ID = "U" + "a".repeat(32);

it("連携済み: users の persona/tasteProfile を返す", async () => {
  const profile: CustomerProfile = {
    persona: { primary: "explorer", scores: { serenity: 0, explorer: 3, sensory: 0 }, lastUpdated: "x" },
    tasteProfile: { preferredCategories: ["oolong"], flavorPreferences: ["甘い"], scenePref: "夜" },
  };
  const deps: CustomerKarteDeps = {
    resolveShopifyId: async () => "900800400778",
    getShopifyProfile: async () => profile,
    getLineProfile: async () => {
      throw new Error("未連携経路は呼ばれてはいけない");
    },
  };
  const karte = await loadCustomerKarte(LINE_ID, ENV_WITH_FIREBASE, SB, deps);
  assertEqual(karte.persona, "explorer", "persona");
  assertEqual(karte.tasteProfile?.preferredCategories.join(","), "oolong", "tasteProfile");
});

it("未連携 LINE: lineUsers の persona/tasteProfile を返す", async () => {
  const lineProfile: LineUserProfile = {
    persona: { primary: "serenity", scores: { serenity: 3, explorer: 0, sensory: 0 }, lastUpdated: "x" },
    tasteProfile: { preferredCategories: ["green"], flavorPreferences: [], scenePref: null },
  };
  const deps: CustomerKarteDeps = {
    resolveShopifyId: async () => null, // 未連携
    getShopifyProfile: async () => {
      throw new Error("連携経路は呼ばれてはいけない");
    },
    getLineProfile: async () => lineProfile,
  };
  const karte = await loadCustomerKarte(LINE_ID, ENV_WITH_FIREBASE, SB, deps);
  assertEqual(karte.persona, "serenity", "persona");
  assertEqual(karte.tasteProfile?.preferredCategories.join(","), "green", "tasteProfile");
});

it("fail-safe: Firebase 未設定 → 空カルテ（I/O を試みない）", async () => {
  let touched = false;
  const deps: CustomerKarteDeps = {
    resolveShopifyId: async () => {
      touched = true;
      return "1";
    },
  };
  const karte = await loadCustomerKarte(LINE_ID, ENV_NO_FIREBASE, SB, deps);
  assertEqual(karte.persona, null, "persona=null");
  assertEqual(karte.tasteProfile, null, "tasteProfile=null");
  assertEqual(touched, false, "Firebase 未設定なら resolve に到達しない");
});

it("fail-safe: 読取失敗（getShopifyProfile throw）→ 空カルテ", async () => {
  const deps: CustomerKarteDeps = {
    resolveShopifyId: async () => "1",
    getShopifyProfile: async () => {
      throw new Error("firestore down");
    },
  };
  const karte = await loadCustomerKarte(LINE_ID, ENV_WITH_FIREBASE, SB, deps);
  assertEqual(karte.persona, null, "persona=null");
  assertEqual(karte.tasteProfile, null, "tasteProfile=null");
});

it("非 LINE ID かつ未連携 → 空カルテ（lineUsers を引かない）", async () => {
  let lineTouched = false;
  const deps: CustomerKarteDeps = {
    resolveShopifyId: async () => null,
    getLineProfile: async () => {
      lineTouched = true;
      return null;
    },
  };
  const karte = await loadCustomerKarte("web-anon-123", ENV_WITH_FIREBASE, SB, deps);
  assertEqual(karte.persona, null, "persona=null");
  assertEqual(lineTouched, false, "非 LINE ID は lineUsers を引かない");
});

(async () => {
  for (const t of queue) {
    total++;
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failures.push(`${t.name}`);
      console.log(`  [FAIL] ${t.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("\n============================================================");
  console.log("customer-karte Test Results");
  console.log("============================================================");
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${total - passed}`);
  if (failures.length > 0) process.exit(1);
})();
