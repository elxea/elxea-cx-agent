/**
 * Firestore REST API クライアント（Edge runtime 対応）
 *
 * Cloudflare Workers では firebase-admin SDK が動作しないため、
 * Firestore REST API + jose ライブラリによる JWT 認証を使用する。
 *
 * 環境変数（Cloudflare Workers Secrets）:
 *   FIREBASE_PROJECT_ID    — Firebase プロジェクト ID
 *   FIREBASE_CLIENT_EMAIL  — サービスアカウントのメールアドレス
 *   FIREBASE_PRIVATE_KEY   — サービスアカウントの秘密鍵（PEM 形式）
 */

import { SignJWT, importPKCS8 } from "jose";
import type { Env } from "../index";
import type { PreferenceSignals } from "./preference-extractor";

// ---------------------------------------------------------------------------
// 型定義（elxea-web-app の types.ts に準拠）
// ---------------------------------------------------------------------------

export type PersonaType = "serenity" | "explorer" | "sensory";
export type DepthLevel = "entry" | "explore" | "deep";
export type MembershipTier = "none" | "standard" | "premium";

export type PersonaScores = {
  serenity: number;
  explorer: number;
  sensory: number;
};

export type PersonaProfile = {
  primary: PersonaType | null;
  scores: PersonaScores;
  lastUpdated: string; // ISO 8601
};

export type TasteProfile = {
  preferredCategories: string[];
  flavorPreferences: string[];
  scenePref: string | null;
};

export type OnboardingStatus = {
  completedAt: string | null;
  initialAction: "view_tea" | "explore_tea" | "about" | "howto" | "none" | null;
  /** 友だち追加の流入元。pkg_{product_slug} = QR同梱物経由、brand_card = ブランドカード、direct = 通常追加 */
  source?: string | null;
  twoWeekQuestionAnswered?: boolean;
  twoWeekAnswer?: string | null;
};

export type CustomerProfile = {
  lineUserId?: string | null;
  email?: string;
  displayName?: string;
  membershipTier?: MembershipTier;
  persona?: PersonaProfile;
  depthLevel?: DepthLevel;
  tasteProfile?: TasteProfile;
  onboarding?: OnboardingStatus;
  createdAt?: string;
  lastActiveAt?: string;
  /** 最終購入日時 (ISO 8601) — 注文 webhook で更新されるデノーマライズフィールド */
  lastPurchaseAt?: string | null;
  /** 今月の配信受信回数 — broadcastHistory 書き込み時にインクリメント */
  broadcastCountThisMonth?: number;
  /** broadcastCountThisMonth のリセット対象月 (YYYY-MM) */
  broadcastCountMonth?: string;
};

export type BehaviorAction =
  | "tap_button"
  | "view_content"
  | "view_product"
  | "purchase"
  | "line_message"
  | "search"
  | "tea_mention"
  | "flavor_preference"
  | "topic_interest"
  | "chat_started"
  | "product_viewed"
  | "cart_link_clicked"
  | "feedback_given"
  | "survey_completed";

export type BehaviorChannel = "line" | "web";

export type BehaviorEventMetadata = {
  contentId?: string;
  productId?: string;
  query?: string;
  buttonLabel?: string;
};

export type BehaviorEvent = {
  action: BehaviorAction;
  channel: BehaviorChannel;
  metadata: BehaviorEventMetadata;
  personaSignal: PersonaType | null;
  createdAt: string; // ISO 8601
};

// ---------------------------------------------------------------------------
// Firestore REST API ヘルパー
// ---------------------------------------------------------------------------

