import type { Context } from "hono";
import type { Env } from "../index";
import { runAgent } from "../agent/core";
import { createEmbedding } from "../lib/embedding";
import {
  verifyLineSignature,
  pushTextMessage,
  pushFlexMessage,
  getImageContent,
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
import {
  getFirestoreEnv,
  updateCustomerProfile,
  addBehaviorEvent,
  recordBehaviorEvent,
  type CustomerProfile,
  type BehaviorEvent,
} from "../lib/firestore";
import { recordResponseTime, recordApiError, sendNegativeFeedbackAlert } from "../lib/alerts";
import { runPreferencePipeline } from "../lib/preference-pipeline";

/** 入力テキストの最大文字数（Embedding + Claude 入力の上限考慮） */
const MAX_MESSAGE_LENGTH = 2000;

/** テイスティングノート CTA を表示するターン数の閾値 */
const TASTING_NOTE_TURN_THRESHOLD = 5;

/** テイスティングノート CTA 表示済みユーザー（インメモリ — セッション単位） */
const tastingNoteCTAShown = new Set<string>();

/** テイスティングノート CTA テキスト */
const TASTING_NOTE_CTA_TEXT =
  "\n\n\u273F 体験を記録する \u2192 https://elxea.com/ja/tasting-note";

/** オンボーディング Quick Reply のトリガーテキスト */
const ONBOARDING_EXPLORE_TEXT = "onboarding:explore_tea";
const ONBOARDING_ABOUT_TEXT = "onboarding:about_elxea";
const ONBOARDING_HOWTO_TEXT = "onboarding:how_to_use";

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
      await handleImageMessage(lineUserId, message.id, env);
      break;

    case "video":
    case "audio":
    case "file":
      await pushTextMessage(
        lineUserId,
        "現在、テキストと画像メッセージに対応しております。お手数ですが、テキストまたは画像でお問い合わせください。",
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
 * ウェルカムメッセージ + Quick Reply 3択で初回オンボーディング。
 *
 * Spec v1 MS2-3 準拠: 友だち追加時に3つの Quick Reply ボタンを表示し、
 * タップした選択肢を行動ログとして記録する。
 *
 * Identity Linking: Messaging API userId を user_identity_map の line_user_id に登録する。
 * line_login_user_id が既に設定されているレコードがあれば、そこに line_user_id を追加して
 * LINE Login userId と Messaging API userId を紐付ける。
 */
async function handleFollowEvent(
  lineUserId: string,
  env: Env,
): Promise<void> {
  const supabase = createSupabaseClient(env);

  // Identity Linking: Messaging API userId を user_identity_map に登録
  // line_login_user_id で既にレコードがあるユーザーを email 経由で特定し、
  // line_user_id（Messaging API）を追加する
  try {
    // まず line_user_id が既に登録されているか確認
    const { data: existingByMessaging } = await supabase
      .from("user_identity_map")
      .select("id, unified_user_id")
      .eq("line_user_id", lineUserId)
      .single();

    if (!existingByMessaging) {
      // line_user_id 未登録の場合:
      // LINE Profile API でプロフィールを取得して email ベースでマッチングを試みる
      // ただし LINE Profile API は email を返さないため、
      // line_login_user_id が設定されていて line_user_id が未設定のレコードを探す
      // (同一プロバイダー内で友だち追加前に LINE Login 済みのユーザー)
      //
      // 注: 直接的なマッチングは困難なため、line_user_id が null のレコードのうち
      // 最近作成されたものに line_user_id を設定するのではなく、
      // customer_linkages テーブルも活用する
      const { data: linkage } = await supabase
        .from("customer_linkages")
        .select("shopify_customer_id, email")
        .eq("line_user_id", lineUserId)
        .single();

      if (linkage?.email) {
        // customer_linkages 経由で email が取得できた場合、
        // user_identity_map で同じ email のレコードに line_user_id を設定
        const { data: identityByEmail } = await supabase
          .from("user_identity_map")
          .select("id, unified_user_id, line_user_id")
          .eq("email", linkage.email)
          .single();

        if (identityByEmail && !identityByEmail.line_user_id) {
          await supabase
            .from("user_identity_map")
            .update({ line_user_id: lineUserId })
            .eq("id", identityByEmail.id);
          console.log(
            `[follow] Linked Messaging API userId ${lineUserId} to existing identity (unified=${identityByEmail.unified_user_id}) via email`,
          );
        }
      } else {
        // customer_linkages にもない場合:
        // line_login_user_id が設定されていて line_user_id が null のレコードを
        // email なしでは特定できないため、新規レコードを作成
        // (後で LINE Login 時に email ベースで統合される)
        const { error: insertError } = await supabase
          .from("user_identity_map")
          .insert({
            unified_user_id: lineUserId,
            line_user_id: lineUserId,
          });

        if (insertError) {
          // unique constraint violation の場合はスキップ（既に別経路で登録済み）
          if (!insertError.message.includes("duplicate") && !insertError.message.includes("unique")) {
            console.warn("[follow] Failed to create identity mapping:", insertError.message);
          }
        } else {
          console.log(`[follow] Created new identity mapping for Messaging API userId ${lineUserId}`);
        }
      }
    }
  } catch (err) {
    // Identity linking 失敗時もウェルカムメッセージは送る
    console.warn("[follow] Identity linking failed:", err instanceof Error ? err.message : err);
  }

  const welcomeText =
    "こんにちは！elxea（エルシア）へようこそ。\n\n" +
    "鹿児島の茶畑から届くお茶を、あなたにぴったりの一杯としてお届けします。\n\n" +
    "まずは、何から始めましょうか？";

  const quickReplyItems: QuickReplyItem[] = [
    {
      type: "action",
      action: { type: "message", label: "お茶を探す", text: ONBOARDING_EXPLORE_TEXT },
    },
    {
      type: "action",
      action: { type: "message", label: "elxea について知る", text: ONBOARDING_ABOUT_TEXT },
    },
    {
      type: "action",
      action: { type: "message", label: "使い方を教えて", text: ONBOARDING_HOWTO_TEXT },
    },
  ];

  await pushTextMessage(lineUserId, welcomeText, env, quickReplyItems);

  // Firestore にオンボーディング開始を記録（fire-and-forget）
  try {
    const fsEnv = getFirestoreEnv(env);
    const { data: linkage } = await supabase
      .from("customer_linkages")
      .select("shopify_customer_id")
      .eq("line_user_id", lineUserId)
      .single();

    if (linkage?.shopify_customer_id) {
      await updateCustomerProfile(
        String(linkage.shopify_customer_id),
        {
          onboarding: {
            completedAt: null,
            initialAction: null,
          },
        } as Partial<CustomerProfile>,
        fsEnv,
      );
    }
  } catch (err) {
    // Firebase 未設定 or 未紐付けの場合はスキップ
    console.log("[onboarding] Firestore recording skipped:", err instanceof Error ? err.message : err);
  }
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

    // 行動イベント記録（fire-and-forget）
    recordBehaviorEvent(
      lineUserId, "line", "feedback_given",
      { query: rating === 1 ? "positive" : "negative" },
      env as Parameters<typeof recordBehaviorEvent>[4],
      supabase,
    ).catch((err) => console.warn("[feedback] behavior event failed:", err instanceof Error ? err.message : err));

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

/**
 * オンボーディング Quick Reply タップを処理する。
 * 各ボタンに応じた会話フローを開始し、Firestore に記録する。
 * @returns true if the message was an onboarding action (handled), false otherwise.
 */
async function handleOnboardingMessage(
  lineUserId: string,
  userMessage: string,
  env: Env,
): Promise<boolean> {
  let responseText: string;
  let initialAction: string;
  let followUpQuickReplies: QuickReplyItem[] = [];

  switch (userMessage) {
    case ONBOARDING_EXPLORE_TEXT:
      initialAction = "explore_tea";
      responseText =
        "お茶を探しましょう！\n\n" +
        "elxea では鹿児島を中心に、各地の生産者から届くお茶を取り揃えています。\n\n" +
        "どんなシーンで楽しみたいですか？";
      followUpQuickReplies = [
        {
          type: "action",
          action: { type: "message", label: "朝のひととき", text: "朝におすすめのお茶を教えてください" },
        },
        {
          type: "action",
          action: { type: "message", label: "仕事の合間に", text: "仕事の合間にリフレッシュできるお茶を教えてください" },
        },
        {
          type: "action",
          action: { type: "message", label: "夜のリラックス", text: "夜にリラックスできるお茶を教えてください" },
        },
      ];
      break;

    case ONBOARDING_ABOUT_TEXT:
      initialAction = "about";
      responseText =
        "elxea は「日常に、静かな豊かさを」をテーマに、鹿児島の生産者と直接つながるブランドです。\n\n" +
        "茶畑で丁寧に育てられたお茶を、生産者のストーリーと一緒にお届けしています。\n\n" +
        "お茶だけでなく、茶葉を使ったスキンケアも手がけています。気になることがあれば、何でも聞いてくださいね。";
      followUpQuickReplies = [
        {
          type: "action",
          action: { type: "message", label: "商品を見てみたい", text: "おすすめの商品を教えてください" },
        },
        {
          type: "action",
          action: { type: "message", label: "生産者のこと", text: "生産者さんについて教えてください" },
        },
      ];
      break;

    case ONBOARDING_HOWTO_TEXT:
      initialAction = "howto";
      responseText =
        "こちらは elxea の AI コンシェルジュです。\n\n" +
        "できること:\n" +
        "- お茶の好みに合わせたおすすめ提案\n" +
        "- 商品の詳しい説明（産地・味わい・淹れ方）\n" +
        "- 注文状況の確認\n" +
        "- ギフト選びのお手伝い\n\n" +
        "「こんなお茶が飲みたい」「この商品について教えて」など、気軽にメッセージしてくださいね。";
      followUpQuickReplies = [
        {
          type: "action",
          action: { type: "message", label: "おすすめを聞く", text: "おすすめのお茶を教えてください" },
        },
        {
          type: "action",
          action: { type: "message", label: "注文を確認する", text: "注文状況を確認したいです" },
        },
      ];
      break;

    default:
      return false;
  }

  // 応答送信
  await pushTextMessage(lineUserId, responseText, env, followUpQuickReplies);

  // Firestore にオンボーディング完了を記録（fire-and-forget）
  recordOnboardingCompletion(lineUserId, initialAction, env).catch((err) => {
    console.log("[onboarding] Firestore completion recording failed:", err instanceof Error ? err.message : err);
  });

  return true;
}

/**
 * Firestore にオンボーディング完了を記録する。
 * - onboarding.completedAt に現在時刻を設定
 * - onboarding.initialAction にタップしたボタンを記録
 * - behaviorLog にイベントを追加
 */
async function recordOnboardingCompletion(
  lineUserId: string,
  initialAction: string,
  env: Env,
): Promise<void> {
  const fsEnv = getFirestoreEnv(env);
  const supabase = createSupabaseClient(env);

  const { data: linkage } = await supabase
    .from("customer_linkages")
    .select("shopify_customer_id")
    .eq("line_user_id", lineUserId)
    .single();

  if (!linkage?.shopify_customer_id) {
    console.log("[onboarding] No linkage found for user, skipping Firestore recording");
    return;
  }

  const shopifyId = String(linkage.shopify_customer_id);
  const now = new Date().toISOString();

  // オンボーディングステータス更新
  await updateCustomerProfile(
    shopifyId,
    {
      onboarding: {
        completedAt: now,
        initialAction: initialAction as "view_tea" | "explore_tea" | "about" | "howto" | "none",
      },
    } as Partial<CustomerProfile>,
    fsEnv,
  );

  // 行動ログ記録
  const event: BehaviorEvent = {
    action: "tap_button",
    channel: "line",
    metadata: { buttonLabel: `onboarding:${initialAction}` },
    personaSignal: initialAction === "explore_tea" ? "explorer" :
                   initialAction === "about" ? "serenity" : null,
    createdAt: now,
  };

  await addBehaviorEvent(shopifyId, event, fsEnv);
}

/** テキストメッセージを処理してエージェントに渡す */
async function handleTextMessage(
  lineUserId: string,
  userMessage: string,
  env: Env,
): Promise<void> {
  // 空メッセージをスキップ
  if (!userMessage.trim()) return;

  // オンボーディング Quick Reply タップの処理
  const wasOnboarding = await handleOnboardingMessage(lineUserId, userMessage, env);
  if (wasOnboarding) return;

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

  // 初回メッセージの場合、chat_started イベントを記録（fire-and-forget）
  if (history.length === 0) {
    recordBehaviorEvent(
      lineUserId, "line", "chat_started", {},
      env as Parameters<typeof recordBehaviorEvent>[4],
      supabase,
    ).catch((err) => console.warn("[line] chat_started event failed:", err instanceof Error ? err.message : err));
  }

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

  // テイスティングノート CTA: 5ターン以上 & 未表示の場合、応答末尾に追加
  let responseText = result.response;
  if (
    !tastingNoteCTAShown.has(lineUserId) &&
    history.filter((m) => m.role === "assistant").length + 1 >= TASTING_NOTE_TURN_THRESHOLD
  ) {
    responseText += TASTING_NOTE_CTA_TEXT;
    tastingNoteCTAShown.add(lineUserId);
  }

  // テキスト送信と応答保存を並列実行
  await Promise.all([
    pushTextMessage(lineUserId, responseText, env, allQuickReplies),
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

  // 嗜好抽出パイプライン（fire-and-forget: レスポンスをブロックしない）
  // 今回の会話（user message + assistant response）を含む履歴で実行
  const fullHistory = [
    ...history,
    { role: "user", content: processedMessage },
    { role: "assistant", content: result.response },
  ];
  runPreferencePipeline(fullHistory, lineUserId, "line", env, supabase)
    .catch((err) => console.warn("[line] preference pipeline failed:", err instanceof Error ? err.message : err));
}

/** 画像メッセージを処理して vision で解析する */
async function handleImageMessage(
  lineUserId: string,
  messageId: string,
  env: Env,
): Promise<void> {
  const supabase = createSupabaseClient(env);

  // Identity Resolver: unified_user_id を解決
  const identity = await resolveUnifiedUserId(supabase, lineUserId, "line");
  const effectiveUserId = identity.unifiedUserId;

  // LINE Content API で画像をダウンロード
  const imageContent = await getImageContent(messageId, env);

  // 画像解析用のプロンプト（Embedding は空ベクトルでスキップ）
  const imagePrompt = "送られた画像の内容を確認してください。";

  // 履歴取得（画像メッセージの前の会話文脈を含める）
  const history = identity.isLinked
    ? await getCrossChannelMessages(supabase, effectiveUserId)
    : await getRecentMessages(supabase, effectiveUserId, "line");

  // 空の Embedding（画像メッセージではナレッジ検索を行わないため）
  const embedding = new Array(1536).fill(0);

  // メッセージ保存（画像受信の記録）
  await saveMessage(supabase, {
    userId: lineUserId,
    channel: "line",
    role: "user",
    content: "[画像メッセージ]",
  });

  // エージェント実行（画像コンテンツ付き）
  const result = await runAgent(
    imagePrompt,
    history,
    embedding,
    effectiveUserId,
    "line",
    env,
    { isLinked: identity.isLinked, imageContent },
  );

  // 応答送信と保存を並列実行
  await Promise.all([
    pushTextMessage(lineUserId, result.response, env),
    saveMessage(supabase, {
      userId: lineUserId,
      channel: "line",
      role: "assistant",
      content: result.response,
    }),
  ]);

  // Flex Message がある場合はテキストの後に送信
  if (result.flexMessages && result.flexMessages.length > 0) {
    for (const flex of result.flexMessages) {
      await pushFlexMessage(lineUserId, flex.altText, flex.contents, env)
        .catch((err) => {
          console.error("Flex Message send failed:", err);
        });
    }
  }
}
