/**
 * Unit Tests — events gateway / 主体の発行 / L0 の語彙（CDP 統合 Stage 1）
 *
 * Supabase には触れない（fake クライアント注入）。検証範囲:
 *   - ULID の形と、subject_id が「無意味」であること
 *   - 冪等キーが **生の識別子を含まない**（E5）
 *   - SEC-1: email_hash では主体を解決しない・発行もしない
 *   - E1: 未知の語彙は捨てずに schema_ok = false で積む / 壊れた形だけを落とす
 *   - T-12: 積めなかったときは必ず理由が付く（無言で戻る枝が無い）
 *   - 透過性: 元の書き込みの返り値はそのまま返り、例外はそのまま投げ直される
 *   - 非阻害: L0 側がどれだけ壊れても gateway は throw しない
 *
 * 使用: npx tsx tests/unit/cdp-events-gateway.test.ts
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { newSubjectId, isSubjectId, ULID_RE } from "../../src/lib/cdp/ulid";
import {
  isKnownEventType,
  isWellFormedEventType,
  isKnownChannel,
  isWellFormedChannel,
  behaviorEventType,
  flowEventType,
  RESOLVABLE_IDENTIFIER_KINDS,
  IDENTIFIER_KINDS,
  KNOWN_EVENT_TYPES,
} from "../../src/lib/cdp/event-vocabulary";
import { resolveOrIssueSubject } from "../../src/lib/cdp/subjects";
import {
  buildIdempotencyKey,
  identifierForChannel,
  recordCustomerEvent,
  throughGateway,
  type CustomerFact,
} from "../../src/lib/cdp/events-gateway";

let total = 0;
let passed = 0;
const failures: string[] = [];
const queue: Array<{ name: string; fn: () => void | Promise<void> }> = [];
function it(name: string, fn: () => void | Promise<void>) {
  queue.push({ name, fn });
}
function assertEqual<T>(a: T, e: T, label = "") {
  if (a !== e) throw new Error(`${label}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function assertTrue(v: boolean, label = "") {
  if (!v) throw new Error(`${label}: expected true`);
}

// ---------------------------------------------------------------------------
// fake Supabase — insert / select(eq).limit だけを持つ最小のインメモリ実装。
// customer_events.idempotency_key の一意制約は実スキーマ（041）の写しとして再現する。
// ---------------------------------------------------------------------------
function makeFake(opts?: { failTable?: string; throwOnTable?: string }) {
  const store: Record<string, Array<Record<string, unknown>>> = {};
  const rows = (t: string) => (store[t] ??= []);

  /** identity_edges_uniq（migration 040・2 列）の写し。subject_id は **含まない**。 */
  const edgeClash = (
    existing: Array<Record<string, unknown>>,
    row: Record<string, unknown>,
  ) =>
    existing.some(
      (r) =>
        r.identifier_kind === row.identifier_kind &&
        r.identifier_value === row.identifier_value,
    );

  const client = {
    from(table: string) {
      if (opts?.throwOnTable === table) throw new Error("network down");
      const filters: Array<[string, unknown]> = [];
      const api = {
        async insert(row: Record<string, unknown>) {
          if (opts?.failTable === table) return { error: { message: "insert boom" } };
          if (table === "customer_events") {
            const clash = rows(table).some(
              (r) => r.idempotency_key === row.idempotency_key,
            );
            if (clash) return { error: { code: "23505", message: "duplicate key value" } };
          }
          if (table === "identity_edges" && edgeClash(rows(table), row)) {
            return { error: { code: "23505", message: "duplicate key value" } };
          }
          rows(table).push({ ...row });
          return { error: null };
        },
        // ON CONFLICT DO NOTHING（ignoreDuplicates: true）だけを再現する。
        // DO UPDATE は E4 のトリガに掛かるため実スキーマでも使えない ＝ ここでも拒む。
        async upsert(
          row: Record<string, unknown>,
          options?: { onConflict?: string; ignoreDuplicates?: boolean },
        ) {
          if (opts?.failTable === table) return { error: { message: "upsert boom" } };
          if (options?.ignoreDuplicates !== true) {
            return { error: { message: "この fake は DO NOTHING のみ再現する" } };
          }
          if (table === "identity_edges") {
            // 実スキーマ（040）の identity_edges_uniq は 2 列。3 列だと衝突しない。
            if (options.onConflict !== "identifier_kind,identifier_value") {
              return { error: { message: `想定外の onConflict: ${options.onConflict}` } };
            }
            if (edgeClash(rows(table), row)) return { error: null }; // DO NOTHING
          }
          rows(table).push({ ...row });
          return { error: null };
        },
        select(_cols: string) {
          return api;
        },
        eq(col: string, val: unknown) {
          filters.push([col, val]);
          return api;
        },
        limit(_n: number) {
          if (opts?.failTable === table) {
            return Promise.resolve({ data: null, error: { message: "select boom" } });
          }
          const data = rows(table).filter((r) =>
            filters.every(([c, v]) => String(r[c]) === String(v)),
          );
          return Promise.resolve({ data, error: null });
        },
      };
      return api;
    },
  };
  return { client: client as unknown as SupabaseClient, store };
}

