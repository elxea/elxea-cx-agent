/**
 * Unit Tests -- Notion駆動 LINE配信 送信部（T4/T5/T6/T12/T8/T9/T10）
 *
 * 送信は全て mock/stub でネットワーク非接触。実 LINE / 実 Notion / 実 Supabase には触れない。
 * 検証範囲:
 *   - 配信対象の日本語↔enum 変換（parseAudience）
 *   - 配信予定日時の厳格化（missing/date_only/invalid/future/due）
 *   - コンテンツ pinning ハッシュ（一致/編集で不一致/スナップショット欠如）
 *   - 承認者!=著者（自己承認検知）
 *   - メッセージ組み立て（text 空 / image 非HTTPS・Notion署名URL 拒否）
 *   - 対象解決の除外（未リンク/退会/opt-out/ペルソナ不一致/重複）・500超バッチ・ページング
 *   - broadcast 見積 fail-closed
 *   - オーケストレータの順序（claim→ガード→送信stub）・dry-run 無送信・pinning 不一致で中止・reaper
 *
 * 使用方法:
 *   npx tsx tests/unit/delivery-send.test.ts
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
function assertFalse(value: boolean, label = "") {
  if (value) throw new Error(`${label ? label + ": " : ""}expected false`);
}

// ---------------------------------------------------------------------------
// 対象
// ---------------------------------------------------------------------------
import { parseAudience, audienceLabel } from "../../src/lib/delivery-audience";
import { evaluateScheduledTime } from "../../src/lib/delivery-time";
import { computeContentHash, hashesMatch } from "../../src/lib/content-hash";
import { hasIndependentApprover } from "../../src/lib/delivery-approval";
import {
  buildMessages,
  chunkForMulticast,
  isPermanentHttpsUrl,
  createRecordingSender,
  noopSender,
} from "../../src/lib/line-messages";
import {
  joinCandidates,
  filterEligible,
  collectAllPages,
  resolveTargets,
  type LinkageRow,
  type PersonaRow,
  type TargetResolverDeps,
} from "../../src/lib/target-resolver";
import {
  runDeliveryOnce,
  classifyStaleSending,
  type OrchestratorDeps,
  type DeliveryRepoPort,
} from "../../src/lib/delivery-orchestrator";
import type { DeliveryPage } from "../../src/lib/delivery-repository";
import type {
  LedgerStore,
  LedgerEntry,
  ConsumptionFetcher,
} from "../../src/lib/message-ledger";

// ---------------------------------------------------------------------------
// parseAudience
// ---------------------------------------------------------------------------
describe("parseAudience（配信対象 日本語↔enum）", () => {
  it("全員 → broadcast(all)", () => {
    const a = parseAudience("全員");
    assertTrue(!!a && a.kind === "all", "all");
  });
  it("癒し → persona serenity", () => {
    const a = parseAudience("癒し");
    assertTrue(!!a && a.kind === "persona" && a.persona === "serenity", "serenity");
  });
  it("探求 → explorer / 味覚 → sensory", () => {
    const e = parseAudience("探求");
    const s = parseAudience("味覚");
    assertTrue(!!e && e.kind === "persona" && e.persona === "explorer", "explorer");
    assertTrue(!!s && s.kind === "persona" && s.persona === "sensory", "sensory");
  });
  it("空・未知・null は null（fail-closed）", () => {
    assertEqual(parseAudience(""), null, "空");
    assertEqual(parseAudience("  "), null, "空白");
    assertEqual(parseAudience("その他"), null, "未知");
    assertEqual(parseAudience(null), null, "null");
    assertEqual(parseAudience(undefined), null, "undefined");
  });
  it("audienceLabel は逆変換ラベルを返す", () => {
    assertEqual(audienceLabel({ kind: "all" }), "全員");
    assertEqual(audienceLabel({ kind: "persona", persona: "serenity" }), "癒し");
  });
});

// ---------------------------------------------------------------------------
// evaluateScheduledTime（TZ 厳格化）
// ---------------------------------------------------------------------------
describe("evaluateScheduledTime（日時厳格化）", () => {
  const now = new Date("2026-07-10T05:00:00Z");
  it("空/null は missing（送信不可）", () => {
    const d = evaluateScheduledTime(null, now);
    assertTrue(!d.sendable && d.reason === "missing", "missing");
  });
  it("date-only（時刻なし）は date_only（送信不可）", () => {
    const d = evaluateScheduledTime("2026-07-10", now);
    assertTrue(!d.sendable && d.reason === "date_only", "date_only");
  });
  it("パース不能は invalid（送信不可）", () => {
    const d = evaluateScheduledTime("not-a-date", now);
    assertTrue(!d.sendable && d.reason === "invalid", "invalid");
  });
  it("過去 datetime は sendable && due", () => {
    const d = evaluateScheduledTime("2026-07-10T04:00:00Z", now);
    assertTrue(d.sendable, "sendable");
    if (d.sendable) assertTrue(d.due, "due");
  });
  it("未来 datetime は sendable だが due=false（エラーではない）", () => {
    const d = evaluateScheduledTime("2026-07-10T06:00:00Z", now);
    assertTrue(d.sendable, "sendable");
    if (d.sendable) assertFalse(d.due, "not due");
  });
  it("JST オフセット付き（06:00+09:00 = 21:00 UTC 前日）を UTC 正規化する", () => {
    // 2026-07-10T06:00:00+09:00 = 2026-07-09T21:00:00Z（now=07-10 05:00Z より過去 → due）
    const d = evaluateScheduledTime("2026-07-10T06:00:00+09:00", now);
    assertTrue(d.sendable, "sendable");
    if (d.sendable) {
      assertEqual(d.sendAtUtc, "2026-07-09T21:00:00.000Z", "UTC 正規化");
      assertTrue(d.due, "due");
    }
  });
});

// ---------------------------------------------------------------------------
// content-hash（pinning）
// ---------------------------------------------------------------------------
describe("computeContentHash / hashesMatch（TOCTOU pinning）", () => {
  it("同一内容は同一ハッシュ", async () => {
    const a = await computeContentHash({ format: "text", body: "こんにちは", imageUrl: null });
    const b = await computeContentHash({ format: "text", body: "こんにちは", imageUrl: null });
    assertEqual(a, b, "deterministic");
    assertTrue(hashesMatch(a, b), "match");
  });
  it("本文を編集するとハッシュ不一致（送信中止根拠）", async () => {
    const snap = await computeContentHash({ format: "text", body: "旧本文", imageUrl: null });
    const cur = await computeContentHash({ format: "text", body: "新本文（編集後）", imageUrl: null });
    assertFalse(hashesMatch(snap, cur), "mismatch");
  });
  it("画像URLを編集するとハッシュ不一致", async () => {
    const snap = await computeContentHash({ format: "image", body: null, imageUrl: "https://cdn.example.com/a.jpg" });
    const cur = await computeContentHash({ format: "image", body: null, imageUrl: "https://cdn.example.com/b.jpg" });
    assertFalse(hashesMatch(snap, cur), "mismatch");
  });
  it("空スナップショットは常に不一致（fail-closed）", async () => {
    const cur = await computeContentHash({ format: "text", body: "x", imageUrl: null });
    assertFalse(hashesMatch(null, cur), "null snapshot");
    assertFalse(hashesMatch("", cur), "empty snapshot");
  });
});

// ---------------------------------------------------------------------------
// 自己承認検知
// ---------------------------------------------------------------------------
describe("hasIndependentApprover（承認者!=著者）", () => {
  it("担当者と異なる承認者がいれば true", () => {
    assertTrue(hasIndependentApprover(["u-author"], ["u-approver"]), "independent");
  });
  it("承認者が空は false（fail-closed）", () => {
    assertFalse(hasIndependentApprover(["u-author"], []), "no approver");
  });
  it("承認者が全員担当者を兼ねる（自己承認）は false", () => {
    assertFalse(hasIndependentApprover(["u-a", "u-b"], ["u-a"]), "self approval");
    assertFalse(hasIndependentApprover(["u-a"], ["u-a"]), "single self");
  });
  it("担当者に無関係な承認者が 1 人でもいれば true", () => {
    assertTrue(hasIndependentApprover(["u-a"], ["u-a", "u-c"]), "one independent");
  });
});

// ---------------------------------------------------------------------------
// buildMessages / isPermanentHttpsUrl / chunk（T6）
// ---------------------------------------------------------------------------
describe("buildMessages（text/image 可変化）", () => {
  it("text: 本文があれば text メッセージ 1 件", () => {
    const r = buildMessages({ format: "text", body: "本文です", imageUrl: null });
    assertTrue(r.ok, "ok");
    if (r.ok) {
      assertEqual(r.messages.length, 1, "1 件");
      assertEqual(r.messages[0].type, "text", "type text");
    }
  });
  it("text: 本文が空は不可（fail-closed）", () => {
    const r = buildMessages({ format: "text", body: "  ", imageUrl: null });
    assertFalse(r.ok, "empty body rejected");
  });
  it("image: 恒久 HTTPS なら image メッセージ", () => {
    const r = buildMessages({ format: "image", body: null, imageUrl: "https://cdn.example.com/a.jpg" });
    assertTrue(r.ok, "ok");
    if (r.ok) assertEqual(r.messages[0].type, "image", "type image");
  });
  it("image: Notion 署名 URL / http は拒否", () => {
    assertFalse(buildMessages({ format: "image", body: null, imageUrl: "http://cdn.example.com/a.jpg" }).ok, "http");
    assertFalse(
      buildMessages({ format: "image", body: null, imageUrl: "https://prod-files-secure.s3.amazonaws.com/x?X-Amz-Signature=abc" }).ok,
      "notion signed",
    );
    assertFalse(
      buildMessages({ format: "image", body: null, imageUrl: "https://file.notion.so/f/a.jpg" }).ok,
      "notion host",
    );
  });
  it("isPermanentHttpsUrl の判定", () => {
    assertTrue(isPermanentHttpsUrl("https://cdn.shopify.com/x.jpg"), "cdn https");
    assertFalse(isPermanentHttpsUrl("https://x.notion.site/a.jpg"), "notion.site");
    assertFalse(isPermanentHttpsUrl(null), "null");
  });
  it("chunkForMulticast は 500 超を分割", () => {
    const ids = Array.from({ length: 1250 }, (_, i) => `u${i}`);
    const batches = chunkForMulticast(ids);
    assertEqual(batches.length, 3, "3 バッチ");
    assertEqual(batches[0].length, 500, "batch0=500");
    assertEqual(batches[2].length, 250, "batch2=250");
  });
});

// ---------------------------------------------------------------------------
// target-resolver（T4）
// ---------------------------------------------------------------------------
describe("joinCandidates / filterEligible（除外ロジック）", () => {
  const linkages: LinkageRow[] = [
    { shopifyCustomerId: "s1", lineUserId: "L1", unfollowed: false, optedOut: false },
    { shopifyCustomerId: "s2", lineUserId: "L2", unfollowed: true, optedOut: false }, // 退会
    { shopifyCustomerId: "s3", lineUserId: "L3", unfollowed: false, optedOut: true }, // opt-out
    { shopifyCustomerId: "s4", lineUserId: null, unfollowed: false, optedOut: false }, // 未リンク
    { shopifyCustomerId: "s5", lineUserId: "L5", unfollowed: false, optedOut: false },
  ];
  const personas: PersonaRow[] = [
    { shopifyCustomerId: "s1", persona: "serenity" },
    { shopifyCustomerId: "s2", persona: "serenity" },
    { shopifyCustomerId: "s3", persona: "serenity" },
    { shopifyCustomerId: "s4", persona: "serenity" },
    { shopifyCustomerId: "s5", persona: "explorer" }, // 別ペルソナ
    { shopifyCustomerId: "s6", persona: "serenity" }, // linkage 無し（未リンク）
  ];

  it("serenity 対象は L1 のみ（退会/opt-out/未リンク/別ペルソナを除外）", () => {
    const cands = joinCandidates(personas, linkages);
    const ids = filterEligible(cands, "serenity");
    assertEqual(ids.length, 1, "1 件");
    assertEqual(ids[0], "L1", "L1 のみ");
  });
  it("explorer 対象は L5", () => {
    const cands = joinCandidates(personas, linkages);
    const ids = filterEligible(cands, "explorer");
    assertEqual(ids.join(","), "L5", "L5");
  });
  it("同一 lineUserId の重複は 1 件に畳む", () => {
    const dupPersonas: PersonaRow[] = [
      { shopifyCustomerId: "s1", persona: "serenity" },
      { shopifyCustomerId: "s1", persona: "serenity" },
    ];
    const ids = filterEligible(joinCandidates(dupPersonas, linkages), "serenity");
    assertEqual(ids.length, 1, "dedup");
  });
});

describe("collectAllPages（ページング）", () => {
  it("nextCursor が尽きるまで全件集める", async () => {
    const pages = [
      { items: [1, 2], nextCursor: "c1" },
      { items: [3, 4], nextCursor: "c2" },
      { items: [5], nextCursor: undefined },
    ];
    let call = 0;
    const all = await collectAllPages<number>(async () => pages[call++]);
    assertEqual(all.join(","), "1,2,3,4,5", "all pages");
    assertEqual(call, 3, "3 ページ取得");
  });
});

describe("resolveTargets", () => {
  const baseDeps = (over: Partial<TargetResolverDeps>): TargetResolverDeps => ({
    loadLinkages: async () => [],
    loadPersonaUsers: async () => [],
    broadcastEstimate: async () => null,
    ...over,
  });

  it("全員: 見積があれば broadcast", async () => {
    const r = await resolveTargets({ kind: "all" }, baseDeps({ broadcastEstimate: async () => 38 }));
    assertTrue(r.kind === "broadcast", "broadcast");
    if (r.kind === "broadcast") assertEqual(r.estimatedRecipients, 38, "38");
  });
  it("全員: 見積 null は error（fail-closed）", async () => {
    const r = await resolveTargets({ kind: "all" }, baseDeps({ broadcastEstimate: async () => null }));
    assertTrue(r.kind === "error", "error");
  });
  it("ペルソナ: 除外後 0 件は error", async () => {
    const r = await resolveTargets(
      { kind: "persona", persona: "serenity" },
      baseDeps({
        loadLinkages: async () => [{ shopifyCustomerId: "s1", lineUserId: "L1", unfollowed: true, optedOut: false }],
        loadPersonaUsers: async () => [{ shopifyCustomerId: "s1", persona: "serenity" }],
      }),
    );
    assertTrue(r.kind === "error", "error (0 件)");
  });
  it("ペルソナ: multicast + バッチ + 件数", async () => {
    const r = await resolveTargets(
      { kind: "persona", persona: "serenity" },
      baseDeps({
        loadLinkages: async () => [
          { shopifyCustomerId: "s1", lineUserId: "L1", unfollowed: false, optedOut: false },
          { shopifyCustomerId: "s2", lineUserId: "L2", unfollowed: false, optedOut: false },
        ],
        loadPersonaUsers: async () => [
          { shopifyCustomerId: "s1", persona: "serenity" },
          { shopifyCustomerId: "s2", persona: "serenity" },
        ],
      }),
    );
    assertTrue(r.kind === "multicast", "multicast");
    if (r.kind === "multicast") {
      assertEqual(r.estimatedRecipients, 2, "2 件");
      assertEqual(r.batches.length, 1, "1 バッチ");
    }
  });
});

// ---------------------------------------------------------------------------
// delivery-repository（T5）— fake NotionRequest でプロパティ整形を検証
// ---------------------------------------------------------------------------
import {
  normalizeDeliveryPage,
  queryDueDeliveries,
  writeDeliveryResult,
  pinApproval,
  resetApproval as repoResetApproval,
  DELIVERY_PROPS,
  type NotionRequest,
} from "../../src/lib/delivery-repository";

describe("normalizeDeliveryPage（Notion page → DeliveryPage）", () => {
  it("日本語プロパティを正しく抽出する", () => {
    const P = DELIVERY_PROPS;
    const raw = {
      id: "pg1",
      last_edited_time: "2026-07-10T04:00:00Z",
      properties: {
        [P.title]: { title: [{ plain_text: "夏の配信" }] },
        [P.status]: { status: { name: "Approved" } },
        [P.audience]: { select: { name: "癒し" } },
        [P.format]: { select: { name: "image" } },
        [P.body]: { rich_text: [] },
        [P.imageUrl]: { url: "https://cdn.example.com/x.jpg" },
        [P.scheduled]: { date: { start: "2026-07-10T06:00:00+09:00" } },
        [P.sent]: { checkbox: false },
        [P.contentHash]: { rich_text: [{ plain_text: "abc123" }] },
        [P.estimate]: { number: 38 },
        [P.assignees]: { people: [{ id: "u-author" }] },
        [P.approvers]: { people: [{ id: "u-approver" }] },
      },
    };
    const page = normalizeDeliveryPage(raw);
    assertEqual(page.title, "夏の配信", "title");
    assertEqual(page.status, "Approved", "status");
    assertEqual(page.audienceRaw, "癒し", "audience");
    assertEqual(page.format, "image", "format");
    assertEqual(page.imageUrl, "https://cdn.example.com/x.jpg", "imageUrl");
    assertEqual(page.body, null, "empty body → null");
    assertEqual(page.contentHash, "abc123", "hash");
    assertEqual(page.estimate, 38, "estimate");
    assertEqual(page.assignees.join(","), "u-author", "assignees");
    assertEqual(page.approvers.join(","), "u-approver", "approvers");
    assertFalse(page.sent, "not sent");
  });
});

describe("queryDueDeliveries（フィルタ組み立て）", () => {
  it("Approved AND 未送信 AND 予定<=now のフィルタを送る", async () => {
    let captured: Record<string, unknown> | undefined;
    const req: NotionRequest = async (path, method, body) => {
      captured = body;
      assertTrue(path.includes("/query"), "query path");
      assertEqual(method, "POST", "POST");
      return { results: [], has_more: false };
    };
    await queryDueDeliveries(req, "2026-07-10T05:00:00Z", "db-1");
    const filter = (captured as { filter: { and: Array<Record<string, unknown>> } }).filter;
    assertEqual(filter.and.length, 3, "3 条件");
  });
});

describe("writeDeliveryResult / pinApproval / resetApproval（PATCH 整形）", () => {
  it("writeResult は送信済み=true, sent_at, 消費実績 を含む", async () => {
    let captured: Record<string, unknown> | undefined;
    const req: NotionRequest = async (_p, _m, body) => {
      captured = body;
      return {};
    };
    await writeDeliveryResult(req, "pg1", {
      status: "Sent",
      sentAtUtc: "2026-07-10T05:00:00Z",
      summary: "OK",
      consumed: 38,
    });
    const props = (captured as { properties: Record<string, { checkbox?: boolean; number?: number }> }).properties;
    assertTrue(props[DELIVERY_PROPS.sent].checkbox === true, "送信済み=true");
    assertEqual(props[DELIVERY_PROPS.consumed].number, 38, "消費実績");
  });
  it("pinApproval は コンテンツハッシュ を書き Approved にする", async () => {
    let captured: Record<string, unknown> | undefined;
    const req: NotionRequest = async (_p, _m, body) => {
      captured = body;
      return {};
    };
    await pinApproval(req, "pg1", "hash-xyz");
    const props = (captured as { properties: Record<string, { status?: { name: string }; rich_text?: Array<{ text: { content: string } }> }> }).properties;
    assertEqual(props[DELIVERY_PROPS.status].status?.name, "Approved", "Approved");
    assertEqual(props[DELIVERY_PROPS.contentHash].rich_text?.[0].text.content, "hash-xyz", "hash 保存");
  });
  it("resetApproval は Draft に戻す", async () => {
    let captured: Record<string, unknown> | undefined;
    const req: NotionRequest = async (_p, _m, body) => {
      captured = body;
      return {};
    };
    await repoResetApproval(req, "pg1", "編集検知");
    const props = (captured as { properties: Record<string, { status?: { name: string } }> }).properties;
    assertEqual(props[DELIVERY_PROPS.status].status?.name, "Draft", "Draft");
  });
});

// ---------------------------------------------------------------------------
// オーケストレータ（T9）— fake 注入・ネットワーク非接触
// ---------------------------------------------------------------------------

function makeFakeLedger(): LedgerStore & { rows: LedgerEntry[] } {
  const rows: LedgerEntry[] = [];
  return {
    rows,
    async claim(entry) {
      if (rows.some((r) => r.notionPageId === entry.notionPageId && r.month === entry.month)) {
        return { claimed: false };
      }
      rows.push({ ...entry });
      return { claimed: true };
    },
    async confirmedConsumption(month) {
      return rows.filter((r) => r.month === month).reduce((s, r) => s + r.recipients, 0);
    },
  };
}

function makeFakeRepo(pages: DeliveryPage[]): DeliveryRepoPort & {
  calls: string[];
  statuses: Record<string, string>;
  results: Record<string, unknown>;
  resets: string[];
} {
  const calls: string[] = [];
  const statuses: Record<string, string> = {};
  const results: Record<string, unknown> = {};
  const resets: string[] = [];
  return {
    calls,
    statuses,
    results,
    resets,
    async queryDue() {
      calls.push("queryDue");
      return pages;
    },
    async querySending() {
      calls.push("querySending");
      return [];
    },
    async setStatus(pageId, status) {
      calls.push(`setStatus:${status}`);
      statuses[pageId] = status;
    },
    async writeResult(pageId, result) {
      calls.push(`writeResult:${result.status}`);
      results[pageId] = result;
    },
    async resetApproval(pageId, reason) {
      calls.push("resetApproval");
      resets.push(`${pageId}:${reason}`);
    },
  };
}

const consumptionOk = (usage: number): ConsumptionFetcher => async () => ({ ok: true, totalUsage: usage });

async function makePage(over: Partial<DeliveryPage>): Promise<DeliveryPage> {
  const base: DeliveryPage = {
    id: "page-1",
    title: "テスト配信",
    status: "Approved",
    audienceRaw: "全員",
    format: "text",
    body: "配信本文",
    imageUrl: null,
    scheduledStart: "2026-07-10T04:00:00Z",
    sent: false,
    contentHash: null,
    estimate: null,
    assignees: ["author-1"],
    approvers: ["approver-1"],
    lastEditedTime: "2026-07-10T04:30:00Z",
    ...over,
  };
  // contentHash が未指定なら本文/画像から正しいスナップショットを埋める（pinning 一致）。
  if (base.contentHash === null && over.contentHash === undefined) {
    base.contentHash = await computeContentHash({
      format: base.format ?? "text",
      body: base.body,
      imageUrl: base.imageUrl,
    });
  }
  return base;
}

function baseDeps(over: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    repo: makeFakeRepo([]),
    ledger: makeFakeLedger(),
    consumption: consumptionOk(0),
    ledgerHasClaim: async () => false,
    resolveTargets: async () => ({ kind: "broadcast", estimatedRecipients: 4 }),
    sender: createRecordingSender(),
    now: () => new Date("2026-07-10T05:00:00Z"),
    sendEnabled: true,
    ...over,
  };
}

describe("runDeliveryOnce: 正常系（順序 claim→ガード→送信）", () => {
  it("Approved & due & pinning 一致で送信し Sent 書戻し", async () => {
    const page = await makePage({});
    const repo = makeFakeRepo([page]);
    const ledger = makeFakeLedger();
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(baseDeps({ repo, ledger, sender }));

    assertEqual(res.processed[0].disposition, "sent", "sent");
    // claim が送信より前: ledger に 1 行 claim 済み、sender は 1 回呼ばれた
    assertEqual(ledger.rows.length, 1, "claim 済み");
    assertEqual(sender.calls.length, 1, "送信 1 回");
    assertEqual(sender.calls[0].kind, "broadcast", "broadcast 送信");
    // setStatus:Sending が writeResult:Sent より前
    const iSending = repo.calls.indexOf("setStatus:Sending");
    const iSent = repo.calls.indexOf("writeResult:Sent");
    assertTrue(iSending >= 0 && iSent > iSending, "Sending→Sent 順");
  });
});

describe("runDeliveryOnce: 送信が起きない条件（安全性）", () => {
  it("dry-run（sendEnabled=false）は送信も書戻しもしない", async () => {
    const page = await makePage({});
    const repo = makeFakeRepo([page]);
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(baseDeps({ repo, sender, sendEnabled: false }));
    assertEqual(sender.calls.length, 0, "無送信");
    assertFalse(repo.calls.includes("writeResult:Sent"), "書戻しなし");
    assertEqual(res.processed[0].disposition, "sent", "dry-run 完走扱い");
    assertTrue(res.processed[0].reason.includes("dry-run"), "dry-run 明記");
  });
  it("通数ガード超過なら送信しない（claim 前に弾く）", async () => {
    const page = await makePage({});
    const sender = createRecordingSender();
    // 残枠 200-10-195=-5 相当。consumption 195 + estimate 4 → cap_exceeded
    const res = await runDeliveryOnce(
      baseDeps({ repo: makeFakeRepo([page]), consumption: consumptionOk(195), sender }),
    );
    assertEqual(sender.calls.length, 0, "無送信");
    assertEqual(res.processed[0].disposition, "skipped", "skipped");
    assertTrue(res.processed[0].reason.includes("通数ガード"), "ガード理由");
  });
  it("pinning 不一致（本文編集）なら承認リセットして送信しない", async () => {
    const page = await makePage({ contentHash: "deadbeef" }); // わざと不一致
    const repo = makeFakeRepo([page]);
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(baseDeps({ repo, sender }));
    assertEqual(sender.calls.length, 0, "無送信");
    assertEqual(res.processed[0].disposition, "reset", "reset");
    assertTrue(repo.calls.includes("resetApproval"), "resetApproval 呼ばれた");
  });
  it("自己承認（独立承認者なし）は送信しない", async () => {
    const page = await makePage({ assignees: ["u-a"], approvers: ["u-a"] });
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(baseDeps({ repo: makeFakeRepo([page]), sender }));
    assertEqual(sender.calls.length, 0, "無送信");
    assertEqual(res.processed[0].disposition, "skipped", "skipped");
    assertTrue(res.processed[0].reason.includes("自己承認"), "自己承認理由");
  });
  it("未来の配信予定日時は送信しない", async () => {
    const page = await makePage({ scheduledStart: "2026-07-10T06:00:00Z" });
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(baseDeps({ repo: makeFakeRepo([page]), sender }));
    assertEqual(sender.calls.length, 0, "無送信");
    assertTrue(res.processed[0].reason.includes("未来"), "未来理由");
  });
  it("配信対象が空は送信しない（fail-closed）", async () => {
    const page = await makePage({ audienceRaw: null });
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(baseDeps({ repo: makeFakeRepo([page]), sender }));
    assertEqual(sender.calls.length, 0, "無送信");
  });
  it("既に送信済み（sent=true）はスキップ", async () => {
    const page = await makePage({ sent: true });
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(baseDeps({ repo: makeFakeRepo([page]), sender }));
    assertEqual(sender.calls.length, 0, "無送信");
    assertEqual(res.processed[0].disposition, "skipped", "skipped");
  });
});

describe("runDeliveryOnce: multicast 経路", () => {
  it("ペルソナは multicast で送信し実送信数を消費計上", async () => {
    const page = await makePage({ audienceRaw: "癒し" });
    const repo = makeFakeRepo([page]);
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(
      baseDeps({
        repo,
        sender,
        resolveTargets: async () => ({
          kind: "multicast",
          userIds: ["L1", "L2"],
          batches: [["L1", "L2"]],
          estimatedRecipients: 2,
        }),
      }),
    );
    assertEqual(sender.calls[0].kind, "multicast", "multicast");
    assertEqual(res.processed[0].recipients, 2, "2 件送信");
    const result = repo.results[page.id] as { consumed: number };
    assertEqual(result.consumed, 2, "消費実績 2");
  });
});

// ---------------------------------------------------------------------------
// reaper 分類
// ---------------------------------------------------------------------------
describe("classifyStaleSending（reaper）", () => {
  const now = new Date("2026-07-10T05:00:00Z");
  const timeout = 15 * 60 * 1000;
  it("タイムアウト前は skip", () => {
    const a = classifyStaleSending({ lastEditedTime: "2026-07-10T04:55:00Z" }, now, timeout, false);
    assertEqual(a, "skip", "skip");
  });
  it("タイムアウト & 台帳 claim あり → recover_failed（二重送信防止）", () => {
    const a = classifyStaleSending({ lastEditedTime: "2026-07-10T04:40:00Z" }, now, timeout, true);
    assertEqual(a, "recover_failed", "recover_failed");
  });
  it("タイムアウト & 台帳 claim なし → reset_retry", () => {
    const a = classifyStaleSending({ lastEditedTime: "2026-07-10T04:40:00Z" }, now, timeout, false);
    assertEqual(a, "reset_retry", "reset_retry");
  });
  it("lastEditedTime 不明は skip", () => {
    assertEqual(classifyStaleSending({ lastEditedTime: null }, now, timeout, true), "skip", "null");
  });
});

describe("noopSender（dry-run 送信ポート）", () => {
  it("multicast/broadcast はネットワークに触れず見積を返す", async () => {
    const m = await noopSender.multicast([["a", "b"]], [{ type: "text", text: "x" }]);
    assertEqual(m.deliveredRecipients, 2, "multicast 2");
    const b = await noopSender.broadcast([{ type: "text", text: "x" }], 38);
    assertEqual(b.deliveredRecipients, 38, "broadcast 38");
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
  console.log("delivery-send Test Results");
  console.log("=".repeat(60));
  console.log(`Total: ${totalTests}, Passed: ${passedTests}, Failed: ${failedTests}`);
  if (failures.length > 0) {
    console.log("\nFailed tests:");
    for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  }
  process.exit(failedTests > 0 ? 1 : 0);
})();
