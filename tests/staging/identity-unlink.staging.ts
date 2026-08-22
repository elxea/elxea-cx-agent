/**
 * Staging 実証 -- 連携解除の HTTP 入口 と 本人解決の逆引き
 *
 * デプロイ済みの staging Worker に実際の HTTP を投げて、ユニットテストでは
 * 確かめられない「本当に配線されているか」を確認する。
 *
 * 確認する契約:
 *   1. 認証なし / 誤 API key → 401（fail-closed・ブラウザ直叩き不可）
 *   2. ルートが存在する（401 が返る = 404 ではない）
 *   3. 入力検証 — shopify_customer_id 欠落・非数値 → 400 /
 *      line_user_id の形式不正 → 400 / linkage-status の両方指定 → 400
 *   4. 逆引きが動く — 未連携の LINE userId で linked=false が返る
 *   5. 解除が冪等 — 連携の無い顧客に対して cleared_count=0 で 200
 *   6. 最小開示 — 応答に LINE の生 ID が現れない
 *
 * ⚠ 実データを壊さないため、**存在しないテスト用 ID** だけを使う。
 *   実在顧客の連携を外す操作はしない。LINE への送信も発生しない
 *   （このエンドポイントはメッセージを送らない）。
 *
 * ⚠ 秘密の扱い: SYNC_API_SECRET は環境から読むだけで、**値を出力しない**。
 *
 * 使用方法:
 *   STAGING_WORKER_URL=https://elxea-agent-staging.setaka-on.workers.dev \
 *   SYNC_API_SECRET_STAGING=*** npx tsx tests/staging/identity-unlink.staging.ts
 */

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".dev.vars", quiet: true });
loadEnv({ quiet: true });

const STAGING_URL =
  process.env.STAGING_WORKER_URL ||
  "https://elxea-agent-staging.setaka-on.workers.dev";

/** staging 用の共有秘密。値は絶対に出力しない。 */
const SECRET =
  process.env.SYNC_API_SECRET_STAGING || process.env.SYNC_API_SECRET || "";

/** 実在しないテスト用 ID（実データを触らないため）。 */
const TEST_CUSTOMER_ID = "999000999000";
const TEST_LINE_USER_ID = "Udeadbeefdeadbeefdeadbeefdeadbeef";

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`FAIL: ${name} -- ${msg}`);
    failures.push(`${name}: ${msg}`);
  }
}

function expectStatus(actual: number, expected: number, ctx: string): void {
  if (actual !== expected) {
    throw new Error(`${ctx}: expected HTTP ${expected}, got ${actual}`);
  }
}

