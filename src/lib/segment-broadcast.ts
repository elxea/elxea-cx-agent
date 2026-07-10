/**
 * セグメント別自動配信（Cron Trigger）
 *
 * 月2回、Firestore の全ユーザーをペルソナ別にセグメント化し、
 * LINE multicast API でペルソナに合ったメッセージを配信する。
 *
 * 配信制約:
 * - 初回購入後24時間以内は配信しない
 * - 購入事実を直接参照しない（季節・シーン提案のみ）
 * - 月2回以下（LINE）
 * - LINE Messaging API のレート制限に準拠（multicast: 1リクエスト500人まで）
 *
 * 配信ログ:
 * - Firestore `broadcastLogs/{docId}` コレクションに記録
 * - 各ユーザーの `users/{id}/broadcastHistory/{docId}` にも記録
 */

import type { Env } from "../index";
import type { PersonaType, FirestoreEnv } from "./firestore";
import {
  getFirestoreEnv,
  getAccessToken,
  fromFirestoreValue,
  toFirestoreValue,
  firestoreBaseUrl,
} from "./firestore";
import { createSupabaseClient } from "./supabase";
import { selectTemplate, getCurrentSeason, type BroadcastTemplate } from "./broadcast-templates";

// ---------------------------------------------------------------------------
// 型定義
// ---------------------------------------------------------------------------

/** セグメント化されたユーザー */
type SegmentedUser = {
  lineUserId: string;
  shopifyCustomerId: string;
  persona: PersonaType;
  lastPurchaseAt: string | null;
  broadcastCountThisMonth: number;
};

/** 配信結果 */
export type BroadcastResult = {
  /** 配信実行日時 (ISO 8601) */
  executedAt: string;
  /** セグメント別配信数 */
  segments: {
    persona: PersonaType;
    userCount: number;
    templateId: string;
    success: boolean;
    error?: string;
  }[];
  /** 配信スキップ数（制約による除外） */
  skippedCount: number;
  /** 合計配信数 */
  totalDelivered: number;
};

/** Firestore runQuery で返るドキュメント */
type FirestoreQueryResult = {
  document?: {
    name: string;
    fields?: Record<string, Record<string, unknown>>;
  };
}[];

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** LINE multicast の最大宛先数（API 制限） */
const MULTICAST_MAX_RECIPIENTS = 500;

/** 初回購入後の配信抑止期間（ミリ秒） */
const PURCHASE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24時間

/** 月あたりの最大配信回数 */
const MAX_BROADCASTS_PER_MONTH = 2;


// ---------------------------------------------------------------------------
// ユーザーセグメント化
// ---------------------------------------------------------------------------

/**
 * Firestore の全ユーザーを取得し、ペルソナ別にセグメント化する。
 *
 * customer_linkages テーブル（Supabase）で LINE userId が紐付いている
 * ユーザーのみを対象とする（LINE 配信のため）。
 *
 * Firestore REST API の runQuery で persona.primary が設定済みの
 * ユーザーを取得する。
 */
