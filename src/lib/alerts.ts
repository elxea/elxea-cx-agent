/**
 * Alert Monitoring -- 異常検知アラート
 *
 * Cloudflare Workers のインメモリカウンターを使用して異常を検知する。
 *
 * アラート送信先:
 * - Notion CX Agent Alerts DB: 全アラートを蓄積（フィルタ・集計可能）
 * - Slack Webhook: 緊急アラートのみ（escalation_surge, api_error の critical）
 *
 * 監視項目:
 * 1. エスカレーション急増: 1時間に3件以上 -> Notion + Slack
 * 2. API エラー率上昇: 5分間で error 3件以上 -> Notion + Slack
 * 3. レスポンス時間増加: 5分間の平均5秒以上 -> Notion のみ
 * 4. ネガティブフィードバック: 個別通知 -> Notion のみ
 *
 * 注意: Workers はリクエストごとにインスタンスが再利用される場合があるため、
 * インメモリカウンターは同一 isolate 内でのみ有効。
 */

import type { Env } from "../index";

// ---------------------------------------------------------------------------
// アラート型定義
// ---------------------------------------------------------------------------

export type AlertType =
  | "escalation_surge"
  | "api_error"
  | "response_time"
  | "negative_feedback";

export type AlertSeverity = "critical" | "warning" | "info";

// ---------------------------------------------------------------------------
// 閾値設定
// ---------------------------------------------------------------------------

/** エスカレーション急増: 1時間に N 件以上 */
const ESCALATION_THRESHOLD = 3;
const ESCALATION_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** API エラー率: N 分間で M 件以上 */
const API_ERROR_THRESHOLD = 3;
const API_ERROR_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** レスポンス時間: N 分間の平均が M 秒以上 */
const RESPONSE_TIME_THRESHOLD_MS = 5000;
const RESPONSE_TIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

/** 同一アラートの通知クールダウン（重複通知防止） */
const ALERT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

// ---------------------------------------------------------------------------
// カウンターストア（インメモリ）
// ---------------------------------------------------------------------------

type TimestampedEvent = { timestamp: number };

/** エスカレーションイベント */
const escalationEvents: TimestampedEvent[] = [];

/** API エラーイベント */
const apiErrorEvents: Array<TimestampedEvent & { errorMessage: string }> = [];

/** レスポンスタイム記録 */
const responseTimeEvents: Array<TimestampedEvent & { durationMs: number }> = [];

/** 最後に各アラートを送信した時刻（クールダウン管理） */
const lastAlertSent: Record<string, number> = {};

// ---------------------------------------------------------------------------
// イベント記録 API
// ---------------------------------------------------------------------------

/**
 * エスカレーションイベントを記録する。
 * core.ts の escalate_to_human ツール実行時に呼び出す。
 */
export function recordEscalation(env: Env): void {
  const now = Date.now();
  escalationEvents.push({ timestamp: now });
  pruneEvents(escalationEvents, ESCALATION_WINDOW_MS, now);

  if (escalationEvents.length >= ESCALATION_THRESHOLD) {
    if (!isInCooldown("escalation_surge", now)) {
      lastAlertSent["escalation_surge"] = now;
      const details = `${escalationEvents.length} escalations in the past hour (threshold: ${ESCALATION_THRESHOLD}). Please review the escalation queue.`;
      // 緊急: Notion + Slack
      sendAlert(env, "escalation_surge", "critical", details).catch(console.error);
    }
  }
}

/**
 * API エラーを記録する。
 * エージェント処理中にキャッチしたエラーを記録する。
 */
export function recordApiError(env: Env, errorMessage: string): void {
  const now = Date.now();
  apiErrorEvents.push({ timestamp: now, errorMessage });
  pruneEvents(apiErrorEvents, API_ERROR_WINDOW_MS, now);

  const recentErrors = apiErrorEvents.filter(
    (e) => now - e.timestamp <= API_ERROR_WINDOW_MS,
  );

  if (recentErrors.length >= API_ERROR_THRESHOLD) {
    if (!isInCooldown("api_error_rate", now)) {
      lastAlertSent["api_error_rate"] = now;
      const errorSample = recentErrors
        .slice(-3)
        .map((e) => `  - ${e.errorMessage}`)
        .join("\n");
      const details = `${recentErrors.length} errors in the past 5 minutes (threshold: ${API_ERROR_THRESHOLD}).\n\nRecent errors:\n${errorSample}`;
      // 緊急: Notion + Slack
      sendAlert(env, "api_error", "critical", details).catch(console.error);
    }
  }
}

