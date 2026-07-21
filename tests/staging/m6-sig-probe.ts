/**
 * M6 署名プローブ — staging worker の LINE webhook 署名検証が手元の secret と一致するかだけを測る。
 *
 * events: [] の空ボディを送るので、署名検証を通っても **エージェント処理は一切起きない**
 * （processEvents がループを 0 回回して終わる）。LINE への送信も発生しない。
 *
 * 使い方: STAGING_BASE_URL=... npx tsx tests/staging/m6-sig-probe.ts
 */
import dotenv from "dotenv";
import * as crypto from "node:crypto";
import {
  assertAllowedTestTarget,
  installTestFetchGuard,
  resolveStagingBaseUrl,
} from "../lib/assert-not-prod";

dotenv.config({ path: ".dev.vars" });
installTestFetchGuard("m6-sig-probe");

const STAGING_URL = resolveStagingBaseUrl(undefined, "m6-sig-probe STAGING_BASE_URL");

async function main() {
  console.log(`Target: ${STAGING_URL}/webhook/line`);
  const body = JSON.stringify({ destination: "Uffffffffffffffffffffffffffffffff", events: [] });

  const candidates: Array<[string, string | undefined]> = [
    ["LINE_CHANNEL_SECRET_TEST", process.env.LINE_CHANNEL_SECRET_TEST],
    ["LINE_CHANNEL_SECRET", process.env.LINE_CHANNEL_SECRET],
    ["(garbage control)", "0".repeat(32)],
  ];

  for (const [label, secret] of candidates) {
    if (!secret) {
      console.log(`  ${label}: 未設定 (skip)`);
      continue;
    }
    const sig = crypto.createHmac("sha256", secret).update(body).digest("base64");
    const target = assertAllowedTestTarget(`${STAGING_URL}/webhook/line`, "m6-sig-probe");
    const res = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-line-signature": sig },
      body,
    }).catch((e) => {
      console.log(`  ${label}: fetch 失敗 ${e instanceof Error ? e.message : e}`);
      return null;
    });
    console.log(`  ${label}: HTTP ${res?.status ?? "n/a"}`);
  }
}

main().catch((e) => {
  console.error("[FATAL]", e instanceof Error ? e.message : e);
  process.exit(1);
});
