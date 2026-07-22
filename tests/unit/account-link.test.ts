/**
 * Unit Tests -- LINE 純正 Account Link（linkToken / nonce / accountLink イベント / 連携解除）
 *
 * 検証対象（実ネットワーク・実 Supabase には一切触れない）:
 *   1. nonce 生成: CSPRNG・128bit 以上・base64url・LINE 仕様の長さ（10〜255）・毎回異なる
 *   2. nonce の single-use: 同じ nonce は 2 回消費できない（同時到達・webhook 再送でも二重連携しない）
 *   3. nonce の TTL: 期限切れは消費できない（reason=expired）
 *   4. link.result="failed" では **連携行を書かない**（LINE の所有者検証が失敗している）
 *   5. 連携成立の冪等性: 同じイベントが 2 度届いても upsert は 1 回きり
 *   6. linkToken 発行: 成功/失敗の扱い（fetch はスタブ・値をログに出さない）
 *   7. URL 組み立て: 連携入口 / LINE 連携ダイアログ
 *   8. nonce 発行ハンドラの認証（SYNC_API_SECRET fail-closed）と入力検証
 *   9. 連携解除: 連携列だけを消し、行は消さない（配信停止フラグを巻き戻さない）
 *
 * nonce の store は「フィルタを実際に適用する」インメモリ fake で再現する（戻り値を固定した
 * 単純 mock ではなく実挙動を通す）。single-use / TTL はこの fake 上で本物の条件式が効く。
 *
 * 使用方法:
 *   npx tsx tests/unit/account-link.test.ts
 */

import type { Context } from "hono";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../../src/index";
import {
  ACCOUNT_LINK_NONCES_TABLE,
  ACCOUNT_LINK_SOURCE,
  ACCOUNT_LINK_DIALOG_URL,
  NONCE_BYTES,
  NONCE_TTL_MINUTES,
  generateNonce,
  isValidNonceFormat,
  isValidLinkTokenFormat,
  buildLinkTokenEndpoint,
  buildAccountLinkEntryUrl,
  buildAccountLinkRedirectUrl,
  issueLinkToken,
  issueAccountLinkNonce,
  consumeAccountLinkNonce,
  handleAccountLinkEvent,
} from "../../src/lib/account-link";
import { clearCustomerLinkage } from "../../src/lib/customer-linkage";
import {
  handleLinkageFlow,
  resolveAccountLinkEntryUrl,
  resolveLinkageUrlForUser,
} from "../../src/lib/subscriber-linkage";
import { identityAccountLinkNonceHandler } from "../../src/routes/identity";
import { ACCOUNT_LINK_UNLINK_TRIGGER } from "../../src/lib/brand-copy";
import type { LineResponder } from "../../src/lib/line";