const FACT: CustomerFact = {
  eventType: "behavior.view_content",
  channel: "web",
  identifier: { kind: "web_session_id", value: "sess-abc" },
  dedupe: "article-1@2026-08-29T00:00:00.000Z",
  source: "cx-agent.behavior-log",
  occurredAt: "2026-08-29T00:00:00.000Z",
};

// --- ULID -------------------------------------------------------------------

it("newSubjectId は 26 文字の Crockford base32（I/L/O/U を含まない）", () => {
  for (let i = 0; i < 50; i += 1) {
    const id = newSubjectId();
    assertTrue(ULID_RE.test(id), `ULID の形 (${id})`);
    assertEqual(id.length, 26, "長さ");
    assertTrue(!/[ILOU]/.test(id), `紛らわしい文字を含まない (${id})`);
  }
});

it("newSubjectId は時刻が先頭に来る（後で発行したものが辞書順で後ろになる）", () => {
  const zeros = new Uint8Array(16);
  const early = newSubjectId(1_700_000_000_000, zeros);
  const late = newSubjectId(1_700_000_001_000, zeros);
  assertTrue(early < late, "時刻順に並ぶ");
});

it("isSubjectId は形の違う値を弾く", () => {
  assertEqual(isSubjectId(newSubjectId()), true, "正しい ULID");
  assertEqual(isSubjectId("not-a-ulid"), false, "別形式");
  assertEqual(isSubjectId(""), false, "空");
  assertEqual(isSubjectId(null), false, "null");
});

// --- 語彙 -------------------------------------------------------------------

it("既知の語彙は既知と判定される（三分裂していた行動語彙が 1 つに合流している）", () => {
  assertEqual(isKnownEventType(behaviorEventType("chat_started")), true, "cx-agent 由来");
  assertEqual(isKnownEventType(behaviorEventType("audio_play")), true, "web-app 由来");
  assertEqual(isKnownEventType(flowEventType("survey.answer")), true, "flow 由来");
  assertEqual(isKnownEventType("purchase.order_paid"), true, "独立した出来事");
});

it("channel の 4 者食い違いが 1 つの登録簿に合流している（shopify を含む）", () => {
  for (const ch of ["line", "web", "shopify"]) {
    assertEqual(isKnownChannel(ch), true, `既知 channel ${ch}`);
  }
  assertEqual(isKnownChannel("sms"), false, "未知 channel");
});

it("未知の語彙は「未知」だが、形が正しければ **載せられる**（E1）", () => {
  assertEqual(isKnownEventType("behavior.some_new_action"), false, "未知");
  assertEqual(isWellFormedEventType("behavior.some_new_action"), true, "形は正しい");
});

it("形が壊れた型名・channel は載せられない（語彙の検査ではなく形の検査）", () => {
  assertEqual(isWellFormedEventType("Behavior.View"), false, "大文字");
  assertEqual(isWellFormedEventType("behavior..view"), false, "空セグメント");
  assertEqual(isWellFormedEventType(""), false, "空");
  assertEqual(isWellFormedEventType(`a.${"x".repeat(100)}`), false, "長すぎ");
  assertEqual(isWellFormedChannel("WEB"), false, "大文字 channel");
});

