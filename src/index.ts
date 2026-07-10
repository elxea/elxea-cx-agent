import { Hono } from "hono";
import { cors } from "hono/cors";
import { lineWebhook, storePendingFollowRef } from "./routes/line";
import {
  webChatHandler,
  webChatHistoryHandler,
  webChatFeedbackHandler,
  webChatFeedbackStatsHandler,
  webChatImageHandler,
  webChatEventHandler,
} from "./routes/web";
import { surveyHandler } from "./routes/survey";
import { identityLinkHandler, identityLinkLineHandler } from "./routes/identity";
import { runKnowledgeSync } from "./sync/knowledge";
import { runBatchMetafieldSync } from "./sync/shopify-metafield";
import {
  runDelivery,
  runScheduledDelivery,
  pinDeliveryApproval,
} from "./lib/delivery-runtime";
import { getAlertStatus } from "./lib/alerts";

/**
 * 配信用 cron パターン（誤発火防止のため明示分岐で判定）。
 * wrangler.toml [triggers] crons に登録済み（15分毎）。scheduled ハンドラはこの
 * パターンのときだけ runScheduledDelivery（承認 pin 前処理 → 配信）を実行する。
 * ⚠ 実送信は runDelivery 内の DELIVERY_SEND_ENABLED!="true" ガードで既定 dry-run。
 *   cron が回っても DELIVERY_SEND_ENABLED を "true" にしない限り LINE には送らない。
 */
// ⚠ 非 export（module-level const）。Workers ランタイムはエントリの named export を
//   すべてハンドラとして解釈するため、文字列の named export は起動を壊す
//   （"Incorrect type for map entry ... not of type 'function or ExportedHandler'"）。
const DELIVERY_CRON_PATTERN = "*/15 * * * *";

export type Env = {
  // LINE（本番 = @307tzhkw）
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  // LINE 配信 2 環境対応（テスト = @426vlcyb）
  LINE_CHANNEL_ACCESS_TOKEN_TEST?: string;
  /** 配信の対象環境。"prod" | "test"（未設定・不正は "test" に倒す）。 */
  DELIVERY_TARGET_ENV?: string;
  /** 実送信の許可フラグ。"true" のときのみ実送信。既定 false（dry-run）。 */
  DELIVERY_SEND_ENABLED?: string;
  /** broadcast(全員配信) の想定受信者数（無料枠ガード見積用）。 */
  LINE_BROADCAST_ESTIMATED_RECIPIENTS_PROD?: string;
  LINE_BROADCAST_ESTIMATED_RECIPIENTS_TEST?: string;
  /** Notion 配信コンテンツ DB の database_id（未設定は既定 ID）。 */
  NOTION_DELIVERY_DB_ID?: string;
  /**
   * 社内テスト配信(allowlist)の宛先 LINE user ID（カンマ区切り）。
   * 未設定/空は allowlist 配信を fail-closed（対象0 → 送信不可）。PII のためコード非記載。
   */
  LINE_INTERNAL_USER_IDS?: string;
  /**
   * 社内テスト配信(allowlist)限定の順序付き画像URL群（カンマ区切り・恒久HTTPS）。
   * audience=allowlist のときだけ本文(text)に続けて image N を組む簡易経路（v2 までの暫定）。
   * Notion 複数画像UIの本実装までのブリッジ。prod/persona/all には適用しない。
   */
  DELIVERY_TEST_IMAGE_URLS?: string;
  /** 旧セグメント配信の再活性フラグ（既定 false = 退役）。 */
  LEGACY_SEGMENT_BROADCAST_ENABLED?: string;
  // ── R2（配信画像ホスティング）──
  // Notion files「画像」→ R2 → 恒久公開URL で LINE 送信する。put は承認 pin 時のみ。
  /** Cloudflare アカウント ID（R2 put 用）。承認 pin 時のみ必須。 */
  R2_ACCOUNT_ID?: string;
  /** Cloudflare API トークン（Workers R2 Storage: Edit）。secret。承認 pin 時のみ必須。 */
  R2_API_TOKEN?: string;
  /** R2 バケット名（既定 elxea-images）。 */
  R2_BUCKET_NAME?: string;
  /** R2 公開ベースURL（例 https://pub-xxxx.r2.dev）。送信時の URL 再構成に使う。 */
  R2_PUBLIC_BASE?: string;
  // AI
  ANTHROPIC_API_KEY: string;
  AI: Ai;
  // Database
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // Notion
  NOTION_TOKEN: string;
  NOTION_PRODUCT_LIST_DB_ID: string;
  NOTION_SET_MENU_DB_ID: string;
  NOTION_TEA_MENU_DB_ID: string;
  NOTION_CONTENT_HUB_DB_ID?: string;
  // Shopify
  SHOPIFY_STORE_DOMAIN?: string;
  SHOPIFY_ADMIN_ACCESS_TOKEN?: string;
  SHOPIFY_STOREFRONT_ACCESS_TOKEN?: string;
  // Notifications
  SLACK_WEBHOOK_URL?: string;
  // Notion Alerts DB
  NOTION_ALERTS_DB_ID?: string;
  // Sync
  SYNC_API_SECRET?: string;
  // Firebase / Firestore
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ status: "ok", service: "elxea-agent" }));