// ---------------------------------------------------------------------------
// テストハーネス（外部依存なし・async 対応）
// ---------------------------------------------------------------------------

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures: Array<{ name: string; error: string }> = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function describe(suiteName: string, fn: () => void) {
  queue.push({ name: `--- ${suiteName} ---`, fn: () => {} });
  fn();
}
function it(testName: string, fn: () => void | Promise<void>) {
  queue.push({ name: testName, fn });
}
function assertEqual<T>(actual: T, expected: T, label = "") {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assert(value: boolean, label = "") {
  if (!value) throw new Error(`${label ? label + ": " : ""}expected true`);
}

// ---------------------------------------------------------------------------
// フィルタを実際に適用する fake Supabase（nonce の single-use / TTL を本物の条件で通す）
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

type FakeDb = {
  client: SupabaseClient;
  tables: Record<string, Row[]>;
  /** 実行された書き込み操作の記録（呼ばれた/呼ばれないの検証用）。 */
  writes: Array<{ table: string; op: string }>;
};

function makeFakeSupabase(seed?: Record<string, Row[]>): FakeDb {
  const tables: Record<string, Row[]> = seed ?? {};
  const writes: Array<{ table: string; op: string }> = [];

  function query(table: string, op: string, payload?: Row) {
    const rows = (tables[table] ??= []);
    const filters: Array<(r: Row) => boolean> = [];
    let limit = Infinity;

    const exec = (): { data: Row[] | null; error: { message: string } | null } => {
      const matched = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "select") {
        return { data: matched.slice(0, limit), error: null };
      }
      if (op === "update") {
        writes.push({ table, op });
        for (const r of matched) Object.assign(r, payload);
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      if (op === "insert") {
        writes.push({ table, op });
        // 主キー相当（nonce）の重複は DB が拒む。
        const pk = payload?.nonce;
        if (pk !== undefined && rows.some((r) => r.nonce === pk)) {
          return { data: null, error: { message: "duplicate key value" } };
        }
        rows.push({ ...(payload as Row) });
        return { data: [{ ...(payload as Row) }], error: null };
      }
      if (op === "upsert") {
        writes.push({ table, op });
        return { data: null, error: null };
      }
      return { data: null, error: { message: `unsupported op ${op}` } };
    };

    const api: Record<string, unknown> = {
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return api;
      },
      is(col: string, val: unknown) {
        filters.push((r) =>
          val === null ? r[col] === null || r[col] === undefined : r[col] === val,
        );
        return api;
      },
      not(col: string, _op: string, val: unknown) {
        // 使うのは `.not(col, "is", null)`（= NULL でない行だけ）のみ。
        filters.push((r) =>
          val === null ? !(r[col] === null || r[col] === undefined) : r[col] !== val,
        );
        return api;
      },
      gt(col: string, val: unknown) {
        filters.push(
          (r) =>
            new Date(String(r[col])).getTime() > new Date(String(val)).getTime(),
        );
        return api;
      },
      limit(n: number) {
        limit = n;
        return api;
      },
      select(_cols?: string) {
        return api;
      },
      then(
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) {
        return Promise.resolve(exec()).then(resolve, reject);
      },
    };
    return api;
  }

  const client = {
    from(table: string) {
      return {
        select: (cols?: string) => (query(table, "select") as { select: (c?: string) => unknown }).select(cols),
        insert: (row: Row) => query(table, "insert", row),
        update: (row: Row) => query(table, "update", row),
        upsert: (row: Row) => query(table, "upsert", row),
      };
    },
  } as unknown as SupabaseClient;

  return { client, tables, writes };
}

/** 送信を記録するだけの Responder。 */
function mockResponder(): { responder: LineResponder; texts: string[] } {
  const texts: string[] = [];
  const responder: LineResponder = {
    async text(t: string) {
      texts.push(t);
    },
    async flex() {
      /* 未使用 */
    },
  };
  return { responder, texts };
}

const SYN_LINE = "U0123456789abcdef0123456789abcdef";
const SYN_SHOPIFY = "900800400001";
const TEST_SECRET = "test-sync-secret-abc123";

function testEnv(extra?: Partial<Env>): Env {
  return {
    SUPABASE_URL: "http://localhost:0",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    LINE_CHANNEL_ACCESS_TOKEN: "test-token",
    ...extra,
  } as unknown as Env;
}

// ---------------------------------------------------------------------------
// 1. nonce 生成（CSPRNG・128bit 以上・base64url・LINE 仕様の長さ）
// ---------------------------------------------------------------------------

describe("generateNonce（LINE 仕様: 予測困難・一度きり・10〜255 文字・128bit 以上）", () => {
  it("192bit（24byte）を base64url 化した 32 文字を返す", () => {
    assertEqual(NONCE_BYTES, 24, "NONCE_BYTES = 192bit");
    assert(NONCE_BYTES * 8 >= 128, "128bit 以上（LINE 推奨）");
    const n = generateNonce();
    assertEqual(n.length, 32, "base64url(24byte) = 32 文字");
  });

  it("base64url のみ（URL クエリに載せても壊れない）", () => {
    for (let i = 0; i < 50; i++) {
      const n = generateNonce();
      assert(/^[A-Za-z0-9_-]+$/.test(n), `base64url only: ${n}`);
      assert(!n.includes("="), "no padding");
    }
  });

  it("LINE の長さ要件（10〜255 文字）を満たす", () => {
    const n = generateNonce();
    assert(n.length >= 10 && n.length <= 255, "10..255");
    assert(isValidNonceFormat(n), "format gate accepts generated nonce");
  });

  it("毎回異なる（1000 本で重複ゼロ）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateNonce());
    assertEqual(seen.size, 1000, "全て一意");
  });

  it("isValidNonceFormat: 短すぎ / 長すぎ / 記号混入は弾く", () => {
    assertEqual(isValidNonceFormat("short"), false, "9 文字以下");
    assertEqual(isValidNonceFormat("a".repeat(256)), false, "256 文字");
    assertEqual(isValidNonceFormat("abcdefghij+"), false, "base64url 外の記号");
    assertEqual(isValidNonceFormat(undefined), false, "undefined");
    assertEqual(isValidNonceFormat("a".repeat(10)), true, "境界 10 文字");
    assertEqual(isValidNonceFormat("a".repeat(255)), true, "境界 255 文字");
  });
});

