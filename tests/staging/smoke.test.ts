/**
 * Staging Smoke Test for elxea-cx-agent
 *
 * Verifies that the Worker is reachable and core endpoints respond correctly.
 * Designed to run after staging deployment in CI or manually.
 *
 * Usage:
 *   npx tsx tests/staging/smoke.test.ts                       # 既定は localhost:8787
 *   STAGING_BASE_URL=https://elxea-agent-staging.setaka-on.workers.dev npx tsx tests/staging/smoke.test.ts
 *
 * 宛先は共有ガード（tests/lib/assert-not-prod）のホワイトリストを必ず通す。
 * staging Worker と localhost 以外（本番 Worker を含む）は送信前に throw して中断する。
 */

import { assertAllowedTestTarget, installTestFetchGuard } from "../lib/assert-not-prod";

installTestFetchGuard("staging smoke test");

const STAGING_URL = assertAllowedTestTarget(
  process.env.STAGING_BASE_URL || process.env.STAGING_WORKER_URL || "http://localhost:8787",
  "staging smoke test STAGING_BASE_URL",
);

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(
      `FAIL: ${name} -- ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

async function testWorkerResponds200(): Promise<void> {
  const res = await fetch(STAGING_URL);
  if (res.status !== 200) {
    throw new Error(`Expected 200 at root, got ${res.status}`);
  }
  const body = (await res.json()) as { status?: string };
  if (body.status !== "ok") {
    throw new Error(`Expected { status: "ok" }, got ${JSON.stringify(body)}`);
  }
}

async function testWebhookEndpointExists(): Promise<void> {
  const res = await fetch(`${STAGING_URL}/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: [] }),
  });
  // Should not be 404. A 400 or 401 without a valid LINE signature is expected.
  if (res.status === 404) {
    throw new Error("Webhook endpoint returned 404 -- route not found");
  }
}

async function testHealthEndpoint(): Promise<void> {
  // The root endpoint serves as the health check for this Worker.
  const res = await fetch(STAGING_URL);
  if (res.status !== 200) {
    throw new Error(`Health check failed with status ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {
  console.log("=".repeat(50));
  console.log("elxea-cx-agent Staging Smoke Test");
  console.log(`Target: ${STAGING_URL}`);
  console.log(`Date:   ${new Date().toISOString()}`);
  console.log("=".repeat(50));
  console.log("");

  await runTest("Worker responds 200 at root", testWorkerResponds200);
  await runTest("Webhook endpoint exists (POST /webhook)", testWebhookEndpointExists);
  await runTest("Health endpoint returns 200", testHealthEndpoint);

  console.log("");
  console.log("=".repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
})();
