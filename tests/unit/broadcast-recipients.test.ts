/**
 * Unit Tests -- 全員配信の受信者数を「送信のたびに実測する」経路（実送信ゼロ・ネットワーク非接触）
 *
 * 背景（2026-09-11 に判明した実害）:
 *   全員配信は宛先指定なしで送るため実到達は「その時点の友だち全員」。それなのに台帳と
 *   無料枠ガードに載せる人数を env 固定値(48)で持っていたため、2 ヶ月で台帳が過少になった
 *   （実測 68 に対し台帳 48）。本テストは「実測が正・env はフォールバック」への転換と、
 *   既存の fail-closed を緩めていないことを機械で固定する。
 *
 * 検証範囲:
 *   - 実測成功 / 実測0件 / 実測失敗(429) / env も無い
 *   - ページング（2ページ目で next 無し）・ページ上限の安全弁・継続トークン循環の検出
 *   - PII 非保持（userId を数に潰して外へ出さない）
 *   - broadcast 応答ヘッダ X-Line-Request-Id の捕捉
 *   - 送信後の台帳補正（実数で直す / 集計前は触らない / 14日超は諦める）
 *   - **非回帰**: target-resolver の fail-closed（見積 null → kind:"error"）を壊していないこと
 *
 * 使用方法:
 *   npx tsx tests/unit/broadcast-recipients.test.ts
 */

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
function assertTrue(value: boolean, label = "") {
  if (!value) throw new Error(`${label ? label + ": " : ""}expected true`);
}

// ---------------------------------------------------------------------------
// 対象
// ---------------------------------------------------------------------------
import {
  parseFollowerPage,
  parseFallbackCount,
  countFollowers,
  resolveBroadcastRecipientEstimate,
  createLineFollowerPageFetcher,
  MAX_FOLLOWER_PAGES,
  type FollowerPageFetcher,
} from "../../src/lib/line-audience-size";
import {
  parseDeliveredStats,
  decideCorrection,
  isWithinInsightRetention,
  runBroadcastRecipientReconcile,
  INSIGHT_RETENTION_DAYS,
  type ReconcileStore,
  type ReconcileTargetRow,
  type DeliveredStatsFetcher,
} from "../../src/lib/broadcast-reconcile";
import { resolveTargets, type TargetResolverDeps } from "../../src/lib/target-resolver";
import { parseAudience } from "../../src/lib/delivery-audience";
import { createLineSender } from "../../src/lib/line-messages";
import { resolveDeliveryChannel } from "../../src/lib/delivery-channel";
import type { Env } from "../../src/index";

/** ページ列を順に返す fake（ネットワーク非接触）。 */
function pagesFetcher(
  pages: Array<{ count: number; next?: string }>,
): FollowerPageFetcher {
  let i = 0;
  return async () => {
    const p = pages[i] ?? { count: 0 };
    i++;
    return p;
  };
}

// ---------------------------------------------------------------------------
describe("parseFollowerPage（純粋・PII 非保持）", () => {
  it("userIds の個数だけを返し、値そのものは返さない", () => {
    const page = parseFollowerPage({ userIds: ["U1", "U2", "U3"], next: "tok" });
    assertEqual(page.count, 3, "count");
    assertEqual(page.next, "tok", "next");
    // 返り値に userId が一切含まれないことを構造で確認する（PII を持ち回らない設計の固定）。
    assertEqual(JSON.stringify(page).includes("U1"), false, "userId が返り値に混入していない");
    assertEqual(Object.keys(page).sort().join(","), "count,next", "返すキーは count/next のみ");
  });

  it("next が空文字・欠落なら undefined（最終ページ扱い）", () => {
    assertEqual(parseFollowerPage({ userIds: ["U1"], next: "" }).next, undefined, "空文字");
    assertEqual(parseFollowerPage({ userIds: ["U1"] }).next, undefined, "欠落");
  });

  it("壊れた body は 0 件として扱う（throw しない）", () => {
    assertEqual(parseFollowerPage(null).count, 0, "null");
    assertEqual(parseFollowerPage({ userIds: "nope" }).count, 0, "配列でない");
  });
});