// ---------------------------------------------------------------------------
// 2. URL 組み立て
// ---------------------------------------------------------------------------

describe("URL 組み立て", () => {
  it("buildLinkTokenEndpoint: Messaging API の linkToken エンドポイント", () => {
    assertEqual(
      buildLinkTokenEndpoint(SYN_LINE),
      `https://api.line.me/v2/bot/user/${SYN_LINE}/linkToken`,
    );
  });

  it("buildAccountLinkEntryUrl: 自社入口に linkToken を付ける（既存クエリは保持）", () => {
    const u = new URL(
      buildAccountLinkEntryUrl("https://example.test/ja/link?from=line", "tok_123"),
    );
    assertEqual(u.pathname, "/ja/link");
    assertEqual(u.searchParams.get("linkToken"), "tok_123");
    assertEqual(u.searchParams.get("from"), "line", "既存クエリを壊さない");
  });

  it("buildAccountLinkRedirectUrl: LINE ダイアログに linkToken と nonce だけを載せる", () => {
    const u = new URL(buildAccountLinkRedirectUrl("tok_123", "nonce_abc"));
    assertEqual(`${u.origin}${u.pathname}`, ACCOUNT_LINK_DIALOG_URL);
    assertEqual(u.searchParams.get("linkToken"), "tok_123");
    assertEqual(u.searchParams.get("nonce"), "nonce_abc");
    assertEqual([...u.searchParams.keys()].length, 2, "余計なパラメータを載せない");
  });

  it("isValidLinkTokenFormat: 実測 32 文字は通る / 空・記号・過大長は弾く", () => {
    assertEqual(isValidLinkTokenFormat("a".repeat(32)), true);
    assertEqual(isValidLinkTokenFormat(""), false);
    assertEqual(isValidLinkTokenFormat("tok with space"), false);
    assertEqual(isValidLinkTokenFormat("a".repeat(513)), false);
  });
});

// ---------------------------------------------------------------------------
// 3. linkToken 発行（fetch スタブ・ネットワーク非接触）
// ---------------------------------------------------------------------------

describe("issueLinkToken（Messaging API・never throw）", () => {
  it("200 + linkToken → ok:true", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ linkToken: "b".repeat(32) }),
      text: async () => "",
    })) as unknown as typeof fetch;
    const res = await issueLinkToken(SYN_LINE, testEnv(), { fetchImpl });
    assert(res.ok, "ok");
    assertEqual(res.ok ? res.linkToken : "", "b".repeat(32));
  });

  it("403 → ok:false（例外にしない・理由コードのみ）", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => "forbidden",
    })) as unknown as typeof fetch;
    const res = await issueLinkToken(SYN_LINE, testEnv(), { fetchImpl });
    assertEqual(res.ok, false);
    assertEqual(res.ok ? "" : res.reason, "http_403");
  });

  it("ネットワーク例外 → ok:false（throw しない）", async () => {
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const res = await issueLinkToken(SYN_LINE, testEnv(), { fetchImpl });
    assertEqual(res.ok, false);
    assertEqual(res.ok ? "" : res.reason, "network_error");
  });

  it("channel access token 未設定 → 呼ばずに ok:false", async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called++;
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }) as unknown as typeof fetch;
    const res = await issueLinkToken(
      SYN_LINE,
      { LINE_CHANNEL_ACCESS_TOKEN: "" } as Env,
      { fetchImpl },
    );
    assertEqual(res.ok, false);
    assertEqual(called, 0, "LINE を呼ばない");
  });
});

// ---------------------------------------------------------------------------
// 4. nonce の発行・消費（single-use / TTL）
// ---------------------------------------------------------------------------

