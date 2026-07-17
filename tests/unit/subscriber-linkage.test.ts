/**
 * Unit Tests -- subscriber-linkage（アカウント連携導線・定期便判定・ブロック4）
 *
 * 検証:
 *   (a) allowlist パース / staging ゲート
 *   (b) テスト用オーバーライドは staging(DELIVERY_TARGET_ENV="test") でのみ有効・本番では常に無効
 *   (c) resolveLinkedSubscriber: 未連携 / override / firestore / 非定期便 の各分岐（deps 注入）
 *   (d) selectLinkageMessage の分岐 と 文言（絵文字なし・押し売りなし・URL）
 *
 * 使用方法: npx tsx tests/unit/subscriber-linkage.test.ts
 */

import type { Env } from "../../src/index";
import type { LineResponder } from "../../src/lib/line";
import {
  LINKAGE_TRIGGER,
  TEST_SUBSCRIBER_ENV_KEY,
  isStagingSubscriberOverrideEnv,
  parseTestSubscriberAllowlist,
  isTestSubscriberOverride,
  resolveLinkedSubscriber,
  selectLinkageMessage,
  buildLinkageInviteMessage,
  buildSubscriberLinkedMessage,
  buildNonSubscriberDeclineMessage,
  resolveLiffLinkageUrl,
  buildLinkageInviteFlex,
  emitLinkageButton,
  sendLinkageInvite,
  type LinkageResolution,
} from "../../src/lib/subscriber-linkage";
import {
  LINKAGE_INVITE_BODY,
  SUBSCRIBER_LINKED_BODY,
  NON_SUBSCRIBER_DECLINE_BODY,
  LINKAGE_BENEFIT_LINE,
  LINKAGE_BUTTON_LABEL,
  SITE_URL_JA,
} from "../../src/lib/brand-copy";

const LIFF_URL = "https://liff.line.me/2009473839-ubrqGbMF";

/** 送信を記録する mock responder（flex/text の呼び出しを観測する）。 */
function mockResponder(): {
  responder: LineResponder;
  calls: Array<{ kind: "text" | "flex"; altOrText: string; payload?: unknown }>;
} {
  const calls: Array<{ kind: "text" | "flex"; altOrText: string; payload?: unknown }> = [];
  const responder: LineResponder = {
    async text(text, quickReplyItems) {
      calls.push({ kind: "text", altOrText: text, payload: quickReplyItems });
    },
    async flex(altText, contents) {
      calls.push({ kind: "flex", altOrText: altText, payload: contents });
    },
  };
  return { responder, calls };
}

/** Flex bubble の footer button の uri を取り出す（存在しなければ null）。 */
function extractButtonUri(contents: unknown): string | null {
  const c = contents as {
    footer?: { contents?: Array<{ action?: { type?: string; uri?: string } }> };
  };
  const action = c.footer?.contents?.[0]?.action;
  return action?.type === "uri" ? action.uri ?? null : null;
}