/** Firestore REST API エンドポイント */
export function firestoreBaseUrl(projectId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

// ---------------------------------------------------------------------------
// アクセストークンキャッシュ（C-1 修正）
// モジュールレベルでキャッシュし、有効期限 - 60秒マージンまで再利用する。
// Cloudflare Workers では同一 isolate 内で有効。
// ---------------------------------------------------------------------------
let cachedToken: string | null = null;
let cachedTokenExpiresAt = 0; // Unix ms

/** サービスアカウントから OAuth2 アクセストークンを取得（JWT → Google OAuth2） */
export async function getAccessToken(env: FirestoreEnv): Promise<string> {
  // キャッシュが有効ならそのまま返す（60秒のマージンを確保）
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const { FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = env;

  // 秘密鍵は Cloudflare Secrets で \n が文字列になっているため変換
  const privateKey = FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");

  const key = await importPKCS8(privateKey, "RS256");

  const nowSec = Math.floor(now / 1000);
  const jwt = await new SignJWT({
    scope: "https://www.googleapis.com/auth/datastore",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(FIREBASE_CLIENT_EMAIL)
    .setSubject(FIREBASE_CLIENT_EMAIL)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + 3600)
    .sign(key);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Failed to get Firebase access token: ${err}`);
  }

  const tokenData = (await tokenRes.json()) as {
    access_token: string;
    expires_in?: number;
  };

  // キャッシュに保存（expires_in が返されない場合は 3600秒と仮定、60秒マージン）
  const expiresInMs = ((tokenData.expires_in ?? 3600) - 60) * 1000;
  cachedToken = tokenData.access_token;
  cachedTokenExpiresAt = now + expiresInMs;

  return cachedToken;
}

// ---------------------------------------------------------------------------
// Firestore 値変換ユーティリティ
// ---------------------------------------------------------------------------

/** JavaScript 値を Firestore Value 形式に変換 */
export function toFirestoreValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { integerValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return {
      arrayValue: {
        values: value.map((v) => toFirestoreValue(v)),
      },
    };
  }
  if (typeof value === "object") {
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = toFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

/** Firestore ドキュメントフィールドを JavaScript オブジェクトに変換 */
export function fromFirestoreFields(
  fields: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    result[key] = fromFirestoreValue(value);
  }
  return result;
}

/** Firestore Value を JavaScript 値に変換 */
export function fromFirestoreValue(value: Record<string, unknown>): unknown {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("stringValue" in value) return value.stringValue;
  if ("timestampValue" in value) return value.timestampValue; // ISO 8601 文字列として返す
  if ("arrayValue" in value) {
    const arr = value.arrayValue as { values?: Array<Record<string, unknown>> };
    return (arr.values ?? []).map(fromFirestoreValue);
  }
  if ("mapValue" in value) {
    const map = value.mapValue as {
      fields?: Record<string, Record<string, unknown>>;
    };
    return fromFirestoreFields(map.fields ?? {});
  }
  return null;
}

// ---------------------------------------------------------------------------
// Firestore Env 型（Env の部分型）
// ---------------------------------------------------------------------------

export type FirestoreEnv = {
  FIREBASE_PROJECT_ID: string;
  FIREBASE_CLIENT_EMAIL: string;
  FIREBASE_PRIVATE_KEY: string;
};

/** Env から FirestoreEnv を安全に取り出す */
export function getFirestoreEnv(env: Env): FirestoreEnv {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } =
    env as Env & FirestoreEnv;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error(
      "Missing Firebase credentials: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY are required",
    );
  }
  return { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY };
}

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------

/** shopifyCustomerId が数値のみで構成されることを検証（M-4 修正） */
function validateShopifyCustomerId(id: string): void {
  if (!/^\d+$/.test(id)) {
    throw new Error(
      `Invalid shopifyCustomerId: expected numeric string, got "${id}"`,
    );
  }
}

// ---------------------------------------------------------------------------
// CRUD 関数
// ---------------------------------------------------------------------------

/**
 * Firestore から顧客プロファイルを取得。
 *
 * @param shopifyCustomerId Shopify の数値顧客 ID（GID の末尾数値部分）
 * @returns CustomerProfile または null（ドキュメントが存在しない場合）
 */
export async function getCustomerProfile(
  shopifyCustomerId: string,
  env: FirestoreEnv,
): Promise<CustomerProfile | null> {
  validateShopifyCustomerId(shopifyCustomerId);
  const { FIREBASE_PROJECT_ID } = env;
  const accessToken = await getAccessToken(env);
  const url = `${firestoreBaseUrl(FIREBASE_PROJECT_ID)}/users/${shopifyCustomerId}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (res.status === 404) {
    return null;
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore GET error (${res.status}): ${err}`);
  }

  const doc = (await res.json()) as {
    fields?: Record<string, Record<string, unknown>>;
  };

  if (!doc.fields) {
    return {};
  }

  return fromFirestoreFields(doc.fields) as CustomerProfile;
}

/**
 * Firestore の顧客プロファイルを更新（PATCH = 部分更新）。
 *
 * @param shopifyCustomerId Shopify の数値顧客 ID
 * @param updates 更新するフィールドのみを含むオブジェクト
 */
export async function updateCustomerProfile(
  shopifyCustomerId: string,
  updates: Partial<CustomerProfile>,
  env: FirestoreEnv,
): Promise<void> {
  validateShopifyCustomerId(shopifyCustomerId);
  const { FIREBASE_PROJECT_ID } = env;
  const accessToken = await getAccessToken(env);

  // 更新するフィールドのキー一覧（updateMask 用）
  const updateMaskFields = Object.keys(updates)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");

  const url = `${firestoreBaseUrl(FIREBASE_PROJECT_ID)}/users/${shopifyCustomerId}?${updateMaskFields}`;

  // Firestore ドキュメント形式に変換
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields[key] = toFirestoreValue(value);
    }
  }

  const body = JSON.stringify({ fields });

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore PATCH error (${res.status}): ${err}`);
  }
}

/**
 * behaviorLog サブコレクションにイベントを追加。
 *
 * @param shopifyCustomerId Shopify の数値顧客 ID
 * @param event 追加するイベント
 */
export async function addBehaviorEvent(
  shopifyCustomerId: string,
  event: BehaviorEvent,
  env: FirestoreEnv,
): Promise<void> {
  validateShopifyCustomerId(shopifyCustomerId);
  const { FIREBASE_PROJECT_ID } = env;
  const accessToken = await getAccessToken(env);

  // POST でオートID ドキュメントを生成
  const url = `${firestoreBaseUrl(FIREBASE_PROJECT_ID)}/users/${shopifyCustomerId}/behaviorLog`;

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (value !== undefined) {
      fields[key] = toFirestoreValue(value);
    }
  }

  const body = JSON.stringify({ fields });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore POST (behaviorLog) error (${res.status}): ${err}`);
  }
}

/**
 * behaviorLog から直近の N 件を取得。
 *
 * Firestore REST の runQuery を使用して降順ソート + limit を実現。
 *
 * @param shopifyCustomerId Shopify の数値顧客 ID
 * @param limit 取得件数（デフォルト 20）
 */
export async function getRecentBehaviors(
  shopifyCustomerId: string,
  env: FirestoreEnv,
  limit = 20,
): Promise<BehaviorEvent[]> {
  validateShopifyCustomerId(shopifyCustomerId);
  const { FIREBASE_PROJECT_ID } = env;
  const accessToken = await getAccessToken(env);

  const url = `${firestoreBaseUrl(FIREBASE_PROJECT_ID)}:runQuery`;

  const body = JSON.stringify({
    structuredQuery: {
      from: [
        {
          collectionId: "behaviorLog",
          allDescendants: false,
        },
      ],
      where: {
        fieldFilter: {
          field: { fieldPath: "__name__" },
          op: "GREATER_THAN_OR_EQUAL",
          value: {
            referenceValue: `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${shopifyCustomerId}/behaviorLog/\0`,
          },
        },
      },
      orderBy: [
        {
          field: { fieldPath: "createdAt" },
          direction: "DESCENDING",
        },
      ],
      limit,
    },
    parent: `projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${shopifyCustomerId}`,
  });

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore runQuery error (${res.status}): ${err}`);
  }

  const results = (await res.json()) as Array<{
    document?: { fields?: Record<string, Record<string, unknown>> };
  }>;

  return results
    .filter((r) => r.document?.fields)
    .map((r) => fromFirestoreFields(r.document!.fields!) as BehaviorEvent);
}

