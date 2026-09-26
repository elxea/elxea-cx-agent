/**
 * ハーメティック -- 公式 EC の閉店中の文と分岐（D2a: C-9〜C-17, C-21, C-22 と連携の状態別の返事）
 *
 * 設計: 実装設計 rev2 第3・4・6・9章 https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 * 文言の正本: 文言 v2（elxea-ccs）https://app.notion.com/p/3e770c9d064c818eb5eee425b35dba90
 *   - 閉店中の文は文言 v2 の「新しい文」との完全一致（`${SUPPORT_EMAIL}` は brand-copy.ts の SUPPORT_EMAIL、
 *     `${PURCHASE_URL}` は storefront.ts の PURCHASE_URL を差し込む）
 *   - 開店時の文は master（788baac）の今の文との完全一致（siteOpen=true を渡して固定する）
 *   文言が変わったらテストを文言に合わせる（文言が正）。
 *
 * 判定は storefront.ts の collectLinks + isClosedSiteLink（文字列の単純一致では判定しない。
 * C-9 は info@elxea.com を出すので、メールアドレスは閉じたリンクとして数えない）。
 *
 * 連携の状態・マルシェ客・開店状態は deps で注入し、Supabase / Firestore / LINE には触れない。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { installHermeticFetch, type Hermetic } from "../lib/hermetic";
import { synthLineUserId } from "../lib/synthetic";
import type { Env } from "../../src/index";
import type { LineResponder, QuickReplyItem } from "../../src/lib/line";
import { collectLinks, isClosedSiteLink, PURCHASE_URL, AMAZON_STORE_URL } from "../../src/lib/storefront";
import {
  ABOUT_BLURB,
  WELCOME_DELIVERY_FREQUENCY,
  SUPPORT_EMAIL,
  LINKAGE_INVITE_BODY,
  NON_SUBSCRIBER_DECLINE_BODY,
  SUBSCRIBER_LINKED_BODY,
  MARCHE_LINKAGE_SOFT_ACK,
  ACCOUNT_LINK_NOT_LINKED_BODY,
  LINKAGE_PREPARING_BODY,
  NON_SUBSCRIBER_DECLINE_BODY_CLOSED,
  READING_PREPARING_BODY,
  TASTING_NOTE_CTA_TEXT_OPEN,
  tastingNoteCtaText,
} from "../../src/lib/brand-copy";
import {
  SUBSCRIPTION_TRIGGER,
  ABOUT_TRIGGER,
  buildAboutMessage,
  buildSubscriptionMessage,
  buildSubscriptionInquiryReply,
  handleMenuActionFlow,
} from "../../src/lib/menu-actions";
import {
  LINKAGE_TRIGGER,
  buildLinkageInviteMessage,
  buildNonSubscriberDeclineMessage,
  selectLinkageMessage,
  handleLinkageFlow,
  type LinkageResolution,
} from "../../src/lib/subscriber-linkage";
import { ACCOUNT_LINK_UNLINK_TRIGGER } from "../../src/lib/brand-copy";
import { orderLinkRequiredMessage } from "../../src/lib/shopify";
import { BROADCAST_TEMPLATES, withBroadcastSiteLink } from "../../src/lib/broadcast-templates";
import { buildBrandCanonicalFacts } from "../../src/sync/knowledge";
import { handleJournalFlow, READING_TRIGGER, READING_TRIGGER_ALT } from "../../src/lib/journal";

let h: Hermetic;
beforeEach(() => {
  h = installHermeticFetch(env);
});
afterEach(() => {
  h.restore();
});

/** 閉じたサイトへのリンク（閉店中の判定）を取り出す。空なら閉じたリンクなし。 */
function closedLinks(message: unknown): string[] {
  return collectLinks(message).filter((l) => isClosedSiteLink(l, false));
}

type TextCall = { text: string; quickReplies?: QuickReplyItem[] };
type FlexCall = { altText: string; contents: Record<string, unknown> };
function captureResponder(): { responder: LineResponder; texts: TextCall[]; flexes: FlexCall[] } {
  const texts: TextCall[] = [];
  const flexes: FlexCall[] = [];
  const responder: LineResponder = {
    async text(text, quickReplies): Promise<void> {
      texts.push({ text, quickReplies });
    },
    async flex(altText, contents): Promise<void> {
      flexes.push({ altText, contents });
    },
  };
  return { responder, texts, flexes };
}

