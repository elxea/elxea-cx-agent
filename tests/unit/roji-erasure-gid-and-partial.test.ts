/**
 * Unit Tests — 消去 API の「偽の clean」と「途中終了 = 失敗」を潰す（修正 F6）
 *
 * 一次入力（仕様の正本）: rojiカルテの項目 — 最終形の定義 図2
 *   https://www.notion.so/3b570c9d064c81669025cdbe1064b12c
 *
 * ─ 何を守るテストか ─
 *   実データの初期化作業で 2 つの欠陥が実証された。どちらも「消していないのに消したと言う」形。
 *
 *   (F6-1) ID の形が揃っていない
 *     Supabase の別名表には EC 上の顧客番号が "7654321" と
 *     "gid://shopify/Customer/7654321" の **2 つの形**で入っている。Firestore は
 *     数字のほうでしか掘れない。旧実装は「数字でなければ飛ばす」判定を
 *     消す側 2 か所・検算側 1 か所に散らしていたため、gid 形式の人は
 *     **1 件も消さないのに検算も同じ理由で 0 件と数え、clean=true を返した**。
 *     → 形を揃える関数を 1 つに定め、消す側と検算側が**同じ集合**を見ることを固定する。
 *     → 揃えられない ID は黙って捨てず residue に出る（数えられないものを「無い」と言わない）。
 *
 *   (F6-2) 途中で力尽きたときに「失敗」と言う
 *     1 リクエストで消しきれない量（Cloudflare Workers の subrequest 上限）に当たると、
 *     旧実装は途中まで消したうえで例外を投げ、呼び出し側には HTTP 500 erase_failed しか
 *     見えなかった（実測: 21 doc で発生）。再送すれば進む状態なのに失敗にしか見えない。
 *     → 上限に当たったら例外にせず「続きが要る（202 / continue_required）」を返す。
 *     → ただし **本物の失敗（Firestore 500 等）を「続きが要る」に化かしてはならない**
 *        （それは同じ嘘を別の形で作ることになる）。ここも固定する。
 *
 * Supabase / Firestore / ネットワークには触れない（fetch を差し替えた偽の置き場を使う）。
 *
 * 使用: npx tsx tests/unit/roji-erasure-gid-and-partial.test.ts
 */

import { generateKeyPairSync } from "node:crypto";
import worker from "../../src/index";
import { LINE_USERS_COLLECTION } from "../../src/lib/firestore";
import {
  erasePerson,
  firestoreKeys,
  normalizeShopifyCustomerId,
  type ResolvedIdentity,
} from "../../src/lib/roji-erasure";