describe("issueAccountLinkNonce / consumeAccountLinkNonce", () => {
  it("発行 → 1 度だけ消費できる（single-use）", async () => {
    const db = makeFakeSupabase();
    const issued = await issueAccountLinkNonce(db.client, SYN_SHOPIFY);
    assert(issued.ok, "issued");
    const nonce = issued.ok ? issued.nonce : "";

    const first = await consumeAccountLinkNonce(db.client, nonce);
    assert(first.ok, "1 回目は成功");
    assertEqual(first.ok ? first.shopifyCustomerId : "", SYN_SHOPIFY);

    const second = await consumeAccountLinkNonce(db.client, nonce);
    assertEqual(second.ok, false, "2 回目は失敗");
    assertEqual(second.ok ? "" : second.reason, "already_used");
  });

  it("TTL 切れ → 消費できない（reason=expired・連携に使えない）", async () => {
    const db = makeFakeSupabase();
    const t0 = Date.parse("2026-07-22T00:00:00.000Z");
    const issued = await issueAccountLinkNonce(db.client, SYN_SHOPIFY, {
      nowMs: t0,
      ttlMinutes: NONCE_TTL_MINUTES,
    });
    assert(issued.ok, "issued");
    const nonce = issued.ok ? issued.nonce : "";

    // TTL（既定 5 分）+ 1 秒後に到着したイベント。
    const late = t0 + (NONCE_TTL_MINUTES * 60 + 1) * 1000;
    const res = await consumeAccountLinkNonce(db.client, nonce, { nowMs: late });
    assertEqual(res.ok, false, "期限切れは消費できない");
    assertEqual(res.ok ? "" : res.reason, "expired");
  });

  it("TTL 内なら消費できる（境界の内側）", async () => {
    const db = makeFakeSupabase();
    const t0 = Date.parse("2026-07-22T00:00:00.000Z");
    const issued = await issueAccountLinkNonce(db.client, SYN_SHOPIFY, { nowMs: t0 });
    const nonce = issued.ok ? issued.nonce : "";
    const inTime = t0 + (NONCE_TTL_MINUTES * 60 - 1) * 1000;
    const res = await consumeAccountLinkNonce(db.client, nonce, { nowMs: inTime });
    assert(res.ok, "TTL 内は消費できる");
  });

  it("未知の nonce → reason=unknown（DB を汚さない）", async () => {
    const db = makeFakeSupabase();
    const res = await consumeAccountLinkNonce(db.client, "z".repeat(32));
    assertEqual(res.ok, false);
    assertEqual(res.ok ? "" : res.reason, "unknown");
  });

  it("形式不正な nonce → DB に触れず invalid_format", async () => {
    const db = makeFakeSupabase();
    const res = await consumeAccountLinkNonce(db.client, "bad nonce!");
    assertEqual(res.ok, false);
    assertEqual(res.ok ? "" : res.reason, "invalid_format");
    assertEqual(db.writes.length, 0, "書き込みゼロ");
  });

  it("発行した行は nonce 主キー・TTL・未消費で保存される", async () => {
    const db = makeFakeSupabase();
    const t0 = Date.parse("2026-07-22T00:00:00.000Z");
    const issued = await issueAccountLinkNonce(db.client, SYN_SHOPIFY, { nowMs: t0 });
    const rows = db.tables[ACCOUNT_LINK_NONCES_TABLE];
    assertEqual(rows.length, 1);
    assertEqual(rows[0].shopify_customer_id, SYN_SHOPIFY);
    assertEqual(rows[0].consumed_at, undefined, "未消費（consumed_at 未設定）");
    assertEqual(
      rows[0].expires_at,
      new Date(t0 + NONCE_TTL_MINUTES * 60 * 1000).toISOString(),
      "TTL",
    );
    assert(issued.ok && rows[0].nonce === issued.nonce, "nonce 一致");
  });
});

// ---------------------------------------------------------------------------
// 5. accountLink イベント処理（failed で書かない / 冪等 / 解除の通知）
// ---------------------------------------------------------------------------

/** upsert 呼び出しを観測する差し替え。 */
function makeUpsertSpy(ok = true) {
  const calls: Array<Record<string, unknown>> = [];
  const upsertLinkage = async (
    _c: SupabaseClient,
    input: { lineUserId: string; shopifyCustomerId: string; source?: string | null },
  ) => {
    calls.push({ ...input });
    return ok
      ? ({
          ok: true as const,
          lineUserId: input.lineUserId,
          shopifyCustomerId: input.shopifyCustomerId,
        })
      : ({ ok: false as const, error: "db down" });
  };
  return { upsertLinkage, calls };
}