it("行動語彙の登録簿は cx-agent の 14 値 + audio_play を含む", () => {
  const expected = [
    "tap_button", "view_content", "view_product", "purchase", "line_message",
    "search", "tea_mention", "flavor_preference", "topic_interest", "chat_started",
    "product_viewed", "cart_link_clicked", "feedback_given", "survey_completed",
    "audio_play",
  ];
  for (const a of expected) {
    assertTrue(KNOWN_EVENT_TYPES.has(behaviorEventType(a)), `behavior.${a} が登録簿にある`);
  }
});

// --- SEC-1 ------------------------------------------------------------------

it("SEC-1: email_hash は識別子の語彙にはあるが、解決には使えない", () => {
  assertTrue(
    (IDENTIFIER_KINDS as readonly string[]).includes("email_hash"),
    "観測としては置ける",
  );
  assertEqual(RESOLVABLE_IDENTIFIER_KINDS.has("email_hash" as never), false, "解決には使わない");
});

it("SEC-1: email_hash で呼ばれても主体を発行しない（黙って作らない・理由を返す）", async () => {
  const { client, store } = makeFake();
  const r = await resolveOrIssueSubject(
    client,
    { kind: "email_hash", value: "deadbeef" },
    "test",
  );
  assertEqual(r.subjectId, null, "主体を返さない");
  assertEqual(r.subjectId === null ? r.reason : "", "identifier_kind_not_resolvable", "理由");
  assertEqual((store.subjects ?? []).length, 0, "主体を発行していない");
});

// --- 主体の発行 -------------------------------------------------------------

it("初回は発行し、2 回目は同じ主体を引く（edge が 2 本にならない）", async () => {
  const { client, store } = makeFake();
  const first = await resolveOrIssueSubject(client, { kind: "line_messaging_uid", value: "U1" }, "test");
  const second = await resolveOrIssueSubject(client, { kind: "line_messaging_uid", value: "U1" }, "test");

  assertTrue(first.subjectId !== null, "1 回目で発行");
  assertEqual(first.issued, true, "1 回目は issued");
  assertEqual(second.subjectId, first.subjectId, "2 回目は同じ主体");
  assertEqual(second.issued, false, "2 回目は発行しない");
  assertEqual(store.subjects.length, 1, "subjects 1 行");
  assertEqual(store.identity_edges.length, 1, "edges 1 行");
});

// MID-1（QA 指摘 2026-08-29）: 未登録の鍵に同時に 2 つ来ても主体は 1 つに収まる。
// 3 列 UNIQUE だった初版は、subject_id が違えば衝突しないので edge が 2 本立ち、
// 「1 鍵 = 1 主体」が黙って破れていた。fake の一意判定も 2 列に揃えてある。
it("同じ鍵で並行に 2 つ走っても、主体は 1 つに収束する（edge は 1 本・発行者は 1 つ）", async () => {
  const { client, store } = makeFake();
  const [a, b] = await Promise.all([
    resolveOrIssueSubject(client, { kind: "line_messaging_uid", value: "U-race" }, "test-a"),
    resolveOrIssueSubject(client, { kind: "line_messaging_uid", value: "U-race" }, "test-b"),
  ]);

  assertTrue(a.subjectId !== null, "A が主体を得られない");
  assertTrue(b.subjectId !== null, "B が主体を得られない");
  assertEqual(a.subjectId, b.subjectId, "同じ鍵なのに違う主体を返した（1 鍵 = 1 主体が破れている）");
  assertEqual(store.identity_edges.length, 1, "edge が 2 本立っている");
  assertEqual([a.issued, b.issued].filter(Boolean).length, 1, "発行者はちょうど 1 つ");

  // 収束したあとに 3 つ目が来ても、同じ主体を引くだけ（発行しない）。
  const third = await resolveOrIssueSubject(
    client,
    { kind: "line_messaging_uid", value: "U-race" },
    "test-c",
  );
  assertEqual(third.subjectId, a.subjectId, "3 つ目が別の主体を引いた");
  assertEqual(third.issued, false, "3 つ目が発行してしまった");
  assertEqual(store.identity_edges.length, 1, "3 つ目で edge が増えた");
});