/**
 * レスポンスタイムを記録する。
 * リクエストハンドラの処理時間を計測して記録する。
 */
export function recordResponseTime(env: Env, durationMs: number): void {
  const now = Date.now();
  responseTimeEvents.push({ timestamp: now, durationMs });
  pruneEvents(responseTimeEvents, RESPONSE_TIME_WINDOW_MS, now);

  const recentTimes = responseTimeEvents.filter(
    (e) => now - e.timestamp <= RESPONSE_TIME_WINDOW_MS,
  );

  if (recentTimes.length >= 3) {
    const avgMs =
      recentTimes.reduce((sum, e) => sum + e.durationMs, 0) /
      recentTimes.length;

    if (avgMs >= RESPONSE_TIME_THRESHOLD_MS) {
      const details = `avg ${avgMs.toFixed(0)}ms over ${recentTimes.length} requests (threshold: ${RESPONSE_TIME_THRESHOLD_MS}ms)`;
      console.warn(`[alert] Response time degradation: ${details}`);
      // 非緊急: Notion のみ（Slack には送信しない）
      sendAlert(env, "response_time", "warning", details).catch(console.error);
    }
  }
}

/**
 * 現在のアラート状態を取得（デバッグ / ヘルスチェック用）。
 */
export function getAlertStatus(): {
  escalations: { count: number; window: string };
  apiErrors: { count: number; window: string };
  responseTime: { avgMs: number; count: number; window: string };
} {
  const now = Date.now();

  const recentEscalations = escalationEvents.filter(
    (e) => now - e.timestamp <= ESCALATION_WINDOW_MS,
  );
  const recentErrors = apiErrorEvents.filter(
    (e) => now - e.timestamp <= API_ERROR_WINDOW_MS,
  );
  const recentTimes = responseTimeEvents.filter(
    (e) => now - e.timestamp <= RESPONSE_TIME_WINDOW_MS,
  );

  const avgMs =
    recentTimes.length > 0
      ? recentTimes.reduce((sum, e) => sum + e.durationMs, 0) /
        recentTimes.length
      : 0;

  return {
    escalations: {
      count: recentEscalations.length,
      window: "1h",
    },
    apiErrors: {
      count: recentErrors.length,
      window: "5m",
    },
    responseTime: {
      avgMs: Math.round(avgMs),
      count: recentTimes.length,
      window: "5m",
    },
  };
}

// ---------------------------------------------------------------------------
// Negative Feedback Alert
// ---------------------------------------------------------------------------

/**
 * ネガティブフィードバックを通知する。
 * ユーザーが改善希望を送信した際に呼び出す。
 * Notion に記録（Slack には送信しない）。
 */
export async function sendNegativeFeedbackAlert(
  env: Env,
  userId: string,
  messageContent: string,
  comment?: string | null,
): Promise<void> {
  const truncatedContent =
    messageContent.length > 200
      ? messageContent.slice(0, 200) + "..."
      : messageContent;

  let details = `User: ${userId.slice(0, 8)}...\nMessage: ${truncatedContent}`;
  if (comment) {
    details += `\nComment: ${comment}`;
  }

  // 非緊急: Notion のみ
  await sendAlert(env, "negative_feedback", "info", details);
}

// ---------------------------------------------------------------------------
// 統合アラート送信
// ---------------------------------------------------------------------------

/** 緊急アラートの判定: Slack にも送信するタイプ */
const CRITICAL_ALERT_TYPES: AlertType[] = ["escalation_surge", "api_error"];

/**
 * アラートを送信する（統合エントリポイント）。
 *
 * 1. Notion DB にアラートページを作成（全アラート）
 * 2. 緊急アラート（escalation_surge, api_error の critical）のみ Slack にも送信
 */