/** その場限りの鍵（fetch は差し替え済みで、実際の Google には接続しない）。 */
const { privateKey: EPHEMERAL_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const PROJECT = "fake-project";
const DOC_PREFIX = `projects/${PROJECT}/databases/(default)/documents/`;
const FS_BASE = `https://firestore.googleapis.com/v1/${DOC_PREFIX}`.replace(/\/$/, "");

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
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function assertTrue(v: boolean, label = "") {
  if (!v) throw new Error(`${label}: expected true`);
}

function baseEnv(extra: Record<string, string> = {}) {
  return {
    SUPABASE_URL: "https://fake.supabase.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "fake-key",
    FIREBASE_PROJECT_ID: PROJECT,
    FIREBASE_CLIENT_EMAIL: "fake@example.invalid",
    FIREBASE_PRIVATE_KEY: EPHEMERAL_KEY,
    ERASE_API_SECRET: "fake-erase-secret",
    ...extra,
  } as never;
}

// ---------------------------------------------------------------------------
// 偽の Firestore（メモリ上の置き場）— 実際に「消えたか」を観測できる形にする
// ---------------------------------------------------------------------------

type Fake = {
  /** 存在するドキュメントのパス（例: "users/7654321", "users/7654321/orders/o1"）。 */
  docs: Set<string>;
  /** comments/{id} -> authorId */
  authors: Map<string, string>;
  /** 消しても消えないドキュメント（消し残しの模擬）。 */
  undeletable: Set<string>;
  /** すべてのリクエスト URL（gid が混ざっていないかの検査に使う）。 */
  urls: string[];
  /** runQuery に渡された照合値。 */
  queriedValues: string[];
  /** Supabase RPC の呼び出し順。 */
  calls: string[];
  /** n 回目以降の Firestore 呼び出しで Cloudflare の上限例外を投げる（0 = 投げない）。 */
  throwCapacityAfter: number;
  /** Firestore が HTTP 500 を返し始める呼び出し回数（0 = 返さない）。 */
  serverErrorAfter: number;
  fsCalls: number;
  restore(): void;
};

function docsIn(fake: Fake, collectionPath: string): string[] {
  const prefix = `${collectionPath}/`;
  return [...fake.docs].filter((d) => d.startsWith(prefix) && !d.slice(prefix.length).includes("/"));
}

function subcollectionsOf(fake: Fake, docPath: string): string[] {
  const prefix = `${docPath}/`;
  const out = new Set<string>();
  for (const d of fake.docs) {
    if (!d.startsWith(prefix)) continue;
    const rest = d.slice(prefix.length).split("/");
    if (rest.length >= 2 && rest[0]) out.add(rest[0]);
  }
  return [...out];
}

function installFake(opts: {
  docs?: string[];
  authors?: Record<string, string>;
  undeletable?: string[];
  identity: ResolvedIdentity;
  supabaseResidueClean?: boolean;
  throwCapacityAfter?: number;
  serverErrorAfter?: number;
}): Fake {
  const realFetch = globalThis.fetch;
  const fake: Fake = {
    docs: new Set(opts.docs ?? []),
    authors: new Map(Object.entries(opts.authors ?? {})),
    undeletable: new Set(opts.undeletable ?? []),
    urls: [],
    queriedValues: [],
    calls: [],
    throwCapacityAfter: opts.throwCapacityAfter ?? 0,
    serverErrorAfter: opts.serverErrorAfter ?? 0,
    fsCalls: 0,
    restore() {
      globalThis.fetch = realFetch;
    },
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    fake.urls.push(url);

    // Google のトークン発行。外に出さない。
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return json({ access_token: "fake-token", expires_in: 3600 });
    }

    // ── Supabase RPC ────────────────────────────────────────────────
    if (url.includes("/rest/v1/rpc/roji_resolve_identity")) {
      fake.calls.push("resolve");
      return json(opts.identity);
    }
    if (url.includes("/rest/v1/rpc/roji_erase_person")) {
      fake.calls.push("supabase_erase");
      return json({
        words_deleted: 0,
        ledger_rows_deleted: 0,
        person_deleted: 1,
        identity: opts.identity,
        deleted: { customer_linkages: 1 },
      });
    }
    if (url.includes("/rest/v1/rpc/roji_erasure_residue")) {
      fake.calls.push("supabase_residue");
      const clean = opts.supabaseResidueClean !== false;
      return json({
        remaining: { customer_linkages: clean ? 0 : 1 },
        preserved: { roji_edit_records: 1 },
        clean,
      });
    }

    // ── Firestore ───────────────────────────────────────────────────
    if (!url.startsWith("https://firestore.googleapis.com/")) return json({}, 404);

    fake.fsCalls++;
    if (fake.throwCapacityAfter > 0 && fake.fsCalls > fake.throwCapacityAfter) {
      // Cloudflare Workers が 1 リクエストの上限を超えたときに投げる例外を模す。
      throw new Error("Too many subrequests.");
    }
    if (fake.serverErrorAfter > 0 && fake.fsCalls > fake.serverErrorAfter) {
      return json({ error: "boom" }, 500);
    }

    const rest = url.slice(FS_BASE.length); // ":commit" / "/users/1?..." など
    const method = (init?.method ?? "GET").toUpperCase();

    if (rest.startsWith(":commit")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { writes?: Array<{ delete?: string }> };
      for (const w of body.writes ?? []) {
        const p = (w.delete ?? "").slice(DOC_PREFIX.length);
        if (!fake.undeletable.has(p)) fake.docs.delete(p);
      }
      return json({ writeResults: (body.writes ?? []).map(() => ({})) });
    }

    if (rest.startsWith(":runQuery")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        structuredQuery?: {
          from?: Array<{ collectionId?: string }>;
          where?: { fieldFilter?: { value?: { stringValue?: string } } };
        };
      };
      const collection = body.structuredQuery?.from?.[0]?.collectionId ?? "";
      const value = body.structuredQuery?.where?.fieldFilter?.value?.stringValue ?? "";
      fake.queriedValues.push(value);
      const hits = [...fake.authors.entries()]
        .filter(([path, author]) => author === value && fake.docs.has(path) && path.startsWith(`${collection}/`))
        .map(([path]) => ({ document: { name: `${DOC_PREFIX}${path}` } }));
      return json(hits);
    }

    const [rawPath, query = ""] = rest.replace(/^\//, "").split("?");
    const path = decodeURIComponent(rawPath ?? "");

    if (path.endsWith(":listCollectionIds")) {
      const docPath = path.slice(0, -":listCollectionIds".length);
      return json({ collectionIds: subcollectionsOf(fake, docPath) });
    }

    if (method === "DELETE") {
      if (!fake.docs.has(path)) return json({}, 404);
      if (!fake.undeletable.has(path)) fake.docs.delete(path);
      return json({});
    }

    if (method === "GET") {
      // pageSize があればコレクションの一覧、無ければドキュメントの存在確認。
      if (query.includes("pageSize=")) {
        return json({ documents: docsIn(fake, path).map((d) => ({ name: `${DOC_PREFIX}${d}` })) });
      }
      return fake.docs.has(path) ? json({ name: `${DOC_PREFIX}${path}` }) : json({}, 404);
    }

    return json({}, 404);
  }) as typeof fetch;

  return fake;
}