it("負けた側が発行した主体は残るが、鍵からは辿れない（不変条件は edge 側が保つ）", async () => {
  const { client, store } = makeFake();
  const [a, b] = await Promise.all([
    resolveOrIssueSubject(client, { kind: "web_session_id", value: "s-race" }, "test-a"),
    resolveOrIssueSubject(client, { kind: "web_session_id", value: "s-race" }, "test-b"),
  ]);
  const winner = a.subjectId;
  assertEqual(b.subjectId, winner, "勝者が 1 つに定まっていない");
  // 発行そのものは 2 回起きうる（負けたほうは edge を持てない）。
  assertTrue(store.subjects.length <= 2, "主体が 3 つ以上立っている");
  const edgeSubjects = new Set(store.identity_edges.map((e) => e.subject_id));
  assertEqual(edgeSubjects.size, 1, "鍵から辿れる主体が 1 つでない");
  assertTrue(edgeSubjects.has(winner), "鍵が勝者以外を指している");
});

it("空の識別子では発行しない（理由付き）", async () => {
  const { client, store } = makeFake();
  const r = await resolveOrIssueSubject(client, { kind: "line_messaging_uid", value: "  " }, "test");
  assertEqual(r.subjectId, null, "主体なし");
  assertEqual(r.subjectId === null ? r.reason : "", "identifier_value_empty", "理由");
  assertEqual((store.subjects ?? []).length, 0, "発行していない");
});

it("channel から identity_edges の kind を決める（分岐を 1 か所に閉じている）", () => {
  assertEqual(identifierForChannel("web", "s").kind, "web_session_id", "web");
  assertEqual(identifierForChannel("line", "U").kind, "line_messaging_uid", "line");
  // 未知の channel は line 側に倒す（LINE が既定チャネルであるため）。
  assertEqual(identifierForChannel("shopify", "7").kind, "line_messaging_uid", "既定");
});

// --- 冪等キー ---------------------------------------------------------------

it("冪等キーは subject_id を使い、生の識別子を含まない（E5）", () => {
  const sid = newSubjectId();
  const key = buildIdempotencyKey("cx-agent.flow-events", sid, "flow.menu_tap", "menu/1@t");
  assertTrue(key.includes(sid), "subject_id を含む");
  assertTrue(!key.includes("U1234567890"), "生の LINE userId を含まない");
  assertEqual(key, `cx-agent.flow-events:${sid}:flow.menu_tap:menu/1@t`, "組み立て");
});

it("冪等キーは 200 文字で切り詰める（DB の CHECK と揃える）", () => {
  const key = buildIdempotencyKey("s", newSubjectId(), "behavior.search", "x".repeat(500));
  assertEqual(key.length, 200, "上限");
});

// --- gateway ----------------------------------------------------------------

it("既知の語彙は schema_ok = true で積まれる", async () => {
  const { client, store } = makeFake();
  const r = await recordCustomerEvent(client, FACT);
  assertEqual(r.stored, true, "積まれた");
  assertEqual(r.schemaOk, true, "既知");
  assertEqual(store.customer_events.length, 1, "1 行");
  assertEqual(store.customer_events[0].schema_ok, true, "行の schema_ok");
});

it("E1: 未知の語彙でも **捨てずに** 積み、schema_ok = false を立てる", async () => {
  const { client, store } = makeFake();
  const r = await recordCustomerEvent(client, { ...FACT, eventType: "behavior.brand_new" });
  assertEqual(r.stored, true, "積まれた（捨てていない）");
  assertEqual(r.schemaOk, false, "未知と印を付けた");
  assertEqual(store.customer_events[0].event_type, "behavior.brand_new", "型名はそのまま");
});

it("E1: 未知の channel も同じ扱い（schema_ok = false で積む）", async () => {
  const { client } = makeFake();
  const r = await recordCustomerEvent(client, { ...FACT, channel: "sms" });
  assertEqual(r.stored, true, "積まれた");
  assertEqual(r.schemaOk, false, "未知");
});