let total = 0, passed = 0, failed = 0;
const failures: Array<{ name: string; error: string }> = [];
function it(name: string, fn: () => void | Promise<void>) {
  total++;
  try {
    const r = fn();
    if (r instanceof Promise) {
      // 同期集計のため、呼び出し側で await する
      return r.then(
        () => { passed++; console.log(`  [PASS] ${name}`); },
        (err) => { failed++; const m = err instanceof Error ? err.message : String(err); console.log(`  [FAIL] ${name}: ${m}`); failures.push({ name, error: m }); },
      );
    }
    passed++; console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed++; const m = err instanceof Error ? err.message : String(err);
    console.log(`  [FAIL] ${name}: ${m}`); failures.push({ name, error: m });
  }
}
function assert(cond: boolean, label: string) { if (!cond) throw new Error(label); }
function assertEqual<T>(a: T, b: T, label = "") { if (a !== b) throw new Error(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

/** 絵文字（主要な emoji レンジ）を含まないことを検証する。 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}️]/u;

const STAGING = "test";
const PROD = "prod";
const SYN_LINE = "Ub10c4deadbeef0000000000000000000"; // 合成テスト ID（U+32hex）
const SYN_SHOPIFY = "900800400001";

function envWith(overrides: Partial<Env>): Env {
  return {
    DELIVERY_TARGET_ENV: STAGING,
    FIREBASE_PROJECT_ID: "test-project",
    FIREBASE_CLIENT_EMAIL: "test@example.com",
    FIREBASE_PRIVATE_KEY: "x",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "x",
    ...overrides,
  } as unknown as Env;
}

const fakeSupabase = {} as unknown as import("@supabase/supabase-js").SupabaseClient;

async function run() {
  console.log("\n--- (a) allowlist パース / staging ゲート ---");
  it("env key 名が固定", () => assertEqual(TEST_SUBSCRIBER_ENV_KEY, "TEST_SUBSCRIBER_LINE_IDS"));
  it("parse: 空/未定義は []", () => { assertEqual(parseTestSubscriberAllowlist(undefined).length, 0); assertEqual(parseTestSubscriberAllowlist("").length, 0); });
  it("parse: カンマ区切り・トリム・空要素除去", () => {
    const r = parseTestSubscriberAllowlist(" a , b ,, c ");
    assertEqual(r.join("|"), "a|b|c");
  });
  it("staging ゲート: test=true / prod=false / 未設定=false", () => {
    assert(isStagingSubscriberOverrideEnv({ DELIVERY_TARGET_ENV: STAGING }), "test true");
    assert(!isStagingSubscriberOverrideEnv({ DELIVERY_TARGET_ENV: PROD }), "prod false");
    assert(!isStagingSubscriberOverrideEnv({}), "unset false");
  });

  console.log("\n--- (b) テスト用オーバーライドは本番で必ず無効 ---");
  it("staging + allowlist 一致 → true", () => {
    assert(isTestSubscriberOverride(SYN_LINE, { DELIVERY_TARGET_ENV: STAGING, TEST_SUBSCRIBER_LINE_IDS: SYN_LINE }), "should be true");
  });
  it("staging + allowlist 不一致 → false", () => {
    assert(!isTestSubscriberOverride("Uother", { DELIVERY_TARGET_ENV: STAGING, TEST_SUBSCRIBER_LINE_IDS: SYN_LINE }), "should be false");
  });
  it("本番(prod) では allowlist に入っていても常に false（本番コードパス非影響の担保）", () => {
    assert(!isTestSubscriberOverride(SYN_LINE, { DELIVERY_TARGET_ENV: PROD, TEST_SUBSCRIBER_LINE_IDS: SYN_LINE }), "prod must be inert");
  });
  it("DELIVERY_TARGET_ENV 未設定でも allowlist は無効（既定は非 staging 扱い）", () => {
    assert(!isTestSubscriberOverride(SYN_LINE, { TEST_SUBSCRIBER_LINE_IDS: SYN_LINE }), "unset must be inert");
  });

  console.log("\n--- (c) resolveLinkedSubscriber 分岐（deps 注入・実 I/O なし） ---");
  await it("未連携（customer_linkages に無い）→ linked=false", async () => {
    const r = await resolveLinkedSubscriber(SYN_LINE, envWith({}), {
      supabase: fakeSupabase,
      resolveCustomerId: async () => null,
      getProfile: async () => { throw new Error("should not read firestore when unlinked"); },
    });
    assertEqual(r.linked, false, "linked"); assertEqual(r.isSubscriber, false, "sub"); assertEqual(r.source, "none", "source");
  });
  await it("連携済み + staging override → isSubscriber=true / source=override（Firestore 非参照）", async () => {
    const r = await resolveLinkedSubscriber(SYN_LINE, envWith({ TEST_SUBSCRIBER_LINE_IDS: SYN_LINE }), {
      supabase: fakeSupabase,
      resolveCustomerId: async () => SYN_SHOPIFY,
      getProfile: async () => { throw new Error("override should short-circuit before firestore"); },
    });
    assertEqual(r.linked, true, "linked"); assertEqual(r.isSubscriber, true, "sub"); assertEqual(r.source, "override", "source");
    assertEqual(r.shopifyCustomerId, SYN_SHOPIFY, "shopifyId");
  });
  await it("連携済み + Firestore isSubscriber=true → source=firestore", async () => {
    const r = await resolveLinkedSubscriber(SYN_LINE, envWith({}), {
      supabase: fakeSupabase,
      resolveCustomerId: async () => SYN_SHOPIFY,
      getProfile: async () => ({ isSubscriber: true }),
    });
    assertEqual(r.isSubscriber, true, "sub"); assertEqual(r.source, "firestore", "source");
  });
  await it("連携済み + Firestore isSubscriber=false → 非定期便 / source=none", async () => {
    const r = await resolveLinkedSubscriber(SYN_LINE, envWith({}), {
      supabase: fakeSupabase,
      resolveCustomerId: async () => SYN_SHOPIFY,
      getProfile: async () => ({ isSubscriber: false }),
    });
    assertEqual(r.linked, true, "linked"); assertEqual(r.isSubscriber, false, "sub"); assertEqual(r.source, "none", "source");
  });
  await it("本番(prod) では override が効かず Firestore で判定される", async () => {
    const r = await resolveLinkedSubscriber(SYN_LINE, envWith({ DELIVERY_TARGET_ENV: PROD, TEST_SUBSCRIBER_LINE_IDS: SYN_LINE }), {
      supabase: fakeSupabase,
      resolveCustomerId: async () => SYN_SHOPIFY,
      getProfile: async () => ({ isSubscriber: false }),
    });
    assertEqual(r.isSubscriber, false, "prod override inert → firestore false"); assertEqual(r.source, "none", "source");
  });

  console.log("\n--- (d) 文言（分岐・絵文字なし・押し売りなし） ---");
  it("trigger 定数", () => assertEqual(LINKAGE_TRIGGER, "アカウントを連携する"));
  it("selectLinkageMessage: 未連携=案内", () => {
    const m = selectLinkageMessage({ linked: false, shopifyCustomerId: null, isSubscriber: false, source: "none" });
    assert(m.includes(LINKAGE_INVITE_BODY.slice(0, 20)), "invite body");
  });
  it("selectLinkageMessage: 連携済み定期便=定期便客応答", () => {
    const m = selectLinkageMessage({ linked: true, shopifyCustomerId: SYN_SHOPIFY, isSubscriber: true, source: "override" });
    assertEqual(m, buildSubscriberLinkedMessage());
    assert(m.includes(SUBSCRIBER_LINKED_BODY.slice(0, 20)), "subscriber body");
  });
  it("selectLinkageMessage: 連携済み非定期便=丁寧なお断り", () => {
    const m = selectLinkageMessage({ linked: true, shopifyCustomerId: SYN_SHOPIFY, isSubscriber: false, source: "none" });
    assert(m.includes(NON_SUBSCRIBER_DECLINE_BODY.slice(0, 20)), "decline body");
  });
  it("各文言に絵文字を含まない", () => {
    for (const m of [buildLinkageInviteMessage(), buildSubscriberLinkedMessage(), buildNonSubscriberDeclineMessage()]) {
      assert(!EMOJI_RE.test(m), `emoji found in: ${m}`);
    }
  });
  it("押し売り語（限定/今だけ/セール/割引/お得）を含まない", () => {
    const banned = ["限定", "今だけ", "セール", "割引", "お得", "急いで"];
    for (const m of [buildLinkageInviteMessage(), buildSubscriberLinkedMessage(), buildNonSubscriberDeclineMessage()]) {
      for (const w of banned) assert(!m.includes(w), `banned word "${w}" in: ${m}`);
    }
  });
  it("案内・お断りは URL を含む", () => {
    assert(buildLinkageInviteMessage().includes("https://"), "invite url");
    assert(buildNonSubscriberDeclineMessage().includes("https://elxea.com/ja/subscription"), "decline url");
  });

  console.log("\n--- (e) LIFF 連携ボタン導線（トーク内入り口・ブロック4） ---");
  it("resolveLiffLinkageUrl: 設定あり→URL / 未設定・空→null（prod fail-safe）", () => {
    assertEqual(resolveLiffLinkageUrl({ LIFF_LINKAGE_URL: LIFF_URL }), LIFF_URL, "set");
    assertEqual(resolveLiffLinkageUrl({ LIFF_LINKAGE_URL: "  " }), null, "whitespace");
    assertEqual(resolveLiffLinkageUrl({}), null, "unset");
  });
  it("buildLinkageInviteMessage: liffUrl 指定→LIFF 着地 / 未指定→従来 elxea.com/ja（点4 fail-safe）", () => {
    assert(buildLinkageInviteMessage(LIFF_URL).includes(LIFF_URL), "liff landing");
    assert(!buildLinkageInviteMessage(LIFF_URL).includes(SITE_URL_JA), "no legacy url when liff set");
    assert(buildLinkageInviteMessage(null).includes(SITE_URL_JA), "legacy url when unset");
    assert(buildLinkageInviteMessage().includes(SITE_URL_JA), "legacy url when arg absent");
  });
  it("buildLinkageInviteFlex: 便益1行 + LIFF を開く URI ボタン（ラベル一致・絵文字なし）", () => {
    const flex = buildLinkageInviteFlex(LIFF_URL);
    assertEqual(extractButtonUri(flex.contents), LIFF_URL, "button uri");
    assert(flex.altText.includes(LINKAGE_BENEFIT_LINE.slice(0, 12)), "altText = benefit");
    const json = JSON.stringify(flex.contents);
    assert(json.includes(LINKAGE_BENEFIT_LINE), "benefit line present");
    assert(json.includes(LINKAGE_BUTTON_LABEL), "button label present");
    assert(!EMOJI_RE.test(json), "no emoji in flex");
  });
  it("buildLinkageInviteFlex: leadText を先頭に添えられる", () => {
    const flex = buildLinkageInviteFlex(LIFF_URL, { leadText: "先頭のリード文" });
    assert(JSON.stringify(flex.contents).includes("先頭のリード文"), "leadText present");
  });
  await it("emitLinkageButton: LIFF 設定時→flex 送信 + true（surface 記録は fire-and-forget）", async () => {
    const { responder, calls } = mockResponder();
    const shown = await emitLinkageButton(SYN_LINE, envWith({ LIFF_LINKAGE_URL: LIFF_URL }), responder, "trigger");
    assertEqual(shown, true, "shown");
    assertEqual(calls.length, 1, "one send");
    assertEqual(calls[0].kind, "flex", "flex");
    assertEqual(extractButtonUri(calls[0].payload), LIFF_URL, "button uri sent");
  });
  await it("emitLinkageButton: LIFF 未設定時→何も送らず false（prod fail-safe）", async () => {
    const { responder, calls } = mockResponder();
    const shown = await emitLinkageButton(SYN_LINE, envWith({ LIFF_LINKAGE_URL: undefined }), responder, "menu4");
    assertEqual(shown, false, "not shown");
    assertEqual(calls.length, 0, "nothing sent");
  });
  await it("sendLinkageInvite: LIFF 設定時→ボタン flex のみ（fallback text 非送信）", async () => {
    const { responder, calls } = mockResponder();
    await sendLinkageInvite(SYN_LINE, envWith({ LIFF_LINKAGE_URL: LIFF_URL }), responder, "FALLBACK");
    assertEqual(calls.length, 1, "one send");
    assertEqual(calls[0].kind, "flex", "flex");
  });
  await it("sendLinkageInvite: LIFF 未設定時→fallback テキストのみ（従来動作）", async () => {
    const { responder, calls } = mockResponder();
    await sendLinkageInvite(SYN_LINE, envWith({ LIFF_LINKAGE_URL: undefined }), responder, "FALLBACK");
    assertEqual(calls.length, 1, "one send");
    assertEqual(calls[0].kind, "text", "text");
    assertEqual(calls[0].altOrText, "FALLBACK", "fallback text");
  });

  console.log(`\n==================================================`);
  console.log(`subscriber-linkage.test: ${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) { for (const f of failures) console.log(`  FAIL: ${f.name} — ${f.error}`); process.exit(1); }
}

run();