const UNLINKED: LinkageResolution = { linked: false, shopifyCustomerId: null, isSubscriber: false, source: "none" };
const LINKED_SUB: LinkageResolution = { linked: true, shopifyCustomerId: "gid://shopify/Customer/1", isSubscriber: true, source: "override" };
const LINKED_NON_SUB: LinkageResolution = { linked: true, shopifyCustomerId: "gid://shopify/Customer/1", isSubscriber: false, source: "none" };

/** 連携ボタンの URL が設定されていても、閉店中はボタンが出ないことを確かめるための env。 */
function envWith(over: Partial<Env>): Env {
  return { ...(env as unknown as Env), ...over } as Env;
}
const ENV_WITH_LINK_URLS = envWith({
  LIFF_LINKAGE_URL: "https://liff.line.me/0000000000-test",
  ACCOUNT_LINK_ENTRY_URL: "https://example.invalid/link",
} as Partial<Env>);
const ENV_NO_LINK_URLS = envWith({ LIFF_LINKAGE_URL: undefined, ACCOUNT_LINK_ENTRY_URL: undefined } as Partial<Env>);

// ---------------------------------------------------------------------------
// master（788baac）の今の文（開店時の期待値）
// ---------------------------------------------------------------------------
const MASTER_C9 =
  "いつも elxea の定期便をご利用いただき、ありがとうございます。\n\nお届け中のプラン内容やお届け日のご確認・ご変更は、こちらのページからお手続きいただけます。\nhttps://elxea.com/ja/subscription\n\nご不明な点があれば、このままメッセージでお気軽にお尋ねください。";
const MASTER_C10 =
  "elxea の定期便は、季節のお茶を旬に合わせて定期的にお届けする仕組みです。\n\n選ぶ手間なく、その時季にいちばんおいしいお茶を、暮らしのそばに置いていただけます。\n\nプランの詳細はこちらからご覧いただけます。\nhttps://elxea.com/ja/subscription\n\n気になることがあれば、このままメッセージでお尋ねくださいね。";
const MASTER_C11 =
  "定期便の内容とお申し込みは、elxea のサイトでご覧いただけます。\nhttps://elxea.com/ja/subscription\n\nお茶のことでしたら、このままメッセージでお尋ねくださいね。";
const ABOUT_TAIL =
  "このトークは、elxea のサポートを担当する AI がお答えしています。お茶えらびのご相談など、気軽に話しかけてくださいね。\n\n" +
  WELCOME_DELIVERY_FREQUENCY;
const MASTER_C12 = `${ABOUT_BLURB}\n\nくわしくはこちらをご覧ください。\nhttps://elxea.com/ja\n\n${ABOUT_TAIL}`;
const MASTER_LINKAGE_INVITE_BODY =
  "ご購入時のアカウントとこのトークを連携すると、あなたの好みに合わせたご案内を、このトークで受け取れるようになります。お手数ですが、マイページからアカウント連携をお願いします。";
const MASTER_NON_SUBSCRIBER_DECLINE_BODY =
  "アカウントの連携が完了しました。これからは、あなたの好みに合わせたご案内を、このトークでお届けしますね。定期便のご案内をご希望のときは、こちらからいつでもご覧いただけます。";
const MASTER_C21_LINE =
  "ご注文内容の照会には、LINEアカウントとご購入時のShopifyアカウントの連携が必要です。マイページからアカウント連携をお願いします。連携後、ご自身の注文番号で照会いただけます。";
const MASTER_C21_WEB =
  "ご注文内容の照会には、ご購入時のアカウントでのログイン（連携）が必要です。ログインのうえ、再度お試しください。";

