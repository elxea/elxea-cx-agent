import type { Context } from "hono";
import type { Env } from "../index";
import { runAgent } from "../agent/core";
import { createEmbedding } from "../lib/embedding";
import {
  verifyLineSignature,
  pushTextMessage,
  pushFlexMessage,
  type LineWebhookBody,
  type QuickReplyItem,
} from "../lib/line";
import {
  createSupabaseClient,
  saveMessage,
  getRecentMessages,
  getCrossChannelMessages,
} from "../lib/supabase";
import { resolveUnifiedUserId } from "../lib/identity";
import { recordResponseTime, recordApiError, sendNegativeFeedbackAlert } from "../lib/alerts";

/** 入力テキストの最大文字数（Embedding + Claude 入力の上限考慮） */
const MAX_MESSAGE_LENGTH = 2000;

/** フィードバック Quick Reply のトリガーテキスト */
const FEEDBACK_POSITIVE_TEXT = "feedback:positive";
const FEEDBACK_NEGATIVE_TEXT = "feedback:negative";

/** フィードバック待ちユーザーのコメント収集状態（インメモリ） */
const pendingFeedbackComments = new Map<string, { messageContent: string; expiresAt: number }>();

/** コメント待ちの有効期限（5分） */
const FEEDBACK_COMMENT_TTL_MS = 5 * 60 * 1000;

/**
 * LINE Webhook ハンドラー。
 *
 * 1. 署名検証
 * 2. 即時 200 OK を返却
 * 3. waitUntil() でバックグラウンド処理
 */
export async function lineWebhook(c: Context<{ Bindings: Env }>) {
  const body = await c.req.text();
  const signature = c.req.header("x-line-signature") ?? "";

  // 署名検証
  const isValid = await verifyLineSignature(
    body,
    signature,
    c.env.LINE_CHANNEL_SECRET,
  );
  if (!isValid) {
    return c.json({ error: "Invalid signature" }, 403);
  }

  const webhookBody: LineWebhookBody = JSON.parse(body);

  // 即時 200 OK を返しつつ、バックグラウンドで処理
  c.executionCtx.waitUntil(processEvents(webhookBody, c.env));

  return c.json({ status: "ok" });
}

/** イベントをバックグラウンドで処理 */
async function processEvents(
  webhookBody: LineWebhookBody,
  env: Env,
): Promise<void> {
  const supabase = createSupabaseClient(env);

  for (const event of webhookBody.events) {
    // 再送の場合はスキップ（べき等性 — deliveryContext チェック）
    if (event.deliveryContext.isRedelivery) {
      console.log(`Skipping redelivered event: ${event.webhookEventId}`);
      continue;
    }

    // イベント ID でべき等性チェック（processed_events テーブル）
    const { data: existing } = await supabase
      .from("processed_events")
      .select("webhook_event_id")
      .eq("webhook_event_id", event.webhookEventId)
      .single();

    if (existing) {
      console.log(`Already processed event: ${event.webhookEventId}`);
      continue;
    }

    // 処理済みとして記録
    await supabase
      .from("processed_events")
      .insert({ webhook_event_id: event.webhookEventId })
      .then(({ error }) => {
        if (error) console.error("Failed to record processed event:", error);
      });

    const lineUserId = event.source.userId;
    if (!lineUserId) continue;

    // メッセージイベントの処理
    if (event.type === "message" && event.message) {
      try {
        const lineStart = Date.now();
        await handleMessage(lineUserId, event.message, env);
        recordResponseTime(env, Date.now() - lineStart);
      } catch (error) {
        console.error("Error processing message:", error);
        recordApiError(env, error instanceof Error ? error.message : String(error));
        await pushTextMessage(
          lineUserId,
          "申し訳ありません、一時的にエラーが発生しました。しばらくしてからもう一度お試しください。",
          env,
        ).catch(console.error);
      }
    }
    // フォローイベント（友だち追加時のウェルカムメッセージ）
    if (event.type === "follow") {
      try {
        await handleFollowEvent(lineUserId, env);
      } catch (error) {
        console.error("Error processing follow event:", error);
      }
    }

    // アンフォローイベントは現時点ではログのみ
    if (event.type === "unfollow") {
      console.log(`User unfollowed: ${lineUserId}`);
    }
  }
}