async function getSegmentedUsers(
  env: Env,
  fsEnv: FirestoreEnv,
): Promise<{ users: SegmentedUser[]; errors: string[] }> {
  const errors: string[] = [];
  const supabase = createSupabaseClient(env);

  // 1. Supabase から LINE 紐付け済みユーザーを取得
  const { data: linkages, error: linkageError } = await supabase
    .from("customer_linkages")
    .select("line_user_id, shopify_customer_id")
    .not("line_user_id", "is", null);

  if (linkageError) {
    errors.push(`customer_linkages query error: ${linkageError.message}`);
    return { users: [], errors };
  }

  if (!linkages || linkages.length === 0) {
    return { users: [], errors };
  }

  // 2. Firestore runQuery で persona.primary が設定済みの全ユーザーを一括取得
  //    （N+1 クエリ回避: 個別ドキュメント取得 + orders クエリを廃止）
  const accessToken = await getAccessToken(fsEnv);
  const users: SegmentedUser[] = [];

  // LINE userId → shopifyCustomerId のマップを構築
  const lineUserMap = new Map<string, string>();
  for (const linkage of linkages) {
    if (linkage.line_user_id && linkage.shopify_customer_id) {
      lineUserMap.set(
        String(linkage.shopify_customer_id),
        linkage.line_user_id,
      );
    }
  }

  try {
    const queryUrl = `${firestoreBaseUrl(fsEnv.FIREBASE_PROJECT_ID)}:runQuery`;
    const queryRes = await fetch(queryUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "users", allDescendants: false }],
          // persona.primary が存在するユーザーのみ取得
          where: {
            fieldFilter: {
              field: { fieldPath: "persona.primary" },
              op: "NOT_EQUAL",
              value: { nullValue: null },
            },
          },
          limit: 500,
        },
      }),
    });

    if (!queryRes.ok) {
      const errText = await queryRes.text();
      errors.push(`Firestore runQuery error (${queryRes.status}): ${errText}`);
      return { users: [], errors };
    }

    const results = (await queryRes.json()) as FirestoreQueryResult;

    // 現在の年月（broadcastCountThisMonth リセット判定用）
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    for (const entry of results) {
      if (!entry.document?.name || !entry.document?.fields) continue;

      // ドキュメント名から shopifyCustomerId を取得
      const nameParts = entry.document.name.split("/");
      const shopifyId = nameParts[nameParts.length - 1];

      // LINE 紐付けがないユーザーはスキップ
      const lineUserId = lineUserMap.get(shopifyId);
      if (!lineUserId) continue;

      const fields = entry.document.fields;

      // persona.primary を取得
      const personaField = fields.persona;
      if (!personaField) continue;

      const personaMap = personaField.mapValue as {
        fields?: Record<string, Record<string, unknown>>;
      } | undefined;

      const primaryValue = personaMap?.fields?.primary;
      if (!primaryValue) continue;

      const persona = primaryValue.stringValue as PersonaType | undefined;
      if (!persona || !["serenity", "explorer", "sensory"].includes(persona)) {
        continue;
      }

      // デノーマライズされた lastPurchaseAt を参照（orders クエリ不要）
      const lastPurchaseAt = fields.lastPurchaseAt
        ? (fromFirestoreValue(fields.lastPurchaseAt) as string | null)
        : null;

      // デノーマライズされた broadcastCountThisMonth を参照
      let broadcastCountThisMonth = 0;
      const broadcastCountMonth = fields.broadcastCountMonth
        ? (fromFirestoreValue(fields.broadcastCountMonth) as string | null)
        : null;

      if (broadcastCountMonth === currentMonth && fields.broadcastCountThisMonth) {
        broadcastCountThisMonth = fromFirestoreValue(fields.broadcastCountThisMonth) as number;
      }
      // broadcastCountMonth が異なる月の場合、カウントは0（月替わりリセット）

      users.push({
        lineUserId,
        shopifyCustomerId: shopifyId,
        persona,
        lastPurchaseAt,
        broadcastCountThisMonth,
      });
    }
  } catch (err) {
    errors.push(
      `Firestore query error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { users, errors };
}

// ---------------------------------------------------------------------------
// 配信制約チェック
// ---------------------------------------------------------------------------

/**
 * ユーザーが配信対象かどうかを判定する。
 *
 * 除外条件:
 * 1. 初回購入後24時間以内
 * 2. 今月の配信回数が上限に達している（デノーマライズフィールド参照）
 */
function shouldDeliverToUser(
  user: SegmentedUser,
): { deliver: boolean; reason?: string } {
  // 制約1: 初回購入後24時間以内は配信しない
  if (user.lastPurchaseAt) {
    const purchaseTime = new Date(user.lastPurchaseAt).getTime();
    const now = Date.now();
    if (now - purchaseTime < PURCHASE_COOLDOWN_MS) {
      return { deliver: false, reason: "purchase_cooldown" };
    }
  }

  // 制約2: 月2回以下（デノーマライズされた broadcastCountThisMonth を使用）
  if (user.broadcastCountThisMonth >= MAX_BROADCASTS_PER_MONTH) {
    return { deliver: false, reason: "monthly_limit_reached" };
  }

  return { deliver: true };
}

// ---------------------------------------------------------------------------
// 今月の配信回数取得
// ---------------------------------------------------------------------------

/**
 * Firestore から今月の配信回数を取得する。
 * broadcastLogs コレクションの今月分をカウント。
 */
async function getMonthlyBroadcastCount(
  fsEnv: FirestoreEnv,
): Promise<number> {
  const accessToken = await getAccessToken(fsEnv);
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const url = `${firestoreBaseUrl(fsEnv.FIREBASE_PROJECT_ID)}:runQuery`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "broadcastLogs", allDescendants: false }],
        where: {
          fieldFilter: {
            field: { fieldPath: "executedAt" },
            op: "GREATER_THAN_OR_EQUAL",
            value: { stringValue: monthStart },
          },
        },
      },
      parent: `projects/${fsEnv.FIREBASE_PROJECT_ID}/databases/(default)/documents`,
    }),
  });

  if (!res.ok) return 0;

  const results = (await res.json()) as FirestoreQueryResult;
  return results.filter((r) => r.document?.fields).length;
}


// ---------------------------------------------------------------------------
// LINE multicast 送信
// ---------------------------------------------------------------------------

/**
 * LINE multicast API で複数ユーザーにメッセージを送信する。
 *
 * multicast は最大500人。超える場合はバッチに分割する。
 * https://developers.line.biz/en/reference/messaging-api/#send-multicast-message
 */
async function lineMulticast(
  userIds: string[],
  text: string,
  env: Env,
): Promise<{ success: boolean; error?: string }> {
  if (userIds.length === 0) {
    return { success: true };
  }

  // 500人ずつバッチに分割
  const batches: string[][] = [];
  for (let i = 0; i < userIds.length; i += MULTICAST_MAX_RECIPIENTS) {
    batches.push(userIds.slice(i, i + MULTICAST_MAX_RECIPIENTS));
  }

  const errors: string[] = [];

  for (const batch of batches) {
    try {
      const res = await fetch(
        "https://api.line.me/v2/bot/message/multicast",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
          body: JSON.stringify({
            to: batch,
            messages: [{ type: "text", text }],
          }),
        },
      );

      if (!res.ok) {
        const errText = await res.text().catch(() => "unknown");
        errors.push(`multicast batch failed (${res.status}): ${errText}`);
      }
    } catch (err) {
      errors.push(
        `multicast exception: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (errors.length > 0) {
    return { success: false, error: errors.join("; ") };
  }

  return { success: true };
}

// ---------------------------------------------------------------------------
// 配信ログ記録
// ---------------------------------------------------------------------------

/**
 * 配信ログを Firestore に記録する。
 *
 * - broadcastLogs/{autoId}: 全体の配信ログ
 * - users/{shopifyId}/broadcastHistory/{autoId}: ユーザー別の配信履歴
 */
async function recordBroadcastLog(
  result: BroadcastResult,
  deliveredUsers: Array<{ shopifyCustomerId: string; templateId: string }>,
  fsEnv: FirestoreEnv,
): Promise<void> {
  const accessToken = await getAccessToken(fsEnv);

  // 1. 全体ログ
  const logFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    logFields[key] = toFirestoreValue(value);
  }

  await fetch(
    `${firestoreBaseUrl(fsEnv.FIREBASE_PROJECT_ID)}/broadcastLogs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fields: logFields }),
    },
  ).catch((err) => {
    console.error("[broadcast] Failed to write broadcastLogs:", err);
  });

  // 2. ユーザー別の配信履歴をバッチ書き込み（Firestore commit エンドポイント）
  //    broadcastCountThisMonth のインクリメントは transform が commit では使えないため
  //    プロファイル読み取り → パッチに分割する。バッチ書き込みは最大500件/commit。
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const databasePath = `projects/${fsEnv.FIREBASE_PROJECT_ID}/databases/(default)`;
  const commitUrl = `https://firestore.googleapis.com/v1/${databasePath}/documents:commit`;

  // バッチサイズ上限（Firestore commit API は 500 writes/commit）
  const BATCH_SIZE = 500;

  // broadcastHistory の書き込みをバッチ化
  for (let i = 0; i < deliveredUsers.length; i += BATCH_SIZE) {
    const batch = deliveredUsers.slice(i, i + BATCH_SIZE);
    const writes = batch.map(({ shopifyCustomerId, templateId }) => ({
      update: {
        name: `${databasePath}/documents/users/${shopifyCustomerId}/broadcastHistory/${crypto.randomUUID()}`,
        fields: {
          deliveredAt: toFirestoreValue(result.executedAt),
          templateId: toFirestoreValue(templateId),
        },
      },
    }));

    await fetch(commitUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ writes }),
    }).catch((err) => {
      console.warn(`[broadcast] Failed to commit broadcastHistory batch (offset=${i}):`, err);
    });
  }

  // broadcastCountThisMonth のインクリメント（プロファイル読み取りが必要なため並列実行）
  const countUpdatePromises = deliveredUsers.map(async ({ shopifyCustomerId }) => {
    try {
      const profileUrl = `${firestoreBaseUrl(fsEnv.FIREBASE_PROJECT_ID)}/users/${shopifyCustomerId}`;
      const profileRes = await fetch(profileUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });

      let newCount = 1;
      if (profileRes.ok) {
        const profileDoc = (await profileRes.json()) as {
          fields?: Record<string, Record<string, unknown>>;
        };
        const existingMonth = profileDoc.fields?.broadcastCountMonth
          ? (fromFirestoreValue(profileDoc.fields.broadcastCountMonth) as string)
          : null;
        if (existingMonth === currentMonth && profileDoc.fields?.broadcastCountThisMonth) {
          newCount = (fromFirestoreValue(profileDoc.fields.broadcastCountThisMonth) as number) + 1;
        }
      }

      const updateFields = {
        broadcastCountThisMonth: toFirestoreValue(newCount),
        broadcastCountMonth: toFirestoreValue(currentMonth),
      };

      await fetch(
        `${profileUrl}?updateMask.fieldPaths=broadcastCountThisMonth&updateMask.fieldPaths=broadcastCountMonth`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ fields: updateFields }),
        },
      );
    } catch (err) {
      console.warn(`[broadcast] Failed to update broadcastCount for ${shopifyCustomerId}:`, err);
    }
  });

  await Promise.allSettled(countUpdatePromises);
}

