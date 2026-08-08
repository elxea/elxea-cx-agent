/**
 * Unit Tests — 消す順番（独立レビュー指摘 F1）
 *
 * 一次入力（仕様の正本）: rojiカルテの項目 — 最終形の定義 図2
 *   https://www.notion.so/3b570c9d064c81669025cdbe1064b12c
 *
 * ─ 何を守るテストか ─
 *   消去は **特定 → Firestore → Supabase** の順でなければならない。
 *   別名表（customer_linkages / user_identity_map）は「LINE の ID ↔ EC 上の顧客番号」の
 *   対応そのもので、**本人を特定する唯一の手がかり**。これを先に消すと、
 *   そのあと Firestore の消去が失敗したとき、再送しても誰なのか分からなくなり、
 *   未連携カルテが永久に消えないまま「消えました」と報告される。
 *
 *   よってここでは次の 3 つを機械で固定する:
 *     1. 呼び出しの順番が 特定 → Firestore → Supabase であること
 *     2. Firestore が失敗したら **Supabase の消去に進まない**こと
 *        （＝別名表が生き残り、再送で同じ人を特定できる）
 *     3. 消し残しがあるとき clean=true を返さないこと
 *
 * Supabase / Firestore には触れない（fetch を差し替えて呼び出しを記録する）。
 *
 * 使用: npx tsx tests/unit/roji-erasure-order.test.ts
 */

import { generateKeyPairSync } from "node:crypto";
import { erasePerson } from "../../src/lib/roji-erasure";

/**
 * その場限りの鍵。Firestore の署名処理を通すためだけのもので、外部には一切出さない
 * （fetch は下で差し替えてあり、実際の Google には接続しない）。
 */
const { privateKey: EPHEMERAL_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

let total = 0;
let passed = 0;
const failures: string[] = [];

async function it(name: string, fn: () => void | Promise<void>) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  [FAIL] ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
function assertEqual<T>(a: T, e: T, label = "") {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertTrue(v: boolean, label = "") {
  if (!v) throw new Error(`${label}: expected true`);
}

const ENV = {
  SUPABASE_URL: "https://fake.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "fake-key",
  FIREBASE_PROJECT_ID: "fake-project",
  FIREBASE_CLIENT_EMAIL: "fake@example.invalid",
  FIREBASE_PRIVATE_KEY: EPHEMERAL_KEY,
} as never;

const IDENTITY = {
  shopify_ids: ["123456"],
  line_ids: ["Uline1"],
  web_refs: [],
  person_seqs: [1],
};

/**
 * fetch を差し替え、呼び出しの種類を순に記録する。
 * Firestore のアクセストークン取得も差し替える（外部に出さない）。
 */
function installFakeFetch(opts: { firestoreFails?: boolean; residueDirty?: boolean }) {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    // Google のトークン発行（Firestore アクセスの前段）。外に出さない。
    if (url.includes("oauth2") || url.includes("googleapis.com/token") || url.includes("token")) {
      if (url.includes("firestore.googleapis.com")) {
        // 下の Firestore 分岐に流す
      } else {
        return json({ access_token: "fake-token", expires_in: 3600 });
      }
    }

    if (url.includes("/rest/v1/rpc/roji_resolve_identity")) {
      calls.push("resolve");
      return json(IDENTITY);
    }
    if (url.includes("/rest/v1/rpc/roji_erase_person")) {
      calls.push("supabase_erase");
      return json({
        words_deleted: 1,
        ledger_rows_deleted: 1,
        person_deleted: 1,
        identity: IDENTITY,
        deleted: { conversations: 1 },
      });
    }
    if (url.includes("/rest/v1/rpc/roji_erasure_residue")) {
      calls.push("residue");
      return json({
        remaining: opts.residueDirty ? { conversations: 1 } : { conversations: 0 },
        preserved: { roji_edit_records: 1 },
        clean: !opts.residueDirty,
      });
    }
    if (url.includes("firestore.googleapis.com")) {
      calls.push("firestore");
      if (opts.firestoreFails) return json({ error: "boom" }, 500);
      // listCollectionIds / runQuery / GET / DELETE すべてに空の成功を返す。
      if (url.includes("listCollectionIds")) return json({ collectionIds: [] });
      if (url.includes("runQuery")) return json([]);
      if (init?.method === "DELETE") return json({});
      return json({}, 404); // docExists → 無い
    }
    return json({}, 404);
  }) as typeof fetch;

  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
}

async function main() {
  console.log("\n=== 消す順番（特定 → Firestore → Supabase）===");

  await it("特定が Firestore より先、Supabase の消去が最後に呼ばれる", async () => {
    const fake = installFakeFetch({});
    try {
      await erasePerson(ENV, { kind: "line", id: "Uline1" });
    } finally {
      fake.restore();
    }
    const first = fake.calls.indexOf("resolve");
    const firstFs = fake.calls.indexOf("firestore");
    const erase = fake.calls.indexOf("supabase_erase");
    assertTrue(first >= 0, "特定が呼ばれていない");
    assertTrue(firstFs >= 0, "Firestore が呼ばれていない");
    assertTrue(erase >= 0, "Supabase の消去が呼ばれていない");
    assertTrue(first < firstFs, `特定が Firestore より後（calls=${fake.calls.join(">")}）`);
    assertTrue(
      firstFs < erase,
      `Supabase の消去が Firestore より先に走っている（calls=${fake.calls.join(">")}）` +
        " — この順だと途中で失敗したとき本人を特定できなくなる",
    );
  });

  await it("Firestore が失敗したら、Supabase の消去に進まない（別名表が生き残る）", async () => {
    const fake = installFakeFetch({ firestoreFails: true });
    let threw = false;
    try {
      await erasePerson(ENV, { kind: "line", id: "Uline1" });
    } catch {
      threw = true;
    } finally {
      fake.restore();
    }
    assertTrue(threw, "Firestore が失敗したのに例外が伝播していない");
    assertEqual(
      fake.calls.includes("supabase_erase"),
      false,
      "Firestore 失敗後に Supabase の消去が走った（別名表が消え、再送で本人を特定できなくなる）",
    );
  });

  await it("消し残しがあれば clean = false を返す（成功と報告しない）", async () => {
    const fake = installFakeFetch({ residueDirty: true });
    try {
      const r = await erasePerson(ENV, { kind: "line", id: "Uline1" });
      assertEqual(r.clean, false, "消し残しがあるのに clean = true");
    } finally {
      fake.restore();
    }
  });

  console.log(`\n=== 結果: ${passed}/${total} PASS ===`);
  if (failures.length > 0) {
    console.error("\n失敗:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("[FATAL]", e);
  process.exit(1);
});