it("T-12: 積めなかったときは必ず理由が付く（無言で戻る枝が無い）", async () => {
  const { client } = makeFake();
  const cases: Array<[Partial<CustomerFact>, string]> = [
    [{ eventType: "Bad Type" }, "event_type_malformed"],
    [{ channel: "WEB" }, "channel_malformed"],
    [{ dedupe: "" }, "dedupe_missing"],
    [
      { identifier: { kind: "email_hash", value: "x" } },
      "subject_unavailable:identifier_kind_not_resolvable",
    ],
  ];
  for (const [patch, reason] of cases) {
    const r = await recordCustomerEvent(client, { ...FACT, ...patch });
    assertEqual(r.stored, false, `積まない (${reason})`);
    assertEqual(r.reason, reason, "理由");
  }
});

it("元の書き込みが skip した理由が L0 の payload に残る（T-12 の本体）", async () => {
  const { client, store } = makeFake();
  await recordCustomerEvent(client, FACT, {
    status: "skipped",
    reason: "not_linked_to_shopify",
  });
  const payload = store.customer_events[0].payload as {
    legacy_write?: { status?: string; reason?: string };
  };
  assertEqual(payload.legacy_write?.status, "skipped", "status");
  assertEqual(payload.legacy_write?.reason, "not_linked_to_shopify", "reason");
});

it("同じ dedupe の 2 回目は duplicate として静かに落ちる（失敗として数えない）", async () => {
  const { client, store } = makeFake();
  await recordCustomerEvent(client, FACT);
  const second = await recordCustomerEvent(client, FACT);
  assertEqual(second.stored, false, "2 行目にならない");
  assertEqual(second.reason, "duplicate_idempotency_key", "理由");
  assertEqual(store.customer_events.length, 1, "1 行のまま");
});

it("L0 側が壊れていても gateway は throw しない（応答を止めない）", async () => {
  for (const opts of [
    { failTable: "customer_events" },
    { failTable: "identity_edges" },
    { throwOnTable: "subjects" },
  ]) {
    const { client } = makeFake(opts);
    const r = await recordCustomerEvent(client, FACT);
    assertEqual(r.stored, false, `積めない (${JSON.stringify(opts)})`);
    assertTrue(typeof r.reason === "string" && r.reason.length > 0, "理由が付く");
  }
});

// --- 透過性 -----------------------------------------------------------------

it("throughGateway は元の書き込みの返り値をそのまま返す", async () => {
  const { client } = makeFake();
  const result = await throughGateway(client, FACT, async () => ({ ok: true, n: 42 }));
  assertEqual(result.n, 42, "返り値が素通し");
});

it("throughGateway は元の書き込みの例外をそのまま投げ直す（握りつぶさない）", async () => {
  const { client, store } = makeFake();
  let thrown: unknown = null;
  try {
    await throughGateway(client, FACT, async () => {
      throw new TypeError("legacy exploded");
    });
  } catch (err) {
    thrown = err;
  }
  assertTrue(thrown instanceof TypeError, "同じ例外が出る");
  // 落ちたこと自体も出来事として残っている。
  const payload = store.customer_events[0].payload as { legacy_write?: { status?: string } };
  assertEqual(payload.legacy_write?.status, "failed", "failed として残る");
});

it("throughGateway は元の書き込みを先に呼ぶ（L0 が先行して嘘をつかない）", async () => {
  const { client } = makeFake();
  const order: string[] = [];
  await throughGateway(client, FACT, async () => {
    order.push("legacy");
    return { status: "ok" as const };
  });
  order.push("after");
  assertEqual(order[0], "legacy", "元の書き込みが先");
});

// --- runner -----------------------------------------------------------------

async function run() {
  console.log("\n=== cdp-events-gateway.test ===\n");
  for (const { name, fn } of queue) {
    total += 1;
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  [FAIL] ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log(`\n=== cdp-events-gateway.test: ${passed}/${total} passed, ${failures.length} failed ===`);
  if (failures.length > 0) process.exit(1);
}

void run();