// ---------------------------------------------------------------------------
// Convenience: recordBehaviorEvent (fire-and-forget 用)
// ---------------------------------------------------------------------------

/**
 * 行動イベントを記録する高レベルヘルパー。
 *
 * Shopify Customer ID の解決 → addBehaviorEvent を一貫して行う。
 * 紐付けされていないユーザーの場合は何もしない（silent skip）。
 *
 * @param userId LINE user ID or web session ID
 * @param channel "line" | "web"
 * @param action BehaviorAction
 * @param metadata イベントメタデータ
 * @param env Env (Firestore + Supabase credentials)
 * @param supabase 既に作成済みの Supabase クライアント（省略時は内部で作成）
 */
export async function recordBehaviorEvent(
  userId: string,
  channel: BehaviorChannel,
  action: BehaviorAction,
  metadata: BehaviorEventMetadata,
  env: FirestoreEnv & { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string },
  supabase?: ReturnType<typeof import("./supabase").createSupabaseClient>,
): Promise<void> {
  // Firestore credentials がなければスキップ
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    return;
  }

  // Supabase クライアント（渡されなければ動的 import を回避し throw）
  if (!supabase) {
    console.warn("[recordBehaviorEvent] supabase client required but not provided, skipping");
    return;
  }

  // customer_linkages から Shopify Customer ID を解決
  const column = channel === "line" ? "line_user_id" : "shopify_customer_id";
  const { data: linkage } = await supabase
    .from("customer_linkages")
    .select("shopify_customer_id")
    .eq(column, userId)
    .single();

  if (!linkage?.shopify_customer_id) {
    // 紐付けなし — イベント記録をスキップ
    return;
  }

  const shopifyId = String(linkage.shopify_customer_id);

  const event: BehaviorEvent = {
    action,
    channel,
    metadata,
    personaSignal: null,
    createdAt: new Date().toISOString(),
  };

  await addBehaviorEvent(shopifyId, event, env);
}

