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
import {
  identityLinkHandler,
  identityLinkLineHandler,
  identityLinkLiffHandler,
} from "./routes/identity";
import { shopifyOrderWebhook } from "./routes/shopify-webhook";
import { classifyCron } from "./lib/cron-routing";
import { runKnowledgeSync } from "./sync/knowledge";
import { runBatchMetafieldSync } from "./sync/shopify-metafield";
import {
  runDelivery,
  runScheduledDelivery,
  pinDeliveryApproval,
} from "./lib/delivery-runtime";
import { runBroadcastStatsFetch } from "./lib/broadcast-stats";
import { runDormantReengagement } from "./lib/dormant-reengagement";
import { runMarcheActivation } from "./lib/marche-activation";
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
// 分類は純粋関数 classifyCron（cron-routing.ts）に集約。
// ⚠ 到達性（T3 修正）: 以前は crons に配信パターン（15分毎）しか無く、scheduled の配信分岐が
//   return するため、同期（runBatchMetafieldSync 含む）が「登録された cron から一度も発火
//   しない」死蔵だった。wrangler.toml の crons に同期パターンを追加し、classifyCron で
//   配信/同期を両立させる（配信パターン以外は必ず同期へ到達）。実発火は本番デプロイ後。

export type Env = {
  // LINE（本番 = @307tzhkw）
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  // LINE 配信 2 環境対応（テスト = @426vlcyb）
  LINE_CHANNEL_ACCESS_TOKEN_TEST?: string;
  /** 配信の対象環境。"prod" | "test"（未設定・不正は "test" に倒す）。 */
  DELIVERY_TARGET_ENV?: string;
  /**
   * アカウント連携導線の LIFF URL（トーク内入り口の「連携ボタン」の遷移先・ブロック4）。
   * 設定時のみ、未連携ユーザーの連携文脈（完全一致トリガー / ④定期便の未連携分岐）に
   * 「便益1行 + 連携ボタン（この URL を開く URI アクション）」を出す。
   * ⚠ 未設定（prod・空）は fail-safe: ボタンを出さず従来の案内テキスト（elxea.com/ja）に倒す。
   *   本番へは GA 判断まで値を置かない（wrangler.toml の [env.staging.vars] にのみ設定）。
   */
  LIFF_LINKAGE_URL?: string;
  /** 実送信の許可フラグ。"true" のときのみ実送信。既定 false（dry-run）。 */
  DELIVERY_SEND_ENABLED?: string;
  /**
   * 休眠一通（ブロック3-B）の実送信許可フラグ。"true" のときのみ実送信。
   * 既定 未設定=false（dry-run: 候補と本文を台帳へ記録するだけで LINE には送らない）。
   * DELIVERY_SEND_ENABLED とは独立（休眠機能だけを別ゲートで制御する）。
   */
  DORMANT_SEND_ENABLED?: string;
  /** 休眠判定のしきい値（日）。未設定・不正は既定 60（dormant-reengagement.DEFAULT_DORMANT_THRESHOLD_DAYS）。 */
  DORMANT_THRESHOLD_DAYS?: string;
  /** 休眠一通の 1 実行あたり送信上限（通）。未設定・不正は既定 20。月次予算は line_message_ledger が別途会計。 */
  DORMANT_PER_RUN_CAP?: string;
  /**
   * マルシェ活性化ナッジ（spec drift #1）の実送信許可フラグ。"true" のときのみ実送信。
   * 既定 未設定=false（dry-run: 候補と本文を marche_activation_log に記録するだけで LINE には送らない）。
   * DELIVERY/DORMANT_SEND_ENABLED とは独立（活性化機能だけを別ゲートで制御する）。
   */
  MARCHE_SEND_ENABLED?: string;
  /** マルシェ活性化の下限しきい値（日・追加からこの日数を過ぎたら対象）。未設定・不正は既定 1。 */
  MARCHE_ACTIVATION_THRESHOLD_DAYS?: string;
  /** マルシェ活性化の上限ウィンドウ（日・追加からこの日数を過ぎたら休眠に譲る）。未設定・不正は既定 14。 */
  MARCHE_ACTIVATION_WINDOW_DAYS?: string;
  /** マルシェ活性化の 1 実行あたり送信上限（通）。未設定・不正は既定 20。月次予算は line_message_ledger が別途会計。 */
  MARCHE_ACTIVATION_PER_RUN_CAP?: string;
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
  /**
   * チャット返信で使う Anthropic モデル ID（任意）。
   * 未設定時は core.ts の DEFAULT_REPLY_MODEL（最安クラス Haiku 4.5）にフォールバック。
   * モデル名は機密でないため wrangler の [env.*.vars] で設定してよい。
   */
  ANTHROPIC_MODEL?: string;
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
  /**
   * Shopify webhook の署名検証用 secret（HMAC-SHA256）。
   * 注文 webhook 受信の必須条件。未設定は fail-closed（全受信を 401 拒否）。
   * 値はコミットしない（`wrangler secret put SHOPIFY_WEBHOOK_SECRET`）。
   */
  SHOPIFY_WEBHOOK_SECRET?: string;
  /**
   * 【staging 限定・テスト用】定期便扱いにする合成 LINE userId の allowlist（カンマ区切り）。
   * ブロック4 のテスト連携キット用。Shopify を読めない staging で「この合成 ID は定期便」を作る。
   * ⚠ DELIVERY_TARGET_ENV="test"（=staging）のときだけ有効。本番（"prod"）では設定されても常に無効
   *   （subscriber-linkage.ts の isStagingSubscriberOverrideEnv でゲート）。本番には絶対に設定しない。
   */
  TEST_SUBSCRIBER_LINE_IDS?: string;
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

// Shopify 注文 webhook（受け口を作って待つ・稼働で即通電）。
// HMAC 署名検証（fail-closed）→ 注文 ID 冪等 claim → 背景処理（ペルソナ通電＋lastPurchaseAt＋定期便）。
app.post("/webhooks/shopify/orders", shopifyOrderWebhook);

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
// 案A（LIFF 連携）: customer_linkages への冪等 upsert（web-app サーバから X-API-Key 付きで呼ぶ）
app.post("/api/identity/link-liff", identityLinkLiffHandler);

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
 * 配信計測 fetch 手動トリガ API（P0-7b）。
 * Bearer(SYNC_API_SECRET) 必須・fail-closed。cron の "stats" 分岐と同一処理を同期実行する。
 *
 * ⚠ 読み取り専用: LINE Insight（GET）+ Supabase の読み書きのみ。LINE 送信系 API は一切呼ばない
 *   （実 LINE 配信を発生させない）。staging の疎通確認（対象0件でも正常終了）に使う。
 * cron と違い結果 JSON を同期で返す（証跡化のため待ってから応答する）。
 */
app.post("/api/broadcast-stats/fetch", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (
    !c.env.SYNC_API_SECRET ||
    authHeader !== `Bearer ${c.env.SYNC_API_SECRET}`
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const result = await runBroadcastStatsFetch(c.env).catch((err) => ({
    ok: false as const,
    reason: err instanceof Error ? err.message : String(err),
    unitsScanned: 0,
    snapshotsWritten: 0,
    details: [] as never[],
  }));

  console.log(
    "Manual broadcast stats fetch completed:",
    JSON.stringify({
      ok: result.ok,
      reason: result.reason,
      unitsScanned: result.unitsScanned,
      snapshotsWritten: result.snapshotsWritten,
    }),
  );

  return c.json({ status: "broadcast_stats_fetch_completed", result });
});

/**
 * 休眠再エンゲージ 手動トリガ API（ブロック3-B）。
 * Bearer(SYNC_API_SECRET) 必須・fail-closed。cron の "dormant" 分岐と同一処理を同期実行する。
 *
 * ⚠ 実送信ガード（多層・既定は送らない）:
 *   - DORMANT_SEND_ENABLED != "true"（既定）: dry-run。候補と本文を台帳に記録するだけで LINE 送信系 API に触れない。
 *   - 恒久重複防止（1人1回・90日再送間隔）は dormant_reengagement_log、月次予算は line_message_ledger。
 * staging の疎通確認（対象0でも正常終了・dry-run で送信0）に使う。結果 JSON を同期で返す（証跡化）。
 */
app.post("/api/dormant/run", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (
    !c.env.SYNC_API_SECRET ||
    authHeader !== `Bearer ${c.env.SYNC_API_SECRET}`
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const result = await runDormantReengagement(c.env).catch((err) => ({
    ok: false as const,
    reason: err instanceof Error ? err.message : String(err),
    sendEnabled: c.env.DORMANT_SEND_ENABLED === "true",
    thresholdDays: 0,
    perRunCap: 0,
    scanned: 0,
    candidates: 0,
    sent: 0,
    dryRun: 0,
    budgetBlocked: 0,
    details: [] as never[],
  }));

  console.log(
    "Manual dormant re-engagement completed:",
    JSON.stringify({
      ok: result.ok,
      reason: result.reason,
      sendEnabled: result.sendEnabled,
      scanned: result.scanned,
      candidates: result.candidates,
      sent: result.sent,
      dryRun: result.dryRun,
    }),
  );

  return c.json({ status: "dormant_reengagement_completed", result });
});

/**
 * マルシェ活性化ナッジ 手動トリガ API（spec drift #1）。
 * Bearer(SYNC_API_SECRET) 必須・fail-closed。cron の stats tick 同居処理と同一処理を同期実行する。
 *
 * ⚠ 実送信ガード（多層・既定は送らない）:
 *   - MARCHE_SEND_ENABLED != "true"（既定）: dry-run。候補と本文を marche_activation_log に記録するだけで LINE 送信系 API に触れない。
 *   - 恒久重複防止（1人1回）は marche_activation_log、月次予算は line_message_ledger。
 * staging の疎通確認（対象0でも正常終了・dry-run で送信0）に使う。結果 JSON を同期で返す（証跡化）。
 */
app.post("/api/marche-activation/run", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (
    !c.env.SYNC_API_SECRET ||
    authHeader !== `Bearer ${c.env.SYNC_API_SECRET}`
  ) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const result = await runMarcheActivation(c.env).catch((err) => ({
    ok: false as const,
    reason: err instanceof Error ? err.message : String(err),
    sendEnabled: c.env.MARCHE_SEND_ENABLED === "true",
    thresholdDays: 0,
    windowDays: 0,
    perRunCap: 0,
    scanned: 0,
    candidates: 0,
    sent: 0,
    dryRun: 0,
    budgetBlocked: 0,
    details: [] as never[],
  }));

  console.log(
    "Manual marche activation completed:",
    JSON.stringify({
      ok: result.ok,
      reason: result.reason,
      sendEnabled: result.sendEnabled,
      scanned: result.scanned,
      candidates: result.candidates,
      sent: result.sent,
      dryRun: result.dryRun,
    }),
  );

  return c.json({ status: "marche_activation_completed", result });
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
    const cronKind = classifyCron(event.cron);

    // Notion駆動 LINE配信 cron（誤発火防止のため else の前に明示分岐）。
    // 承認 pin 前処理 → runDelivery の順（runScheduledDelivery）。運用者は Notion で
    // Status=Approved にするだけでよい（承認 pin は cron が代行する）。
    // ⚠ 実送信は runDelivery 内の DELIVERY_SEND_ENABLED!="true" で dry-run（既定 送らない）。
    if (cronKind === "delivery") {
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

    // 配信計測 fetch cron（P0-7b・"0 19 * * *" = 04:00 JST）。
    // broadcast_stats の 24h/72h/7d スナップショットを LINE Insight から取得して upsert する。
    // ⚠ 読み取り専用（LINE Insight GET + Supabase）。LINE 送信系 API は一切呼ばない（実配信を発生させない）。
    //   migration 024 未適用や insight トークン未設定は fail-soft（ok:false で理由ログ・ジョブは投げない）。
    if (cronKind === "stats") {
      ctx.waitUntil(
        runBroadcastStatsFetch(env)
          .then((result) => {
            console.log(
              "Scheduled broadcast stats fetch completed:",
              JSON.stringify({
                ok: result.ok,
                reason: result.reason,
                unitsScanned: result.unitsScanned,
                snapshotsWritten: result.snapshotsWritten,
              }),
            );
          })
          .catch((err) => {
            // 二重の安全網（runBroadcastStatsFetch は基本 throw しないが、cron 経路は未処理 reject を残さない）。
            console.error(
              "Scheduled broadcast stats fetch threw (fail-soft):",
              err instanceof Error ? err.message : String(err),
            );
          }),
      );

      // ブロック3-B 休眠検知を stats tick に同居させる（専用 cron を新設できないため・wrangler.toml 参照）。
      // stats（0 19）は staging 限定トリガ（本番 [triggers] に無い）なので、この同居も staging 限定で発火する
      // ＝本番では実行されない。既定は送信封鎖（DORMANT_SEND_ENABLED != "true" で dry-run・LINE 送信系 API 非接触）。
      // stats とは独立の waitUntil（片方の失敗が他方を巻き込まない）。fail-soft でジョブは throw しない。
      ctx.waitUntil(
        runDormantReengagement(env)
          .then((result) => {
            console.log(
              "Scheduled dormant re-engagement completed (co-located on stats tick):",
              JSON.stringify({
                ok: result.ok,
                reason: result.reason,
                sendEnabled: result.sendEnabled,
                scanned: result.scanned,
                candidates: result.candidates,
                sent: result.sent,
                dryRun: result.dryRun,
              }),
            );
          })
          .catch((err) => {
            console.error(
              "Scheduled dormant re-engagement threw (fail-soft):",
              err instanceof Error ? err.message : String(err),
            );
          }),
      );

      // マルシェ活性化ナッジ（spec drift #1）も stats tick に同居させる（専用 cron を新設できない・
      // Cloudflare の 5 トリガ上限で 6 本目は登録拒否＝wrangler.toml 参照。stats（0 19）は staging 限定
      // トリガ〔本番 [triggers] に無い〕なので、この同居も staging 限定で発火＝本番では実行されない）。
      // 既定は送信封鎖（MARCHE_SEND_ENABLED != "true" で dry-run・LINE 送信系 API 非接触）。
      // stats/dormant とは独立の waitUntil（1 つの失敗が他を巻き込まない）。fail-soft でジョブは throw しない。
      ctx.waitUntil(
        runMarcheActivation(env)
          .then((result) => {
            console.log(
              "Scheduled marche activation completed (co-located on stats tick):",
              JSON.stringify({
                ok: result.ok,
                reason: result.reason,
                sendEnabled: result.sendEnabled,
                scanned: result.scanned,
                candidates: result.candidates,
                sent: result.sent,
                dryRun: result.dryRun,
              }),
            );
          })
          .catch((err) => {
            console.error(
              "Scheduled marche activation threw (fail-soft):",
              err instanceof Error ? err.message : String(err),
            );
          }),
      );
      return;
    }

    // 休眠再エンゲージ cron（ブロック3-B・"0 20 * * *" = 05:00 JST）。
    // 休眠中の友だちを抽出し「静かな一通」を送る。
    // ⚠ 既定は送信封鎖（DORMANT_SEND_ENABLED != "true" で dry-run: 候補と本文を台帳へ記録するだけ・LINE 送信系 API 非接触）。
    //   migration 025 未適用・Firebase 未設定等は fail-soft（ok:false 理由ログ・ジョブは投げない）。
    if (cronKind === "dormant") {
      ctx.waitUntil(
        runDormantReengagement(env)
          .then((result) => {
            console.log(
              "Scheduled dormant re-engagement completed:",
              JSON.stringify({
                ok: result.ok,
                reason: result.reason,
                sendEnabled: result.sendEnabled,
                scanned: result.scanned,
                candidates: result.candidates,
                sent: result.sent,
                dryRun: result.dryRun,
              }),
            );
          })
          .catch((err) => {
            // 二重の安全網（runDormantReengagement は基本 throw しないが、cron 経路は未処理 reject を残さない）。
            console.error(
              "Scheduled dormant re-engagement threw (fail-soft):",
              err instanceof Error ? err.message : String(err),
            );
          }),
      );
      return;
    }

    // 旧セグメント配信 cron（"0 21 1,15 * *"）は退役（T10）。
    // 明示分岐を削除し、パターンが来ても default（日次同期）には落ちるが実害なし
    // （runSegmentBroadcast はコードレベルで no-op 化済み）。

    // 日次同期（ナレッジ同期 + Shopify Metafield バッチ同期）。
    // ⚠ T3: SYNC_CRON_PATTERN を明示分岐で拾う。以前は配信分岐の return により
    //   ここへ到達できず同期が死蔵していた（crons に同期パターンが無かった）。
    //   SYNC_CRON_PATTERN と、未知パターン（安全網）の両方でこの同期を回す。
    const runDailySync = () =>
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
      ]);

    // classifyCron は配信パターン以外（同期パターン + 想定外の安全網）を "sync" に倒すため、
    // ここに到達した時点で cronKind === "sync"。配信分岐は上で return 済み。
    ctx.waitUntil(runDailySync());
  },
} satisfies ExportedHandler<Env>;