// CORS for Web Chat API（M-1: localhost は開発環境のみ許可）
app.use("/api/*", async (c, next) => {
  const allowedOrigins = [
    "https://www.elxea.com",
    "https://elxea.com",
    "https://www.elxea.jp",
    "https://elxea.jp",
  ];
  // ENVIRONMENT 環境変数が "development" の場合のみ localhost を許可
  if ((c.env as Env & { ENVIRONMENT?: string }).ENVIRONMENT === "development") {
    allowedOrigins.push("http://localhost:3000");
  }
  const middleware = cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  });
  return middleware(c, next);
});

app.post("/webhook/line", lineWebhook);

// Web Chat routes
app.post("/api/chat", webChatHandler);
app.get("/api/chat/history", webChatHistoryHandler);
app.post("/api/chat/image", webChatImageHandler);
app.post("/api/chat/event", webChatEventHandler);
app.post("/api/chat/feedback", webChatFeedbackHandler);
app.get("/api/chat/feedback/stats", webChatFeedbackStatsHandler);

// Survey route
app.post("/api/survey", surveyHandler);

// Identity link routes
app.post("/api/identity/link", identityLinkHandler);
app.post("/api/identity/link-line", identityLinkLineHandler);

/**
 * LIFF Follow Ref API。
 * QR コードスキャン後の LIFF ページが友だち追加前に呼び出す。
 * ref パラメータと LINE userId を紐付けて一時保存する。
 *
 * Body: { lineUserId: string, ref: string }
 */
app.post("/api/follow-ref", async (c) => {
  const body = await c.req.json<{ lineUserId?: string; ref?: string }>().catch(
    () => ({}) as { lineUserId?: string; ref?: string },
  );

  if (!body.lineUserId || !body.ref) {
    return c.json({ error: "lineUserId and ref are required" }, 400);
  }

  // ref パラメータのバリデーション（英数字・アンダースコア・ハイフンのみ）
  if (!/^[a-zA-Z0-9_-]+$/.test(body.ref)) {
    return c.json({ error: "Invalid ref format" }, 400);
  }

  await storePendingFollowRef(body.lineUserId, body.ref, c.env);

  return c.json({ status: "ok" });
});

/**
 * アラート状態確認 API。
 * 認証付き — エスカレーション/エラー/レスポンスタイムの現在のカウンターを返す。
 */
app.get("/api/alerts/status", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (
    !c.env.SYNC_API_SECRET ||
    authHeader !== `Bearer ${c.env.SYNC_API_SECRET}`
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return c.json({ status: "ok", alerts: getAlertStatus() });
});

/**
 * 手動同期 API（MS4 4.6）。
 * Bearer トークンで認証。full / incremental モードを指定可能。
 */
app.post("/api/sync", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (
    !c.env.SYNC_API_SECRET ||
    authHeader !== `Bearer ${c.env.SYNC_API_SECRET}`
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json<{ mode?: "full" | "incremental" }>().catch(
    () => ({}) as { mode?: "full" | "incremental" },
  );
  const mode = body.mode ?? "incremental";

  c.executionCtx.waitUntil(
    runKnowledgeSync(c.env, mode).then((result) => {
      console.log("Manual sync completed:", JSON.stringify(result));
    }),
  );

  return c.json({ status: "sync_started", mode });
});

/**
 * Shopify Metafield バッチ同期 API（MS4-2）。
 * Bearer トークンで認証。Firestore の更新された顧客プロファイルを
 * Shopify Customer Metafields に同期する。
 */
app.post("/api/sync/shopify-metafields", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (
    !c.env.SYNC_API_SECRET ||
    authHeader !== `Bearer ${c.env.SYNC_API_SECRET}`
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json<{ since?: string }>().catch(() => ({}));

  c.executionCtx.waitUntil(
    runBatchMetafieldSync(c.env, (body as { since?: string }).since).then(
      (result) => {
        console.log(
          "Shopify metafield batch sync completed:",
          JSON.stringify({
            total: result.total,
            succeeded: result.succeeded,
            failed: result.failed,
            skipped: result.skipped,
            durationMs: result.durationMs,
          }),
        );
      },
    ),
  );

  return c.json({ status: "sync_started", type: "shopify-metafields" });
});

