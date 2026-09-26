/**
 * 送る関所 — 閉店中、お客さんに届く返事と保存される記録から「閉じたサイトへのリンク」を外す。
 *
 * 設計: 実装設計 rev2 第5章「AIの返事と配信の歯止め (送る関所)」
 *   https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 *
 * 関所は 4 つ (どれも閉店中だけ働く。開店中 = EC_SITE_OPEN が true のときは何も変えない):
 *   1. LINE の送信   — src/lib/line.ts の createResponder().text / .flex と pushTextMessage / pushFlexMessage
 *                      (gateLineMessages)
 *   2. 保存           — src/lib/supabase.ts saveMessage の role=assistant (gateText)
 *   3. AI の出口      — src/agent/core.ts runAgent / runAgentStreaming の返す値と逐次送信のコールバック
 *                      (gateAgentResult / gateStreamCallbacks)
 *   4. 履歴           — src/agent/core.ts buildHistoryMessages の AI の過去の発言 (gateText)
 *   + 配信の送信前検査 — src/lib/delivery-send-one.ts (hasClosedLink で検査し、書き換えずに止める)
 *
 * どの経路がどの関所で覆われるか (設計 第5章の対応表をコードに残す):
 *
 *   | 経路                                              | AIの出口 | LINEの送信 | 保存 | 履歴 |
 *   |---------------------------------------------------|----------|------------|------|------|
 *   | LINE の文字の返事 (routes/line.ts runAgent → text) |    o     |     o      |  o   |  o   |
 *   | LINE の画像の返事 (routes/line.ts 画像 → runAgent) |    o     |     o      |  o   |  o   |
 *   | AI が出す Flex (routes/line.ts responder.flex)     |    o     |     o      |  -   |  -   |
 *   | web の逐次送信 (routes/web.ts runAgentStreaming)   | o 持越し |     -      |  o   |  o   |
 *   | web の画像 (routes/web.ts 画像 → runAgent)         |    o     |     -      |  o   |  o   |
 *   | 声 (routes/clm.ts runAgentStreaming)               |    o     |     -      |  -   |  o   |
 *   | 決まった文の返信 (お茶カード・診断・定期便 など)    |    -     | o (消す数0) |  -   |  -   |
 *   | 呼び出し元の無い送信 (pushTextMessage / pushFlex)  |    -     |     o      |  -   |  -   |
 *   | Notion 本文の配信 (delivery-send-one.ts)           |    -     | - (送信前検査で止める) | - | - |
 *   | 自前 push (dormant-reengagement.ts / marche-activation.ts の fetch 直叩き) |
 *   |                                                   |    -     | - (関所の外。D2c のテストで扱う) | - | - |
 *
 * 判断 (設計 第5章): 置き換えではなく消す。閉じたリンクには定期便・体験記録も含まれ、Amazon に
 * 置き換えると「Amazon を定期便の代わりにしない」と食い違うため。購入の案内は AI 自身が
 * プロンプト (C-4・C-6) に従って Amazon の URL を出す。
 *
 * ログ: どの関所で (gate)・どの呼び出し元で (caller)・何本消したか (removed) を 1 行の JSON で出す。
 * 本文は出さない。消した結果が空になった本文は送らず・保存せず、`emptied: true` の warn を必ず出す
 * (設計 QA 3 回目 m4)。決まった文の経路では消す数は 0 のはずなので、ログが出たら文の対の実装漏れの合図。
 */

import { EC_SITE_OPEN, collectLinks, isClosedSiteLink, stripClosedLinks } from "./storefront";

/** 関所の名前 (ログの gate)。 */
export type ClosedLinkGateName = "line_send" | "save" | "agent_exit" | "history" | "delivery";

/** 関所のログ (本文は出さない)。 */
export function logClosedLinkGate(entry: {
  gate: ClosedLinkGateName;
  caller: string;
  removed?: number;
  dropped?: number;
  emptied?: boolean;
}): void {
  console.warn(`[closed-link-gate] ${JSON.stringify(entry)}`);
}