describe("handleAccountLinkEvent", () => {
  it("result=failed → 連携行を書かない・記録もしない・返信もしない", async () => {
    const db = makeFakeSupabase();
    const { upsertLinkage, calls } = makeUpsertSpy();
    const events: unknown[] = [];
    const { responder, texts } = mockResponder();

    const outcome = await handleAccountLinkEvent(
      SYN_LINE,
      { result: "failed", nonce: "n".repeat(32) },
      testEnv(),
      responder,
      {
        supabase: db.client,
        upsertLinkage,
        logEvent: async (_c, e) => {
          events.push(e);
        },
        carryover: async () => {},
      },
    );

    assertEqual(outcome, "skipped_result_failed");
    assertEqual(calls.length, 0, "upsert を呼ばない");
    assertEqual(events.length, 0, "flow_events を書かない");
    assertEqual(texts.length, 0, "返信しない");
    assertEqual(db.writes.length, 0, "DB 書き込みゼロ");
  });

  it("link 欠落 → 連携行を書かない", async () => {
    const db = makeFakeSupabase();
    const { upsertLinkage, calls } = makeUpsertSpy();
    const { responder } = mockResponder();
    const outcome = await handleAccountLinkEvent(
      SYN_LINE,
      undefined,
      testEnv(),
      responder,
      { supabase: db.client, upsertLinkage, carryover: async () => {} },
    );
    assertEqual(outcome, "skipped_result_failed");
    assertEqual(calls.length, 0);
  });

  it("result=ok → nonce を消費して source='account_link' で連携行を書く", async () => {
    const db = makeFakeSupabase();
    const issued = await issueAccountLinkNonce(db.client, SYN_SHOPIFY);
    const nonce = issued.ok ? issued.nonce : "";
    const { upsertLinkage, calls } = makeUpsertSpy();
    const events: Array<{ eventName: string; metadata?: Record<string, unknown> }> = [];
    const { responder, texts } = mockResponder();
    let carried: string[] = [];

    const outcome = await handleAccountLinkEvent(
      SYN_LINE,
      { result: "ok", nonce },
      testEnv(),
      responder,
      {
        supabase: db.client,
        upsertLinkage,
        logEvent: async (_c, e) => {
          events.push(e as { eventName: string; metadata?: Record<string, unknown> });
        },
        carryover: async (_env, lineUserId, shopifyId) => {
          carried = [lineUserId, shopifyId];
        },
      },
    );

    assertEqual(outcome, "linked");
    assertEqual(calls.length, 1, "upsert 1 回");
    assertEqual(calls[0].lineUserId, SYN_LINE);
    assertEqual(calls[0].shopifyCustomerId, SYN_SHOPIFY);
    assertEqual(calls[0].source, ACCOUNT_LINK_SOURCE);
    assertEqual(events.length, 1);
    assertEqual(events[0].eventName, "link.completed");
    assertEqual(
      (events[0].metadata as { source?: string }).source,
      ACCOUNT_LINK_SOURCE,
    );
    assertEqual(carried[0], SYN_LINE, "好み引き継ぎに渡す");
    assertEqual(carried[1], SYN_SHOPIFY);
    assertEqual(texts.length, 1, "完了をお伝えする");
  });

  it("完了メッセージに「解除できる」旨を必ず含む（LINE 必須義務）", async () => {
    const db = makeFakeSupabase();
    const issued = await issueAccountLinkNonce(db.client, SYN_SHOPIFY);
    const nonce = issued.ok ? issued.nonce : "";
    const { upsertLinkage } = makeUpsertSpy();
    const { responder, texts } = mockResponder();

    await handleAccountLinkEvent(SYN_LINE, { result: "ok", nonce }, testEnv(), responder, {
      supabase: db.client,
      upsertLinkage,
      logEvent: async () => {},
      carryover: async () => {},
    });

    assertEqual(texts.length, 1);
    assert(
      texts[0].includes(ACCOUNT_LINK_UNLINK_TRIGGER),
      "解除の合言葉を案内している",
    );
    assert(texts[0].includes("解除"), "解除できる旨がある");
  });

  it("同じイベントが 2 度届いても連携行は 1 回しか書かれない（nonce single-use による冪等）", async () => {
    const db = makeFakeSupabase();
    const issued = await issueAccountLinkNonce(db.client, SYN_SHOPIFY);
    const nonce = issued.ok ? issued.nonce : "";
    const { upsertLinkage, calls } = makeUpsertSpy();
    const { responder } = mockResponder();

    const deps = {
      supabase: db.client,
      upsertLinkage,
      logEvent: async () => {},
      carryover: async () => {},
    };
    const first = await handleAccountLinkEvent(
      SYN_LINE,
      { result: "ok", nonce },
      testEnv(),
      responder,
      deps,
    );
    const second = await handleAccountLinkEvent(
      SYN_LINE,
      { result: "ok", nonce },
      testEnv(),
      responder,
      deps,
    );

    assertEqual(first, "linked");
    assertEqual(second, "skipped_nonce_unusable", "2 度目は nonce が使えない");
    assertEqual(calls.length, 1, "upsert は 1 回だけ");
  });

  it("TTL 切れの nonce を持つイベント → 連携行を書かない", async () => {
    const db = makeFakeSupabase();
    const t0 = Date.parse("2026-07-22T00:00:00.000Z");
    const issued = await issueAccountLinkNonce(db.client, SYN_SHOPIFY, { nowMs: t0 });
    const nonce = issued.ok ? issued.nonce : "";
    // 期限切れ状態を作る（実時刻はもう TTL を過ぎている扱い）。
    db.tables[ACCOUNT_LINK_NONCES_TABLE][0].expires_at = new Date(
      Date.now() - 1000,
    ).toISOString();

    const { upsertLinkage, calls } = makeUpsertSpy();
    const { responder, texts } = mockResponder();
    const outcome = await handleAccountLinkEvent(
      SYN_LINE,
      { result: "ok", nonce },
      testEnv(),
      responder,
      { supabase: db.client, upsertLinkage, logEvent: async () => {}, carryover: async () => {} },
    );

    assertEqual(outcome, "skipped_nonce_unusable");
    assertEqual(calls.length, 0, "連携行を書かない");
    assertEqual(texts.length, 0, "完了を偽って伝えない");
  });

  it("形式不正な nonce → DB に触れずに終わる", async () => {
    const db = makeFakeSupabase();
    const { upsertLinkage, calls } = makeUpsertSpy();
    const { responder } = mockResponder();
    const outcome = await handleAccountLinkEvent(
      SYN_LINE,
      { result: "ok", nonce: "not a nonce" },
      testEnv(),
      responder,
      { supabase: db.client, upsertLinkage, carryover: async () => {} },
    );
    assertEqual(outcome, "skipped_invalid_nonce");
    assertEqual(calls.length, 0);
    assertEqual(db.writes.length, 0);
  });

  it("upsert 失敗 → failed_persist（完了を偽って伝えない）", async () => {
    const db = makeFakeSupabase();
    const issued = await issueAccountLinkNonce(db.client, SYN_SHOPIFY);
    const nonce = issued.ok ? issued.nonce : "";
    const { upsertLinkage } = makeUpsertSpy(false);
    const { responder, texts } = mockResponder();
    const outcome = await handleAccountLinkEvent(
      SYN_LINE,
      { result: "ok", nonce },
      testEnv(),
      responder,
      { supabase: db.client, upsertLinkage, logEvent: async () => {}, carryover: async () => {} },
    );
    assertEqual(outcome, "failed_persist");
    assertEqual(texts.length, 0, "完了と伝えない");
  });
});