async function postUnlink(
  body: unknown,
  apiKey?: string,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  const res = await fetch(`${STAGING_URL}/api/identity/unlink`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function getLinkageStatus(
  query: string,
  apiKey?: string,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["X-API-Key"] = apiKey;
  const res = await fetch(
    `${STAGING_URL}/api/identity/linkage-status?${query}`,
    { headers },
  );
  return { status: res.status, text: await res.text() };
}

(async () => {
  console.log(`\nStaging identity unlink / reverse linkage checks`);
  console.log(`Target: ${STAGING_URL}\n`);

  // --- 1. 認証（秘密が無くても実行できる部分） ---------------------------

  await runTest("認証なしの unlink → 401（fail-closed）", async () => {
    const r = await postUnlink({ shopify_customer_id: TEST_CUSTOMER_ID });
    expectStatus(r.status, 401, "unlink without key");
  });

  await runTest("誤 API key の unlink → 401", async () => {
    const r = await postUnlink(
      { shopify_customer_id: TEST_CUSTOMER_ID },
      "definitely-wrong-key",
    );
    expectStatus(r.status, 401, "unlink with wrong key");
  });

  await runTest("認証なしの逆引き → 401（LINE ID 総当たりを塞ぐ）", async () => {
    const r = await getLinkageStatus(`line_user_id=${TEST_LINE_USER_ID}`);
    expectStatus(r.status, 401, "reverse lookup without key");
  });

  await runTest("ルートが存在する（404 ではなく 401 が返る）", async () => {
    const missing = await fetch(`${STAGING_URL}/api/identity/does-not-exist`, {
      method: "POST",
    });
    expectStatus(missing.status, 404, "nonexistent route sanity check");
    const r = await postUnlink({ shopify_customer_id: TEST_CUSTOMER_ID });
    if (r.status === 404) throw new Error("unlink route not deployed (404)");
  });

  // --- 2. 認証つき（秘密が無ければ skip） --------------------------------

  if (!SECRET) {
    console.log(
      "\nSKIP: SYNC_API_SECRET(_STAGING) が環境にないため、認証つきの検証は実行しない。",
    );
  } else {
    await runTest("shopify_customer_id 欠落 → 400", async () => {
      const r = await postUnlink({}, SECRET);
      expectStatus(r.status, 400, "unlink without customer id");
    });

    await runTest("shopify_customer_id が非数値 → 400", async () => {
      const r = await postUnlink(
        { shopify_customer_id: "not-a-number" },
        SECRET,
      );
      expectStatus(r.status, 400, "unlink with bad customer id");
    });

    await runTest("line_user_id の形式が不正 → 400", async () => {
      const r = await postUnlink(
        { shopify_customer_id: TEST_CUSTOMER_ID, line_user_id: "bad" },
        SECRET,
      );
      expectStatus(r.status, 400, "unlink with bad line id");
    });

    await runTest("逆引きと順引きの同時指定 → 400（曖昧に答えない）", async () => {
      const r = await getLinkageStatus(
        `shopify_customer_id=${TEST_CUSTOMER_ID}&line_user_id=${TEST_LINE_USER_ID}`,
        SECRET,
      );
      expectStatus(r.status, 400, "both params");
    });

    await runTest("逆引きが動く — 未連携の LINE → linked=false", async () => {
      const r = await getLinkageStatus(
        `line_user_id=${TEST_LINE_USER_ID}`,
        SECRET,
      );
      expectStatus(r.status, 200, "reverse lookup");
      const body = JSON.parse(r.text) as {
        linked?: boolean;
        shopify_customer_id?: string | null;
      };
      if (body.linked !== false) {
        throw new Error(`expected linked=false, got ${JSON.stringify(body)}`);
      }
      if (body.shopify_customer_id !== null) {
        throw new Error("未連携なのに顧客 ID が返っている");
      }
    });

    await runTest(
      "解除は冪等 — 連携の無い顧客で cleared_count=0 の 200",
      async () => {
        const r = await postUnlink(
          { shopify_customer_id: TEST_CUSTOMER_ID },
          SECRET,
        );
        expectStatus(r.status, 200, "idempotent unlink");
        const body = JSON.parse(r.text) as {
          success?: boolean;
          cleared_count?: number;
        };
        if (body.success !== true) throw new Error("success ではない");
        if (body.cleared_count !== 0) {
          throw new Error(
            `外すものが無いのに cleared_count=${body.cleared_count}`,
          );
        }
      },
    );

    await runTest("応答に LINE の生 ID が現れない（最小開示）", async () => {
      const r = await postUnlink(
        { shopify_customer_id: TEST_CUSTOMER_ID },
        SECRET,
      );
      if (r.text.includes(TEST_LINE_USER_ID) || /"U[0-9a-f]{32}"/.test(r.text)) {
        throw new Error("応答に LINE userId が含まれている");
      }
    });

    // --- 3. 往復の実証（連携 → 解決 → 解除 → 遮断） --------------------
    //
    // ここが本 PR の主旨そのもの。ユニットテストは mock なので、
    // 「実際の台帳に書いて、実際に引けて、実際に消える」ことは staging でしか示せない。
    // 使うのは実在しないテスト用 ID だけ。LINE への送信は発生しない
    // （link-liff / unlink はどちらもメッセージを送らない）。

    await runTest(
      "往復: 連携 → 逆引きが Shopify 顧客に解決 → 解除 → 解決しなくなる",
      async () => {
        // (1) 連携を作る（既存の link-liff 経路）
        const linkRes = await fetch(`${STAGING_URL}/api/identity/link-liff`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": SECRET,
          },
          body: JSON.stringify({
            line_messaging_user_id: TEST_LINE_USER_ID,
            shopify_customer_id: TEST_CUSTOMER_ID,
          }),
        });
        expectStatus(linkRes.status, 200, "link-liff");

        try {
          // (2) 逆引きが Shopify 顧客に解決する（= マイページ分裂が塞がる条件）
          const after = await getLinkageStatus(
            `line_user_id=${TEST_LINE_USER_ID}`,
            SECRET,
          );
          expectStatus(after.status, 200, "reverse lookup after link");
          const linked = JSON.parse(after.text) as {
            linked?: boolean;
            shopify_customer_id?: string | null;
          };
          if (linked.linked !== true) {
            throw new Error(
              `連携したのに linked=false: ${JSON.stringify(linked)}`,
            );
          }
          if (linked.shopify_customer_id !== TEST_CUSTOMER_ID) {
            throw new Error(
              `解決先が違う: ${linked.shopify_customer_id} != ${TEST_CUSTOMER_ID}`,
            );
          }
        } finally {
          // (3) 解除する（後片付けも兼ねる。失敗しても必ず実行する）
          const unlinkRes = await postUnlink(
            { shopify_customer_id: TEST_CUSTOMER_ID },
            SECRET,
          );
          expectStatus(unlinkRes.status, 200, "unlink");
          const cleared = JSON.parse(unlinkRes.text) as {
            cleared_count?: number;
          };
          if (cleared.cleared_count !== 1) {
            throw new Error(
              `実際に解除された件数が 1 でない: ${cleared.cleared_count}`,
            );
          }
        }

        // (4) 解除後は解決しない（＝解除が本人解決に効いている）
        const blocked = await getLinkageStatus(
          `line_user_id=${TEST_LINE_USER_ID}`,
          SECRET,
        );
        expectStatus(blocked.status, 200, "reverse lookup after unlink");
        const gone = JSON.parse(blocked.text) as {
          linked?: boolean;
          shopify_customer_id?: string | null;
        };
        if (gone.linked !== false || gone.shopify_customer_id !== null) {
          throw new Error(
            `解除したのにまだ解決する: ${JSON.stringify(gone)}`,
          );
        }
      },
    );

    await runTest("解除は二度押しでも壊れない（冪等・2 回目は 0 件）", async () => {
      const r = await postUnlink(
        { shopify_customer_id: TEST_CUSTOMER_ID },
        SECRET,
      );
      expectStatus(r.status, 200, "second unlink");
      const body = JSON.parse(r.text) as { cleared_count?: number };
      if (body.cleared_count !== 0) {
        throw new Error(`2 回目なのに cleared_count=${body.cleared_count}`);
      }
    });
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Staging checks -- Passed: ${passed}, Failed: ${failed}`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  console.log("=".repeat(60));
  process.exit(failed > 0 ? 1 : 0);
})();
