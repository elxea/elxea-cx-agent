import type { Context } from "hono";
import type { Env } from "../index";
import { runAgent } from "../agent/core";
import { createEmbedding } from "../lib/embedding";
import {
  verifyLineSignature,
  getImageContent,
  createResponder,
  type LineWebhookBody,
  type QuickReplyItem,
  type LineResponder,
} from "../lib/line";
import {
  createSupabaseClient,
  saveMessage,
  getRecentMessages,
  getCrossChannelMessages,
} from "../lib/supabase";
import { resolveUnifiedUserId } from "../lib/identity";
import {
  handleTeaMenuFlow,
  fetchSellingTeas,
  buildTeaCard,
  resolveTeaBySlug,
  TEA_LIST_ENTRY_TRIGGER,
  type TeaItem,
} from "../lib/tea-menu";
import { handleMenuActionFlow, consultEntryValue } from "../lib/menu-actions";
import { handleLinkageFlow } from "../lib/subscriber-linkage";
import { handlePreferenceDiagnosis } from "../lib/preference-diagnosis";
import { handleMyKarteFlow } from "../lib/my-karte";
import {
  buildResponseQuickReplies,
  FEEDBACK_POSITIVE_TEXT,
  FEEDBACK_NEGATIVE_TEXT,
} from "../lib/feedback-quick-reply";
import { logFlowEvent } from "../lib/flow-events";
import { menuTapValue } from "../lib/menu-tap";
import {
  ONBOARDING_EXPLORE_INTRO,
  ONBOARDING_ABOUT_BODY,
  buildProductWelcome,
} from "../lib/brand-copy";
import {
  ONBOARDING_EXPLORE_TEXT,
  ONBOARDING_ABOUT_TEXT,
  ONBOARDING_HOWTO_TEXT,
  buildEntryWelcome,
  buildSourceResponse,
  parseWelcomeSourceAnswer,
  type WelcomeSource,
} from "../lib/welcome-onboarding";
import {
  getFirestoreEnv,
  updateCustomerProfile,
  updateLineUserProfile,
  addBehaviorEvent,
  recordBehaviorEvent,
  type CustomerProfile,
  type LineUserProfile,
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

/**
 * オンボーディング Quick Reply のトリガーテキスト（従来 3 択）は
 * src/lib/welcome-onboarding.ts に集約（入口質問型ウェルカムと共用の正本）。
 */

/** ref パラメータのプレフィックス（QR同梱物経由） */
const REF_PACKAGE_PREFIX = "pkg_";

/** pending_follow_refs の有効期限（10分 — QRスキャンから友だち追加までのバッファ） */
const PENDING_REF_TTL_MINUTES = 10;

// フィードバック Quick Reply のトリガーテキスト（FEEDBACK_POSITIVE_TEXT / FEEDBACK_NEGATIVE_TEXT）と、
// 生成・提示頻度ロジック（buildResponseQuickReplies）は ../lib/feedback-quick-reply に集約した
// （監査 #5: 👍/👎 の常時付与をやめ提示頻度を絞る。handleFeedbackMessage はここから import 参照）。

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

// ---------------------------------------------------------------------------
// Pending Follow Ref — QR コード経由の ref パラメータを一時保存
// ---------------------------------------------------------------------------
// LINE follow event は ref パラメータをネイティブにサポートしないため、
// LIFF ページが友だち追加前に storePendingFollowRef() を呼び出し、
// follow event 時に getPendingFollowRef() で取得する方式を採用。
// ---------------------------------------------------------------------------

/**
 * LIFF 経由で受け取った ref パラメータを Supabase に一時保存する。
 * LIFF ページ → POST /api/follow-ref → この関数 → Supabase pending_follow_refs テーブル
 */
export async function storePendingFollowRef(
  lineUserId: string,
  ref: string,
  env: Env,
): Promise<void> {
  const supabase = createSupabaseClient(env);
  const expiresAt = new Date(Date.now() + PENDING_REF_TTL_MINUTES * 60 * 1000).toISOString();

  // upsert: 同じユーザーが短時間に複数回スキャンした場合は最新を採用
  await supabase
    .from("pending_follow_refs")
    .upsert(
      { line_user_id: lineUserId, ref, expires_at: expiresAt },
      { onConflict: "line_user_id" },
    )
    .then(({ error }) => {
      if (error) console.error("[follow-ref] Failed to store pending ref:", error.message);
    });
}

/**
 * 友だち追加時に pending ref を取得し、取得後に削除する（ワンタイム読み取り）。
 * 有効期限切れのレコードは無視する。
 */
async function getPendingFollowRef(
  lineUserId: string,
  env: Env,
): Promise<string | null> {
  const supabase = createSupabaseClient(env);

  const { data } = await supabase
    .from("pending_follow_refs")
    .select("ref, expires_at")
    .eq("line_user_id", lineUserId)
    .single();

  if (!data) return null;

  // 有効期限チェック
  if (new Date(data.expires_at) < new Date()) {
    // 期限切れ — 削除して null を返す
    await supabase
      .from("pending_follow_refs")
      .delete()
      .eq("line_user_id", lineUserId);
    return null;
  }

  // ワンタイム読み取り: 取得後に削除
  await supabase
    .from("pending_follow_refs")
    .delete()
    .eq("line_user_id", lineUserId);

  return data.ref;
}

/**
 * ref パラメータから product_slug を抽出する。
 * ref=pkg_{product_slug} のフォーマットを解析。
 * @returns product_slug or null（pkg_ プレフィックスでない場合）
 */
function extractProductSlug(ref: string): string | null {
  if (ref.startsWith(REF_PACKAGE_PREFIX)) {
    return ref.slice(REF_PACKAGE_PREFIX.length);
  }
  return null;
}

// 商品固有ウェルカム文面は brand-copy.ts の buildProductWelcome（SoT）へ移設した（監査 #3）。
//   旧 buildProductWelcomeMessage はブランド文言をベタ書きし読み仮名/配信頻度を欠いていた。
// QR の Quick Reply（自由対話3択）と RAG 由来の商品名解決（lookupProductBySlug）は廃止し、
//   handleFollowEvent で slug→5桁番号を解決して当該お茶のカード（💬感想ボタン付き）を直接提示する
//   card→感想→次の一杯 ループへ置き換えた（監査 #4・Figma §17:334）。

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

    // このイベント（1 ターン）専用の Responder。reply token が生きていれば最初の送信を
    // 無料化し、無い/使用済み/失敗時は push にフォールバックする。
    const responder = createResponder(lineUserId, event.replyToken, env);

    // メッセージイベントの処理
    if (event.type === "message" && event.message) {
      try {
        const lineStart = Date.now();
        await handleMessage(lineUserId, event.message, env, responder);
        recordResponseTime(env, Date.now() - lineStart);
      } catch (error) {
        console.error("Error processing message:", error);
        recordApiError(env, error instanceof Error ? error.message : String(error));
        await responder
          .text(
            "申し訳ありません、一時的にエラーが発生しました。しばらくしてからもう一度お試しください。",
          )
          .catch(console.error);
      }
    }
    // フォローイベント（友だち追加時のウェルカムメッセージ）
    if (event.type === "follow") {
      try {
        await handleFollowEvent(lineUserId, env, responder);
      } catch (error) {
        console.error("Error processing follow event:", error);
      }
    }

    // アンフォロー（退会/ブロック相当）は配信対象から除外するため記録する（migration 020）。
    if (event.type === "unfollow") {
      console.log(`User unfollowed: ${lineUserId}`);
      try {
        const supabase = createSupabaseClient(env);
        const { error } = await supabase
          .from("customer_linkages")
          .update({ unfollowed_at: new Date().toISOString() })
          .eq("line_user_id", lineUserId);
        if (error) {
          console.warn(
            `[unfollow] Failed to mark unfollowed_at for ${lineUserId}: ${error.message}`,
          );
        }
      } catch (err) {
        console.warn(
          "[unfollow] unfollowed_at 記録に失敗:",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
}

/** メッセージタイプに応じて処理を分岐 */
async function handleMessage(
  lineUserId: string,
  message: { type: string; id: string; text?: string },
  env: Env,
  responder: LineResponder,
): Promise<void> {
  switch (message.type) {
    case "text":
      await handleTextMessage(lineUserId, message.text ?? "", env, responder);
      break;

    case "sticker":
      await responder.text(
        "スタンプありがとうございます！何かご質問がありましたら、テキストでお気軽にどうぞ。",
      );
      break;

    case "image":
      await handleImageMessage(lineUserId, message.id, env, responder);
      break;

    case "video":
    case "audio":
    case "file":
      await responder.text(
        "現在、テキストと画像メッセージに対応しております。お手数ですが、テキストまたは画像でお問い合わせください。",
      );
      break;

    case "location":
      await responder.text(
        "位置情報ありがとうございます。何かご質問がありましたら、テキストでお気軽にどうぞ。",
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
  responder: LineResponder,
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

  // --- ref パラメータの取得（QR同梱物経由かどうかの判定） ---
  let ref: string | null = null;
  try {
    ref = await getPendingFollowRef(lineUserId, env);
    if (ref) {
      console.log(`[follow] Found pending ref for ${lineUserId}: ${ref}`);
    }
  } catch (err) {
    console.warn("[follow] Failed to get pending ref:", err instanceof Error ? err.message : err);
  }

  // ref の有無で分岐: 商品固有 or 通常のウェルカムメッセージ
  const onboardingSource = ref ?? "direct";
  const productSlug = ref ? extractProductSlug(ref) : null;

  if (productSlug) {
    // --- QR同梱物経由: ブランド正本ウェルカム（#3）→ 当該お茶のカード（#4） ---
    // 商品が確定している最大流入（QR 同梱）を、card→感想→次の一杯 の個別最適ループへ直接乗せる。
    let productName = productSlug.replace(/_/g, " ");
    let resolvedTea: TeaItem | null = null;
    try {
      const teas = await fetchSellingTeas(env);
      resolvedTea = resolveTeaBySlug(productSlug, teas);
      if (resolvedTea) productName = resolvedTea.name;
    } catch (err) {
      // 販売中お茶の取得失敗時もウェルカムは必ず届ける（slug をそのまま商品名に使う）。
      console.warn("[follow] tea resolve failed:", err instanceof Error ? err.message : err);
    }

    // #3: ウェルカム文面はブランド正本（brand-copy.buildProductWelcome）へ一本化。
    //     読み仮名（エルクシア）・シングルオリジン・配信頻度が SoT 経由で必ず入る。
    const welcomeText = buildProductWelcome(productName);

    if (resolvedTea) {
      // #4: 当該お茶のカード（💬感想ボタン付き）を提示し、card→感想→次の一杯 ループへ乗せる。
      const card = buildTeaCard(resolvedTea);
      await responder.text(welcomeText);
      await responder.text(card.text, card.quickReplies);
      console.log(`[follow] QR welcome + rating card for ${resolvedTea.number} to ${lineUserId}`);
    } else {
      // お茶を解決できない（販売終了・番号変更 等）: 一覧入口を添えて行き止まりにしない。
      await responder.text(welcomeText, [
        {
          type: "action",
          action: { type: "message", label: "🍃 お茶の一覧を見る", text: TEA_LIST_ENTRY_TRIGGER },
        },
      ]);
      console.log(`[follow] QR welcome (slug unresolved: ${productSlug}) to ${lineUserId}`);
    }
  } else {
    // --- 通常の友だち追加ウェルカム（入口質問型・ブロック2） ---
    // 「どこで elxea を知ったか」を 1 回だけ質問し、回答で 3 動線へ分岐する。
    // 回答は handleOnboardingMessage の入口質問ブランチが処理する。
    const { text: welcomeText, quickReplies } = buildEntryWelcome();
    await responder.text(welcomeText, quickReplies);
  }

  // Firestore にオンボーディング開始 + source を記録（fire-and-forget）
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
            source: onboardingSource,
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

// buildFeedbackQuickReplies() は ../lib/feedback-quick-reply へ移設（監査 #5: 常時付与をやめ提示頻度を絞る）。
// タップ経路（下記 handleFeedbackMessage）は不変＝ message_feedback 記録 / Slack ネガ通知の信号は保全する。

/**
 * フィードバックメッセージを処理する。
 * @returns true if the message was a feedback action (handled), false otherwise.
 */
async function handleFeedbackMessage(
  lineUserId: string,
  userMessage: string,
  env: Env,
  responder: LineResponder,
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

    await responder.text(
      "ご意見ありがとうございます。改善に活かしてまいります。",
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
      await responder.text(
        "ありがとうございます！お役に立てて嬉しいです。",
      );
    } else {
      // コメント待ち状態をセット
      pendingFeedbackComments.set(lineUserId, {
        messageContent: lastAssistantContent,
        expiresAt: Date.now() + FEEDBACK_COMMENT_TTL_MS,
      });
      await responder.text(
        "ご意見ありがとうございます。よろしければ、どんな点を改善できるかメッセージで教えてください。",
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
  responder: LineResponder,
): Promise<boolean> {
  let responseText: string;
  let initialAction: string;
  let followUpQuickReplies: QuickReplyItem[] = [];

  // 入口質問型ウェルカムの回答（ブロック2）: 流入元の 3 択タップを分岐処理する。
  // 完全一致のトークンのみ横取りし、それ以外（自由発話・5桁番号・メニュー操作）は
  // parseWelcomeSourceAnswer が null を返すため下流ハンドラへ素通りする（質問は 1 回だけ・再提示しない）。
  const welcomeSource = parseWelcomeSourceAnswer(userMessage);
  if (welcomeSource) {
    // 記録は送信より前に投げる（fire-and-forget）。回答があった事実は配信成否に依存しないため、
    // welcome.tap と同じく送信前に記録する（下流で send が失敗しても記録は残る）。
    // (b) flow_events(welcome.source)（value=marche/online/other）。
    void logFlowEvent(createSupabaseClient(env), {
      eventName: "welcome.source",
      userRef: lineUserId,
      value: welcomeSource,
    });
    // (a) Firestore lineUsers/{id}.onboarding.source。
    recordWelcomeSource(lineUserId, welcomeSource, env).catch((err) => {
      console.log(
        "[onboarding] welcome.source Firestore recording failed:",
        err instanceof Error ? err.message : err,
      );
    });

    const { text, quickReplies } = buildSourceResponse(welcomeSource);
    await responder.text(text, quickReplies);

    return true;
  }

  // welcome.tap 記録（P0-1・fire-and-forget）: ウェルカム 3 択の探索/について/使い方タップ（H9）。
  const welcomeTap: Record<string, "explore" | "about" | "howto"> = {
    [ONBOARDING_EXPLORE_TEXT]: "explore",
    [ONBOARDING_ABOUT_TEXT]: "about",
    [ONBOARDING_HOWTO_TEXT]: "howto",
  };
  const wtv = welcomeTap[userMessage];
  if (wtv) {
    void logFlowEvent(createSupabaseClient(env), {
      eventName: "welcome.tap",
      userRef: lineUserId,
      value: wtv,
    });
  }

  switch (userMessage) {
    case ONBOARDING_EXPLORE_TEXT:
      initialAction = "explore_tea";
      responseText =
        "お茶を探しましょう！\n\n" +
        `${ONBOARDING_EXPLORE_INTRO}\n\n` +
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
      responseText = ONBOARDING_ABOUT_BODY;
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
  await responder.text(responseText, followUpQuickReplies);

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

/**
 * 入口質問の回答（流入元）を Firestore lineUsers/{lineUserId}.onboarding.source に記録する（ブロック2）。
 *
 * 友だち追加直後の回答は Shopify 未連携が多いため、連携済みカルテ（users/{shopifyId}）ではなく
 * 未連携カルテ（lineUsers/{lineUserId}）に残す。将来連携成立時に users へマージ可能な同一構造。
 * completedAt / initialAction は入口質問の段階では未確定のため null（完了は別途 recordOnboardingCompletion）。
 */
async function recordWelcomeSource(
  lineUserId: string,
  source: WelcomeSource,
  env: Env,
): Promise<void> {
  const fsEnv = getFirestoreEnv(env);
  await updateLineUserProfile(
    lineUserId,
    {
      onboarding: {
        completedAt: null,
        initialAction: null,
        source,
      },
    } as Partial<LineUserProfile>,
    fsEnv,
  );
}

/** テキストメッセージを処理してエージェントに渡す */
async function handleTextMessage(
  lineUserId: string,
  userMessage: string,
  env: Env,
  responder: LineResponder,
): Promise<void> {
  // 空メッセージをスキップ
  if (!userMessage.trim()) return;

  // menu.tap 記録（P0-1・fire-and-forget）: リッチメニュー 5 枠の完全一致タップを flow_events へ。
  //   下流の各インターセプタは会話保存より前に return するため、ここで先に記録する（H4 枠別タップ分布）。
  const tapValue = menuTapValue(userMessage);
  if (tapValue) {
    void logFlowEvent(createSupabaseClient(env), {
      eventName: "menu.tap",
      userRef: lineUserId,
      value: tapValue,
    });
  }

  // consult.entry 記録（P0-1・fire-and-forget）: ③相談の初手 3 択（order/tea/other）タップ。
  //   これらは AI 会話へ素通りするため、ここで先に記録してから通常フローへ流す（return しない）。
  const consultValue = consultEntryValue(userMessage);
  if (consultValue) {
    void logFlowEvent(createSupabaseClient(env), {
      eventName: "consult.entry",
      userRef: lineUserId,
      value: consultValue,
    });
  }

  // オンボーディング Quick Reply タップの処理
  const wasOnboarding = await handleOnboardingMessage(lineUserId, userMessage, env, responder);
  if (wasOnboarding) return;

  // フィードバックメッセージの処理（Quick Reply タップ or コメント入力）
  const wasFeedback = await handleFeedbackMessage(lineUserId, userMessage, env, responder);
  if (wasFeedback) return;

  // 選択式お茶メニュー案内（タップ主体・状態レス・LLM 不使用）。
  // 限定トリガー（入口発話 / tea:* トークン / 既知の 5 桁番号）のみ反応し、
  // 無関係な発話は素通りさせて既存の AI 自由対話フローを一切壊さない。
  // ⚠ 順序（QA 回帰修正 2026-07-12）: onboarding / feedback の pending-state
  //   ハンドラより後に置く。改善希望タップ後の「次メッセージ＝コメント」に
  //   5 桁番号や入口語が含まれても tea-menu が横取りしないようにするため
  //   （それらの pending トークンは tea トリガーと衝突しないため後置は安全）。
  const wasTeaMenu = await handleTeaMenuFlow(lineUserId, userMessage, env, responder);
  if (wasTeaMenu) return;

  // リッチメニュー ③相談 / ④定期便 / ⑤elxeaについて の決定的応答（LLM 不使用・完全一致トリガー）。
  // tea-menu 同様、onboarding / feedback の pending-state ハンドラより後に置く。
  // 対象 3 トリガーは自由発話・pending トークンと衝突しないため後置は安全。無関係発話は素通り。
  const wasMenuAction = await handleMenuActionFlow(lineUserId, userMessage, env, responder);
  if (wasMenuAction) return;

  // アカウント連携導線（定期便客限定・ブロック4）。完全一致トリガー「アカウントを連携する」のみ
  // 横取りし、未連携=案内 / 連携済み定期便=定期便客応答 / 連携済み非定期便=丁寧なお断り を出し分ける。
  // 読み取りのみ（Shopify 非接触）。tea-menu / menu-actions と同じく onboarding / feedback の後に後置。
  const wasLinkage = await handleLinkageFlow(lineUserId, userMessage, env, responder);
  if (wasLinkage) return;

  // 好み診断（リッチメニュー②・タップ主体・状態レス・LLM 不使用）。
  // トリガー「好みに合うお茶を診断してほしいです」と `診断｜*` トークンのみ横取りし、
  // Q1→Q2→Q3→結果を quick reply で返す。結果確定時に winner を persona へ weight=3 加算（fail-safe）。
  // ⚠ 順序: tea-menu / menu-actions と同じく onboarding / feedback の pending-state ハンドラより後。
  //   これにより「改善希望」タップ後のコメント待ち中に `診断｜…` を送っても feedback が優先し
  //   （既存優先順の正しい挙動）、診断トークンが feedback に吸われる。診断トリガー・トークンは
  //   自由発話・pending トークンと衝突しないため後置は安全。無関係発話は素通り。
  const wasDiagnosis = await handlePreferenceDiagnosis(lineUserId, userMessage, env, responder);
  if (wasDiagnosis) return;

  // マイカルテ（UX②・完全一致「マイカルテ」・read-only）。ユーザーの理解プロフィールを
  // 3 枚の Flex カルーセル（あなた / これまで / だから）で返す。未連携 LINE ユーザーでも動作し、
  // 生スコアは一切出さない。空カルテは診断 CTA に graceful。tea-menu / 診断と同じく後置（無関係発話は素通り）。
  const wasMyKarte = await handleMyKarteFlow(lineUserId, userMessage, env, responder);
  if (wasMyKarte) return;

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
    // A-1: 評価・入口の直読みは生の lineUserId をキーにする（product_ratings.user_ref と一致）。
    { isLinked: identity.isLinked, ratingUserRef: lineUserId },
  );

  // Quick Reply を LINE 形式に変換する。
  const agentQuickReplies: QuickReplyItem[] = result.quickReplies?.map(
    (qr) => ({
      type: "action" as const,
      action: { type: "message" as const, label: qr.label, text: qr.text },
    }),
  ) ?? [];

  // このターンを含むアシスタント応答の通算回数（tasting-note CTA と共有する turn カウント）。
  const assistantTurnCount = history.filter((m) => m.role === "assistant").length + 1;

  // 監査 #5: 👍/👎 の「毎ターン常時付与」をやめ、静か原則に沿って提示頻度を絞る（初回 + N ターンに 1 度）。
  //   信号（message_feedback 記録 / Slack ネガ通知）は handleFeedbackMessage 側で常時有効・不変。
  //   ここは surfacing の頻度だけを絞る（感想→product_ratings→次の一杯 の個別最適ループには非干渉）。
  const allQuickReplies = buildResponseQuickReplies(agentQuickReplies, { assistantTurnCount });

  // テイスティングノート CTA: 5ターン以上 & 未表示の場合、応答末尾に追加
  let responseText = result.response;
  if (
    !tastingNoteCTAShown.has(lineUserId) &&
    assistantTurnCount >= TASTING_NOTE_TURN_THRESHOLD
  ) {
    responseText += TASTING_NOTE_CTA_TEXT;
    tastingNoteCTAShown.add(lineUserId);
  }

  // テキスト送信と応答保存を並列実行。
  // 本文は reply（無料）で送られ、ターン内で reply token を消費する。
  await Promise.all([
    responder.text(responseText, allQuickReplies),
    saveMessage(supabase, {
      userId: lineUserId,
      channel: "line",
      role: "assistant",
      content: result.response,
    }),
  ]);

  // Flex Message がある場合はテキストの後に送信（順序保証）。
  // reply token は本文で消費済みのため、この Flex は push（有料）にフォールバックする。
  if (result.flexMessages && result.flexMessages.length > 0) {
    for (const flex of result.flexMessages) {
      await responder.flex(flex.altText, flex.contents)
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
  responder: LineResponder,
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
    { isLinked: identity.isLinked, imageContent, ratingUserRef: lineUserId },
  );

  // 応答送信と保存を並列実行（本文は reply〔無料〕で送る）
  await Promise.all([
    responder.text(result.response),
    saveMessage(supabase, {
      userId: lineUserId,
      channel: "line",
      role: "assistant",
      content: result.response,
    }),
  ]);

  // Flex Message がある場合はテキストの後に送信（reply 消費済みのため push フォールバック）
  if (result.flexMessages && result.flexMessages.length > 0) {
    for (const flex of result.flexMessages) {
      await responder.flex(flex.altText, flex.contents)
        .catch((err) => {
          console.error("Flex Message send failed:", err);
        });
    }
  }
}