// ---------------------------------------------------------------------------
// 6. nonce 発行ハンドラ（認証 fail-closed / 入力検証）
// ---------------------------------------------------------------------------

type MockResult = { __status: number; __body: unknown };

function makeCtx(opts: {
  apiKey?: string;
  body?: unknown;
  secret?: string;
}): Context<{ Bindings: Env }> {
  return {
    req: {
      header: (name: string) => (name === "X-API-Key" ? opts.apiKey : undefined),
      json: async () => opts.body ?? {},
    },
    env: {
      SYNC_API_SECRET: opts.secret,
      SUPABASE_URL: "http://localhost:0",
      SUPABASE_SERVICE_ROLE_KEY: "test",
    } as unknown as Env,
    json: (body: unknown, status = 200): MockResult => ({
      __status: status,
      __body: body,
    }),
  } as unknown as Context<{ Bindings: Env }>;
}
function statusOf(res: unknown): number {
  return (res as MockResult).__status;
}

describe("identityAccountLinkNonceHandler -- 認証（fail-closed）", () => {
  it("X-API-Key 無し → 401", async () => {
    assertEqual(statusOf(await identityAccountLinkNonceHandler(makeCtx({ secret: TEST_SECRET }))), 401);
  });
  it("X-API-Key 不一致 → 401", async () => {
    assertEqual(
      statusOf(
        await identityAccountLinkNonceHandler(
          makeCtx({ apiKey: "wrong", secret: TEST_SECRET }),
        ),
      ),
      401,
    );
  });
  it("SYNC_API_SECRET 未設定 → 401（誤設定で無認証開放しない）", async () => {
    assertEqual(
      statusOf(
        await identityAccountLinkNonceHandler(
          makeCtx({ apiKey: TEST_SECRET, secret: undefined }),
        ),
      ),
      401,
    );
  });
});