describe("parseFallbackCount（env のパース）", () => {
  it("整数文字列は数値に、負値・非数値・未設定は null", () => {
    assertEqual(parseFallbackCount("48"), 48, "48");
    assertEqual(parseFallbackCount("0"), 0, "0 は有効");
    assertEqual(parseFallbackCount("-1"), null, "負値");
    assertEqual(parseFallbackCount("abc"), null, "非数値");
    assertEqual(parseFallbackCount(undefined), null, "未設定");
    assertEqual(parseFallbackCount(null), null, "null");
  });
});

describe("countFollowers（ページングと安全弁）", () => {
  it("1 ページで完結する（next 無し）", async () => {
    const r = await countFollowers(pagesFetcher([{ count: 68 }]));
    assertEqual(r.count, 68, "count");
    assertEqual(r.pages, 1, "pages");
  });

  it("ページング: 2 ページ目で next 無しなら合算して終わる", async () => {
    const r = await countFollowers(
      pagesFetcher([{ count: 1000, next: "cursor-1" }, { count: 234 }]),
    );
    assertEqual(r.count, 1234, "2 ページ合算");
    assertEqual(r.pages, 2, "pages");
  });

  it("安全弁: ページ上限に達したら throw（不完全な数を正にしない）", async () => {
    // 常に next を返し続ける（LINE 側が壊れた場合の模擬）。
    let n = 0;
    const endless: FollowerPageFetcher = async () => ({ count: 1000, next: `c${n++}` });
    let threw = false;
    try {
      await countFollowers(endless, 3);
    } catch (err) {
      threw = true;
      assertTrue(String(err).includes("ページ上限"), "理由がページ上限であること");
    }
    assertTrue(threw, "throw すること");
  });

  it("安全弁: 同じ継続トークンが返ってきたら throw（無限ループ防止）", async () => {
    const looping: FollowerPageFetcher = async () => ({ count: 1000, next: "same" });
    let threw = false;
    try {
      await countFollowers(looping, MAX_FOLLOWER_PAGES);
    } catch (err) {
      threw = true;
      assertTrue(String(err).includes("循環"), "理由が循環であること");
    }
    assertTrue(threw, "throw すること");
  });
});

describe("resolveBroadcastRecipientEstimate（実測が正・env はフォールバック）", () => {
  it("実測成功 → basis=measured・実測値を使う（env 値は無視される）", async () => {
    const r = await resolveBroadcastRecipientEstimate({
      fetchPage: pagesFetcher([{ count: 68 }]),
      envFallback: 48,
    });
    assertEqual(r.count, 68, "実測値を採用");
    assertEqual(r.basis, "measured", "basis");
    assertEqual(r.reason, undefined, "理由なし");
  });

  it("実測0件 → 0 をそのまま採用する（env の 48 で埋めない）", async () => {
    const r = await resolveBroadcastRecipientEstimate({
      fetchPage: pagesFetcher([{ count: 0 }]),
      envFallback: 48,
    });
    assertEqual(r.count, 0, "0 は実測結果として尊重する");
    assertEqual(r.basis, "measured", "basis");
  });

  it("実測失敗(429) → env フォールバック・理由を残す・throw しない", async () => {
    const r = await resolveBroadcastRecipientEstimate({
      fetchPage: async () => {
        throw new Error("followers/ids 429");
      },
      envFallback: 48,
    });
    assertEqual(r.count, 48, "env 値へ退避");
    assertEqual(r.basis, "env_fallback", "basis");
    assertTrue((r.reason ?? "").includes("429"), "理由に 429 が残る");
  });

  it("実測失敗 かつ env も無い → null（呼び出し側の fail-closed に載せる）", async () => {
    const r = await resolveBroadcastRecipientEstimate({
      fetchPage: async () => {
        throw new Error("followers/ids 500");
      },
      envFallback: null,
    });
    assertEqual(r.count, null, "null を返す");
    assertEqual(r.basis, "env_fallback", "basis");
  });

  it("実測の口が無い（未配線）→ env フォールバック", async () => {
    const r = await resolveBroadcastRecipientEstimate({ envFallback: 12 });
    assertEqual(r.count, 12, "env 値");
    assertEqual(r.basis, "env_fallback", "basis");
  });
});