/** メッセージタイプに応じて処理を分岐 */
async function handleMessage(
  lineUserId: string,
  message: { type: string; id: string; text?: string },
  env: Env,
): Promise<void> {
  switch (message.type) {
    case "text":
      await handleTextMessage(lineUserId, message.text ?? "", env);
      break;

    case "sticker":
      await pushTextMessage(
        lineUserId,
        "スタンプありがとうございます！何かご質問がありましたら、テキストでお気軽にどうぞ。",
        env,
      );
      break;

    case "image":
    case "video":
    case "audio":
    case "file":
      await pushTextMessage(
        lineUserId,
        "現在、テキストメッセージのみ対応しております。お手数ですが、テキストでお問い合わせください。",
        env,
      );
      break;

    case "location":
      await pushTextMessage(
        lineUserId,
        "位置情報ありがとうございます。何かご質問がありましたら、テキストでお気軽にどうぞ。",
        env,
      );
      break;

    default:
      // 未知のメッセージタイプは無視
      console.log(`Unsupported message type: ${message.type}`);
  }
}

/**
 * フォローイベント（友だち追加）のハンドラー。
 * ウェルカムメッセージ + Quick Reply で初回案内。
 */
async function handleFollowEvent(
  lineUserId: string,
  env: Env,
): Promise<void> {
  const welcomeText =
    "こんにちは！elxea（エルシア）へようこそ。\n\n" +
    "鹿児島の生産者から届くお茶やスキンケアについて、何でも気軽に聞いてくださいね。\n\n" +
    "商品のこと、注文のこと、おすすめが知りたいときなど、お気軽にどうぞ。";

  const quickReplyItems: QuickReplyItem[] = [
    {
      type: "action",
      action: { type: "message", label: "商品を探す", text: "おすすめの商品を教えてください" },
    },
    {
      type: "action",
      action: { type: "message", label: "注文を確認", text: "注文状況を確認したいです" },
    },
    {
      type: "action",
      action: { type: "message", label: "お茶について", text: "どんなお茶がありますか？" },
    },
  ];

  await pushTextMessage(lineUserId, welcomeText, env, quickReplyItems);
}

/**
 * フィードバック Quick Reply アイテムを生成する。
 * エージェント応答の Quick Reply に追加する。
 */
function buildFeedbackQuickReplies(): QuickReplyItem[] {
  return [
    {
      type: "action",
      action: { type: "message", label: "\uD83D\uDC4D よかった", text: FEEDBACK_POSITIVE_TEXT },
    },
    {
      type: "action",
      action: { type: "message", label: "\uD83D\uDC4E 改善希望", text: FEEDBACK_NEGATIVE_TEXT },
    },
  ];
}

/**
 * フィードバックメッセージを処理する。
 * @returns true if the message was a feedback action (handled), false otherwise.
 */
async function handleFeedbackMessage(
  lineUserId: string,
  userMessage: string,
  env: Env,
): Promise<boolean> {
  const supabase = createSupabaseClient(env);

  // コメント待ち状態のチェック（「改善希望」タップ後の次メッセージ）
  const pending = pendingFeedbackComments.get(lineUserId);
  if (pending && Date.now() < pending.expiresAt) {
    // 次メッセージをコメントとして記録
    pendingFeedbackComments.delete(lineUserId);

    const identity = await resolveUnifiedUserId(supabase, lineUserId, "line");

    await supabase.from("message_feedback").insert({
      user_id: identity.unifiedUserId,
      channel: "line",
      message_content: pending.messageContent,
      rating: -1,
      comment: userMessage.trim(),
    });

    // Slack 通知
    await sendNegativeFeedbackAlert(env, identity.unifiedUserId, pending.messageContent, userMessage.trim());

    await pushTextMessage(
      lineUserId,
      "ご意見ありがとうございます。改善に活かしてまいります。",
      env,
    );
    return true;
  }

  // フィードバック Quick Reply のタップ処理
  if (userMessage === FEEDBACK_POSITIVE_TEXT || userMessage === FEEDBACK_NEGATIVE_TEXT) {
    const rating = userMessage === FEEDBACK_POSITIVE_TEXT ? 1 : -1;
    const identity = await resolveUnifiedUserId(supabase, lineUserId, "line");

    // 直近のアシスタントメッセージを取得
    const { data: recentMessages } = await supabase
      .from("conversations")
      .select("content")
      .eq("user_id", lineUserId)
      .eq("channel", "line")
      .eq("role", "assistant")
      .order("created_at", { ascending: false })
      .limit(1);

    const lastAssistantContent = recentMessages?.[0]?.content ?? "";

    await supabase.from("message_feedback").insert({
      user_id: identity.unifiedUserId,
      channel: "line",
      message_content: lastAssistantContent,
      rating,
      comment: null,
    });

    if (rating === 1) {
      await pushTextMessage(
        lineUserId,
        "ありがとうございます！お役に立てて嬉しいです。",
        env,
      );
    } else {
      // コメント待ち状態をセット
      pendingFeedbackComments.set(lineUserId, {
        messageContent: lastAssistantContent,
        expiresAt: Date.now() + FEEDBACK_COMMENT_TTL_MS,
      });
      await pushTextMessage(
        lineUserId,
        "ご意見ありがとうございます。よろしければ、どんな点を改善できるかメッセージで教えてください。",
        env,
      );
    }

    // Slack 通知（ネガティブ時）
    if (rating === -1) {
      await sendNegativeFeedbackAlert(env, identity.unifiedUserId, lastAssistantContent);
    }

    return true;
  }

  // フィードバックメッセージではない
  // コメント待ち状態が期限切れの場合はクリア
  if (pending) {
    pendingFeedbackComments.delete(lineUserId);
  }

  return false;
}

