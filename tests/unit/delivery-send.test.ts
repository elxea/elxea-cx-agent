/**
 * Unit Tests -- Notion駆動 LINE配信 送信部（T4/T5/T6/T12/T8/T9/T10）
 *
 * 送信は全て mock/stub でネットワーク非接触。実 LINE / 実 Notion / 実 Supabase には触れない。
 * 検証範囲:
 *   - 配信対象の日本語↔enum 変換（parseAudience）
 *   - 予定日時は送信条件ではないこと（2026-08-22 完全オンデマンド化。未来/空/date-only でも送る）
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
  unionEligible,
  collectAllPages,
  resolveTargets,
  parseAllowlist,
  type LinkageRow,
  type PersonaRow,
  type LineUserPersonaRow,
  type TargetResolverDeps,
} from "../../src/lib/target-resolver";
import {
  buildAggregationUnit,
  audienceSegmentCode,
  isValidAggregationUnit,
  jstYyyymmdd,
} from "../../src/lib/aggregation-unit";
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
import type { DeliveryPage } from "../../src/lib/delivery-repository";
import {
  buildPersonaPrimaryEqualQuery,
  LINE_USERS_COLLECTION,
} from "../../src/lib/firestore";
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
// 【廃止】evaluateScheduledTime（配信予定日時ゲート）
// ---------------------------------------------------------------------------
// 2026-08-22 完全オンデマンド化（Setaka 指示）に伴い src/lib/delivery-time.ts ごと削除した。
// 配信予定日時は送信条件ではなくなったため、日時厳格化のテストも存在理由を失っている。
// 「予定日時に関わらず Approved なら送る」ことの検証は
// describe("runDeliveryOnce: 予定日時は送信条件ではない（完全オンデマンド化）") に移した。

// ---------------------------------------------------------------------------
// content-hash（pinning）
// ---------------------------------------------------------------------------
describe("computeContentHash / hashesMatch（TOCTOU pinning）", () => {
  it("同一内容は同一ハッシュ", async () => {
    const a = await computeContentHash({ format: "text", body: "こんにちは", audience: "all" });
    const b = await computeContentHash({ format: "text", body: "こんにちは", audience: "all" });
    assertEqual(a, b, "deterministic");
    assertTrue(hashesMatch(a, b), "match");
  });
  it("本文を編集するとハッシュ不一致（送信中止根拠）", async () => {
    const snap = await computeContentHash({ format: "text", body: "旧本文", audience: "all" });
    const cur = await computeContentHash({ format: "text", body: "新本文（編集後）", audience: "all" });
    assertFalse(hashesMatch(snap, cur), "mismatch");
  });
  it("空スナップショットは常に不一致（fail-closed）", async () => {
    const cur = await computeContentHash({ format: "text", body: "x", audience: "all" });
    assertFalse(hashesMatch(null, cur), "null snapshot");
    assertFalse(hashesMatch("", cur), "empty snapshot");
  });
  it("imageUrls 未指定/空は従来の {format,body} と同一ハッシュ（後方互換）", async () => {
    const legacy = await computeContentHash({ format: "text", body: "本文", audience: "all" });
    const empty = await computeContentHash({ format: "text", body: "本文", imageUrls: [], audience: "all" });
    assertEqual(legacy, empty, "undefined と [] は同一");
    assertTrue(hashesMatch(legacy, empty), "match");
  });
  it("恒久R2 URL 群の枚数/順序が変わるとハッシュ不一致（TOCTOU: 画像追加/並替検知）", async () => {
    const base = "https://pub-x.r2.dev/broadcast/pg";
    const one = await computeContentHash({ format: "image", body: null, imageUrls: [`${base}/0.jpg`], audience: "all" });
    const two = await computeContentHash({ format: "image", body: null, imageUrls: [`${base}/0.jpg`, `${base}/1.jpg`], audience: "all" });
    assertFalse(hashesMatch(one, two), "枚数変化で不一致");
    const swapped = await computeContentHash({ format: "image", body: null, imageUrls: [`${base}/1.jpg`, `${base}/0.jpg`], audience: "all" });
    assertFalse(hashesMatch(two, swapped), "順序変化で不一致");
    const same = await computeContentHash({ format: "image", body: null, imageUrls: [`${base}/0.jpg`, `${base}/1.jpg`], audience: "all" });
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
describe("selfApprovalRelaxed（prod は専用フラグでのみ緩和・既定は fail-closed）", () => {
  it("test + フラグ true → 緩和 true", () => {
    assertTrue(
      selfApprovalRelaxed({
        DELIVERY_TARGET_ENV: "test",
        DELIVERY_ALLOW_SELF_APPROVAL_TEST: "true",
      }),
      "test relaxed",
    );
  });
  it("prod + TEST フラグ true → 緩和されない（TEST フラグは prod に効かない）", () => {
    assertFalse(
      selfApprovalRelaxed({
        DELIVERY_TARGET_ENV: "prod",
        DELIVERY_ALLOW_SELF_APPROVAL_TEST: "true",
      }),
      "prod not relaxed by TEST flag",
    );
  });
  it("prod + PROD フラグ true → 緩和 true（Tier2 例外ゲート）", () => {
    assertTrue(
      selfApprovalRelaxed({
        DELIVERY_TARGET_ENV: "prod",
        DELIVERY_ALLOW_SELF_APPROVAL_PROD: "true",
      }),
      "prod relaxed only by explicit PROD flag",
    );
  });
  it("prod + PROD フラグ未設定/非true → 緩和されない（既定 fail-closed）", () => {
    assertFalse(
      selfApprovalRelaxed({ DELIVERY_TARGET_ENV: "prod" }),
      "prod no flag → fail-closed",
    );
    assertFalse(
      selfApprovalRelaxed({
        DELIVERY_TARGET_ENV: "prod",
        DELIVERY_ALLOW_SELF_APPROVAL_PROD: "1",
      }),
      "prod flag must be exactly 'true'",
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

// ---------------------------------------------------------------------------
// ブロック1: lineUsers 直読み ∪ 連携済み users 経由（Spec 2026-07-16）
// ---------------------------------------------------------------------------
describe("unionEligible（連携経由 ∪ lineUsers 直読み・lineUserId 一意化）", () => {
  const noExclude: ReadonlySet<string> = new Set<string>();

  it("連携経由が空でも lineUsers 直読みだけで宛先が成立する（非ゼロ）", () => {
    const rows: LineUserPersonaRow[] = [
      { lineUserId: "U1", persona: "serenity" },
      { lineUserId: "U2", persona: "serenity" },
      { lineUserId: "U3", persona: "explorer" }, // 別ペルソナ→除外
    ];
    const ids = unionEligible([], rows, "serenity", noExclude);
    assertEqual(ids.join(","), "U1,U2", "直読みのみで serenity 2 件");
  });

  it("連携経由と直読みの和集合を lineUserId で一意化する（重複を畳む）", () => {
    const rows: LineUserPersonaRow[] = [
      { lineUserId: "L1", persona: "serenity" }, // 連携経由にも居る→重複
      { lineUserId: "U9", persona: "serenity" }, // 直読み固有
    ];
    const ids = unionEligible(["L1", "L2"], rows, "serenity", noExclude);
    assertEqual(ids.sort().join(","), "L1,L2,U9", "L1 は重複せず 3 件");
  });

  it("退会(unfollow)集合に含まれる lineUserId は直読み経路でも除外する（安全側）", () => {
    const rows: LineUserPersonaRow[] = [
      { lineUserId: "U1", persona: "serenity" },
      { lineUserId: "Ublocked", persona: "serenity" },
    ];
    const ids = unionEligible([], rows, "serenity", new Set(["Ublocked"]));
    assertEqual(ids.join(","), "U1", "退会 Ublocked を除外");
  });

  it("直読みのペルソナ不一致・空 ID は落とす", () => {
    const rows: LineUserPersonaRow[] = [
      { lineUserId: "U1", persona: "sensory" }, // 不一致
      { lineUserId: "", persona: "serenity" }, // 空 ID
      { lineUserId: "U2", persona: "serenity" },
    ];
    const ids = unionEligible([], rows, "serenity", noExclude);
    assertEqual(ids.join(","), "U2", "一致かつ非空のみ");
  });
});

describe("resolveTargets ブロック1（customer_linkages 0 行 + lineUsers 直読み）", () => {
  const baseDeps = (over: Partial<TargetResolverDeps>): TargetResolverDeps => ({
    loadLinkages: async () => [],
    loadPersonaUsers: async () => [],
    broadcastEstimate: async () => null,
    loadAllowlistUserIds: async () => [],
    ...over,
  });

  it("【受け入れ基準(c)】customer_linkages 0 行のままでもペルソナ宛先が非ゼロ", async () => {
    const r = await resolveTargets(
      { kind: "persona", persona: "serenity" },
      baseDeps({
        loadLinkages: async () => [], // 連携 0 行
        loadPersonaUsers: async () => [], // 連携済み persona 0 件
        loadPersonaLineUsers: async () => [
          { lineUserId: "U1", persona: "serenity" },
          { lineUserId: "U2", persona: "serenity" },
          { lineUserId: "U3", persona: "explorer" },
        ],
      }),
    );
    assertTrue(r.kind === "multicast", "multicast（非ゼロ）");
    if (r.kind === "multicast") {
      assertEqual(r.estimatedRecipients, 2, "serenity 2 件（linkages 0 行）");
      assertEqual(r.userIds.join(","), "U1,U2", "直読み由来の宛先");
      assertEqual(r.batches.length, 1, "1 バッチ");
    }
  });

  it("連携経由 + 直読みの和集合（重複 lineUserId を一意化）", async () => {
    const r = await resolveTargets(
      { kind: "persona", persona: "serenity" },
      baseDeps({
        loadLinkages: async () => [
          { shopifyCustomerId: "s1", lineUserId: "L1", unfollowed: false, optedOut: false },
        ],
        loadPersonaUsers: async () => [{ shopifyCustomerId: "s1", persona: "serenity" }],
        loadPersonaLineUsers: async () => [
          { lineUserId: "L1", persona: "serenity" }, // 連携経由と重複
          { lineUserId: "U9", persona: "serenity" }, // 直読み固有
        ],
      }),
    );
    assertTrue(r.kind === "multicast", "multicast");
    if (r.kind === "multicast") {
      assertEqual(r.estimatedRecipients, 2, "L1 重複せず 2 件");
      assertEqual(r.userIds.sort().join(","), "L1,U9", "L1,U9");
    }
  });

  it("退会(unfollow)ユーザーは連携経由でも直読みでも除外（安全側・二重防御）", async () => {
    const r = await resolveTargets(
      { kind: "persona", persona: "serenity" },
      baseDeps({
        loadLinkages: async () => [
          { shopifyCustomerId: "s1", lineUserId: "Lblk", unfollowed: true, optedOut: false },
        ],
        loadPersonaUsers: async () => [{ shopifyCustomerId: "s1", persona: "serenity" }],
        // 同一 lineUserId が lineUsers 直読みにも現れても、退会集合で除外される。
        loadPersonaLineUsers: async () => [
          { lineUserId: "Lblk", persona: "serenity" },
          { lineUserId: "Uok", persona: "serenity" },
        ],
      }),
    );
    assertTrue(r.kind === "multicast", "multicast");
    if (r.kind === "multicast") {
      assertEqual(r.userIds.join(","), "Uok", "退会 Lblk を除外し Uok のみ");
    }
  });

  it("直読み未注入（loadPersonaLineUsers 省略）なら従来の連携経由のみに縮退（後方互換）", async () => {
    const r = await resolveTargets(
      { kind: "persona", persona: "serenity" },
      baseDeps({
        loadLinkages: async () => [
          { shopifyCustomerId: "s1", lineUserId: "L1", unfollowed: false, optedOut: false },
        ],
        loadPersonaUsers: async () => [{ shopifyCustomerId: "s1", persona: "serenity" }],
        // loadPersonaLineUsers は未注入
      }),
    );
    assertTrue(r.kind === "multicast", "multicast");
    if (r.kind === "multicast") assertEqual(r.userIds.join(","), "L1", "連携経由のみ");
  });
});

// ---------------------------------------------------------------------------
// ブロック1 CRITICAL 修正（2026-07-16）: ペルソナ宛先 Firestore クエリを EQUAL 化。
//   旧 NOT_EQUAL null はフィールド欠落行を除外しライブで常に 0 件だった（実測）。
//   構築される structuredQuery が「EQUAL / stringValue=persona」で、
//   NOT_EQUAL / nullValue を一切含まないことを機械的に保証する（NE-null 回帰防止）。
// ---------------------------------------------------------------------------
describe("buildPersonaPrimaryEqualQuery（NE-null 回帰防止・EQUAL 化）", () => {
  it("filter op が EQUAL・比較値が対象ペルソナの stringValue", () => {
    const q = buildPersonaPrimaryEqualQuery("users", "serenity", { limit: 300 }) as {
      where: { fieldFilter: { op: string; field: { fieldPath: string }; value: { stringValue?: string } } };
    };
    assertEqual(q.where.fieldFilter.op, "EQUAL", "op は EQUAL");
    assertEqual(q.where.fieldFilter.field.fieldPath, "persona.primary", "対象は persona.primary");
    assertEqual(q.where.fieldFilter.value.stringValue, "serenity", "比較値は対象ペルソナ");
  });

  it("NOT_EQUAL / nullValue を一切含まない（NE-null 全面排除）", () => {
    for (const persona of ["serenity", "explorer", "sensory"] as const) {
      for (const col of ["users", LINE_USERS_COLLECTION]) {
        const s = JSON.stringify(
          buildPersonaPrimaryEqualQuery(col, persona, { limit: 300 }),
        );
        assertTrue(!s.includes("NOT_EQUAL"), `${col}/${persona}: NOT_EQUAL を含まない`);
        assertTrue(!s.includes("nullValue"), `${col}/${persona}: nullValue を含まない`);
        assertTrue(s.includes(`"stringValue":"${persona}"`), `${col}/${persona}: EQUAL 比較値`);
      }
    }
  });

  it("cursor（startAfterName）指定で startAt/before:false を付ける・未指定なら付けない", () => {
    const withCur = buildPersonaPrimaryEqualQuery("users", "explorer", {
      limit: 300,
      startAfterName: "projects/p/databases/(default)/documents/users/abc",
    }) as { startAt?: { before: boolean; values: Array<{ referenceValue: string }> } };
    assertTrue(!!withCur.startAt, "cursor ありは startAt を付ける");
    assertEqual(withCur.startAt!.before, false, "before:false（次ページ）");
    const noCur = buildPersonaPrimaryEqualQuery("users", "explorer", { limit: 300 }) as {
      startAt?: unknown;
    };
    assertTrue(noCur.startAt === undefined, "cursor なしは startAt を付けない");
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
  writeDeliveryResult,
  pinApproval,
  resetApproval as repoResetApproval,
  DELIVERY_PROPS,
  resolveDeliveryDbId,
  DeliveryDbConfigError,
  PROD_DELIVERY_DB_ID,
  type NotionRequest,
} from "../../src/lib/delivery-repository";

// ---------------------------------------------------------------------------
// 配信 DB の env 分離（cross-env 誤配信の構造的排除・fail-closed）
// ---------------------------------------------------------------------------
describe("resolveDeliveryDbId（test/prod 配信 DB の env 分離・fail-closed）", () => {
  const TEST_DB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("prod + NOTION_DELIVERY_DB_ID 未設定 → PROD_DELIVERY_DB_ID（従来挙動を厳密維持）", () => {
    assertEqual(
      resolveDeliveryDbId({ DELIVERY_TARGET_ENV: "prod" }),
      PROD_DELIVERY_DB_ID,
      "prod default",
    );
  });

  it("prod + 明示 DB → 明示を優先", () => {
    assertEqual(
      resolveDeliveryDbId({
        DELIVERY_TARGET_ENV: "prod",
        NOTION_DELIVERY_DB_ID: "prod-explicit-db",
      }),
      "prod-explicit-db",
      "prod explicit",
    );
  });

  it("test + 専用 DB → その専用 DB", () => {
    assertEqual(
      resolveDeliveryDbId({
        DELIVERY_TARGET_ENV: "test",
        NOTION_DELIVERY_DB_ID: TEST_DB,
      }),
      TEST_DB,
      "test dedicated",
    );
  });

  it("test + 専用 DB 未設定 → throw（prod DB へフォールバックしない・最重要ガード）", () => {
    let threw = false;
    try {
      resolveDeliveryDbId({ DELIVERY_TARGET_ENV: "test" });
    } catch (e) {
      threw = e instanceof DeliveryDbConfigError;
    }
    assertTrue(threw, "test unset fail-closed");
  });

  it("TARGET_ENV 未設定/不正 → test 扱い（厳しい側）で throw", () => {
    let threwUnset = false;
    try {
      resolveDeliveryDbId({});
    } catch (e) {
      threwUnset = e instanceof DeliveryDbConfigError;
    }
    assertTrue(threwUnset, "unset target → test → fail-closed");

    let threwBad = false;
    try {
      resolveDeliveryDbId({ DELIVERY_TARGET_ENV: "STAGING" });
    } catch (e) {
      threwBad = e instanceof DeliveryDbConfigError;
    }
    assertTrue(threwBad, "invalid target → test → fail-closed");
  });

  it("test ワーカーが prod DB を指す → throw（逆方向 cross-send も塞ぐ）", () => {
    let threw = false;
    try {
      resolveDeliveryDbId({
        DELIVERY_TARGET_ENV: "test",
        NOTION_DELIVERY_DB_ID: PROD_DELIVERY_DB_ID,
      });
    } catch (e) {
      threw = e instanceof DeliveryDbConfigError;
    }
    assertTrue(threw, "test pointing prod DB fail-closed");
  });

  it("prod と test は同一 DB を解決し得ない（分離の不変条件）", () => {
    const prodDb = resolveDeliveryDbId({ DELIVERY_TARGET_ENV: "prod" });
    const testDb = resolveDeliveryDbId({
      DELIVERY_TARGET_ENV: "test",
      NOTION_DELIVERY_DB_ID: TEST_DB,
    });
    assertTrue(prodDb !== testDb, "prod db !== test db");
  });
});

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