/** メッセージ (文字列・LINE メッセージ・Flex・その配列) に閉じたリンクが 1 本でもあるか。 */
export function hasClosedLink(message: unknown, siteOpen: boolean = EC_SITE_OPEN): boolean {
  if (siteOpen) return false;
  return collectLinks(message).some((link) => isClosedSiteLink(link, false));
}

/** 本文の関所の結果。emptied = 消した結果、本文が空 (空白だけ) になった。 */
export interface GatedText {
  text: string;
  removed: number;
  emptied: boolean;
}

/**
 * 本文の関所: 閉じたリンクを消す。消したらログを出す。消した結果が空になったら `emptied` を立てて warn する。
 * 消した数が 0 のときは入力とまったく同じ文字列を返す。
 */
export function gateText(
  text: string,
  gate: ClosedLinkGateName,
  caller: string,
  siteOpen: boolean = EC_SITE_OPEN,
): GatedText {
  const r = stripClosedLinks(text, siteOpen);
  if (r.removed === 0) return { text, removed: 0, emptied: false };
  const emptied = r.text.trim() === "";
  logClosedLinkGate({ gate, caller, removed: r.removed, ...(emptied ? { emptied: true } : {}) });
  return { text: r.text, removed: r.removed, emptied };
}

/** quickReply の item のうち、閉じたリンクを含むものを外す (外した数も返す)。 */
function gateQuickReply(message: Record<string, unknown>): { message: Record<string, unknown>; dropped: number } {
  const qr = message.quickReply as { items?: unknown[] } | undefined;
  if (!qr || !Array.isArray(qr.items)) return { message, dropped: 0 };
  const items = qr.items.filter((item) => !hasClosedLink(item, false));
  const dropped = qr.items.length - items.length;
  if (dropped === 0) return { message, dropped: 0 };
  const next: Record<string, unknown> = { ...message };
  if (items.length > 0) next.quickReply = { ...qr, items };
  else delete next.quickReply;
  return { message: next, dropped };
}

/**
 * 関所 1 (LINE の送信): 送るメッセージ列を検査する。
 * - text: 本文の閉じたリンクを消す。消した結果が空なら、そのメッセージは送らない (emptied の warn)。
 *   quickReply の item に閉じたリンクがあれば、その item を外す。
 * - それ以外 (flex など): collectLinks で全 uri・altText を調べ、閉じたリンクがあればそのメッセージを送らない。
 * 開店中は入力をそのまま返す。
 */