/** gid 形式のまま外へ投げていないか（＝実在しないパスを掘っていないか）。 */
function assertNoGidInRequests(fake: Fake) {
  const leaked = fake.urls.filter((u) => /gid(%3A|:)/i.test(u));
  assertEqual(leaked.length, 0, `gid 形式のまま Firestore に投げている（${leaked[0] ?? ""}）`);
}

// ---------------------------------------------------------------------------

const GID = "gid://shopify/Customer/7654321";
const NUM = "7654321";
const LINE_ID = "Uline1";

const GID_IDENTITY: ResolvedIdentity = {
  shopify_ids: [GID],
  line_ids: [LINE_ID],
  web_refs: [],
  person_seqs: [1],
};

/** gid 形式の人が実際に持っている置き場（数字のパスにある）。 */
function gidPersonDocs(): string[] {
  return [
    `users/${NUM}`,
    `users/${NUM}/orders/o1`,
    `users/${NUM}/broadcastHistory/b1`,
    `notificationState/${NUM}`,
    `${LINE_USERS_COLLECTION}/${LINE_ID}`,
    `users/line:${LINE_ID}`,
    "comments/c1",
  ];
}

/** 1 リクエストで消しきれない量（実測は 21 doc で 500 になっていた）を作る。 */
function manyOrderDocs(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `users/${NUM}/orders/many${i}`);
}

