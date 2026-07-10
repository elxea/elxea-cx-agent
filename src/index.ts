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
import { runDelivery, pinDeliveryApproval } from "./lib/delivery-runtime";
import { getAlertStatus } from "./lib/alerts";

/**
 * 配信用 cron パターン（誤発火防止のため明示分岐で判定）。
 * ⚠ wrangler.toml crons=[] のため実登録はしていない（本タスクでは自動発火ゼロ）。
 *   再開時にこのパターンを crons に追記する。
 */
export const DELIVERY_CRON_PATTERN = "*/15 * * * *";

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
  /** 旧セグメント配信の再活性フラグ（既定 false = 退役）。 */
  LEGACY_SEGMENT_BROADCAST_ENABLED?: string;
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

  c.executionCtx.waitUntil(
    runDelivery(c.env).then((result) => {
      console.log(
        "Manual LINE delivery completed:",
        JSON.stringify({
          scanned: result.scanned,
          processed: result.processed.length,
          reaper: result.reaper.length,
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
    // ⚠ crons=[] のため実発火しない。runDelivery は DELIVERY_SEND_ENABLED!="true" で dry-run。
    if (cronPattern === DELIVERY_CRON_PATTERN) {
      ctx.waitUntil(
        runDelivery(env).then((result) => {
          console.log(
            "Scheduled LINE delivery completed:",
            JSON.stringify({
              scanned: result.scanned,
              processed: result.processed.length,
              reaper: result.reaper.length,
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
