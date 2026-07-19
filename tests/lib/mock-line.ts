/**
 * LINE 送信モック（設計 §2-2 / §2-5「LINE 送信 fetch をモックして返答ペイロードを捕捉」）。
 *
 * 本番コードの reply/push は素の fetch("https://api.line.me/v2/bot/message/{reply,push}") を叩く。
 * ここではその宛先を横取りして 200 を返し、送信されるはずだった messages（text / flex / quickReply）を
 * 捕捉する。api.line.me を実際に呼ばない＝外部送信ゼロ。捕捉した内容を assert して「目視の自動判定化」。
 */

/** 捕捉した 1 回の送信。 */
export interface CapturedLineSend {
  kind: "reply" | "push" | "other";
  /** reply の場合の replyToken。 */
  replyToken?: string;
  /** push の場合の宛先 userId。 */
  to?: string;
  /** 送信 message object 群（type: "text" | "flex" ...）。 */
  messages: Array<Record<string, unknown>>;
}

export interface LineCapture {
  sends: CapturedLineSend[];
  handle(url: string, init?: RequestInit): Promise<Response>;
  /** 捕捉した全 text message の text を配列で返す。 */
  texts(): string[];
  /** 捕捉した全 flex message を配列で返す。 */
  flexes(): Array<Record<string, unknown>>;
  /** 全 message を平坦化して返す。 */
  allMessages(): Array<Record<string, unknown>>;
}

/** LINE 送信キャプチャを作る。 */
export function createLineCapture(): LineCapture {
  const sends: CapturedLineSend[] = [];

  async function handle(url: string, init?: RequestInit): Promise<Response> {
    let body: Record<string, unknown> = {};
    try {
      body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    const messages = Array.isArray(body.messages)
      ? (body.messages as Array<Record<string, unknown>>)
      : [];

    if (url.includes("/message/reply")) {
      sends.push({ kind: "reply", replyToken: body.replyToken as string | undefined, messages });
    } else if (url.includes("/message/push")) {
      sends.push({ kind: "push", to: body.to as string | undefined, messages });
    } else {
      // Content API 等（本フローでは未使用）。呼ばれても 200 空で返す。
      sends.push({ kind: "other", messages });
    }

    // 常に 200（reply 成功 → 呼び出し側は push フォールバックしない）。
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  return {
    sends,
    handle,
    allMessages() {
      return sends.flatMap((s) => s.messages);
    },
    texts() {
      return sends
        .flatMap((s) => s.messages)
        .filter((m) => m.type === "text")
        .map((m) => String((m as { text?: unknown }).text ?? ""));
    },
    flexes() {
      return sends.flatMap((s) => s.messages).filter((m) => m.type === "flex");
    },
  };
}