describe("identityAccountLinkNonceHandler -- 入力検証（認証通過後）", () => {
  it("shopify_customer_id 欠落 → 400", async () => {
    assertEqual(
      statusOf(
        await identityAccountLinkNonceHandler(
          makeCtx({ apiKey: TEST_SECRET, secret: TEST_SECRET, body: {} }),
        ),
      ),
      400,
    );
  });
  it("不正な shopify_customer_id → 400", async () => {
    assertEqual(
      statusOf(
        await identityAccountLinkNonceHandler(
          makeCtx({
            apiKey: TEST_SECRET,
            secret: TEST_SECRET,
            body: { shopify_customer_id: "gid://shopify/Customer/abc" },
          }),
        ),
      ),
      400,
    );
  });
  it("不正な link_token → 400（URL に載せる前に弾く）", async () => {
    assertEqual(
      statusOf(
        await identityAccountLinkNonceHandler(
          makeCtx({
            apiKey: TEST_SECRET,
            secret: TEST_SECRET,
            body: {
              shopify_customer_id: SYN_SHOPIFY,
              link_token: "bad token with spaces",
            },
          }),
        ),
      ),
      400,
    );
  });
  it("不正 JSON body → 400", async () => {
    const ctx = makeCtx({ apiKey: TEST_SECRET, secret: TEST_SECRET });
    (ctx.req as unknown as { json: () => Promise<unknown> }).json = async () => {
      throw new Error("bad json");
    };
    assertEqual(statusOf(await identityAccountLinkNonceHandler(ctx)), 400);
  });
});

// ---------------------------------------------------------------------------
// 7. 連携 URL の解決（Account Link 優先・LIFF フォールバック）
// ---------------------------------------------------------------------------

describe("resolveLinkageUrlForUser（お客さまごとの連携 URL）", () => {
  it("ACCOUNT_LINK_ENTRY_URL 未設定 → 従来の LIFF URL（無回帰）", async () => {
    const url = await resolveLinkageUrlForUser(
      SYN_LINE,
      testEnv({ LIFF_LINKAGE_URL: "https://liff.line.me/x-y" }),
      {
        issueLinkToken: async () => {
          throw new Error("呼ばれてはいけない");
        },
      },
    );
    assertEqual(url, "https://liff.line.me/x-y");
  });

  it("ACCOUNT_LINK_ENTRY_URL 設定 → linkToken 付きの自社入口 URL", async () => {
    const url = await resolveLinkageUrlForUser(
      SYN_LINE,
      testEnv({ ACCOUNT_LINK_ENTRY_URL: "https://elxea.test/ja/link" }),
      { issueLinkToken: async () => ({ ok: true, linkToken: "c".repeat(32) }) },
    );
    assertEqual(url, `https://elxea.test/ja/link?linkToken=${"c".repeat(32)}`);
  });

  it("linkToken 発行失敗 → LIFF URL へ fail-safe（導線を消さない）", async () => {
    const url = await resolveLinkageUrlForUser(
      SYN_LINE,
      testEnv({
        ACCOUNT_LINK_ENTRY_URL: "https://elxea.test/ja/link",
        LIFF_LINKAGE_URL: "https://liff.line.me/x-y",
      }),
      { issueLinkToken: async () => ({ ok: false, reason: "http_500" }) },
    );
    assertEqual(url, "https://liff.line.me/x-y");
  });

  it("両方未設定 → null（従来どおりテキスト案内に倒れる）", async () => {
    assertEqual(await resolveLinkageUrlForUser(SYN_LINE, testEnv()), null);
    assertEqual(resolveAccountLinkEntryUrl({ ACCOUNT_LINK_ENTRY_URL: "  " }), null);
  });
});