/**
 * 配信 承認 pin API（T12）。
 * Bearer(SYNC_API_SECRET) 必須・fail-closed。指定ページの現在値をハッシュして
 * 「コンテンツハッシュ」に保存し Status=Approved にする（TOCTOU スナップショット）。
 * 実送信はしない。承認者!=著者もここで検証する。
 */
app.post("/api/delivery/approve", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (
    !c.env.SYNC_API_SECRET ||
    authHeader !== `Bearer ${c.env.SYNC_API_SECRET}`
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json<{ pageId?: string }>().catch(() => ({}) as { pageId?: string });
  if (!body.pageId || typeof body.pageId !== "string") {
    return c.json({ error: "pageId is required" }, 400);
  }

  const result = await pinDeliveryApproval(c.env, body.pageId).catch((err) => ({
    ok: false as const,
    reason: err instanceof Error ? err.message : String(err),
  }));

  if (!result.ok) {
    return c.json({ status: "rejected", reason: result.reason }, 422);
  }
  return c.json({ status: "approved", pinned: true });
});

/**
 * 配信 手動トリガ API（T8）。
 * Bearer(SYNC_API_SECRET) 必須・fail-closed。冪等性は台帳 claim 経路で担保。
 * 実送信は DELIVERY_SEND_ENABLED="true" のときのみ（既定 dry-run）。cron とは独立。
 */
app.post("/api/delivery/run", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (
    !c.env.SYNC_API_SECRET ||
    authHeader !== `Bearer ${c.env.SYNC_API_SECRET}`
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  // 手動トリガも scheduled と同じ配線（承認 pin 前処理 → runDelivery）を通す。
  // 運用者が Notion で Approved にした行を、手動でも「pin して拾う」ところまで再現する。
  c.executionCtx.waitUntil(
    runScheduledDelivery(c.env).then((result) => {
      console.log(
        "Manual LINE delivery completed:",
        JSON.stringify({
          pinned: result.pinPass.filter((p) => p.action === "pinned").length,
          resetFailed: result.pinPass.filter((p) => p.action === "reset_failed").length,
          scanned: result.run.scanned,
          processed: result.run.processed.length,
          reaper: result.run.reaper.length,
        }),
      );
    }),
  );

  return c.json({
    status: "delivery_started",
    sendEnabled: c.env.DELIVERY_SEND_ENABLED === "true",
  });
});

/**
 * Workers エクスポート。
 * - fetch: Hono HTTP ハンドラ
 * - scheduled: Cron Trigger による定期処理
 *   - 毎日 18:00 UTC (03:00 JST): ナレッジ同期 + Shopify Metafield 同期
 *   - 1日・15日 21:00 UTC (06:00 JST): セグメント別自動配信（月2回）
 */
export default {
  fetch: app.fetch,
  scheduled: async (
    event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) => {
    const cronPattern = event.cron;

    // Notion駆動 LINE配信 cron（誤発火防止のため else の前に明示分岐）。
    // 承認 pin 前処理 → runDelivery の順（runScheduledDelivery）。運用者は Notion で
    // Status=Approved にするだけでよい（承認 pin は cron が代行する）。
    // ⚠ 実送信は runDelivery 内の DELIVERY_SEND_ENABLED!="true" で dry-run（既定 送らない）。
    if (cronPattern === DELIVERY_CRON_PATTERN) {
      ctx.waitUntil(
        runScheduledDelivery(env).then((result) => {
          console.log(
            "Scheduled LINE delivery completed:",
            JSON.stringify({
              pinned: result.pinPass.filter((p) => p.action === "pinned").length,
              resetFailed: result.pinPass.filter((p) => p.action === "reset_failed")
                .length,
              scanned: result.run.scanned,
              processed: result.run.processed.length,
              reaper: result.run.reaper.length,
            }),
          );
        }),
      );
      return;
    }

    // 旧セグメント配信 cron（"0 21 1,15 * *"）は退役（T10）。
    // 明示分岐を削除し、パターンが来ても default（日次同期）には落ちるが実害なし
    // （crons=[] で発火しない。runSegmentBroadcast はコードレベルで no-op 化済み）。

    // デフォルト: 日次同期処理
    ctx.waitUntil(
      Promise.all([
        runKnowledgeSync(env, "incremental").then((result) => {
          console.log("Scheduled knowledge sync completed:", JSON.stringify(result));
        }),
        runBatchMetafieldSync(env).then((result) => {
          console.log(
            "Scheduled metafield sync completed:",
            JSON.stringify({
              total: result.total,
              succeeded: result.succeeded,
              failed: result.failed,
              durationMs: result.durationMs,
            }),
          );
        }),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;