export function gateLineMessages(
  messages: Array<Record<string, unknown>>,
  caller: string,
  siteOpen: boolean = EC_SITE_OPEN,
): Array<Record<string, unknown>> {
  if (siteOpen) return messages;
  const out: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    if (msg.type === "text" && typeof msg.text === "string") {
      const g = gateText(msg.text, "line_send", caller, false);
      if (g.emptied) continue;
      const withText = g.removed > 0 ? { ...msg, text: g.text } : msg;
      const q = gateQuickReply(withText);
      if (q.dropped > 0) logClosedLinkGate({ gate: "line_send", caller: `${caller}.quickReply`, dropped: q.dropped });
      out.push(q.message);
      continue;
    }
    if (hasClosedLink(msg, false)) {
      logClosedLinkGate({ gate: "line_send", caller: `${caller}.${String(msg.type)}`, dropped: 1 });
      continue;
    }
    out.push(msg);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 関所 3 (AI の出口)
// ---------------------------------------------------------------------------

/** AI の返事に付いてくるもの (runAgent の結果・runAgentStreaming の meta に共通の形)。 */
export interface AgentExtras {
  flexMessages?: Array<{ altText: string; contents: Record<string, unknown> }>;
  productCards?: Array<{ productUrl: string; description: string }>;
  cartLink?: { checkoutUrl: string };
  quickReplies?: Array<{ label: string; text: string }>;
}

/**
 * AI の返事に付いてくるもの (Flex・商品カード・カートリンク・クイックリプライ) から、閉じたリンク入りを外す。
 * 外すだけで書き換えない。開店中は入力をそのまま返す。
 */
export function gateAgentExtras<T extends AgentExtras>(
  result: T,
  caller: string,
  siteOpen: boolean = EC_SITE_OPEN,
): T {
  if (siteOpen) return result;
  // 外すだけで要素の形は変えないので、作業中は共通の形で扱い、最後に元の型に戻す。
  const next: AgentExtras = { ...result };
  let dropped = 0;
  if (result.flexMessages) {
    const kept = result.flexMessages.filter((f) => !hasClosedLink(f, false));
    dropped += result.flexMessages.length - kept.length;
    next.flexMessages = kept;
  }
  if (result.productCards) {
    const kept = result.productCards.filter((p) => !hasClosedLink({ uri: p.productUrl, description: p.description }, false));
    dropped += result.productCards.length - kept.length;
    next.productCards = kept;
  }
  if (result.cartLink && isClosedSiteLink(result.cartLink.checkoutUrl, false)) {
    dropped += 1;
    delete next.cartLink;
  }
  if (result.quickReplies) {
    const kept = result.quickReplies.filter((q) => !hasClosedLink(q, false));
    dropped += result.quickReplies.length - kept.length;
    next.quickReplies = kept;
  }
  if (dropped > 0) logClosedLinkGate({ gate: "agent_exit", caller, dropped });
  return next as T;
}

/**
 * runAgent の結果の関所: 返事の本文から閉じたリンクを消し、付いてくるものから閉じたリンク入りを外す。
 * 本文が空になっても結果の形は変えない (送る側の LINE の関所・保存の関所が空の本文を落とす)。
 */
export function gateAgentResult<T extends AgentExtras & { response: string }>(
  result: T,
  caller: string,
  siteOpen: boolean = EC_SITE_OPEN,
): T {
  if (siteOpen) return result;
  const g = gateText(result.response, "agent_exit", caller, false);
  const next = gateAgentExtras(result, caller, false);
  return g.removed > 0 ? { ...next, response: g.text } : next;
}

/** URL に使える文字 (設計 第5章: 英数字と `./:_-%?=&#~+@`)。逐次送信で末尾に続く部分だけを持ち越す。 */
const URL_CARRY_CHAR_RE = /[A-Za-z0-9./:_\-%?=&#~+@]/;
/** URL の文字の直前にあれば一緒に持ち越すもの (行内の空白と開き括弧。日本語の本文は含まない)。 */
const URL_CARRY_PREFIX_RE = /[ \t　（(]/;

/** 逐次送信の文字の関所。push で断片を受け、閉じたリンクを消してから emit に渡す。 */
export interface StreamingTextGate {
  /** 断片を受け取る。末尾の「URL に使える文字が続く部分」だけを次の断片まで持ち越す。 */
  push(delta: string): void;
  /** 持ち越した分を出し切る (ほかのイベントの前・終わり・エラー時に呼ぶ)。 */
  flush(): void;
  /** これまでに消した数。 */
  readonly removed: number;
  /** 受け取った本文があり、消した結果 1 文字も出さなかったか。 */
  readonly emptied: boolean;
}

/**
 * 逐次送信の文字の関所を作る。
 * 断片をまたぐ URL (`https://elx` + `ea.com/ja`) も消せるように、末尾に続く URL の文字だけを持ち越す。
 * 日本語の本文は URL の文字ではないので持ち越さない (出すのを遅らせない)。開店中は断片をそのまま渡す。
 */
export function createStreamingTextGate(
  emit: (text: string) => void,
  siteOpen: boolean = EC_SITE_OPEN,
): StreamingTextGate {
  let carry = "";
  let removed = 0;
  let received = false;
  let emitted = false;
  const out = (s: string): void => {
    if (s === "") return;
    const r = stripClosedLinks(s, false);
    removed += r.removed;
    if (r.text !== "") {
      if (r.text.trim() !== "") emitted = true;
      emit(r.text);
    }
  };
  return {
    push(delta: string): void {
      if (siteOpen) {
        emit(delta);
        return;
      }
      if (delta.trim() !== "") received = true;
      const buf = carry + delta;
      let cut = buf.length;
      while (cut > 0 && URL_CARRY_CHAR_RE.test(buf[cut - 1])) cut--;
      // URL の文字を持ち越すときだけ、その直前の行内の空白と開き括弧も一緒に持ち越す
      // (消すときに「前の空白・リンクだけを囲む括弧」ごと消せるように。stripClosedLinks の後始末と同じ結果にする)。
      if (cut < buf.length) {
        while (cut > 0 && URL_CARRY_PREFIX_RE.test(buf[cut - 1])) cut--;
      }
      carry = buf.slice(cut);
      out(buf.slice(0, cut));
    },
    flush(): void {
      if (siteOpen) return;
      const rest = carry;
      carry = "";
      out(rest);
    },
    get removed(): number {
      return removed;
    },
    get emptied(): boolean {
      return received && removed > 0 && !emitted;
    },
  };
}

/** 逐次送信のコールバック (src/agent/core.ts の StreamCallbacks と同じ形)。 */
export interface GateableStreamCallbacks {
  onTextDelta: (text: string) => void;
  onProductCards: (products: Array<{ name: string; price: string; url: string; image: string | null; description: string }>) => void;
  onCartLink: (checkoutUrl: string) => void;
  onQuickReplies: (items: Array<{ label: string; text: string }>) => void;
  onDone: (fullResponse: string) => void;
  onError: (error: string) => void;
}

/**
 * 逐次送信のコールバックを包む (設計 第5章 + 設計 QA 3 回目 m3)。
 * - onTextDelta: 持ち越しつきで閉じたリンクを消す
 * - onProductCards / onCartLink / onQuickReplies: 閉じたリンク入りを外す (持ち越した文字を先に出して順序を保つ)
 * - onDone: 持ち越しを出し切り、保存用の全文からも閉じたリンクを消す
 * - onError: 持ち越しを出し切ってから渡す
 * `finish()` は runAgentStreaming が戻るときに呼ぶ (持ち越しの出し切りとログ。二度呼んでもよい)。
 * 開店中は入力のコールバックをそのまま返す。
 */
export function gateStreamCallbacks(
  callbacks: GateableStreamCallbacks,
  caller: string,
  siteOpen: boolean = EC_SITE_OPEN,
): { callbacks: GateableStreamCallbacks; finish: () => void } {
  if (siteOpen) return { callbacks, finish: () => {} };
  const text = createStreamingTextGate((s) => callbacks.onTextDelta(s), false);
  let logged = false;
  const finish = (): void => {
    text.flush();
    if (logged) return;
    if (text.removed > 0) {
      logged = true;
      logClosedLinkGate({ gate: "agent_exit", caller: `${caller}.stream`, removed: text.removed, ...(text.emptied ? { emptied: true } : {}) });
    }
  };
  const wrapped: GateableStreamCallbacks = {
    onTextDelta: (delta: string) => text.push(delta),
    onProductCards: (products) => {
      text.flush();
      const kept = products.filter((p) => !hasClosedLink({ uri: p.url, description: p.description }, false));
      if (kept.length < products.length) {
        logClosedLinkGate({ gate: "agent_exit", caller: `${caller}.productCards`, dropped: products.length - kept.length });
      }
      if (kept.length > 0) callbacks.onProductCards(kept);
    },
    onCartLink: (checkoutUrl: string) => {
      text.flush();
      if (isClosedSiteLink(checkoutUrl, false)) {
        logClosedLinkGate({ gate: "agent_exit", caller: `${caller}.cartLink`, dropped: 1 });
        return;
      }
      callbacks.onCartLink(checkoutUrl);
    },
    onQuickReplies: (items) => {
      text.flush();
      const kept = items.filter((q) => !hasClosedLink(q, false));
      if (kept.length < items.length) {
        logClosedLinkGate({ gate: "agent_exit", caller: `${caller}.quickReplies`, dropped: items.length - kept.length });
      }
      callbacks.onQuickReplies(kept);
    },
    onDone: (fullResponse: string) => {
      finish();
      callbacks.onDone(gateText(fullResponse, "agent_exit", `${caller}.done`, false).text);
    },
    onError: (error: string) => {
      finish();
      callbacks.onError(error);
    },
  };
  return { callbacks: wrapped, finish };
}
