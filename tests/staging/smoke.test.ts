/**
 * Staging Smoke Test for elxea-cx-agent
 *
 * Verifies that the Worker is reachable and core endpoints respond correctly.
 * Designed to run after staging deployment in CI or manually.
 *
 * Usage:
 *   npx tsx tests/staging/smoke.test.ts
 *   STAGING_WORKER_URL=https://elxea-agent-staging.setaka-on.workers.dev npx tsx tests/staging/smoke.test.ts
 */

const STAGING_URL =
  process.env.STAGING_WORKER_URL || "http://localhost:8787";

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
  // ⚠ パスは `/webhook/line`（`src/index.ts` の `app.post("/webhook/line", lineWebhook)`）。
  //   旧実装は `/webhook` を叩いていたが、そのルートは存在しないため staging / prod の
  //   どちらでも必ず 404 になり、deploy-prod.sh の staging smoke ゲートが恒常的に落ちていた。
  //   署名なしの POST は `lineWebhook` 入口の署名検証で 403 になる（イベント処理は走らず、
  //   利用者へ 1 通も送らない）。ここで確かめるのは「ルートが在ること」だけ。
  const res = await fetch(`${STAGING_URL}/webhook/line`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: [] }),
  });
  // 404 以外なら在る。署名なしなので 403 が期待値。
  if (res.status === 404) {
    throw new Error("Webhook endpoint returned 404 -- route not found (POST /webhook/line)");
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
  await runTest("Webhook endpoint exists (POST /webhook/line)", testWebhookEndpointExists);
  await runTest("Health endpoint returns 200", testHealthEndpoint);

  console.log("");
  console.log("=".repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(50));

  if (failed > 0) {
    process.exit(1);
  }
})();