// ---------------------------------------------------------------------------
// 8. 連携解除（LINE 必須義務）
// ---------------------------------------------------------------------------

describe("clearCustomerLinkage（行は消さず連携列だけ消す）", () => {
  it("連携中 → 連携列を null にし、他の列（配信停止フラグ）は触らない", async () => {
    const db = makeFakeSupabase({
      customer_linkages: [
        {
          line_user_id: SYN_LINE,
          shopify_customer_id: SYN_SHOPIFY,
          shopify_email: "x@example.test",
          source: "account_link",
          broadcast_opted_out: true,
          unfollowed_at: null,
        },
      ],
    });

    const res = await clearCustomerLinkage(db.client, SYN_LINE);
    assert(res.ok && res.cleared, "解除できた");

    const row = db.tables.customer_linkages[0];
    assertEqual(row.shopify_customer_id, null, "連携先を外す");
    assertEqual(row.shopify_email, null, "連携由来の個人情報を残さない");
    assertEqual(row.source, null);
    assertEqual(row.broadcast_opted_out, true, "配信停止フラグを巻き戻さない");
    assertEqual(db.tables.customer_linkages.length, 1, "行は消さない");
  });

  it("元から未連携 → cleared=false（冪等・壊さない）", async () => {
    const db = makeFakeSupabase({
      customer_linkages: [
        { line_user_id: SYN_LINE, shopify_customer_id: null, broadcast_opted_out: true },
      ],
    });
    const res = await clearCustomerLinkage(db.client, SYN_LINE);
    assert(res.ok, "ok");
    assertEqual(res.ok ? res.cleared : true, false);
    assertEqual(db.tables.customer_linkages[0].broadcast_opted_out, true);
  });
});

describe("handleLinkageFlow -- 解除トリガー", () => {
  it("「連携を解除する」→ 解除して完了をお伝えする", async () => {
    const db = makeFakeSupabase({
      customer_linkages: [
        { line_user_id: SYN_LINE, shopify_customer_id: SYN_SHOPIFY },
      ],
    });
    const { responder, texts } = mockResponder();
    const handled = await handleLinkageFlow(
      SYN_LINE,
      ACCOUNT_LINK_UNLINK_TRIGGER,
      testEnv(),
      responder,
      { supabase: db.client },
    );
    assertEqual(handled, true, "ここで応答完結");
    assertEqual(texts.length, 1);
    assert(texts[0].includes("解除"), "解除した旨");
    assertEqual(db.tables.customer_linkages[0].shopify_customer_id, null);
  });

  it("未連携で解除を求められた → 壊さずお伝えする", async () => {
    const db = makeFakeSupabase({ customer_linkages: [] });
    const { responder, texts } = mockResponder();
    const handled = await handleLinkageFlow(
      SYN_LINE,
      ACCOUNT_LINK_UNLINK_TRIGGER,
      testEnv(),
      responder,
      { supabase: db.client },
    );
    assertEqual(handled, true);
    assertEqual(texts.length, 1);
    assert(texts[0].includes("連携されているアカウントはありません"), "未連携の案内");
  });

  it("無関係な発話は素通り（false・既存フローを壊さない）", async () => {
    const db = makeFakeSupabase();
    const { responder, texts } = mockResponder();
    const handled = await handleLinkageFlow(
      SYN_LINE,
      "おすすめのお茶を教えてください",
      testEnv(),
      responder,
      { supabase: db.client },
    );
    assertEqual(handled, false);
    assertEqual(texts.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 実行
// ---------------------------------------------------------------------------

async function run() {
  console.log("\n============================================================");
  console.log("Account Link (LINE 純正アカウント連携) Unit Tests");
  console.log("============================================================");

  for (const entry of queue) {
    if (entry.name.startsWith("--- ")) {
      console.log(`\n${entry.name}`);
      continue;
    }
    totalTests++;
    try {
      await entry.fn();
      passedTests++;
      console.log(`  [PASS] ${entry.name}`);
    } catch (err) {
      failedTests++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${entry.name}: ${msg}`);
      failures.push({ name: entry.name, error: msg });
    }
  }

  console.log("\n============================================================");
  console.log("Account Link Unit Test Results");
  console.log("============================================================");
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

void run();
