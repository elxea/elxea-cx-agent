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
import {
  hasIndependentApprover,
  isApprovalAuthorized,
  selfApprovalRelaxed,
} from "../../src/lib/delivery-approval";
import {
  buildMessages,
  chunkForMulticast,
  isPermanentHttpsUrl,
  createRecordingSender,
  noopSender,
  LINE_MAX_MESSAGES,
} from "../../src/lib/line-messages";
import {
  joinCandidates,
  filterEligible,
  collectAllPages,
  resolveTargets,
  parseAllowlist,
  type LinkageRow,
  type PersonaRow,
  type TargetResolverDeps,
} from "../../src/lib/target-resolver";
import {
  buildAggregationUnit,
  audienceSegmentCode,
  isValidAggregationUnit,
  jstYyyymmdd,
} from "../../src/lib/aggregation-unit";
import {
  runDeliveryOnce,
  classifyStaleSending,
  type OrchestratorDeps,
  type DeliveryRepoPort,
} from "../../src/lib/delivery-orchestrator";
import {
  r2KeyForImage,
  r2PublicUrl,
  r2UrlsForPage,
  resolveR2PublicBase,
  resolveR2Config,
  putToR2,
  ingestPageImages,
  describeBlockingImages,
  type R2Config,
} from "../../src/lib/image-ingest";
import {
  pinDueApprovals,
  runScheduledDeliveryWith,
  type PinApprovalResult,
  type ScheduledDeliveryDeps,
} from "../../src/lib/delivery-runtime";
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
  it("社内 → allowlist（userIds は空プレースホルダ・env で解決）", () => {
    const a = parseAudience("社内");
    assertTrue(a?.kind === "allowlist", "allowlist");
    if (a?.kind === "allowlist") assertEqual(a.userIds.length, 0, "parse 時点は空");
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
    const a = await computeContentHash({ format: "text", body: "こんにちは" });
    const b = await computeContentHash({ format: "text", body: "こんにちは" });
    assertEqual(a, b, "deterministic");
    assertTrue(hashesMatch(a, b), "match");
  });
  it("本文を編集するとハッシュ不一致（送信中止根拠）", async () => {
    const snap = await computeContentHash({ format: "text", body: "旧本文" });
    const cur = await computeContentHash({ format: "text", body: "新本文（編集後）" });
    assertFalse(hashesMatch(snap, cur), "mismatch");
  });
  it("空スナップショットは常に不一致（fail-closed）", async () => {
    const cur = await computeContentHash({ format: "text", body: "x" });
    assertFalse(hashesMatch(null, cur), "null snapshot");
    assertFalse(hashesMatch("", cur), "empty snapshot");
  });
  it("imageUrls 未指定/空は従来の {format,body} と同一ハッシュ（後方互換）", async () => {
    const legacy = await computeContentHash({ format: "text", body: "本文" });
    const empty = await computeContentHash({ format: "text", body: "本文", imageUrls: [] });
    assertEqual(legacy, empty, "undefined と [] は同一");
    assertTrue(hashesMatch(legacy, empty), "match");
  });
  it("恒久R2 URL 群の枚数/順序が変わるとハッシュ不一致（TOCTOU: 画像追加/並替検知）", async () => {
    const base = "https://pub-x.r2.dev/broadcast/pg";
    const one = await computeContentHash({ format: "image", body: null, imageUrls: [`${base}/0.jpg`] });
    const two = await computeContentHash({ format: "image", body: null, imageUrls: [`${base}/0.jpg`, `${base}/1.jpg`] });
    assertFalse(hashesMatch(one, two), "枚数変化で不一致");
    const swapped = await computeContentHash({ format: "image", body: null, imageUrls: [`${base}/1.jpg`, `${base}/0.jpg`] });
    assertFalse(hashesMatch(two, swapped), "順序変化で不一致");
    const same = await computeContentHash({ format: "image", body: null, imageUrls: [`${base}/0.jpg`, `${base}/1.jpg`] });
    assertTrue(hashesMatch(two, same), "同一 URL 群は一致");
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
// 自己承認緩和ポリシー（テスト環境限定・prod では緩和不可）
// ---------------------------------------------------------------------------
describe("selfApprovalRelaxed（prod では絶対に緩まない）", () => {
  it("test + フラグ true → 緩和 true", () => {
    assertTrue(
      selfApprovalRelaxed({
        DELIVERY_TARGET_ENV: "test",
        DELIVERY_ALLOW_SELF_APPROVAL_TEST: "true",
      }),
      "test relaxed",
    );
  });
  it("prod + フラグ true → 緩和されない（false・最重要ガード）", () => {
    assertFalse(
      selfApprovalRelaxed({
        DELIVERY_TARGET_ENV: "prod",
        DELIVERY_ALLOW_SELF_APPROVAL_TEST: "true",
      }),
      "prod never relaxes",
    );
  });
  it("test + フラグ未設定/非true → 緩和されない", () => {
    assertFalse(
      selfApprovalRelaxed({ DELIVERY_TARGET_ENV: "test" }),
      "no flag",
    );
    assertFalse(
      selfApprovalRelaxed({
        DELIVERY_TARGET_ENV: "test",
        DELIVERY_ALLOW_SELF_APPROVAL_TEST: "1",
      }),
      "flag must be exactly 'true'",
    );
  });
  it("TARGET_ENV 未設定/不正 は test 扱い（フラグ true で緩和）", () => {
    assertTrue(
      selfApprovalRelaxed({ DELIVERY_ALLOW_SELF_APPROVAL_TEST: "true" }),
      "undefined→test",
    );
    assertTrue(
      selfApprovalRelaxed({
        DELIVERY_TARGET_ENV: "PRODUCTION",
        DELIVERY_ALLOW_SELF_APPROVAL_TEST: "true",
      }),
      "invalid→test",
    );
  });
});

describe("isApprovalAuthorized（承認者必須は常に維持・緩和は独立性のみ免除）", () => {
  it("allowSelfApproval=false は hasIndependentApprover と同義", () => {
    assertTrue(
      isApprovalAuthorized(["u-a"], ["u-b"], false),
      "independent ok",
    );
    assertFalse(
      isApprovalAuthorized(["u-a"], ["u-a"], false),
      "self approval blocked",
    );
  });
  it("allowSelfApproval=true でも承認者ゼロは false（fail-closed 維持）", () => {
    assertFalse(isApprovalAuthorized(["u-a"], [], true), "no approver even when relaxed");
  });
  it("allowSelfApproval=true なら自己承認（担当者=承認者）を許容", () => {
    assertTrue(isApprovalAuthorized(["u-a"], ["u-a"], true), "self approval allowed in test");
  });
});

// ---------------------------------------------------------------------------
// buildMessages / isPermanentHttpsUrl / chunk（T6）
// ---------------------------------------------------------------------------
describe("buildMessages（text/image 可変化）", () => {
  it("text: 本文があれば text メッセージ 1 件", () => {
    const r = buildMessages({ format: "text", body: "本文です" });
    assertTrue(r.ok, "ok");
    if (r.ok) {
      assertEqual(r.messages.length, 1, "1 件");
      assertEqual(r.messages[0].type, "text", "type text");
    }
  });
  it("text: 本文が空は不可（fail-closed）", () => {
    const r = buildMessages({ format: "text", body: "  " });
    assertFalse(r.ok, "empty body rejected");
  });
  it("image: 恒久 HTTPS なら image メッセージ", () => {
    const r = buildMessages({ format: "image", body: null, imageUrls: ["https://cdn.example.com/a.jpg"] });
    assertTrue(r.ok, "ok");
    if (r.ok) assertEqual(r.messages[0].type, "image", "type image");
  });
  it("image: Notion 署名 URL / http は拒否", () => {
    assertFalse(buildMessages({ format: "image", body: null, imageUrls: ["http://cdn.example.com/a.jpg"] }).ok, "http");
    assertFalse(
      buildMessages({ format: "image", body: null, imageUrls: ["https://prod-files-secure.s3.amazonaws.com/x?X-Amz-Signature=abc"] }).ok,
      "notion signed",
    );
    assertFalse(
      buildMessages({ format: "image", body: null, imageUrls: ["https://file.notion.so/f/a.jpg"] }).ok,
      "notion host",
    );
  });
  it("isPermanentHttpsUrl の判定（R2 公開URL を通す）", () => {
    assertTrue(isPermanentHttpsUrl("https://cdn.shopify.com/x.jpg"), "cdn https");
    assertTrue(
      isPermanentHttpsUrl(
        "https://pub-90a0485599904fee8228ef56bb51c2e6.r2.dev/broadcast/pg/0.jpg",
      ),
      "R2 pub-*.r2.dev を通す",
    );
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
// buildMessages: text + 複数画像モード（今回の最小実装 A）
// ---------------------------------------------------------------------------
describe("buildMessages（text + 複数画像 / 送信順・上限）", () => {
  const img = (n: string) => `https://cdn.example.com/${n}.jpg`;

  it("text 本文 + image 3 枚を [text, image, image, image] の順で組む", () => {
    const r = buildMessages({
      format: "text",
      body: "本文です",
      imageUrls: [img("a"), img("b"), img("c")],
    });
    assertTrue(r.ok, "ok");
    if (r.ok) {
      assertEqual(r.messages.length, 4, "text1 + image3 = 4 件");
      assertEqual(r.messages[0].type, "text", "先頭は text");
      assertEqual(r.messages[1].type, "image", "2件目 image");
      assertEqual(r.messages[2].type, "image", "3件目 image");
      assertEqual(r.messages[3].type, "image", "4件目 image");
      // 送信順（imageUrls の順）を厳密に保持
      if (r.messages[1].type === "image") assertEqual(r.messages[1].originalContentUrl, img("a"), "1枚目=a");
      if (r.messages[2].type === "image") assertEqual(r.messages[2].originalContentUrl, img("b"), "2枚目=b");
      if (r.messages[3].type === "image") assertEqual(r.messages[3].originalContentUrl, img("c"), "3枚目=c");
      // previewImageUrl は originalContentUrl と同一（最小版）
      if (r.messages[1].type === "image") {
        assertEqual(r.messages[1].previewImageUrl, r.messages[1].originalContentUrl, "preview=original");
      }
    }
  });

  it("image のみ（本文なし）は image N のみを順序通り組む", () => {
    const r = buildMessages({
      format: "image",
      body: null,
      imageUrls: [img("a"), img("b")],
    });
    assertTrue(r.ok, "ok");
    if (r.ok) {
      assertEqual(r.messages.length, 2, "image 2 件（text なし）");
      assertEqual(r.messages[0].type, "image", "先頭も image");
    }
  });

  it("text 形式で本文が空なら不可（fail-closed）", () => {
    const r = buildMessages({
      format: "text",
      body: "   ",
      imageUrls: [img("a")],
    });
    assertFalse(r.ok, "空本文は不可");
  });

  it("画像URLに恒久HTTPSでないもの（Notion署名/http）が 1 件でもあれば全体不可", () => {
    const r1 = buildMessages({
      format: "text",
      body: "本文",
      imageUrls: [img("a"), "http://cdn.example.com/b.jpg"],
    });
    assertFalse(r1.ok, "http 混入で不可");
    const r2 = buildMessages({
      format: "text",
      body: "本文",
      imageUrls: [img("a"), "https://file.notion.so/f/x.jpg"],
    });
    assertFalse(r2.ok, "Notion署名URL 混入で不可");
  });

  it(`合計メッセージ数が LINE 上限(${LINE_MAX_MESSAGES})以内なら OK・超過は不可`, () => {
    // text1 + image4 = 5（上限ちょうど）→ OK
    const ok = buildMessages({
      format: "text",
      body: "本文",
      imageUrls: [img("a"), img("b"), img("c"), img("d")],
    });
    assertTrue(ok.ok, "text1+image4=5 は OK");
    if (ok.ok) assertEqual(ok.messages.length, 5, "5 件");
    // text1 + image5 = 6（上限超過）→ 不可
    const over = buildMessages({
      format: "text",
      body: "本文",
      imageUrls: [img("a"), img("b"), img("c"), img("d"), img("e")],
    });
    assertFalse(over.ok, "6 件は上限超過で不可");
  });

  it("imageUrls 未指定/空なら text は本文 1 件にフォールバック（後方互換）", () => {
    const t = buildMessages({ format: "text", body: "本文", imageUrls: [] });
    assertTrue(t.ok, "空配列は単一形式にフォールバック");
    if (t.ok) assertEqual(t.messages.length, 1, "text 1 件");
    // image 形式は imageUrls（恒久R2 URL 群）必須。空/未指定は送信不可（旧・単一 imageUrl 経路は廃止）。
    const i = buildMessages({ format: "image", body: null, imageUrls: [] });
    assertFalse(i.ok, "imageUrls 空の image は不可（fail-closed）");
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

  it("serenity 対象は L1,L3（退会/未リンク/別ペルソナを除外・opt-out は廃止で除外しない）", () => {
    const cands = joinCandidates(personas, linkages);
    const ids = filterEligible(cands, "serenity");
    // opt-out 廃止（2026-07-13）: s3/L3（旧 opt-out）も配信対象に含まれる。退会 s2/L2・未リンク s4/s6 は除外。
    assertEqual(ids.sort().join(","), "L1,L3", "L1,L3（opt-out は除外しない）");
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
    loadAllowlistUserIds: async () => [],
    ...over,
  });

  it("全員: 見積があれば broadcast（LINE 標準・opt-out 廃止で multicast 統一を撤回）", async () => {
    const r = await resolveTargets(
      { kind: "all" },
      baseDeps({ broadcastEstimate: async () => 38 }),
    );
    assertTrue(r.kind === "broadcast", "broadcast");
    if (r.kind === "broadcast") assertEqual(r.estimatedRecipients, 38, "38（LINE 管理画面の友だち数）");
  });
  it("全員: 見積 null は error（fail-closed）", async () => {
    const r = await resolveTargets(
      { kind: "all" },
      baseDeps({ broadcastEstimate: async () => null }),
    );
    assertTrue(r.kind === "error", "見積なしは error");
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

  // --- 社内 allowlist ---
  it("社内 allowlist: 指定 user ID にだけ multicast（人数一致）", async () => {
    const r = await resolveTargets(
      { kind: "allowlist", userIds: [] },
      baseDeps({ loadAllowlistUserIds: async () => ["Uaaa", "Ubbb", "Uccc"] }),
    );
    assertTrue(r.kind === "multicast", "multicast");
    if (r.kind === "multicast") {
      assertEqual(r.userIds.join(","), "Uaaa,Ubbb,Uccc", "指定IDのみ");
      assertEqual(r.estimatedRecipients, 3, "3 件");
      assertEqual(r.batches.length, 1, "1 バッチ");
    }
  });
  it("社内 allowlist: env 未設定/空は error（fail-closed）", async () => {
    const empty = await resolveTargets(
      { kind: "allowlist", userIds: [] },
      baseDeps({ loadAllowlistUserIds: async () => [] }),
    );
    assertTrue(empty.kind === "error", "空は error");
  });
  it("社内 allowlist: 重複排除する", async () => {
    const r = await resolveTargets(
      { kind: "allowlist", userIds: [] },
      baseDeps({ loadAllowlistUserIds: async () => ["Ux", "Ux", " Ux ", "Uy", ""] }),
    );
    assertTrue(r.kind === "multicast", "multicast");
    if (r.kind === "multicast") {
      assertEqual(r.userIds.join(","), "Ux,Uy", "重複/空を排除");
      assertEqual(r.estimatedRecipients, 2, "2 件");
    }
  });
  it("社内 allowlist: 500 超は複数バッチに分割", async () => {
    const many = Array.from({ length: 501 }, (_, i) => `U${i}`);
    const r = await resolveTargets(
      { kind: "allowlist", userIds: [] },
      baseDeps({ loadAllowlistUserIds: async () => many }),
    );
    assertTrue(r.kind === "multicast", "multicast");
    if (r.kind === "multicast") {
      assertEqual(r.estimatedRecipients, 501, "501 件");
      assertEqual(r.batches.length, 2, "2 バッチ");
    }
  });
});

describe("parseAllowlist（env カンマ区切り → ID 配列）", () => {
  it("トリム・空要素除去", () => {
    assertEqual(parseAllowlist(" Ua , Ub ,,Uc ").join(","), "Ua,Ub,Uc", "整形");
  });
  it("未設定/空は空配列（fail-closed 起点）", () => {
    assertEqual(parseAllowlist(undefined).length, 0, "undefined");
    assertEqual(parseAllowlist("").length, 0, "空文字");
    assertEqual(parseAllowlist("   ").length, 0, "空白のみ");
  });
});

// ---------------------------------------------------------------------------
// aggregation-unit（P0-7a）— 配信計測の集計単位命名
// ---------------------------------------------------------------------------
describe("buildAggregationUnit（unit 命名・LINE 制約準拠）", () => {
  // 2026-08-06T20:00:00Z = JST 2026-08-07 05:00 → 日付は 20260807
  const d = new Date("2026-08-06T20:00:00Z");
  it("全員 → s{YYYYMMDD}_all（JST 日付・アンダースコア区切り）", () => {
    assertEqual(buildAggregationUnit({ kind: "all" }, d), "s20260807_all", "all");
  });
  it("ペルソナ → ser/exp/sen", () => {
    assertEqual(buildAggregationUnit({ kind: "persona", persona: "serenity" }, d), "s20260807_ser", "ser");
    assertEqual(buildAggregationUnit({ kind: "persona", persona: "explorer" }, d), "s20260807_exp", "exp");
    assertEqual(buildAggregationUnit({ kind: "persona", persona: "sensory" }, d), "s20260807_sen", "sen");
  });
  it("社内 allowlist → int", () => {
    assertEqual(buildAggregationUnit({ kind: "allowlist", userIds: [] }, d), "s20260807_int", "int");
  });
  it("audienceSegmentCode / jstYyyymmdd の単体", () => {
    assertEqual(audienceSegmentCode({ kind: "all" }), "all", "seg all");
    assertEqual(jstYyyymmdd(d), "20260807", "JST 日付");
  });
  it("生成した unit はすべて LINE 制約（半角英数字・_・30字以内）を満たす", () => {
    for (const a of [
      { kind: "all" } as const,
      { kind: "persona", persona: "serenity" } as const,
      { kind: "allowlist", userIds: [] } as const,
    ]) {
      assertTrue(isValidAggregationUnit(buildAggregationUnit(a, d)), `valid: ${buildAggregationUnit(a, d)}`);
    }
  });
  it("isValidAggregationUnit はハイフン/長すぎ/空を弾く（設計例のハイフンは不許可）", () => {
    assertFalse(isValidAggregationUnit("s20260807-all"), "ハイフンは不許可");
    assertFalse(isValidAggregationUnit(""), "空");
    assertFalse(isValidAggregationUnit("a".repeat(31)), "31字");
    assertTrue(isValidAggregationUnit("s20260807_all"), "正規");
  });
});

// ---------------------------------------------------------------------------
// image-ingest（Notion files 一時URL → R2 恒久URL）— fetch 注入・ネットワーク非接触
// ---------------------------------------------------------------------------
describe("image-ingest: R2 キー/URL の決定性", () => {
  it("r2KeyForImage は broadcast/<pageId>/<index>.jpg", () => {
    assertEqual(r2KeyForImage("pg1", 0), "broadcast/pg1/0.jpg", "index0");
    assertEqual(r2KeyForImage("pg1", 2), "broadcast/pg1/2.jpg", "index2");
  });
  it("r2UrlsForPage は枚数から恒久URLを順序通り決定的に生成（pin/送信で一致）", () => {
    const urls = r2UrlsForPage("pg1", 3, "https://pub-x.r2.dev/");
    assertEqual(urls.length, 3, "3 件");
    assertEqual(urls[0], "https://pub-x.r2.dev/broadcast/pg1/0.jpg", "0");
    assertEqual(urls[2], "https://pub-x.r2.dev/broadcast/pg1/2.jpg", "2（末尾スラッシュ正規化）");
  });
  it("resolveR2PublicBase は env 優先・既定フォールバック・末尾スラッシュ除去", () => {
    assertEqual(resolveR2PublicBase({ R2_PUBLIC_BASE: "https://pub-y.r2.dev/" }), "https://pub-y.r2.dev", "env");
    assertTrue(resolveR2PublicBase({}).startsWith("https://pub-"), "既定フォールバック");
  });
  it("r2PublicUrl は base + key を結合", () => {
    assertEqual(
      r2PublicUrl("https://pub-x.r2.dev", "broadcast/pg/0.jpg"),
      "https://pub-x.r2.dev/broadcast/pg/0.jpg",
      "join",
    );
  });
});

describe("image-ingest: resolveR2Config（資格情報 fail-closed）", () => {
  it("account/token 未設定は throw（put 経路に載せない）", () => {
    let threw = false;
    try {
      resolveR2Config({});
    } catch {
      threw = true;
    }
    assertTrue(threw, "資格情報なしは throw");
  });
  it("account/token ありは既定 bucket/base で解決", () => {
    const cfg = resolveR2Config({ R2_ACCOUNT_ID: "acc", R2_API_TOKEN: "tok" });
    assertEqual(cfg.bucket, "elxea-images", "既定 bucket");
    assertTrue(cfg.publicBase.startsWith("https://pub-"), "既定 base");
  });
});

describe("image-ingest: ingestPageImages（fetch 注入・実 R2/LINE 非接触）", () => {
  const cfg: R2Config = {
    accountId: "acc",
    apiToken: "tok",
    bucket: "elxea-images",
    publicBase: "https://pub-x.r2.dev",
  };
  // Notion 一時URL の取得と R2 PUT を両方こなす擬似 fetch。
  function makeFetch(opts?: { contentType?: string; bytes?: number }) {
    const calls: Array<{ url: string; method: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      if (url.includes("api.cloudflare.com")) {
        // R2 PUT
        return { ok: true, status: 200, async text() { return ""; } } as unknown as Response;
      }
      // Notion 一時URL の取得
      const buf = new Uint8Array(opts?.bytes ?? 1024);
      return {
        ok: true,
        status: 200,
        headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? (opts?.contentType ?? "image/jpeg") : null) },
        async arrayBuffer() { return buf.buffer; },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("順序保持で R2 恒久URL を返し、PUT を枚数分だけ叩く（実送信なし）", async () => {
    const { fetchImpl, calls } = makeFetch();
    const res = await ingestPageImages(
      cfg,
      "pg1",
      ["https://notion-temp/a?sig=1", "https://notion-temp/b?sig=2"],
      { fetchImpl },
    );
    assertEqual(res.urls.length, 2, "2 件");
    assertEqual(res.urls[0], "https://pub-x.r2.dev/broadcast/pg1/0.jpg", "0 番");
    assertEqual(res.urls[1], "https://pub-x.r2.dev/broadcast/pg1/1.jpg", "1 番");
    const puts = calls.filter((c) => c.method === "PUT");
    assertEqual(puts.length, 2, "PUT 2 回");
    assertTrue(puts[0].url.includes("/broadcast/pg1/0.jpg"), "PUT 先キー");
    // LINE API を叩いていないこと（実送信ゼロの根拠）。
    assertFalse(calls.some((c) => c.url.includes("api.line.me")), "LINE 非接触");
  });
  it("恒久R2 URL は isPermanentHttpsUrl を通る（送信可）", async () => {
    const { fetchImpl } = makeFetch();
    const res = await ingestPageImages(cfg, "pg1", ["https://notion-temp/a"], { fetchImpl });
    assertTrue(isPermanentHttpsUrl(res.urls[0]), "R2 URL は恒久扱い");
  });
  it("10MB 超過・LINE 非対応形式は warning に積む（put はする・正規化は次段）", async () => {
    const { fetchImpl } = makeFetch({ contentType: "image/heic", bytes: 11 * 1024 * 1024 });
    const res = await ingestPageImages(cfg, "pg1", ["https://notion-temp/big"], { fetchImpl });
    assertEqual(res.urls.length, 1, "URL は返す");
    assertTrue(res.warnings.some((w) => w.includes("サイズ超過")), "サイズ警告");
    assertTrue(res.warnings.some((w) => w.includes("LINE 非対応形式")), "形式警告");
  });
  it("空配列は put せず空 URL 群（text 配信・画像なし）", async () => {
    const { fetchImpl, calls } = makeFetch();
    const res = await ingestPageImages(cfg, "pg1", [], { fetchImpl });
    assertEqual(res.urls.length, 0, "0 件");
    assertEqual(calls.length, 0, "fetch 呼び出しゼロ");
  });
  it("putToR2 は Cloudflare API v4 の PUT を叩き、失敗は throw", async () => {
    const okCalls: string[] = [];
    const okFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      okCalls.push(String(input));
      assertEqual((init?.method ?? "").toUpperCase(), "PUT", "PUT");
      return { ok: true, status: 200, async text() { return ""; } } as unknown as Response;
    }) as unknown as typeof fetch;
    await putToR2(cfg, "broadcast/pg/0.jpg", new Uint8Array(4), "image/jpeg", okFetch);
    assertTrue(okCalls[0].includes("/r2/buckets/elxea-images/objects/"), "R2 objects エンドポイント");
    let threw = false;
    const badFetch = (async () => ({ ok: false, status: 500, async text() { return "err"; } } as unknown as Response)) as unknown as typeof fetch;
    try {
      await putToR2(cfg, "broadcast/pg/0.jpg", new Uint8Array(4), "image/jpeg", badFetch);
    } catch {
      threw = true;
    }
    assertTrue(threw, "非2xx は throw");
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
  it("日本語プロパティを正しく抽出する（files 画像あり → 形式 image 自動判定）", () => {
    const P = DELIVERY_PROPS;
    const raw = {
      id: "pg1",
      last_edited_time: "2026-07-10T04:00:00Z",
      properties: {
        [P.title]: { title: [{ plain_text: "夏の配信" }] },
        [P.status]: { select: { name: "Approved" } },
        [P.audience]: { select: { name: "癒し" } },
        // 「形式」select は読まない（自動判定）。ここでは text にしても files があれば image になる。
        [P.format]: { select: { name: "text" } },
        [P.body]: { rich_text: [] },
        // files 型「画像」: Notion アップロード(file)と外部(external)の両対応・順序保持。
        [P.image]: {
          files: [
            { type: "file", file: { url: "https://notion-temp/a.jpg?sig=1" } },
            { type: "external", external: { url: "https://cdn.example.com/b.jpg" } },
          ],
        },
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
    assertEqual(page.format, "image", "画像ありで image 自動判定（形式 select は無視）");
    assertEqual(page.imageCount, 2, "画像枚数");
    assertEqual(
      page.imageSourceUrls.join(","),
      "https://notion-temp/a.jpg?sig=1,https://cdn.example.com/b.jpg",
      "files の一時URLを順序保持で抽出",
    );
    assertEqual(page.body, null, "empty body → null");
    assertEqual(page.contentHash, "abc123", "hash");
    assertEqual(page.estimate, 38, "estimate");
    assertEqual(page.assignees.join(","), "u-author", "assignees");
    assertEqual(page.approvers.join(","), "u-approver", "approvers");
    assertFalse(page.sent, "not sent");
  });

  it("files 画像なし → 形式 text 自動判定・imageCount 0", () => {
    const P = DELIVERY_PROPS;
    const page = normalizeDeliveryPage({
      id: "pg2",
      properties: {
        [P.title]: { title: [{ plain_text: "お知らせ" }] },
        [P.status]: { select: { name: "Draft" } },
        [P.audience]: { select: { name: "全員" } },
        [P.body]: { rich_text: [{ plain_text: "本文だけ" }] },
        // 「画像」プロパティ自体が無い / 空。
      },
    });
    assertEqual(page.format, "text", "画像なしで text 自動判定");
    assertEqual(page.imageCount, 0, "0 枚");
    assertEqual(page.imageSourceUrls.length, 0, "一時URL なし");
    assertEqual(page.body, "本文だけ", "本文");
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
    // Status は Notion select 型（status 型では 400 になる）。select フィルタであることを固定。
    const statusCond = filter.and.find(
      (c) => (c as { property?: string }).property === DELIVERY_PROPS.status,
    ) as { select?: { equals?: string }; status?: unknown } | undefined;
    assertTrue(!!statusCond?.select, "Status は select フィルタ");
    assertEqual(statusCond?.select?.equals, "Approved", "Approved");
    assertTrue(statusCond?.status === undefined, "status 型フィルタは使わない");
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
    const props = (captured as { properties: Record<string, { select?: { name: string }; rich_text?: Array<{ text: { content: string } }> }> }).properties;
    assertEqual(props[DELIVERY_PROPS.status].select?.name, "Approved", "Approved");
    assertEqual(props[DELIVERY_PROPS.contentHash].rich_text?.[0].text.content, "hash-xyz", "hash 保存");
  });
  it("resetApproval は Draft に戻す", async () => {
    let captured: Record<string, unknown> | undefined;
    const req: NotionRequest = async (_p, _m, body) => {
      captured = body;
      return {};
    };
    await repoResetApproval(req, "pg1", "編集検知");
    const props = (captured as { properties: Record<string, { select?: { name: string } }> }).properties;
    assertEqual(props[DELIVERY_PROPS.status].select?.name, "Draft", "Draft");
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

  it("【P0-7a】broadcast（全員配信）は unit を付けない（LINE 仕様: customAggregationUnits 非対応）", async () => {
    // 全員配信は LINE 標準 broadcast（default baseDeps.resolveTargets が broadcast を返す）。
    // broadcast は customAggregationUnits 非対応のため、送信・台帳とも unit を付けない。
    const page = await makePage({});
    const repo = makeFakeRepo([page]);
    const ledger = makeFakeLedger();
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(baseDeps({ repo, ledger, sender }));
    assertEqual(res.processed[0].disposition, "sent", "sent");
    assertEqual(sender.calls[0].kind, "broadcast", "broadcast 送信");
    assertEqual(sender.calls[0].aggregationUnit, undefined, "broadcast に unit を付けない");
    assertEqual(ledger.rows.length, 1, "claim 1 行");
    assertEqual(ledger.rows[0].aggregationUnit, undefined, "台帳も broadcast は unit なし");
  });
  it("【P0-7a】multicast（ペルソナ/社内）は unit を台帳と送信の両方へ同一値で載せる", async () => {
    // audienceRaw=全員だが resolveTargets を multicast に差し替え（ペルソナ配信の実経路を再現）。
    // now=2026-07-10T05:00Z（JST 07-10）→ unit=s20260710_all
    const page = await makePage({});
    const repo = makeFakeRepo([page]);
    const ledger = makeFakeLedger();
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(
      baseDeps({
        repo,
        ledger,
        sender,
        resolveTargets: async () => ({
          kind: "multicast",
          userIds: ["L1", "L2"],
          batches: [["L1", "L2"]],
          estimatedRecipients: 2,
        }),
      }),
    );
    assertEqual(res.processed[0].disposition, "sent", "sent");
    assertEqual(sender.calls[0].kind, "multicast", "multicast 送信");
    assertEqual(sender.calls[0].aggregationUnit, "s20260710_all", "multicast は送信 unit あり");
    assertEqual(ledger.rows.length, 1, "claim 1 行");
    assertEqual(ledger.rows[0].aggregationUnit, "s20260710_all", "台帳 unit（multicast）");
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
  it("【QA Finding 1】dry-run は台帳 claim を挿入しない（非破壊）", async () => {
    const page = await makePage({});
    const ledger = makeFakeLedger();
    const repo = makeFakeRepo([page]);
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(
      baseDeps({ repo, ledger, sender, sendEnabled: false }),
    );
    // 台帳に 1 行も claim されていない（=後の本番実送信を弾かない）。
    assertEqual(ledger.rows.length, 0, "台帳 claim ゼロ");
    // プレビュー結果（対象・見積）は返る。
    assertEqual(res.processed[0].recipients, 4, "見積プレビュー返却");
    assertTrue(res.processed[0].reason.includes("非破壊"), "非破壊プレビュー明記");
  });
  it("【QA Finding 1】dry-run は Notion を Sending に遷移させない", async () => {
    const page = await makePage({});
    const repo = makeFakeRepo([page]);
    const res = await runDeliveryOnce(
      baseDeps({ repo, sender: createRecordingSender(), sendEnabled: false }),
    );
    // setStatus / writeResult / resetApproval を一切呼ばない（queryDue と reaper の querySending のみ）。
    assertFalse(repo.calls.includes("setStatus:Sending"), "Sending 遷移なし");
    assertFalse(repo.calls.some((c) => c.startsWith("writeResult")), "書戻しなし");
    assertFalse(repo.calls.includes("resetApproval"), "reset なし");
    assertEqual(repo.statuses[page.id], undefined, "status 未変更");
  });
  it("【QA Finding 1】dry-run は reaper も走らせない（Sending 滞留を書き換えない）", async () => {
    // 15 分超の滞留 Sending ページを querySending が返す repo。
    const stale: DeliveryPage = {
      id: "stale-1",
      title: "滞留",
      status: "Sending",
      audienceRaw: "全員",
      format: "text",
      body: "x",
      scheduledStart: "2026-07-10T04:00:00Z",
      sent: false,
      contentHash: "h",
      estimate: null,
      assignees: ["a"],
      approvers: ["b"],
      lastEditedTime: "2026-07-10T04:40:00Z", // now(05:00) から 20 分前 = タイムアウト
    };
    const calls: string[] = [];
    const repo: DeliveryRepoPort = {
      async queryDue() {
        return [];
      },
      async querySending() {
        calls.push("querySending");
        return [stale];
      },
      async setStatus(_id, s) {
        calls.push(`setStatus:${s}`);
      },
      async writeResult(_id, r) {
        calls.push(`writeResult:${r.status}`);
      },
      async resetApproval() {
        calls.push("resetApproval");
      },
    };
    const res = await runDeliveryOnce(
      baseDeps({ repo, ledgerHasClaim: async () => true, sendEnabled: false }),
    );
    // dry-run では reaper 自体を起動しない → querySending も回収書換も無し。
    assertFalse(calls.includes("querySending"), "reaper 未起動");
    assertFalse(calls.some((c) => c.startsWith("writeResult")), "回収書換なし");
    assertEqual(res.reaper.length, 0, "reaper 結果ゼロ");
  });
  it("【QA Finding 1】dry-run 後に本番実送信すると claim も送信も正常に通る", async () => {
    // dry-run が台帳を汚さないことの結合的確認: 同一 ledger で dry-run → 本番の順に実行。
    const page = await makePage({});
    const ledger = makeFakeLedger();
    const sender = createRecordingSender();
    // 1) dry-run（副作用ゼロ）
    await runDeliveryOnce(
      baseDeps({ repo: makeFakeRepo([page]), ledger, sender: createRecordingSender(), sendEnabled: false }),
    );
    assertEqual(ledger.rows.length, 0, "dry-run 後も台帳空");
    // 2) 本番実送信（同一 ledger）→ claim 1 行 + 送信 1 回
    const res = await runDeliveryOnce(
      baseDeps({ repo: makeFakeRepo([page]), ledger, sender, sendEnabled: true }),
    );
    assertEqual(ledger.rows.length, 1, "本番で claim 1 行");
    assertEqual(sender.calls.length, 1, "本番で送信 1 回");
    assertEqual(res.processed[0].disposition, "sent", "Sent");
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

describe("runDeliveryOnce: 社内 allowlist 経路（実 resolveTargets 結線）", () => {
  const allowlistDeps = (ids: string[]): TargetResolverDeps => ({
    loadLinkages: async () => [],
    loadPersonaUsers: async () => [],
    broadcastEstimate: async () => null,
    loadAllowlistUserIds: async () => ids,
  });

  it("社内: dry-run（sendEnabled=false）は allowlist 人数を見積り・送信noop・claim ゼロ", async () => {
    const page = await makePage({ audienceRaw: "社内" });
    const repo = makeFakeRepo([page]);
    const ledger = makeFakeLedger();
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(
      baseDeps({
        repo,
        ledger,
        sender,
        sendEnabled: false,
        resolveTargets: (a) => resolveTargets(a, allowlistDeps(["Ua", "Ub"])),
      }),
    );
    assertEqual(sender.calls.length, 0, "無送信（noop）");
    assertEqual(ledger.rows.length, 0, "claim ゼロ（非破壊）");
    assertEqual(res.processed[0].recipients, 2, "allowlist 2 人と一致");
    assertTrue(res.processed[0].reason.includes("社内"), "社内ラベル");
  });

  it("社内: env 未設定は fail-closed（skip・送信なし）", async () => {
    const page = await makePage({ audienceRaw: "社内" });
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(
      baseDeps({
        repo: makeFakeRepo([page]),
        sender,
        sendEnabled: false,
        resolveTargets: (a) => resolveTargets(a, allowlistDeps([])),
      }),
    );
    assertEqual(sender.calls.length, 0, "無送信");
    assertEqual(res.processed[0].disposition, "skipped", "skipped");
    assertTrue(res.processed[0].reason.includes("fail-closed"), "fail-closed 理由");
  });

  it("社内: testImageUrls があると本文(text)に続けて image N を送信順に組む（allowlist 限定）", async () => {
    const page = await makePage({ audienceRaw: "社内", format: "text", body: "配信本文" });
    // messages を捕捉する sender（recordingSender は messages を保持しないため専用）。
    const captured: import("../../src/lib/line-messages").LineMessage[][] = [];
    const capSender = {
      async multicast(_b: string[][], messages: import("../../src/lib/line-messages").LineMessage[]) {
        captured.push(messages);
        return { ok: true, deliveredRecipients: 1, partial: false };
      },
      async broadcast(messages: import("../../src/lib/line-messages").LineMessage[], est: number) {
        captured.push(messages);
        return { ok: true, deliveredRecipients: est, partial: false };
      },
    };
    const imgs = [
      "https://cdn.example.com/1.jpg",
      "https://cdn.example.com/2.jpg",
      "https://cdn.example.com/3.jpg",
    ];
    await runDeliveryOnce(
      baseDeps({
        repo: makeFakeRepo([page]),
        sender: capSender,
        sendEnabled: true,
        testImageUrls: imgs,
        resolveTargets: (a) => resolveTargets(a, allowlistDeps(["Uonly"])),
      }),
    );
    assertEqual(captured.length, 1, "1 回送信");
    const msgs = captured[0];
    assertEqual(msgs.length, 4, "text1 + image3 = 4 件");
    assertEqual(msgs[0].type, "text", "先頭 text（Notion 本文）");
    assertEqual(msgs[1].type, "image", "続いて image");
    if (msgs[1].type === "image") assertEqual(msgs[1].originalContentUrl, imgs[0], "画像順序 1");
    if (msgs[3].type === "image") assertEqual(msgs[3].originalContentUrl, imgs[2], "画像順序 3");
  });

  it("全員(broadcast=all): testImageUrls があると本文(text)に続けて image N を broadcast で送信順に組む", async () => {
    const page = await makePage({ audienceRaw: "全員", format: "text", body: "配信本文" });
    const captured: import("../../src/lib/line-messages").LineMessage[][] = [];
    let broadcastCalls = 0;
    const capSender = {
      async multicast(_b: string[][], messages: import("../../src/lib/line-messages").LineMessage[]) {
        captured.push(messages);
        return { ok: true, deliveredRecipients: 1, partial: false };
      },
      async broadcast(messages: import("../../src/lib/line-messages").LineMessage[], est: number) {
        broadcastCalls++;
        captured.push(messages);
        return { ok: true, deliveredRecipients: est, partial: false };
      },
    };
    const imgs = [
      "https://cdn.example.com/1.jpg",
      "https://cdn.example.com/2.jpg",
      "https://cdn.example.com/3.jpg",
    ];
    await runDeliveryOnce(
      baseDeps({
        repo: makeFakeRepo([page]),
        sender: capSender,
        sendEnabled: true,
        testImageUrls: imgs,
        resolveTargets: async () => ({ kind: "broadcast", estimatedRecipients: 38 }),
      }),
    );
    assertEqual(broadcastCalls, 1, "broadcast で送信（全員）");
    assertEqual(captured.length, 1, "1 回送信");
    const msgs = captured[0];
    assertEqual(msgs.length, 4, "text1 + image3 = 4 件");
    assertEqual(msgs[0].type, "text", "先頭 text（Notion 本文）");
    if (msgs[1].type === "image") assertEqual(msgs[1].originalContentUrl, imgs[0], "画像順序 1");
    if (msgs[3].type === "image") assertEqual(msgs[3].originalContentUrl, imgs[2], "画像順序 3");
  });

  it("非 allowlist（ペルソナ）には testImageUrls を注入しない（本文のみ）", async () => {
    const page = await makePage({ audienceRaw: "癒し", format: "text", body: "本文のみ" });
    const captured: import("../../src/lib/line-messages").LineMessage[][] = [];
    const capSender = {
      async multicast(_b: string[][], messages: import("../../src/lib/line-messages").LineMessage[]) {
        captured.push(messages);
        return { ok: true, deliveredRecipients: 2, partial: false };
      },
      async broadcast(messages: import("../../src/lib/line-messages").LineMessage[], est: number) {
        captured.push(messages);
        return { ok: true, deliveredRecipients: est, partial: false };
      },
    };
    await runDeliveryOnce(
      baseDeps({
        repo: makeFakeRepo([page]),
        sender: capSender,
        sendEnabled: true,
        testImageUrls: ["https://cdn.example.com/x.jpg"],
        resolveTargets: async () => ({
          kind: "multicast",
          userIds: ["L1", "L2"],
          batches: [["L1", "L2"]],
          estimatedRecipients: 2,
        }),
      }),
    );
    const msgs = captured[0];
    assertEqual(msgs.length, 1, "text のみ（画像注入なし）");
    assertEqual(msgs[0].type, "text", "text");
  });

  it("社内: sendEnabled=true でも multicast 経路（指定IDのみ・実送信数一致）", async () => {
    const page = await makePage({ audienceRaw: "社内" });
    const repo = makeFakeRepo([page]);
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(
      baseDeps({
        repo,
        sender,
        sendEnabled: true,
        resolveTargets: (a) => resolveTargets(a, allowlistDeps(["Ua", "Ub", "Uc"])),
      }),
    );
    assertEqual(sender.calls.length, 1, "送信 1 回");
    assertEqual(sender.calls[0].kind, "multicast", "multicast（broadcast ではない）");
    assertEqual(sender.calls[0].recipients, 3, "3 人");
    assertEqual(res.processed[0].recipients, 3, "実送信 3");
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

describe("runDeliveryOnce: Notion files 画像（R2 恒久URL・全 audience 適用 / TOCTOU）", () => {
  const R2 = "https://pub-x.r2.dev/broadcast/page-1";
  it("ペルソナでも page.imageUrls があれば 本文 + 画像 を送信（env ブリッジ非依存）", async () => {
    const imgs = [`${R2}/0.jpg`, `${R2}/1.jpg`];
    const contentHash = await computeContentHash({
      format: "image",
      body: "本文",
      imageUrls: imgs,
    });
    const page = await makePage({
      audienceRaw: "癒し",
      format: "image",
      body: "本文",
      imageUrls: imgs,
      contentHash,
    });
    const captured: import("../../src/lib/line-messages").LineMessage[][] = [];
    const capSender = {
      async multicast(_b: string[][], messages: import("../../src/lib/line-messages").LineMessage[]) {
        captured.push(messages);
        return { ok: true, deliveredRecipients: 1, partial: false };
      },
      async broadcast(messages: import("../../src/lib/line-messages").LineMessage[], est: number) {
        captured.push(messages);
        return { ok: true, deliveredRecipients: est, partial: false };
      },
    };
    const res = await runDeliveryOnce(
      baseDeps({
        repo: makeFakeRepo([page]),
        sender: capSender,
        sendEnabled: true,
        // env ブリッジは渡さない（Notion files 経路のみで画像が乗ることを確認）。
        resolveTargets: async () => ({
          kind: "multicast",
          userIds: ["L1"],
          batches: [["L1"]],
          estimatedRecipients: 1,
        }),
      }),
    );
    assertEqual(res.processed[0].disposition, "sent", "sent");
    assertEqual(captured.length, 1, "1 回送信");
    const msgs = captured[0];
    assertEqual(msgs.length, 3, "text1 + image2 = 3 件（ペルソナでも画像適用）");
    assertEqual(msgs[0].type, "text", "先頭 text");
    if (msgs[1].type === "image") assertEqual(msgs[1].originalContentUrl, imgs[0], "画像順序 0");
    if (msgs[2].type === "image") assertEqual(msgs[2].originalContentUrl, imgs[1], "画像順序 1");
  });

  it("承認後に画像枚数が増えるとハッシュ不一致 → 承認リセット（送信しない）", async () => {
    const pinned = await computeContentHash({
      format: "image",
      body: "本文",
      imageUrls: [`${R2}/0.jpg`], // 承認時は 1 枚
    });
    const page = await makePage({
      format: "image",
      body: "本文",
      imageUrls: [`${R2}/0.jpg`, `${R2}/1.jpg`], // 送信時は 2 枚（編集で増加）
      contentHash: pinned,
    });
    const repo = makeFakeRepo([page]);
    const sender = createRecordingSender();
    const res = await runDeliveryOnce(baseDeps({ repo, sender }));
    assertEqual(sender.calls.length, 0, "無送信");
    assertEqual(res.processed[0].disposition, "reset", "reset");
    assertTrue(repo.calls.includes("resetApproval"), "resetApproval 呼ばれた");
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
// image-ingest: blocking 分類 + describeBlockingImages（T2・HEIC fail-closed）
// ---------------------------------------------------------------------------
describe("image-ingest: blocking 分類（HEIC/非画像/10MB超は配信ブロック対象）", () => {
  const cfg: R2Config = {
    accountId: "acc",
    apiToken: "tok",
    bucket: "elxea-images",
    publicBase: "https://pub-x.r2.dev",
  };
  function ingestFetch(opts?: { contentType?: string; bytes?: number }) {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.cloudflare.com")) {
        return { ok: true, status: 200, async text() { return ""; } } as unknown as Response;
      }
      const buf = new Uint8Array(opts?.bytes ?? 1024);
      return {
        ok: true,
        status: 200,
        headers: {
          get: (k: string) =>
            k.toLowerCase() === "content-type" ? (opts?.contentType ?? "image/jpeg") : null,
        },
        async arrayBuffer() { return buf.buffer; },
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }
  it("JPEG は blocking なし（送信可）", async () => {
    const res = await ingestPageImages(cfg, "pg", ["https://n/a"], {
      fetchImpl: ingestFetch({ contentType: "image/jpeg" }),
    });
    assertEqual(res.blocking.length, 0, "blocking 0");
  });
  it("HEIC は unsupported_format を blocking に積む（index 0始まり）", async () => {
    const res = await ingestPageImages(cfg, "pg", ["https://n/a"], {
      fetchImpl: ingestFetch({ contentType: "image/heic" }),
    });
    assertEqual(res.blocking.length, 1, "blocking 1");
    assertEqual(res.blocking[0].kind, "unsupported_format", "形式ブロック");
    assertEqual(res.blocking[0].index, 0, "index 0");
  });
  it("非画像(pdf)は not_image を blocking に積む", async () => {
    const res = await ingestPageImages(cfg, "pg", ["https://n/a"], {
      fetchImpl: ingestFetch({ contentType: "application/pdf" }),
    });
    assertEqual(res.blocking[0].kind, "not_image", "非画像ブロック");
  });
  it("10MB超は oversize を blocking に積む", async () => {
    const res = await ingestPageImages(cfg, "pg", ["https://n/a"], {
      fetchImpl: ingestFetch({ contentType: "image/png", bytes: 11 * 1024 * 1024 }),
    });
    assertTrue(res.blocking.some((b) => b.kind === "oversize"), "oversize ブロック");
  });
});

describe("describeBlockingImages（平易な日本語・画像番号1始まり）", () => {
  it("HEIC は「画像2」(index1→2) と JPEG/PNG 指示を出す", () => {
    const msg = describeBlockingImages([
      { index: 1, kind: "unsupported_format", detail: "image/heic" },
    ]);
    assertTrue(msg.includes("画像2"), "1始まり表示");
    assertTrue(msg.includes("JPEG") && msg.includes("PNG"), "変換指示");
  });
  it("空配列は空文字", () => {
    assertEqual(describeBlockingImages([]), "", "空");
  });
});

// ---------------------------------------------------------------------------
// cron ポーリング phase1: pinDueApprovals（承認pin 前処理・fail-closed）
// ---------------------------------------------------------------------------
describe("pinDueApprovals（Approved行を拾って承認pin・冪等・HEIC fail-closed）", () => {
  function makeDeps(
    pages: Array<{ id: string; contentHash: string | null }>,
    pinResults: Record<string, PinApprovalResult>,
  ) {
    const log: string[] = [];
    const resets: Array<{ id: string; reason: string }> = [];
    const cleared: string[] = [];
    const deps = {
      queryDue: async (_iso: string) => {
        log.push("queryDue");
        return pages;
      },
      pin: async (id: string): Promise<PinApprovalResult> => {
        log.push(`pin:${id}`);
        return pinResults[id] ?? { ok: true, contentHash: "h" };
      },
      resetApproval: async (id: string, reason: string) => {
        log.push(`reset:${id}`);
        resets.push({ id, reason });
      },
      clearError: async (id: string) => {
        log.push(`clear:${id}`);
        cleared.push(id);
      },
      now: () => new Date("2026-07-10T05:00:00Z"),
    };
    return { deps, log, resets, cleared };
  }

  it("Approved & 未pin（ハッシュなし）を拾って pin し、成功でエラー詳細を消す", async () => {
    const { deps, log, cleared } = makeDeps([{ id: "p1", contentHash: null }], {
      p1: { ok: true, contentHash: "h" },
    });
    const out = await pinDueApprovals(deps);
    assertEqual(out[0].action, "pinned", "pinned");
    assertTrue(log.includes("pin:p1"), "pin を呼ぶ");
    assertTrue(cleared.includes("p1"), "成功でエラー詳細クリア");
  });

  it("既に pin 済み（ハッシュあり）は pin を呼ばない（二重pinしない・冪等）", async () => {
    const { deps, log } = makeDeps([{ id: "p1", contentHash: "already" }], {});
    const out = await pinDueApprovals(deps);
    assertEqual(out[0].action, "already_pinned", "skip");
    assertFalse(log.includes("pin:p1"), "pin 未呼び出し");
  });

  it("pin 失敗(HEIC)は承認を通さず resetApproval に平易な理由を記録（fail-closed）", async () => {
    const reason =
      "画像2がLINEで表示できない形式です（image/heic）。JPEG か PNG にしてください。";
    const { deps, resets } = makeDeps([{ id: "p1", contentHash: null }], {
      p1: { ok: false, reason },
    });
    const out = await pinDueApprovals(deps);
    assertEqual(out[0].action, "reset_failed", "fail-closed");
    assertEqual(resets[0].id, "p1", "reset 対象");
    assertEqual(resets[0].reason, reason, "エラー詳細に平易な理由");
  });

  it("queryDue 失敗は空を返す（fail-closed・本処理側に委ねる）", async () => {
    const out = await pinDueApprovals({
      queryDue: async () => {
        throw new Error("notion down");
      },
      pin: async () => ({ ok: true as const, contentHash: "h" }),
      resetApproval: async () => {},
      clearError: async () => {},
      now: () => new Date("2026-07-10T05:00:00Z"),
    });
    assertEqual(out.length, 0, "空");
  });
});

describe("runScheduledDeliveryWith（承認pin前処理 → runDelivery の順・cronポーリング配線）", () => {
  it("pin フェーズ完了後に run を呼ぶ（pin→run 順）", async () => {
    const log: string[] = [];
    const deps: ScheduledDeliveryDeps = {
      queryDue: async () => {
        log.push("queryDue");
        return [{ id: "p1", contentHash: null }];
      },
      pin: async (id) => {
        log.push(`pin:${id}`);
        return { ok: true, contentHash: "h" };
      },
      resetApproval: async () => {
        log.push("reset");
      },
      clearError: async (id) => {
        log.push(`clear:${id}`);
      },
      now: () => new Date("2026-07-10T05:00:00Z"),
      run: async () => {
        log.push("run");
        return { scanned: 1, processed: [], reaper: [] };
      },
    };
    const res = await runScheduledDeliveryWith(deps);
    assertTrue(
      log.indexOf("pin:p1") >= 0 && log.indexOf("run") > log.indexOf("pin:p1"),
      "pin→run 順",
    );
    assertEqual(res.pinPass[0].action, "pinned", "pin 結果を返す");
    assertEqual(res.run.scanned, 1, "run 結果を返す");
  });

  it("HEIC で pin 失敗しても run は走る（他行のため）・実送信は run 実装のガードに委ねる", async () => {
    const log: string[] = [];
    const deps: ScheduledDeliveryDeps = {
      queryDue: async () => [{ id: "bad", contentHash: null }],
      pin: async () => ({
        ok: false,
        reason: "画像1がLINEで表示できない形式です（image/heic）。JPEG か PNG にしてください。",
      }),
      resetApproval: async (id) => {
        log.push(`reset:${id}`);
      },
      clearError: async () => {},
      now: () => new Date("2026-07-10T05:00:00Z"),
      run: async () => {
        log.push("run");
        return { scanned: 0, processed: [], reaper: [] };
      },
    };
    const res = await runScheduledDeliveryWith(deps);
    assertEqual(res.pinPass[0].action, "reset_failed", "HEIC は承認通さず fail-closed");
    assertTrue(log.includes("reset:bad"), "エラー詳細記録（reset）");
    assertTrue(log.includes("run"), "pin失敗でも run は継続");
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