async function main() {
  console.log("\n=== F6-1a: ID の形を揃える関数が 1 つだけある ===");

  await it("gid 形式・数字・修飾つき gid のいずれからも顧客番号を取り出す", () => {
    assertEqual(normalizeShopifyCustomerId(NUM), NUM, "数字はそのまま");
    assertEqual(normalizeShopifyCustomerId(GID), NUM, "gid 形式");
    assertEqual(normalizeShopifyCustomerId(`${GID}?namespace=x`), NUM, "修飾つき gid");
    assertEqual(normalizeShopifyCustomerId(`  ${GID}  `), NUM, "前後の空白");
    assertEqual(normalizeShopifyCustomerId("GID://SHOPIFY/CUSTOMER/7654321"), NUM, "大文字の gid");
  });

  await it("顧客番号として使えない値は null（＝呼び出し側で数えさせる）", () => {
    for (const bad of ["", "   ", "abc", "gid://shopify/Order/1", "gid://shopify/Customer/abc", null, undefined]) {
      assertEqual(normalizeShopifyCustomerId(bad), null, `使えない値を通した（${JSON.stringify(bad)}）`);
    }
  });

  await it("消す側と検算側が使う集合が 1 つに揃う（重複は畳まれ、使えない ID は数えられる）", () => {
    const keys = firestoreKeys({
      shopify_ids: [GID, NUM, "abc"],
      line_ids: [LINE_ID, "bad/id"],
      web_refs: [],
      person_seqs: [],
    });
    assertEqual(keys.customerIds.join(","), NUM, "gid と数字が同じ 1 件に畳まれていない");
    assertEqual(keys.lineIds.join(","), LINE_ID, "パスに使えない LINE ID を通した");
    assertEqual(keys.unmappable, 2, "使えなかった ID が数えられていない");
  });

  console.log("\n=== F6-1b: gid 形式の人でも実際に置き場を掘る ===");

  await it("gid 形式の顧客番号でも本カルテ・通知状態・サブコレクションが実際に消える", async () => {
    const fake = installFake({ docs: gidPersonDocs(), authors: { "comments/c1": NUM }, identity: GID_IDENTITY });
    let result;
    try {
      result = await erasePerson(baseEnv(), { kind: "line", id: LINE_ID });
    } finally {
      fake.restore();
    }
    assertNoGidInRequests(fake);
    assertEqual(fake.docs.size, 0, `消え残りがある（${[...fake.docs].join(", ")}）`);
    assertEqual(result.clean, true, "全部消えたのに clean=false");
    assertEqual(result.status, "erased", "status");
    assertTrue(result.firestore.deletedDocs >= 7, `消した件数が少なすぎる（${result.firestore.deletedDocs}）`);
  });

  await it("comments の照合キーが数字の顧客番号になる（gid では 1 件も引けない）", async () => {
    const fake = installFake({ docs: gidPersonDocs(), authors: { "comments/c1": NUM }, identity: GID_IDENTITY });
    try {
      await erasePerson(baseEnv(), { kind: "line", id: LINE_ID });
    } finally {
      fake.restore();
    }
    assertTrue(fake.queriedValues.includes(NUM), `comments を数字の顧客番号で引いていない（${fake.queriedValues.join(",")}）`);
    assertTrue(fake.queriedValues.includes(`line:${LINE_ID}`), "comments を LINE の ID で引いていない");
    assertEqual(fake.queriedValues.some((v) => v.includes("gid://")), false, "comments を gid 形式で引いている");
  });

  console.log("\n=== F6-1c: 消えていないのに clean を返さない ===");

  await it("消し残しがあれば clean=false（旧実装が返していた偽の clean を再発させない）", async () => {
    // 本カルテが消えない置き場を作る。旧実装は gid を飛ばして「0 件」と数え clean=true だった。
    const fake = installFake({
      docs: gidPersonDocs(),
      authors: { "comments/c1": NUM },
      identity: GID_IDENTITY,
      undeletable: [`users/${NUM}`],
    });
    let result;
    try {
      result = await erasePerson(baseEnv(), { kind: "line", id: LINE_ID });
    } finally {
      fake.restore();
    }
    assertEqual(result.clean, false, "消し残しがあるのに clean=true（偽の clean）");
    assertEqual(result.status, "incomplete", "status");
    assertEqual(result.firestoreResidue?.remaining.karte, 1, "本カルテの残りを数えていない");
  });

  await it("Firestore で扱えない ID は黙って捨てず residue に出る", async () => {
    const fake = installFake({
      docs: [],
      identity: { shopify_ids: ["not-a-customer-id"], line_ids: [], web_refs: [], person_seqs: [] },
    });
    let result;
    try {
      result = await erasePerson(baseEnv(), { kind: "shopify", id: "not-a-customer-id" });
    } finally {
      fake.restore();
    }
    assertEqual(result.firestoreResidue?.remaining.unmappable_ids, 1, "扱えなかった ID が数えられていない");
    assertEqual(result.clean, false, "扱えなかった ID があるのに clean=true");
  });

  console.log("\n=== F6-2: 途中で力尽きても「失敗」と言わない ===");

  await it("上限例外は例外として外に出ず continue_required になる", async () => {
    const fake = installFake({
      docs: gidPersonDocs(),
      authors: { "comments/c1": NUM },
      identity: GID_IDENTITY,
      throwCapacityAfter: 3,
    });
    let result;
    try {
      result = await erasePerson(baseEnv(), { kind: "line", id: LINE_ID });
    } finally {
      fake.restore();
    }
    assertEqual(result.continueRequired, true, "続きが要ることを返していない");
    assertEqual(result.status, "continue_required", "status");
    assertEqual(result.clean, false, "途中なのに clean=true");
  });

  await it("途中で止まったとき Supabase の消去には進まない（別名表を残す＝再送で特定できる）", async () => {
    const fake = installFake({
      docs: gidPersonDocs(),
      authors: { "comments/c1": NUM },
      identity: GID_IDENTITY,
      throwCapacityAfter: 3,
    });
    try {
      await erasePerson(baseEnv(), { kind: "line", id: LINE_ID });
    } finally {
      fake.restore();
    }
    assertEqual(
      fake.calls.includes("supabase_erase"),
      false,
      `途中終了なのに別名表を消しに行った（calls=${fake.calls.join(">")}）`,
    );
  });

  await it("予算（ERASE_SUBREQUEST_BUDGET）で自分から止まる場合も同じ扱いになる", async () => {
    // 実測（21 doc で 500）と同じ規模。予算を絞ると 1 リクエストでは消しきれない。
    const fake = installFake({
      docs: [...gidPersonDocs(), ...manyOrderDocs(60)],
      authors: { "comments/c1": NUM },
      identity: GID_IDENTITY,
    });
    let result;
    try {
      result = await erasePerson(baseEnv({ ERASE_SUBREQUEST_BUDGET: "40" }), { kind: "line", id: LINE_ID });
    } finally {
      fake.restore();
    }
    assertEqual(result.continueRequired, true, "予算切れで続きが要ることを返していない");
    assertEqual(fake.calls.includes("supabase_erase"), false, "予算切れなのに別名表を消しに行った");
    assertTrue(result.firestore.deletedDocs > 0, "途中まででも消えていない（溜めた分を流していない）");
  });

  await it("再送を繰り返せば必ず消し終わる（各段階が冪等・毎回必ず前に進む）", async () => {
    const fake = installFake({
      docs: [...gidPersonDocs(), ...manyOrderDocs(60)],
      authors: { "comments/c1": NUM },
      identity: GID_IDENTITY,
    });
    let rounds = 0;
    let last;
    try {
      // 1 回で消しきれない予算のまま、続きが要る限り再送する。
      do {
        rounds++;
        last = await erasePerson(baseEnv({ ERASE_SUBREQUEST_BUDGET: "40" }), { kind: "line", id: LINE_ID });
      } while (last.continueRequired && rounds < 30);
    } finally {
      fake.restore();
    }
    assertTrue(rounds > 1, "1 回で終わってしまい再送の検証になっていない");
    assertEqual(last?.clean, true, `再送しても消し終わらなかった（rounds=${rounds}, 残=${[...fake.docs].slice(0, 5).join(",")}）`);
    assertEqual(fake.docs.size, 0, "再送後も置き場が残っている");
  });

  await it("本物の失敗（Firestore 500）は「続きが要る」に化かさず例外のまま", async () => {
    const fake = installFake({
      docs: gidPersonDocs(),
      authors: { "comments/c1": NUM },
      identity: GID_IDENTITY,
      serverErrorAfter: 2,
    });
    let threw = false;
    try {
      await erasePerson(baseEnv(), { kind: "line", id: LINE_ID });
    } catch {
      threw = true;
    } finally {
      fake.restore();
    }
    assertTrue(threw, "Firestore の 500 が握り潰されている（失敗を『続きが要る』に化かしている）");
    assertEqual(fake.calls.includes("supabase_erase"), false, "Firestore 失敗後に別名表を消しに行った");
  });

  console.log("\n=== F6-2b: HTTP の応答（POST /api/erase）===");

  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const call = (env: unknown) =>
    worker.fetch(
      new Request("https://worker.invalid/api/erase", {
        method: "POST",
        headers: { Authorization: "Bearer fake-erase-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ subject_kind: "line", subject_id: LINE_ID }),
      }),
      env as never,
      ctx,
    );

  await it("消し終わったら 200 status=erased", async () => {
    const fake = installFake({ docs: gidPersonDocs(), authors: { "comments/c1": NUM }, identity: GID_IDENTITY });
    let res: Response;
    try {
      res = await call(baseEnv());
    } finally {
      fake.restore();
    }
    assertEqual(res.status, 200, "HTTP status");
    assertEqual(((await res.json()) as { status?: string }).status, "erased", "本文の status");
  });

  await it("途中までなら 202 status=in_progress（500 erase_failed にしない）", async () => {
    const fake = installFake({
      docs: gidPersonDocs(),
      authors: { "comments/c1": NUM },
      identity: GID_IDENTITY,
      throwCapacityAfter: 3,
    });
    let res: Response;
    try {
      res = await call(baseEnv());
    } finally {
      fake.restore();
    }
    assertEqual(res.status, 202, "途中終了が 500 のままになっている");
    const body = (await res.json()) as { status?: string; continue_required?: boolean };
    assertEqual(body.status, "in_progress", "本文の status");
    assertEqual(body.continue_required, true, "continue_required");
    // 2xx でも **完了ではない**。"erased" と名乗らないことを固定する。
    assertEqual(body.status === "erased", false, "途中なのに erased と名乗っている");
  });

  await it("消し残しがあれば 500 status=incomplete（従来どおり）", async () => {
    const fake = installFake({
      docs: gidPersonDocs(),
      authors: { "comments/c1": NUM },
      identity: GID_IDENTITY,
      undeletable: [`users/${NUM}`],
    });
    let res: Response;
    try {
      res = await call(baseEnv());
    } finally {
      fake.restore();
    }
    assertEqual(res.status, 500, "HTTP status");
    assertEqual(((await res.json()) as { status?: string }).status, "incomplete", "本文の status");
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