// ---------------------------------------------------------------------------
// 文言 v2 の「新しい文」（閉店中の期待値）
// ---------------------------------------------------------------------------
const V2_C9 = `いつも elxea の定期便をご利用いただき、ありがとうございます。\n\nお届け内容やお届け日のご確認・ご変更は、お手数ですが ${SUPPORT_EMAIL} までご連絡ください。\n\nご不明な点があれば、このままメッセージでお気軽にお尋ねください。`;
const V2_C10 = "elxea の定期便は、いまお届けをはじめる準備を進めています。\n\n気になることがあれば、このままメッセージでお尋ねくださいね。";
const V2_C11 = "elxea の定期便は、いまお届けをはじめる準備を進めています。\n\nお茶のことでしたら、このままメッセージでお尋ねくださいね。";
const V2_C12 = `${ABOUT_BLURB}\n\n${ABOUT_TAIL}`;
const V2_C13 = "アカウントの連携は、いま準備を進めているところです。\n\nお茶のことでしたら、このままメッセージでお尋ねくださいね。";
const V2_C14 = "アカウントの連携が完了しました。これからは、あなたの好みに合わせたご案内を、このトークでお届けしますね。";
const V2_C17 = `購入先（公式サイトの開店まで）: Amazon の elxea ストア ${PURCHASE_URL}`;
const V2_C21 = "ご注文内容の照会に必要なアカウントの連携は、いま準備を進めているところです。Amazon でのご注文は、Amazon の注文履歴からご確認いただけます。";
const V2_C22 = "読みものは、いま準備を進めているところです。\n\nお茶のことでしたら、このままメッセージでお尋ねくださいね。";

describe("D2a 文の対: 開店時 = master の文 / 閉店中 = 文言 v2（完全一致）", () => {
  const pairs: Array<{ id: string; open: string | null; closed: string | null; openExpected: string | null; closedExpected: string | null }> = [
    { id: "C-9 定期便・利用中", open: buildSubscriptionMessage("subscriber", true), closed: buildSubscriptionMessage("subscriber", false), openExpected: MASTER_C9, closedExpected: V2_C9 },
    { id: "C-10 定期便・売り込み面 ON の未利用", open: buildSubscriptionMessage("generic", true), closed: buildSubscriptionMessage("generic", false), openExpected: MASTER_C10, closedExpected: V2_C10 },
    { id: "C-11 定期便・既定", open: buildSubscriptionInquiryReply(true), closed: buildSubscriptionInquiryReply(false), openExpected: MASTER_C11, closedExpected: V2_C11 },
    { id: "C-12 elxea について", open: buildAboutMessage(true), closed: buildAboutMessage(false), openExpected: MASTER_C12, closedExpected: V2_C12 },
    { id: "C-13 未連携への連携案内（LIFF なし）", open: buildLinkageInviteMessage(null, true), closed: buildLinkageInviteMessage(null, false), openExpected: `${MASTER_LINKAGE_INVITE_BODY}\nhttps://elxea.com/ja`, closedExpected: V2_C13 },
    { id: "C-13 未連携への連携案内（LIFF あり・staging）", open: buildLinkageInviteMessage("https://liff.line.me/0000000000-test", true), closed: buildLinkageInviteMessage("https://liff.line.me/0000000000-test", false), openExpected: `${MASTER_LINKAGE_INVITE_BODY}\nhttps://liff.line.me/0000000000-test`, closedExpected: V2_C13 },
    { id: "C-14 連携済み・定期便でない", open: buildNonSubscriberDeclineMessage(true), closed: buildNonSubscriberDeclineMessage(false), openExpected: `${MASTER_NON_SUBSCRIBER_DECLINE_BODY}\nhttps://elxea.com/ja/subscription`, closedExpected: V2_C14 },
    { id: "C-15 体験を記録する", open: tastingNoteCtaText(true), closed: tastingNoteCtaText(false), openExpected: "\n\n✿ 体験を記録する → https://elxea.com/ja/tasting-note", closedExpected: null },
    { id: "C-21 未連携の注文照会（LINE）", open: orderLinkRequiredMessage("line", true), closed: orderLinkRequiredMessage("line", false), openExpected: MASTER_C21_LINE, closedExpected: V2_C21 },
  ];

  for (const p of pairs) {
    it(`${p.id}: 開店時は master の文のまま`, () => {
      expect(p.open).toBe(p.openExpected);
    });
    it(`${p.id}: 閉店中は文言 v2 のまま・閉じたリンクなし`, () => {
      expect(p.closed).toBe(p.closedExpected);
      expect(closedLinks(p.closed ?? "")).toEqual([]);
    });
  }

  it("定数も文言 v2 と一致（C-13 / C-14 / C-22）・開店時の元の定数は変えていない", () => {
    expect(LINKAGE_PREPARING_BODY).toBe(V2_C13);
    expect(NON_SUBSCRIBER_DECLINE_BODY_CLOSED).toBe(V2_C14);
    expect(READING_PREPARING_BODY).toBe(V2_C22);
    expect(LINKAGE_INVITE_BODY).toBe(MASTER_LINKAGE_INVITE_BODY);
    expect(NON_SUBSCRIBER_DECLINE_BODY).toBe(MASTER_NON_SUBSCRIBER_DECLINE_BODY);
    expect(TASTING_NOTE_CTA_TEXT_OPEN).toBe("\n\n✿ 体験を記録する → https://elxea.com/ja/tasting-note");
  });

  it("C-9 は問い合わせメールを出す（メールアドレスは閉じたリンクとして数えない）", () => {
    expect(buildSubscriptionMessage("subscriber", false)).toContain("info@elxea.com");
    expect(closedLinks(buildSubscriptionMessage("subscriber", false))).toEqual([]);
  });

  it("C-21: web 向けの返しは開店状態に関係なく master の文のまま（対象外）", () => {
    expect(orderLinkRequiredMessage("web", true)).toBe(MASTER_C21_WEB);
    expect(orderLinkRequiredMessage("web", false)).toBe(MASTER_C21_WEB);
  });

  it("C-17 ナレッジの会社事実: 開店時は公式サイトの行 / 閉店中は購入先の行（公式サイトの住所を入れない）", () => {
    const open = buildBrandCanonicalFacts(true).split("\n");
    const closed = buildBrandCanonicalFacts(false).split("\n");
    expect(open[5]).toBe("公式サイト: https://elxea.com/ja");
    expect(closed[5]).toBe(V2_C17);
    expect(closed[5]).toContain(AMAZON_STORE_URL);
    expect(closed.filter((l) => l.startsWith("公式サイト"))).toEqual([]);
    // 公式サイトの行以外は開店時と同じ（行数・順番も同じ）。
    expect(closed.length).toBe(open.length);
    expect(closed.filter((_, i) => i !== 5)).toEqual(open.filter((_, i) => i !== 5));
    expect(closed).toContain("お問い合わせ: info@elxea.com");
    expect(closedLinks(buildBrandCanonicalFacts(false))).toEqual([]);
  });
});