describe("非回帰: target-resolver の fail-closed は緩めていない", () => {
  function broadcastOnlyDeps(estimate: number | null): TargetResolverDeps {
    return {
      loadLinkages: async () => {
        throw new Error("broadcast 経路で呼ばれてはいけない");
      },
      loadPersonaUsers: async () => {
        throw new Error("broadcast 経路で呼ばれてはいけない");
      },
      broadcastEstimate: async () => estimate,
      loadAllowlistUserIds: async () => {
        throw new Error("broadcast 経路で呼ばれてはいけない");
      },
    };
  }

  it("見積 null は従来どおり kind=error（送信不可）", async () => {
    const audience = parseAudience("全員");
    assertTrue(audience?.kind === "all", "全員 → kind=all");
    const r = await resolveTargets(audience!, broadcastOnlyDeps(null));
    assertEqual(r.kind, "error", "null は error のまま");
  });

  it("見積 0 も従来どおり kind=error（1 未満は送信不可）", async () => {
    const audience = parseAudience("全員");
    const r = await resolveTargets(audience!, broadcastOnlyDeps(0));
    assertEqual(r.kind, "error", "0 は error のまま");
  });

  it("実測値が入れば broadcast として解決される", async () => {
    const audience = parseAudience("全員");
    const r = await resolveTargets(audience!, broadcastOnlyDeps(68));
    assertEqual(r.kind, "broadcast", "kind");
    assertTrue(r.kind === "broadcast" && r.estimatedRecipients === 68, "実測値が見積に載る");
  });
});

describe("delivery-channel: env 値はフォールバックとして解決される", () => {
  it("prod は LINE_BROADCAST_ESTIMATED_RECIPIENTS_PROD を fallbackFriendCount に載せる", () => {
    const ch = resolveDeliveryChannel({
      DELIVERY_TARGET_ENV: "prod",
      LINE_CHANNEL_ACCESS_TOKEN: "dummy-token",
      LINE_BROADCAST_ESTIMATED_RECIPIENTS_PROD: "48",
    } as unknown as Env);
    assertEqual(ch.fallbackFriendCount, 48, "fallbackFriendCount");
    assertEqual(ch.targetEnv, "prod", "targetEnv");
  });

  it("未設定なら null（実測が失敗すれば fail-closed に落ちる）", () => {
    const ch = resolveDeliveryChannel({
      DELIVERY_TARGET_ENV: "prod",
      LINE_CHANNEL_ACCESS_TOKEN: "dummy-token",
    } as unknown as Env);
    assertEqual(ch.fallbackFriendCount, null, "fallbackFriendCount");
  });
});

