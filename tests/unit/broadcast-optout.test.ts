/**
 * Unit Tests -- setBroadcastOptOut（配信 opt-out 停止/再開・UX レビュー指摘 #3）
 *
 * 検証範囲:
 *   (a) LINE 停止:  customer_linkages を line_user_id キーで upsert し broadcast_opted_out=true
 *   (b) LINE 再開:  同 upsert で broadcast_opted_out=false（再開が効く）
 *   (c) Web 停止:   shopify_customer_id 一致行を update（line 行の作成はしない）
 *   (d) fail-safe:  DB エラーは throw せず ok=false・断定しない失敗文言を返す
 *   (e) 未連携 LINE: 行が無くても upsert（onConflict=line_user_id）で確実に永続化する経路
 *
 * 実 Supabase / 実ネットワークには一切触れない（fake client を注入）。
 * 使用方法: npx tsx tests/unit/broadcast-optout.test.ts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../../src/index";
import { setBroadcastOptOut } from "../../src/lib/broadcast-optout";

// --- async 対応テストハーネス（外部依存なし） ---
let total = 0,
  passed = 0,
  failed = 0;
const failures: Array<{ name: string; error: string }> = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function it(name: string, fn: () => void | Promise<void>) {
  queue.push({ name, fn });
}
function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected)
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const env = {} as Env;

type Call =
  | { op: "upsert"; table: string; values: Record<string, unknown>; options: unknown }
  | { op: "update"; table: string; values: Record<string, unknown>; eqCol: string; eqVal: unknown };

function makeFakeSupabase(opts?: { failOn?: "upsert" | "update" }) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      return {
        upsert(values: Record<string, unknown>, options: unknown) {
          calls.push({ op: "upsert", table, values, options });
          return Promise.resolve({
            error: opts?.failOn === "upsert" ? { message: "boom" } : null,
          });
        },
        update(values: Record<string, unknown>) {
          return {
            eq(eqCol: string, eqVal: unknown) {
              calls.push({ op: "update", table, values, eqCol, eqVal });
              return Promise.resolve({
                error: opts?.failOn === "update" ? { message: "boom" } : null,
              });
            },
          };
        },
      };
    },
  };
  return { supabase: client as unknown as SupabaseClient, calls };
}

it("(a) LINE 停止: line_user_id キーで upsert・broadcast_opted_out=true", async () => {
  const { supabase, calls } = makeFakeSupabase();
  const res = await setBroadcastOptOut("U" + "a".repeat(32), "line", true, env, { supabase });
  assert(res.ok, "ok true");
  assertEqual(res.optedOut, true, "optedOut");
  assert(res.text.includes("停止"), "stop message");
  assertEqual(calls.length, 1, "one call");
  const c = calls[0];
  assert(c.op === "upsert" && c.table === "customer_linkages", "upsert customer_linkages");
  if (c.op === "upsert") {
    assertEqual(c.values.line_user_id, "U" + "a".repeat(32), "line_user_id set");
    assertEqual(c.values.broadcast_opted_out, true, "flag true");
    assert(
      !("shopify_customer_id" in c.values),
      "shopify_customer_id は触らない（連携情報を壊さない）",
    );
    assertEqual((c.options as { onConflict?: string }).onConflict, "line_user_id", "onConflict line_user_id");
  }
});

it("(b) LINE 再開: broadcast_opted_out=false（再開が効く）", async () => {
  const { supabase, calls } = makeFakeSupabase();
  const res = await setBroadcastOptOut("U" + "b".repeat(32), "line", false, env, { supabase });
  assert(res.ok, "ok true");
  assertEqual(res.optedOut, false, "optedOut false");
  assert(res.text.includes("再開"), "resume message");
  const c = calls[0];
  if (c.op === "upsert") assertEqual(c.values.broadcast_opted_out, false, "flag false");
});

it("(c) Web 停止: shopify_customer_id 一致行を update（line 行は作らない）", async () => {
  const { supabase, calls } = makeFakeSupabase();
  const res = await setBroadcastOptOut("99887766", "web", true, env, { supabase });
  assert(res.ok, "ok true");
  const c = calls[0];
  assert(c.op === "update" && c.table === "customer_linkages", "update customer_linkages");
  if (c.op === "update") {
    assertEqual(c.eqCol, "shopify_customer_id", "eq shopify_customer_id");
    assertEqual(c.eqVal, "99887766", "eq value");
    assertEqual(c.values.broadcast_opted_out, true, "flag true");
  }
});

it("(d) fail-safe: DB エラーは throw せず ok=false・断定しない失敗文言", async () => {
  const { supabase } = makeFakeSupabase({ failOn: "upsert" });
  const res = await setBroadcastOptOut("U" + "c".repeat(32), "line", true, env, { supabase });
  // ok=false が「成功と断定させない」ための機械的な唯一の根拠（呼び出し側はこれで分岐する）。
  assertEqual(res.ok, false, "ok false on error");
  assert(res.text.includes("失敗"), "失敗文言");
});

it("(e) 未連携 LINE でも upsert で永続化（onConflict=line_user_id・行作成経路）", async () => {
  // 行が存在しないケースでも upsert は同一呼び出しで INSERT 経路になる（衝突キー line_user_id）。
  const { supabase, calls } = makeFakeSupabase();
  await setBroadcastOptOut("U" + "d".repeat(32), "line", true, env, { supabase });
  const c = calls[0];
  assert(c.op === "upsert", "upsert（update ではない = 行が無くても作成できる）");
  if (c.op === "upsert")
    assertEqual((c.options as { onConflict?: string }).onConflict, "line_user_id", "onConflict");
});

// --- ランナー ---
(async () => {
  console.log("\n--- setBroadcastOptOut Unit Tests ---");
  for (const t of queue) {
    total++;
    try {
      await t.fn();
      passed++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${t.name}: ${msg}`);
      failures.push({ name: t.name, error: msg });
    }
  }
  console.log("\n" + "=".repeat(60));
  console.log(`Total: ${total}, Passed: ${passed}, Failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