// ---------------------------------------------------------------------------
// TasteProfile / PersonaProfile 更新（嗜好抽出パイプライン用）
// ---------------------------------------------------------------------------

/**
 * 嗜好シグナルを既存の TasteProfile / PersonaProfile にマージして更新する。
 *
 * 上書きではなく追記（union）方式:
 * - preferredCategories, flavorPreferences: 既存リストに新規値を追加（重複排除）
 * - scenePref: 新しい値があれば上書き（最新の関心シーンを反映）
 * - persona scores: シグナルごとに +1 加算し、primary を再計算
 *
 * @param shopifyCustomerId Shopify 顧客 ID
 * @param signals 抽出された嗜好シグナル
 * @param existingProfile 現在の顧客プロファイル（null 可）
 * @param env Firestore 環境変数
 */
export async function updateTasteProfile(
  shopifyCustomerId: string,
  signals: PreferenceSignals,
  existingProfile: CustomerProfile | null,
  env: FirestoreEnv,
): Promise<Partial<CustomerProfile>> {
  const updates: Partial<CustomerProfile> = {};

  // --- TasteProfile マージ ---
  const existingTaste = existingProfile?.tasteProfile ?? {
    preferredCategories: [],
    flavorPreferences: [],
    scenePref: null,
  };

  // 配列上限（unbounded growth 防止）
  const MAX_ARRAY_SIZE = 50;

  // preferredCategories: 既存 + 新規（重複排除、上限50件 — 超過時は古いものから削除）
  const mergedCategories = [
    ...new Set([
      ...existingTaste.preferredCategories,
      ...signals.preferred_categories,
    ]),
  ].slice(-MAX_ARRAY_SIZE);

  // flavorPreferences: 既存 + 新規（重複排除、上限50件 — 超過時は古いものから削除）
  const mergedFlavors = [
    ...new Set([
      ...existingTaste.flavorPreferences,
      ...signals.flavor_preferences,
    ]),
  ].slice(-MAX_ARRAY_SIZE);

  // scenePref: 新しいシーンがあれば最初のものを採用
  const scenePref =
    signals.scene_preferences.length > 0
      ? signals.scene_preferences[0]
      : existingTaste.scenePref;

  updates.tasteProfile = {
    preferredCategories: mergedCategories,
    flavorPreferences: mergedFlavors,
    scenePref,
  };

  // --- PersonaProfile マージ ---
  if (signals.persona_signals.length > 0) {
    const existingPersona = existingProfile?.persona ?? {
      primary: null,
      scores: { serenity: 0, explorer: 0, sensory: 0 },
      lastUpdated: new Date().toISOString(),
    };

    const scores = { ...existingPersona.scores };

    // 各シグナルに +1
    for (const signal of signals.persona_signals) {
      scores[signal] = (scores[signal] ?? 0) + 1;
    }

    // primary を再計算（最大スコアのペルソナ）
    const primary = (
      Object.entries(scores) as Array<[PersonaType, number]>
    ).reduce((a, b) => (b[1] > a[1] ? b : a))[0];

    updates.persona = {
      primary,
      scores,
      lastUpdated: new Date().toISOString(),
    };
  }

  // lastActiveAt を更新
  updates.lastActiveAt = new Date().toISOString();

  await updateCustomerProfile(shopifyCustomerId, updates, env);

  // 更新後のプロファイルを返す（Shopify 同期トリガー用）
  return updates;
}