/** テキストメッセージを処理してエージェントに渡す */
async function handleTextMessage(
  lineUserId: string,
  userMessage: string,
  env: Env,
): Promise<void> {
  // 空メッセージをスキップ
  if (!userMessage.trim()) return;

  // フィードバックメッセージの処理（Quick Reply タップ or コメント入力）
  const wasFeedback = await handleFeedbackMessage(lineUserId, userMessage, env);
  if (wasFeedback) return;

  // メッセージ長制限（MS8 8.2）
  let processedMessage = userMessage;
  if (userMessage.length > MAX_MESSAGE_LENGTH) {
    processedMessage = userMessage.slice(0, MAX_MESSAGE_LENGTH);
    console.log(
      `Message truncated: ${userMessage.length} → ${MAX_MESSAGE_LENGTH} chars`,
    );
  }

  const supabase = createSupabaseClient(env);

  // Identity Resolver: unified_user_id を解決
  const identity = await resolveUnifiedUserId(supabase, lineUserId, "line");
  const effectiveUserId = identity.unifiedUserId;

  // メッセージ保存・履歴取得・Embedding 生成を全て並列実行
  // 保存は元の userId (lineUserId) で行い、取得は effectiveUserId で行う
  // 紐付け済みユーザーはクロスチャネルで会話を取得
  const [, history, embedding] = await Promise.all([
    saveMessage(supabase, {
      userId: lineUserId,
      channel: "line",
      role: "user",
      content: processedMessage,
    }),
    identity.isLinked
      ? getCrossChannelMessages(supabase, effectiveUserId)
      : getRecentMessages(supabase, effectiveUserId, "line"),
    createEmbedding(processedMessage, env),
  ]);

  // エージェント実行（effectiveUserId を渡す、紐付け状態も伝達）
  const result = await runAgent(
    processedMessage,
    history,
    embedding,
    effectiveUserId,
    "line",
    env,
    { isLinked: identity.isLinked },
  );

  // Quick Reply を LINE 形式に変換し、フィードバック Quick Reply を追加
  const agentQuickReplies: QuickReplyItem[] = result.quickReplies?.map(
    (qr) => ({
      type: "action" as const,
      action: { type: "message" as const, label: qr.label, text: qr.text },
    }),
  ) ?? [];

  const feedbackQuickReplies = buildFeedbackQuickReplies();
  const allQuickReplies = [...agentQuickReplies, ...feedbackQuickReplies];

  // テキスト送信と応答保存を並列実行
  await Promise.all([
    pushTextMessage(lineUserId, result.response, env, allQuickReplies),
    saveMessage(supabase, {
      userId: lineUserId,
      channel: "line",
      role: "assistant",
      content: result.response,
    }),
  ]);

  // Flex Message がある場合はテキストの後に送信（順序保証）
  if (result.flexMessages && result.flexMessages.length > 0) {
    for (const flex of result.flexMessages) {
      await pushFlexMessage(lineUserId, flex.altText, flex.contents, env)
        .catch((err) => {
          console.error("Flex Message send failed:", err);
        });
    }
  }
}
