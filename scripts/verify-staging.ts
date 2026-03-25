/**
 * Staging Deployment Verification Script
 *
 * After deploying to staging with `pnpm deploy:staging`, run this script
 * to verify the deployment is healthy before proceeding to production.
 *
 * Usage:
 *   npx tsx scripts/verify-staging.ts
 *   npx tsx scripts/verify-staging.ts --url https://custom-staging.workers.dev
 *
 * Checks:
 *   1. Health endpoint (GET /) returns 200
 *   2. CORS headers are present on /api/* routes
 *   3. Input validation (400 responses for bad input)
 *   4. Web Chat API responds with SSE stream
 *   5. History API returns valid JSON
 */

import * as crypto from "node:crypto";

const args = process.argv.slice(2);
const customUrl = args.find((a) => a.startsWith("--url="))?.split("=")[1];

const STAGING_URL =
  customUrl ??
  process.env.STAGING_WORKER_URL ??
  "https://elxea-agent-staging.setaka1103.workers.dev";

type CheckResult = {
  name: string;
  pass: boolean;
  details: string;
  critical: boolean;
};

const results: CheckResult[] = [];

function record(name: string, pass: boolean, details: string, critical = true) {
  results.push({ name, pass, details, critical });
  const mark = pass ? "PASS" : "FAIL";
  const criticality = critical ? "" : " (non-critical)";
  console.log(`  [${mark}] ${name}${criticality}: ${details}`);
}

async function safeFetch(
  url: string,
  init?: RequestInit,
): Promise<Response | null> {
  try {
    return await fetch(url, init);
  } catch (err) {
    return null;
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("Staging Deployment Verification");
  console.log(`Target: ${STAGING_URL}`);
  console.log(`Date: ${new Date().toLocaleString("ja-JP")}`);
  console.log("=".repeat(60));

  // 1. Health check
  console.log("\n[1/5] Health Check");
  const health = await safeFetch(`${STAGING_URL}/`);
  if (health) {
    const body = await health.json().catch(() => null);
    const isOk =
      health.status === 200 &&
      body != null &&
      typeof body === "object" &&
      (body as Record<string, unknown>).status === "ok";
    record(
      "GET / health",
      isOk,
      `HTTP ${health.status}, body=${JSON.stringify(body)}`,
    );
  } else {
    record("GET / health", false, "Network error - cannot connect to staging");
    console.log("\nABORT: Cannot connect to staging. Deployment may have failed.");
    process.exit(1);
  }

  // 2. CORS headers
  console.log("\n[2/5] CORS Headers");
  const corsRes = await safeFetch(`${STAGING_URL}/api/chat`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://www.elxea.com",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  if (corsRes) {
    const allowOrigin = corsRes.headers.get("access-control-allow-origin");
    const allowMethods = corsRes.headers.get("access-control-allow-methods");
    record(
      "CORS preflight",
      allowOrigin != null && allowMethods != null,
      `Allow-Origin: ${allowOrigin}, Allow-Methods: ${allowMethods}`,
    );
  } else {
    record("CORS preflight", false, "Network error");
  }

  // 3. Input validation
  console.log("\n[3/5] Input Validation");

  // 3a. Empty message -> 400
  const emptyMsg = await safeFetch(`${STAGING_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "", session_id: crypto.randomUUID() }),
  });
  record(
    "Empty message -> 400",
    emptyMsg?.status === 400,
    `HTTP ${emptyMsg?.status ?? "N/A"}`,
  );

  // 3b. Invalid session_id -> 400
  const badSession = await safeFetch(`${STAGING_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: "test", session_id: "bad" }),
  });
  record(
    "Invalid session_id -> 400",
    badSession?.status === 400,
    `HTTP ${badSession?.status ?? "N/A"}`,
  );

  // 3c. Missing body -> 400
  const noBody = await safeFetch(`${STAGING_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "not-json",
  });
  record(
    "Invalid JSON -> 400",
    noBody?.status === 400,
    `HTTP ${noBody?.status ?? "N/A"}`,
  );

  // 3d. History: invalid session_id -> 400
  const badHistSession = await safeFetch(
    `${STAGING_URL}/api/chat/history?session_id=invalid`,
  );
  record(
    "History: invalid session_id -> 400",
    badHistSession?.status === 400,
    `HTTP ${badHistSession?.status ?? "N/A"}`,
  );

  // 4. Web Chat API smoke test (sends real request to Claude)
  console.log("\n[4/5] Web Chat API Smoke Test");
  const testSessionId = crypto.randomUUID();
  const chatRes = await safeFetch(`${STAGING_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "送料はいくらですか？",
      session_id: testSessionId,
    }),
  });

  if (chatRes && chatRes.status === 200) {
    const rawText = await chatRes.text();
    const events = rawText
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => {
        try {
          return JSON.parse(l.slice(6));
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const hasDone = events.some(
      (e: Record<string, unknown>) => e.type === "done",
    );
    const hasText = events.some(
      (e: Record<string, unknown>) => e.type === "text_delta",
    );

    record(
      "POST /api/chat SSE response",
      hasDone && hasText,
      `HTTP 200, events=${events.length}, has_text=${hasText}, has_done=${hasDone}`,
    );
  } else {
    record(
      "POST /api/chat SSE response",
      false,
      `HTTP ${chatRes?.status ?? "N/A"}`,
      false, // non-critical: could be rate limit or API key issue on staging
    );
  }

  // 5. History API
  console.log("\n[5/5] History API");
  // Wait a moment for the message to be saved
  await new Promise((r) => setTimeout(r, 2000));
  const histRes = await safeFetch(
    `${STAGING_URL}/api/chat/history?session_id=${testSessionId}`,
  );
  if (histRes && histRes.status === 200) {
    const data = (await histRes.json()) as {
      messages: unknown[];
      is_linked: boolean;
    };
    record(
      "GET /api/chat/history",
      Array.isArray(data.messages),
      `HTTP 200, messages=${data.messages.length}, is_linked=${data.is_linked}`,
    );
  } else {
    record(
      "GET /api/chat/history",
      false,
      `HTTP ${histRes?.status ?? "N/A"}`,
      false,
    );
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("Verification Summary");
  console.log("=".repeat(60));

  const criticalFails = results.filter((r) => !r.pass && r.critical);
  const nonCriticalFails = results.filter((r) => !r.pass && !r.critical);
  const passed = results.filter((r) => r.pass);

  console.log(
    `Passed: ${passed.length}/${results.length}` +
      (criticalFails.length > 0
        ? ` | Critical failures: ${criticalFails.length}`
        : "") +
      (nonCriticalFails.length > 0
        ? ` | Non-critical failures: ${nonCriticalFails.length}`
        : ""),
  );

  if (criticalFails.length > 0) {
    console.log("\nCritical failures:");
    for (const f of criticalFails) {
      console.log(`  - ${f.name}: ${f.details}`);
    }
    console.log("\nDO NOT deploy to production until critical failures are resolved.");
    process.exit(1);
  }

  if (nonCriticalFails.length > 0) {
    console.log("\nNon-critical failures (may be expected on staging):");
    for (const f of nonCriticalFails) {
      console.log(`  - ${f.name}: ${f.details}`);
    }
  }

  console.log("\nStaging verification PASSED. Ready for production deploy review.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Verification error:", err);
  process.exit(1);
});