describe("C-16 季節の配信テンプレート 15 件（末尾の URL を 1 つの関数で切り替える）", () => {
  it("15 件すべて: 閉店中（いま）は閉じたリンクなし・末尾に空白や改行が残らない", () => {
    expect(BROADCAST_TEMPLATES.length).toBe(15);
    for (const t of BROADCAST_TEMPLATES) {
      expect(closedLinks(t.text), t.id).toEqual([]);
      expect(t.text, t.id).toBe(t.text.trimEnd());
      expect(withBroadcastSiteLink(t.text, false), t.id).toBe(t.text);
    }
  });
  it("開店時は master の本文と同じ（本文 + 空行 + https://elxea.com/ja）", () => {
    const spring = BROADCAST_TEMPLATES.find((t) => t.id === "serenity-spring-01");
    const sensoryAll = BROADCAST_TEMPLATES.find((t) => t.id === "sensory-all-01");
    expect(withBroadcastSiteLink(spring!.text, true)).toBe(
      "桜の季節ですね。\n\n温かいお茶を片手に、窓の外をぼんやり眺める時間も悪くないですよ。\n\nhttps://elxea.com/ja",
    );
    expect(withBroadcastSiteLink(sensoryAll!.text, true)).toBe(
      "お茶の味わいは「甘み・渋み・苦み・旨味」のバランスで決まります。\n\n今の気分にぴったりの一杯、見つけてみませんか。\n\nhttps://elxea.com/ja",
    );
    for (const t of BROADCAST_TEMPLATES) {
      expect(withBroadcastSiteLink(t.text, true).endsWith("\n\nhttps://elxea.com/ja"), t.id).toBe(true);
    }
  });
});

