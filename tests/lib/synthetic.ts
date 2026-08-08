/**
 * 合成ユーザー・合成イベントの生成（設計 §1-d「合成ユーザー＋ゼロ送信」パターン）。
 *
 * 実在ユーザーの ID は絶対に使わない。U + 32hex ちょうど・予約帯マーカー "e2e" 始まりで、
 * 実在の LINE userId 空間と衝突しない合成 ID を作る（ハーメティックなので DB にも残らない）。
 */

/** 予約帯マーカー（hex のみ）。実在 ID との衝突と誤爆を避ける。 */
const RESERVED_MARKER = "e2e";

/**
 * U + 32hex ちょうどの合成 LINE userId を作る（予約帯・非実在）。
 * @param tag テストケース識別用の短い hex 断片（英数字を hex へ丸める）。
 */
export function synthLineUserId(tag: string): string {
  const cleanedTag = tag.toLowerCase().replace(/[^0-9a-f]/g, "");
  const hex = (RESERVED_MARKER + cleanedTag + "0".repeat(32)).slice(0, 32);
  const id = "U" + hex;
  if (!/^U[0-9a-f]{32}$/.test(id)) {
    throw new Error(`synthLineUserId: 生成 ID の形式が不正: ${id}`);
  }
  return id;
}

/** 一意な webhookEventId（冪等性テーブル processed_events のキー）。 */
export function synthWebhookEventId(): string {
  return `e2e-wh-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/** 合成 replyToken（全ゼロ・実返信は LINE 側で失敗＝誰にも届かない。ここではモックが捕捉する）。 */
export const SYNTH_REPLY_TOKEN = "0".repeat(32);

/**
 * LINE メッセージイベント（text）を 1 件組む。
 * webhookEventId / deliveryContext を必ず含める（processEvents が参照するため）。
 */
export function messageEvent(
  userId: string,
  text: string,
  idx = 0,
): Record<string, unknown> {
  const now = Date.now();
  return {
    type: "message",
    mode: "active",
    timestamp: now,
    source: { type: "user", userId },
    replyToken: SYNTH_REPLY_TOKEN,
    message: { type: "text", id: `e2e-msg-${now}-${idx}`, text },
    webhookEventId: synthWebhookEventId(),
    deliveryContext: { isRedelivery: false },
  };
}

/**
 * LINE postback イベントを 1 件組む。
 *
 * 1タップのボタンのうち、**内部の記号を運ぶもの**（roji のアンケート）は postback で作る
 * （message で作ると記号が本人の吹き出しに出てしまうため）。`data` は画面に出ない。
 */
export function postbackEvent(
  userId: string,
  data: string,
  idx = 0,
): Record<string, unknown> {
  const now = Date.now();
  return {
    type: "postback",
    mode: "active",
    timestamp: now + idx,
    source: { type: "user", userId },
    replyToken: SYNTH_REPLY_TOKEN,
    postback: { data },
    webhookEventId: synthWebhookEventId(),
    deliveryContext: { isRedelivery: false },
  };
}

/**
 * LINE フォローイベント（友だち追加）を 1 件組む。
 * QR 同梱物経由のオンボーディング（handleFollowEvent）を webhook 経路で駆動するために使う。
 * ref（pkg_{slug}）自体は follow event に載らない（LINE 仕様）ため、QR は pending_follow_refs へ
 *   seed して再現する（getPendingFollowRef が読む）。ここでは純粋に follow イベント本体を組む。
 */
export function followEvent(userId: string): Record<string, unknown> {
  const now = Date.now();
  return {
    type: "follow",
    mode: "active",
    timestamp: now,
    source: { type: "user", userId },
    replyToken: SYNTH_REPLY_TOKEN,
    follow: { isUnblocked: false },
    webhookEventId: synthWebhookEventId(),
    deliveryContext: { isRedelivery: false },
  };
}