describe("broadcast の応答ヘッダ X-Line-Request-Id を捕捉する", () => {
  it("送信成功時に requestId を SendOutcome に載せる（fetch は stub）", async () => {
    const origFetch = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = (async (url: string) => {
      calledUrl = String(url);
      return new Response("{}", {
        status: 200,
        headers: { "X-Line-Request-Id": "req-abc-123" },
      });
    }) as unknown as typeof fetch;
    try {
      const sender = createLineSender({
        targetEnv: "test",
        accessToken: "dummy",
        fallbackFriendCount: null,
        label: "test",
      });
      const out = await sender.broadcast([{ type: "text", text: "hi" }], 68);
      assertEqual(out.ok, true, "ok");
      assertEqual(out.requestId, "req-abc-123", "requestId を拾う");
      assertTrue(calledUrl.endsWith("/v2/bot/message/broadcast"), "broadcast を叩いている");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("ヘッダが無ければ undefined（例外にしない）", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;
    try {
      const sender = createLineSender({
        targetEnv: "test",
        accessToken: "dummy",
        fallbackFriendCount: null,
        label: "test",
      });
      const out = await sender.broadcast([{ type: "text", text: "hi" }], 5);
      assertEqual(out.requestId, undefined, "undefined");
      assertEqual(out.ok, true, "送信自体は成功扱い");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("createLineFollowerPageFetcher（GET のみ・非2xx は status を理由に throw）", () => {
  it("429 は body を読まずに status を理由に throw する（PII を触らない）", async () => {
    const origFetch = globalThis.fetch;
    let calledUrl = "";
    let method = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calledUrl = String(url);
      method = String(init?.method ?? "GET");
      return new Response("rate limited", { status: 429 });
    }) as unknown as typeof fetch;
    try {
      const fetchPage = createLineFollowerPageFetcher("dummy");
      let msg = "";
      try {
        await fetchPage();
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      assertEqual(msg, "followers/ids 429", "status を理由にする");
      assertEqual(method, "GET", "GET であること（送信系ではない）");
      assertTrue(calledUrl.includes("/v2/bot/followers/ids"), "followers/ids を叩いている");
      assertTrue(calledUrl.includes("limit=1000"), "limit 最大でページングする");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("parseDeliveredStats（送信 1 回ぶんの実配信数）", () => {
  it("ready + delivered 数値 → その数を採用", () => {
    const s = parseDeliveredStats({ overview: { status: "ready", delivered: 68 } });
    assertEqual(s.ok, true, "ok");
    assertEqual(s.delivered, 68, "delivered");
  });

  it("20 人未満でも delivered は null にならない（丸めの対象外）", () => {
    const s = parseDeliveredStats({ overview: { status: "ready", delivered: 3 } });
    assertEqual(s.delivered, 3, "3 通でもそのまま");
  });

  it("unready は集計前として delivered=null（失敗ではない）", () => {
    const s = parseDeliveredStats({ overview: { status: "unready" } });
    assertEqual(s.ok, true, "ok");
    assertEqual(s.delivered, null, "null");
  });

  it("body が object でなければ取得失敗", () => {
    assertEqual(parseDeliveredStats("nope").ok, false, "ok=false");
  });
});

describe("decideCorrection（純粋・増減どちらでも直す）", () => {
  const row: ReconcileTargetRow = {
    id: "row-1",
    lineRequestId: "req-1",
    recipients: 48,
    createdAt: "2026-09-11T06:42:45Z",
  };

  it("実数が見積より多い → corrected（台帳を増やす）", () => {
    const d = decideCorrection(row, { ok: true, delivered: 68 });
    assertEqual(d.outcome, "corrected", "outcome");
    assertEqual(d.before, 48, "before");
    assertEqual(d.after, 68, "after");
  });

  it("実数が見積より少ない → corrected（台帳を減らす＝残枠を正しく戻す）", () => {
    const d = decideCorrection(row, { ok: true, delivered: 40 });
    assertEqual(d.outcome, "corrected", "outcome");
    assertEqual(d.after, 40, "after");
  });

  it("一致 → unchanged", () => {
    assertEqual(decideCorrection(row, { ok: true, delivered: 48 }).outcome, "unchanged");
  });

  it("集計前 → pending（台帳は触らない）", () => {
    const d = decideCorrection(row, { ok: true, delivered: null, reason: "status=unready" });
    assertEqual(d.outcome, "pending", "outcome");
    assertEqual(d.after, null, "after は書かない");
  });

  it("取得不能 → failed", () => {
    assertEqual(decideCorrection(row, { ok: false, delivered: null }).outcome, "failed");
  });
});

describe("isWithinInsightRetention（14 日の壁）", () => {
  const sent = new Date("2026-09-01T00:00:00Z");
  it("13 日後は引ける", () => {
    assertEqual(isWithinInsightRetention(sent, new Date("2026-09-14T00:00:00Z")), true);
  });
  it(`${INSIGHT_RETENTION_DAYS} 日 + 1 時間後は引けない`, () => {
    assertEqual(isWithinInsightRetention(sent, new Date("2026-09-15T01:00:00Z")), false);
  });
});

describe("runBroadcastRecipientReconcile（後追い補正・DB/LINE は fake）", () => {
  function fakeStore(rows: ReconcileTargetRow[]) {
    const applied: Array<{ id: string; delivered: number; note: string }> = [];
    const store: ReconcileStore = {
      loadPending: async () => rows,
      applyActual: async (id, delivered, note) => {
        applied.push({ id, delivered, note });
      },
    };
    return { store, applied };
  }

  const NOW = new Date("2026-09-12T00:00:00Z");

  it("実数で台帳を直す（48 → 68）", async () => {
    const { store, applied } = fakeStore([
      { id: "r1", lineRequestId: "req-1", recipients: 48, createdAt: "2026-09-11T06:42:45Z" },
    ]);
    const fetchDelivered: DeliveredStatsFetcher = async () => ({ ok: true, delivered: 68 });
    const res = await runBroadcastRecipientReconcile({} as Env, {
      store,
      fetchDelivered,
      now: NOW,
    });
    assertEqual(res.ok, true, "ok");
    assertEqual(res.corrected, 1, "corrected");
    assertEqual(applied.length, 1, "1 行だけ書いた");
    assertEqual(applied[0].delivered, 68, "実数を書いた");
    assertTrue(applied[0].note.includes("68"), "根拠メモに実数が入る");
  });

  it("集計前（unready）は台帳を一切触らない", async () => {
    const { store, applied } = fakeStore([
      { id: "r1", lineRequestId: "req-1", recipients: 48, createdAt: "2026-09-11T23:00:00Z" },
    ]);
    const fetchDelivered: DeliveredStatsFetcher = async () => ({
      ok: true,
      delivered: null,
      reason: "status=unready",
    });
    const res = await runBroadcastRecipientReconcile({} as Env, {
      store,
      fetchDelivered,
      now: NOW,
    });
    assertEqual(res.ok, true, "ok");
    assertEqual(res.corrected, 0, "corrected=0");
    assertEqual(applied.length, 0, "書き込みゼロ");
    assertEqual(res.details[0].outcome, "pending", "pending");
  });

  it("14 日を過ぎた行は諦める（LINE を叩かない・見積のまま残す）", async () => {
    const { store, applied } = fakeStore([
      { id: "old", lineRequestId: "req-old", recipients: 48, createdAt: "2026-08-05T03:00:31Z" },
    ]);
    let called = 0;
    const fetchDelivered: DeliveredStatsFetcher = async () => {
      called++;
      return { ok: true, delivered: 56 };
    };
    const res = await runBroadcastRecipientReconcile({} as Env, {
      store,
      fetchDelivered,
      now: NOW,
    });
    assertEqual(called, 0, "保持期間外は LINE を叩かない");
    assertEqual(applied.length, 0, "書き込みゼロ");
    assertEqual(res.details[0].outcome, "failed", "failed");
    assertTrue((res.details[0].reason ?? "").includes("保持期間"), "理由が保持期間超過");
  });

  it("DB が落ちても throw せず ok:false で返す（配信を巻き添えにしない）", async () => {
    const store: ReconcileStore = {
      loadPending: async () => {
        throw new Error('column "line_request_id" does not exist');
      },
      applyActual: async () => {},
    };
    const res = await runBroadcastRecipientReconcile({} as Env, {
      store,
      fetchDelivered: async () => ({ ok: true, delivered: 1 }),
      now: NOW,
    });
    assertEqual(res.ok, false, "ok=false");
    assertTrue((res.reason ?? "").includes("055"), "migration 未適用の可能性を理由に含む");
  });

  it("LINE が 429 を返しても止まらず failed として記録する", async () => {
    const { store, applied } = fakeStore([
      { id: "r1", lineRequestId: "req-1", recipients: 48, createdAt: "2026-09-11T06:42:45Z" },
    ]);
    const res = await runBroadcastRecipientReconcile({} as Env, {
      store,
      fetchDelivered: async () => ({
        ok: false,
        delivered: null,
        reason: "insight/message/event 429",
      }),
      now: NOW,
    });
    assertEqual(res.ok, true, "巡回自体は完走する");
    assertEqual(applied.length, 0, "書き込みゼロ");
    assertEqual(res.details[0].outcome, "failed", "failed");
  });
});

// ---------------------------------------------------------------------------
// ランナー
// ---------------------------------------------------------------------------
(async () => {
  for (const t of queue) {
    if (t.name.startsWith("--- ")) {
      console.log(`\n${t.name}`);
      continue;
    }
    totalTests++;
    try {
      await t.fn();
      passedTests++;
      console.log(`  [PASS] ${t.name}`);
    } catch (err) {
      failedTests++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  [FAIL] ${t.name}: ${msg}`);
      failures.push({ name: t.name, error: msg });
    }
  }
  console.log("\n" + "=".repeat(60));
  console.log("broadcast-recipients Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failedTests > 0 ? 1 : 0);
})();