describe("話しかけの返事（閉店中は閉じたリンクが 1 つも返らない・開店時は今の動き）", () => {
  type Case = { name: string; resolution: LinkageResolution; marche: boolean; sales: boolean; expected: string };
  const subscriptionCases: Case[] = [
    { name: "定期便利用者（連携済み）", resolution: LINKED_SUB, marche: false, sales: false, expected: V2_C9 },
    { name: "未連携・売り込み面 OFF（既定）", resolution: UNLINKED, marche: false, sales: false, expected: V2_C11 },
    { name: "連携済み非定期便・売り込み面 OFF", resolution: LINKED_NON_SUB, marche: false, sales: false, expected: V2_C11 },
    { name: "未連携・売り込み面 ON（ボタンなし）", resolution: UNLINKED, marche: false, sales: true, expected: V2_C10 },
    { name: "連携済み非定期便・売り込み面 ON", resolution: LINKED_NON_SUB, marche: false, sales: true, expected: V2_C10 },
  ];
  for (const c of subscriptionCases) {
    it(`「定期便について知りたい」${c.name} → 1 通だけ・連携ボタンなし`, async () => {
      const cap = captureResponder();
      let marcheAsked = 0;
      const handled = await handleMenuActionFlow(
        synthLineUserId("d2as"),
        SUBSCRIPTION_TRIGGER,
        envWith({ ...ENV_WITH_LINK_URLS, SALES_SURFACE_ENABLED: c.sales ? "true" : undefined } as Partial<Env>),
        cap.responder,
        { siteOpen: false, resolveLinkage: async () => c.resolution, isMarcheSource: async () => { marcheAsked++; return c.marche; } },
      );
      expect(handled).toBe(true);
      expect(cap.texts.map((t) => t.text)).toEqual([c.expected]);
      expect(cap.flexes.length, "連携ボタン（Flex）を出さない").toBe(0);
      expect(marcheAsked, "ファネルの分岐に入らない").toBe(0);
      expect(closedLinks(cap.texts)).toEqual([]);
    });
  }

  it("「定期便について知りたい」開店時・売り込み面 OFF は master の文のまま", async () => {
    const cap = captureResponder();
    await handleMenuActionFlow(synthLineUserId("d2so"), SUBSCRIPTION_TRIGGER, ENV_NO_LINK_URLS, cap.responder, {
      siteOpen: true,
      resolveLinkage: async () => UNLINKED,
    });
    expect(cap.texts.map((t) => t.text)).toEqual([MASTER_C11]);
    const cap2 = captureResponder();
    await handleMenuActionFlow(synthLineUserId("d2so2"), SUBSCRIPTION_TRIGGER, ENV_NO_LINK_URLS, cap2.responder, {
      siteOpen: true,
      resolveLinkage: async () => LINKED_SUB,
    });
    expect(cap2.texts.map((t) => t.text)).toEqual([MASTER_C9]);
  });

  it("「elxeaについて教えて」閉店中 → C-12（案内の行なし）/ 開店時 → master の文", async () => {
    const closed = captureResponder();
    await handleMenuActionFlow(synthLineUserId("d2aa"), ABOUT_TRIGGER, ENV_NO_LINK_URLS, closed.responder, { siteOpen: false });
    expect(closed.texts.map((t) => t.text)).toEqual([V2_C12]);
    expect(closedLinks(closed.texts)).toEqual([]);
    const open = captureResponder();
    await handleMenuActionFlow(synthLineUserId("d2ao"), ABOUT_TRIGGER, ENV_NO_LINK_URLS, open.responder, { siteOpen: true });
    expect(open.texts.map((t) => t.text)).toEqual([MASTER_C12]);
  });

  type LinkCase = { name: string; resolution: LinkageResolution; marche: boolean; expected: string };
  const linkageCases: LinkCase[] = [
    { name: "未連携", resolution: UNLINKED, marche: false, expected: V2_C13 },
    { name: "未連携のマルシェ客（今の文のまま）", resolution: UNLINKED, marche: true, expected: MARCHE_LINKAGE_SOFT_ACK },
    { name: "連携済みで定期便（今の文のまま）", resolution: LINKED_SUB, marche: false, expected: SUBSCRIBER_LINKED_BODY },
    { name: "連携済みで定期便でない", resolution: LINKED_NON_SUB, marche: false, expected: V2_C14 },
  ];
  for (const c of linkageCases) {
    it(`「アカウントを連携する」${c.name} → 1 通だけ・連携の URL が設定されていてもボタンなし`, async () => {
      const cap = captureResponder();
      const handled = await handleLinkageFlow(synthLineUserId("d2al"), LINKAGE_TRIGGER, ENV_WITH_LINK_URLS, cap.responder, {
        siteOpen: false,
        resolveLinkage: async () => c.resolution,
        isMarcheSource: async () => c.marche,
      });
      expect(handled).toBe(true);
      expect(cap.texts.map((t) => t.text)).toEqual([c.expected]);
      expect(cap.flexes.length, "連携ボタン（Flex）を出さない").toBe(0);
      expect(closedLinks(cap.texts)).toEqual([]);
    });
  }

  it("「アカウントを連携する」開店時・未連携・連携の URL なし → master の案内文（マイページの URL つき）", async () => {
    const cap = captureResponder();
    await handleLinkageFlow(synthLineUserId("d2alo"), LINKAGE_TRIGGER, ENV_NO_LINK_URLS, cap.responder, {
      siteOpen: true,
      resolveLinkage: async () => UNLINKED,
      isMarcheSource: async () => false,
    });
    expect(cap.texts.map((t) => t.text)).toEqual([`${MASTER_LINKAGE_INVITE_BODY}\nhttps://elxea.com/ja`]);
    expect(selectLinkageMessage(LINKED_NON_SUB, true)).toBe(`${MASTER_NON_SUBSCRIBER_DECLINE_BODY}\nhttps://elxea.com/ja/subscription`);
  });

  it("開店時は連携の URL があれば今までどおり連携ボタン（Flex）を出す（「アカウントを連携する」/ 定期便・売り込み面 ON の未連携）", async () => {
    const envLiff = envWith({ LIFF_LINKAGE_URL: "https://liff.line.me/0000000000-test", ACCOUNT_LINK_ENTRY_URL: undefined } as Partial<Env>);
    const link = captureResponder();
    await handleLinkageFlow(synthLineUserId("d2alb"), LINKAGE_TRIGGER, envLiff, link.responder, {
      siteOpen: true,
      resolveLinkage: async () => UNLINKED,
      isMarcheSource: async () => false,
    });
    expect(link.flexes.length).toBe(1);
    expect(JSON.stringify(link.flexes[0])).toContain("liff.line.me/0000000000-test");
    expect(link.texts.length).toBe(0);

    const menu = captureResponder();
    await handleMenuActionFlow(
      synthLineUserId("d2amb"),
      SUBSCRIPTION_TRIGGER,
      envWith({ ...envLiff, SALES_SURFACE_ENABLED: "true" } as Partial<Env>),
      menu.responder,
      { siteOpen: true, resolveLinkage: async () => UNLINKED, isMarcheSource: async () => false },
    );
    expect(menu.texts.map((t) => t.text)).toEqual([MASTER_C10]);
    expect(menu.flexes.length).toBe(1);
  });

  it("「連携を解除する」は閉店中も今までどおり効く（閉店の分岐より前）", async () => {
    const cap = captureResponder();
    let cleared = 0;
    let resolved = 0;
    const handled = await handleLinkageFlow(synthLineUserId("d2au"), ACCOUNT_LINK_UNLINK_TRIGGER, ENV_WITH_LINK_URLS, cap.responder, {
      siteOpen: false,
      resolveLinkage: async () => { resolved++; return LINKED_SUB; },
      supabase: {} as never,
      clearLinkage: (async () => { cleared++; return { ok: true, cleared: false }; }) as never,
    });
    expect(handled).toBe(true);
    expect(cleared, "解除の処理を呼ぶ").toBe(1);
    expect(resolved, "連携状態の分岐には入らない").toBe(0);
    expect(cap.texts.map((t) => t.text)).toEqual([ACCOUNT_LINK_NOT_LINKED_BODY]);
  });

  for (const trigger of [READING_TRIGGER, READING_TRIGGER_ALT]) {
    it(`「${trigger}」閉店中 → C-22 の 1 通だけ（カード・ボタン・quick reply なし・記事を読みに行かない）`, async () => {
      const cap = captureResponder();
      let loaded = 0;
      const handled = await handleJournalFlow(synthLineUserId("d2aj"), trigger, env as unknown as Env, cap.responder, {
        siteOpen: false,
        loadKarte: async () => { loaded++; return { persona: null }; },
        loadArticles: async () => { loaded++; return []; },
      });
      expect(handled).toBe(true);
      expect(cap.texts.map((t) => t.text)).toEqual([V2_C22]);
      expect(cap.texts[0].quickReplies).toBeUndefined();
      expect(cap.flexes.length).toBe(0);
      expect(loaded, "カルテも記事も読まない").toBe(0);
    });
  }
});
