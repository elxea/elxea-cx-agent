/**
 * Unit Tests -- sync/knowledge (FIX-2: 同期失敗の可視化)
 *
 * 検証内容（Spec v3 FIX-2 完了条件の unit 部分）:
 *   - 必須テーブル不在（preflight 失敗）で runKnowledgeSync がエラー終了する
 *   - sync_logs への insert 失敗で runKnowledgeSync がエラー終了する
 *   - 投げられるエラーが SyncLedgerError である（明確なエラー）
 *
 * 本番 DB には一切接続しない。Supabase クライアントをモック注入して
 * 「握りつぶさず throw する」ことのみを検証する。SLACK_WEBHOOK_URL を渡さないため
 * 外部送信も発生しない（notifySyncFailure は未設定で即 return）。
 *
 * 使用方法:
 *   npx tsx tests/unit/sync-knowledge.test.ts
 */

import { runKnowledgeSync, SyncLedgerError } from "../../src/sync/knowledge";
import type { Env } from "../../src/index";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// 非同期対応テストハーネス（外部依存なし）
// ---------------------------------------------------------------------------

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];

async function it(testName: string, fn: () => Promise<void>) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  [PASS] ${testName}`);
  } catch (err) {
    failedTests++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${testName}: ${msg}`);
    failures.push({ name: testName, error: msg });
  }
}

async function assertRejects(
  fn: () => Promise<unknown>,
  label: string,
): Promise<void> {
  let threw = false;
  let resolvedValue: unknown;
  try {
    resolvedValue = await fn();
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(
      `${label}: expected the call to reject, but it resolved with ${JSON.stringify(resolvedValue)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Supabase クライアントのモック
// ---------------------------------------------------------------------------

type MockOpts = {
  preflightError?: { message: string; code?: string };
  insertError?: { message: string };
};

/**
 * 必要最小限のモック。
 * - preflight: from(table).select(cols, opts) を await → { error } を返す
 * - insert:    from("sync_logs").insert(row).select("id").single() → { data, error }
 * どちらの失敗経路もここより先（Notion / AI 呼び出し）へは到達しない。
 */
function makeMockSupabase(opts: MockOpts): SupabaseClient {
  const selectResolved = opts.preflightError
    ? { data: null, error: opts.preflightError, count: null }
    : { data: [], error: null, count: 0 };

  const singleResolved = opts.insertError
    ? { data: null, error: opts.insertError }
    : { data: { id: "test-log-id" }, error: null };

  return {
    from(_table: string) {
      return {
        // preflight 経路（await 可能な thenable）
        select(_cols?: unknown, _options?: unknown) {
          return Promise.resolve(selectResolved);
        },
        // insert 経路
        insert(_row: unknown) {
          return {
            select(_cols?: unknown) {
              return {
                single() {
                  return Promise.resolve(singleResolved);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

const TEST_ENV = {} as Env; // SLACK_WEBHOOK_URL 未設定 → 外部送信なし

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n--- runKnowledgeSync FIX-2 failure paths ---");

  await it("preflight: 必須テーブル不在で同期がエラー終了する", async () => {
    const mock = makeMockSupabase({
      preflightError: {
        message: 'relation "public.sync_logs" does not exist',
        code: "42P01",
      },
    });
    await assertRejects(
      () => runKnowledgeSync(TEST_ENV, "incremental", mock),
      "runKnowledgeSync should reject when a required table is missing",
    );
  });

  await it("sync_logs insert 失敗で同期がエラー終了する", async () => {
    const mock = makeMockSupabase({ insertError: { message: "insert boom" } });
    await assertRejects(
      () => runKnowledgeSync(TEST_ENV, "incremental", mock),
      "runKnowledgeSync should reject when sync_logs insert fails",
    );
  });

  await it("投げられるエラーは SyncLedgerError である", async () => {
    const mock = makeMockSupabase({ insertError: { message: "insert boom" } });
    let caught: unknown;
    try {
      await runKnowledgeSync(TEST_ENV, "incremental", mock);
    } catch (e) {
      caught = e;
    }
    if (!(caught instanceof SyncLedgerError)) {
      throw new Error(
        `expected SyncLedgerError, got ${caught instanceof Error ? caught.name : typeof caught}`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // 結果サマリー
  // -------------------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log("Sync Knowledge (FIX-2) Unit Test Results");
  console.log("=".repeat(60));
  console.log(
    `Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`,
  );

  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.error}`);
    }
  }

  process.exit(failedTests > 0 ? 1 : 0);
}

main();