async function sendAlert(
  env: Env,
  type: AlertType,
  severity: AlertSeverity,
  details: string,
): Promise<void> {
  // 1. Notion に記録（FIX-2 #4: 送信可否を握りつぶさず受け取る）
  const notionDelivered = await sendNotionAlert(env, type, severity, details).catch(
    (err) => {
      console.error(
        `[alert] Notion alert failed for ${type}:`,
        err instanceof Error ? err.message : err,
      );
      return false;
    },
  );

  const isCriticalSlack =
    CRITICAL_ALERT_TYPES.includes(type) && severity === "critical";

  // 2. 緊急アラートは Slack にも送信
  if (isCriticalSlack) {
    const slackText = `*[Alert] ${type.replace(/_/g, " ").toUpperCase()}* (${severity})\n${details}`;
    await sendSlackAlert(env, type, slackText).catch((err) => {
      console.error(`[alert] Slack alert failed for ${type}:`, err instanceof Error ? err.message : err);
    });
  } else if (!notionDelivered) {
    // FIX-2 #4: Notion への配信が「設定済みなのに失敗」した非緊急アラートを
    // 握りつぶさず Slack にフォールバック（監視の監視の穴を塞ぐ）。
    // 未設定スキップ時は notionDelivered=true のためここには来ない（ノイズ回避）。
    const fallbackText = `*[Alert:Notion配信失敗] ${type.replace(/_/g, " ").toUpperCase()}* (${severity})\n${details}\n(Notion Alerts DB への記録に失敗したため Slack に転送)`;
    await sendSlackAlert(env, type, fallbackText).catch((err) => {
      console.error(`[alert] Slack fallback failed for ${type}:`, err instanceof Error ? err.message : err);
    });
  }
}

// ---------------------------------------------------------------------------
// Notion Alert DB
// ---------------------------------------------------------------------------

/**
 * Notion API でアラートページを作成する。
 *
 * DB スキーマ（CX Agent Alerts DB）:
 * - Title (title): アラートタイプの日本語ラベル
 * - Type (select): escalation_surge / api_error / response_time / negative_feedback
 * - Severity (select): critical / warning / info
 * - Details (rich_text): アラートの詳細情報
 * - Timestamp (date): 発生日時
 */
async function sendNotionAlert(
  env: Env,
  type: AlertType,
  severity: AlertSeverity,
  details: string,
): Promise<boolean> {
  // 返り値: 配信成功 or 未設定スキップ = true / 設定済みだが送信失敗 = false（呼び出し側でフォールバック）
  if (!env.NOTION_TOKEN || !env.NOTION_ALERTS_DB_ID) {
    console.warn(
      `[alert] NOTION_TOKEN or NOTION_ALERTS_DB_ID is not set, skipping Notion alert for ${type}`,
    );
    return true;
  }

  const typeLabels: Record<AlertType, string> = {
    escalation_surge: "エスカレーション急増",
    api_error: "API エラー",
    response_time: "レスポンス時間劣化",
    negative_feedback: "ネガティブフィードバック",
  };

  const title = typeLabels[type] ?? type;
  const timestamp = new Date().toISOString();

  const body = {
    parent: { database_id: env.NOTION_ALERTS_DB_ID },
    properties: {
      Title: {
        title: [{ text: { content: title } }],
      },
      Type: {
        select: { name: type },
      },
      Severity: {
        select: { name: severity },
      },
      Details: {
        rich_text: [
          {
            text: {
              content: details.length > 2000 ? details.slice(0, 1997) + "..." : details,
            },
          },
        ],
      },
      Timestamp: {
        date: { start: timestamp },
      },
    },
  };

  try {
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown error");
      console.error(`[alert] Notion API error (${res.status}) for ${type}:`, errText);
      return false;
    }
    console.log(`[alert] Notion alert created: ${type} (${severity})`);
    return true;
  } catch (err) {
    console.error(
      `[alert] Failed to send Notion alert for ${type}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** 古いイベントを削除してメモリリークを防止 */
function pruneEvents<T extends TimestampedEvent>(
  events: T[],
  windowMs: number,
  now: number,
): void {
  const cutoff = now - windowMs;
  // 先頭から古いイベントを削除
  while (events.length > 0 && events[0].timestamp < cutoff) {
    events.shift();
  }
  // 安全弁: 最大1000件
  if (events.length > 1000) {
    events.splice(0, events.length - 1000);
  }
}

/** アラートがクールダウン中か判定 */
function isInCooldown(alertKey: string, now: number): boolean {
  const lastSent = lastAlertSent[alertKey];
  if (!lastSent) return false;
  return now - lastSent < ALERT_COOLDOWN_MS;
}

/** Slack Webhook でアラートを送信 */
async function sendSlackAlert(
  env: Env,
  alertType: string,
  text: string,
): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) {
    console.warn(
      `[alert] SLACK_WEBHOOK_URL is not set, skipping ${alertType} Slack alert`,
    );
    return;
  }

  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      console.error(
        `[alert] Slack notification failed for ${alertType}:`,
        await res.text(),
      );
    } else {
      console.log(`[alert] Slack notification sent: ${alertType}`);
    }
  } catch (err) {
    console.error(
      `[alert] Failed to send Slack notification for ${alertType}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