// ---------------------------------------------------------------------------
// メインエントリポイント
// ---------------------------------------------------------------------------

/**
 * セグメント別自動配信を実行する。
 *
 * Cloudflare Workers の scheduled handler から呼ばれる。
 * 月2回（1日と15日）に実行される前提。
 *
 * @param env Cloudflare Workers 環境変数
 * @returns 配信結果
 */
export async function runSegmentBroadcast(env: Env): Promise<BroadcastResult> {
  const executedAt = new Date().toISOString();
  const result: BroadcastResult = {
    executedAt,
    segments: [],
    skippedCount: 0,
    totalDelivered: 0,
  };

  // ── T10 退役（設計 §9）───────────────────────────────────────────────
  // コード直書きテンプレート配信は Notion駆動 配信（delivery-orchestrator）へ移行済み。
  // cron-off だけでは再活性フットガンが残るため、コードレベルで no-op 化する。
  // 明示的に LEGACY_SEGMENT_BROADCAST_ENABLED="true" が設定された場合のみ旧経路を通す。
  if (env.LEGACY_SEGMENT_BROADCAST_ENABLED !== "true") {
    console.warn(
      "[broadcast] runSegmentBroadcast is retired (T10). " +
        "Notion駆動配信(delivery-orchestrator)へ移行済み。実行せず即 return。",
    );
    return result;
  }

  // Firebase credentials チェック
  let fsEnv: FirestoreEnv;
  try {
    fsEnv = getFirestoreEnv(env);
  } catch {
    console.error("[broadcast] Firebase credentials not configured, skipping");
    return result;
  }

  // 今月の全体配信回数チェック
  const monthlyCount = await getMonthlyBroadcastCount(fsEnv);
  if (monthlyCount >= MAX_BROADCASTS_PER_MONTH) {
    console.log(`[broadcast] Monthly broadcast limit reached (${monthlyCount}/${MAX_BROADCASTS_PER_MONTH}), skipping`);
    return result;
  }

  // ユーザーセグメント化
  const { users, errors } = await getSegmentedUsers(env, fsEnv);
  if (errors.length > 0) {
    console.warn("[broadcast] Segmentation errors:", errors);
  }

  if (users.length === 0) {
    console.log("[broadcast] No eligible users found, skipping");
    return result;
  }

  // ペルソナ別にグループ化
  const personaGroups = new Map<PersonaType, SegmentedUser[]>();
  for (const user of users) {
    const group = personaGroups.get(user.persona) ?? [];
    group.push(user);
    personaGroups.set(user.persona, group);
  }

  const season = getCurrentSeason();
  const deliveredUsers: Array<{ shopifyCustomerId: string; templateId: string }> = [];

  // 各ペルソナグループに配信
  for (const [persona, groupUsers] of personaGroups) {
    // テンプレート選択
    const template: BroadcastTemplate = selectTemplate(persona, season);

    // 配信制約フィルタ（デノーマライズされた broadcastCountThisMonth を使用）
    const eligibleUserIds: string[] = [];
    for (const user of groupUsers) {
      const { deliver, reason } = shouldDeliverToUser(user);

      if (deliver) {
        eligibleUserIds.push(user.lineUserId);
        deliveredUsers.push({
          shopifyCustomerId: user.shopifyCustomerId,
          templateId: template.id,
        });
      } else {
        result.skippedCount++;
        console.log(
          `[broadcast] Skipped user ${user.shopifyCustomerId}: ${reason}`,
        );
      }
    }

    // LINE multicast 送信
    if (eligibleUserIds.length > 0) {
      const sendResult = await lineMulticast(
        eligibleUserIds,
        template.text,
        env,
      );

      result.segments.push({
        persona,
        userCount: eligibleUserIds.length,
        templateId: template.id,
        success: sendResult.success,
        error: sendResult.error,
      });

      if (sendResult.success) {
        result.totalDelivered += eligibleUserIds.length;
      }
    } else {
      result.segments.push({
        persona,
        userCount: 0,
        templateId: template.id,
        success: true,
      });
    }
  }

  // 配信ログ記録
  await recordBroadcastLog(result, deliveredUsers, fsEnv);

  console.log(
    `[broadcast] Completed: ${result.totalDelivered} delivered, ${result.skippedCount} skipped`,
  );

  return result;
}
