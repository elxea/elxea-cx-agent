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
  /**
   * 定期便（サブスク）会員フラグ — 注文 webhook の定期便判定で更新されるデノーマライズフィールド。
   * 出し分け・配信の入力に使う（実際の描画は web-app 側）。true=定期便あり / false or 未設定=通常。
   */
  isSubscriber?: boolean;
  /** isSubscriber を最後に更新した日時 (ISO 8601)。 */
  subscriberUpdatedAt?: string | null;
  /** 今月の配信受信回数 — broadcastHistory 書き込み時にインクリメント */
  broadcastCountThisMonth?: number;
  /** broadcastCountThisMonth のリセット対象月 (YYYY-MM) */
  broadcastCountMonth?: string;
};

/**
 * 未連携（LINE userId ↔ Shopify 顧客 ID 未解決）ユーザーのカルテ。
 *
 * 背景（UX レビュー指摘 #2）: 買い切り・未連携のユーザーは Shopify 顧客 ID が無いため
 * `users/{shopifyCustomerId}` に紐づけられず、診断・会話由来のペルソナスコアが従来は
 * どこにも貯まらなかった（silent skip）。本レコードは LINE userId をキーにした別コレクション
 * `lineUsers/{lineUserId}` に、既存カルテ（CustomerProfile）と同種の persona 情報だけを保持する。
 *
 * プライバシー: 保持するのは既存カルテと同種の好みスコア・タイプ・タイムスタンプのみ。
 * 新たな個人情報は保存しない（lineUserId はドキュメントキーであり、既存の customer_linkages
 * でも識別子として使われている既存情報。氏名・住所・注文内容などは一切持たない）。
 *
 * 将来マージ（今回スコープ外・TODO）: 後日 Shopify 連携が成立したら、この
 * `lineUsers/{lineUserId}.persona.scores` を `users/{shopifyCustomerId}.persona.scores` へ
 * `mergePersonaScores` 系の「別軸への累積加算」流儀で統合し、`mergedToShopify=true` を立てる
 * （or レコード削除）。自動マージ処理は本タスクでは実装しない。構造だけ統合可能にしてある。
 */
export type LineUserProfile = {
  /** LINE userId（= ドキュメントキーの写し。将来マージ処理の可読性のため保持）。 */
  lineUserId?: string;
  /** 好み（ペルソナ）— CustomerProfile.persona と同一構造。 */
  persona?: PersonaProfile;
  /** 会話由来の嗜好 — CustomerProfile.tasteProfile と同一構造（将来拡張用・現状は persona のみ書く）。 */
  tasteProfile?: TasteProfile;
  createdAt?: string;
  lastActiveAt?: string;
  /**
   * 将来 Shopify 連携時にこのレコードを users/{shopifyId} へ統合したら true にする（TODO）。
   * 未マージ = false / 未設定。
   */
  mergedToShopify?: boolean;
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

// ---------------------------------------------------------------------------
// 未連携ユーザーのカルテ（lineUsers/{lineUserId}）— UX レビュー指摘 #2
// 既存 users/{shopifyCustomerId} と同じ低レベル I/O（getAccessToken / toFirestoreValue /
// fromFirestoreFields）を共有しつつ、コレクションとキー検証だけを差し替える。
// ---------------------------------------------------------------------------

/** 未連携カルテのコレクション名。 */
export const LINE_USERS_COLLECTION = "lineUsers";

/**
 * lineUserId が LINE Messaging API の userId 形式（"U" + 32 桁 16 進）であることを検証する。
 * Firestore REST の URL パスにそのまま埋め込むため、パストラバーサル（"/" 等）を構造的に排除する。
 */
function validateLineUserId(id: string): void {
  if (!/^U[0-9a-fA-F]{32}$/.test(id)) {
    throw new Error(
      `Invalid lineUserId: expected LINE user id (U + 32 hex), got "${id.slice(0, 8)}..."`,
    );
  }
}

/**
 * 未連携ユーザーのカルテを取得（lineUsers/{lineUserId}）。
 * @returns LineUserProfile または null（ドキュメント不在）
 */
export async function getLineUserProfile(
  lineUserId: string,
  env: FirestoreEnv,
): Promise<LineUserProfile | null> {
  validateLineUserId(lineUserId);
  const { FIREBASE_PROJECT_ID } = env;
  const accessToken = await getAccessToken(env);
  const url = `${firestoreBaseUrl(FIREBASE_PROJECT_ID)}/${LINE_USERS_COLLECTION}/${lineUserId}`;

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
    throw new Error(`Firestore GET (lineUsers) error (${res.status}): ${err}`);
  }

  const doc = (await res.json()) as {
    fields?: Record<string, Record<string, unknown>>;
  };
  if (!doc.fields) {
    return {};
  }
  return fromFirestoreFields(doc.fields) as LineUserProfile;
}

/**
 * 未連携ユーザーのカルテを更新（PATCH = 部分更新・updateMask 指定フィールドのみ）。
 * ドキュメント不在時は Firestore REST の PATCH が upsert として作成する（users と同挙動）。
 */
export async function updateLineUserProfile(
  lineUserId: string,
  updates: Partial<LineUserProfile>,
  env: FirestoreEnv,
): Promise<void> {
  validateLineUserId(lineUserId);
  const { FIREBASE_PROJECT_ID } = env;
  const accessToken = await getAccessToken(env);

  const updateMaskFields = Object.keys(updates)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");
  const url = `${firestoreBaseUrl(FIREBASE_PROJECT_ID)}/${LINE_USERS_COLLECTION}/${lineUserId}?${updateMaskFields}`;

  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields[key] = toFirestoreValue(value);
    }
  }

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore PATCH (lineUsers) error (${res.status}): ${err}`);
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
// PersonaScore マージ（純粋関数 — I/O なし・完全にユニットテスト可能）
// ---------------------------------------------------------------------------

/**
 * ペルソナシグナルを既存スコアに「加算」してマージする（純粋）。
 *
 * 重要（属性整合の要）: これは「上書き」ではなく「別軸への累積加算」である。
 * - 各ペルソナ軸（serenity / explorer / sensory）は独立に累積する。
 * - 会話由来（weight=1）と購入由来（weight=3）は同じ軸に足し込まれるだけで、
 *   一方が他方を消すことはない（例: 会話で serenity+1 済みのユーザーが explorer 商品を
 *   購入しても serenity は保持され、explorer に +3 されるだけ）。
 * - primary は「最大スコアの軸」を再計算するだけ（tie は先勝ち = Object.entries 順）。
 *
 * この不変条件により「購入判定が会話シグナルを上書きする」事故を構造的に防ぐ。
 *
 * @param existingScores 既存のペルソナスコア
 * @param personaSignals 今回のシグナル（重複含みうる。含まれた回数だけ加算する）
 * @param weight シグナル 1 件あたりの加算値（会話=1 / 購入=3）
 */
export function mergePersonaScores(
  existingScores: PersonaScores,
  personaSignals: PersonaType[],
  weight: number,
): { scores: PersonaScores; primary: PersonaType } {
  const scores: PersonaScores = { ...existingScores };

  // 各シグナルに +weight（既存軸は保持したまま加算 = 上書きしない）
  for (const signal of personaSignals) {
    scores[signal] = (scores[signal] ?? 0) + weight;
  }

  // primary を再計算（最大スコアの軸）。
  const primary = (
    Object.entries(scores) as Array<[PersonaType, number]>
  ).reduce((a, b) => (b[1] > a[1] ? b : a))[0];

  return { scores, primary };
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
 * @param weight シグナルごとのスコア加算値（デフォルト 1。購入データは 3）
 */
/**
 * 嗜好シグナルを既存 taste/persona にマージした更新差分を計算する（純粋・I/O なし）。
 *
 * users（連携済み）と lineUsers（未連携・P0-6）の両方が同一ロジックで書けるよう I/O から切り出した。
 * - tasteProfile: preferredCategories / flavorPreferences は union（上限50・古いものから削除）、
 *   scenePref は新規があれば先頭を採用。
 * - persona: signals.persona_signals があれば mergePersonaScores で「別軸に累積加算」（weight 反映）。
 * - lastActiveAt を常に更新。
 */
export function computeTasteProfileUpdates(
  signals: PreferenceSignals,
  existingTaste: TasteProfile | undefined,
  existingPersona: PersonaProfile | undefined,
  weight = 1,
): { tasteProfile: TasteProfile; persona?: PersonaProfile; lastActiveAt: string } {
  const now = new Date().toISOString();
  const taste = existingTaste ?? {
    preferredCategories: [],
    flavorPreferences: [],
    scenePref: null,
  };
  const MAX_ARRAY_SIZE = 50;

  const mergedCategories = [
    ...new Set([...taste.preferredCategories, ...signals.preferred_categories]),
  ].slice(-MAX_ARRAY_SIZE);
  const mergedFlavors = [
    ...new Set([...taste.flavorPreferences, ...signals.flavor_preferences]),
  ].slice(-MAX_ARRAY_SIZE);
  const scenePref =
    signals.scene_preferences.length > 0
      ? signals.scene_preferences[0]
      : taste.scenePref;

  const result: { tasteProfile: TasteProfile; persona?: PersonaProfile; lastActiveAt: string } = {
    tasteProfile: {
      preferredCategories: mergedCategories,
      flavorPreferences: mergedFlavors,
      scenePref,
    },
    lastActiveAt: now,
  };

  if (signals.persona_signals.length > 0) {
    const basePersona = existingPersona ?? {
      primary: null,
      scores: { serenity: 0, explorer: 0, sensory: 0 },
      lastUpdated: now,
    };
    const { scores, primary } = mergePersonaScores(
      basePersona.scores,
      signals.persona_signals,
      weight,
    );
    result.persona = { primary, scores, lastUpdated: now };
  }

  return result;
}

export async function updateTasteProfile(
  shopifyCustomerId: string,
  signals: PreferenceSignals,
  existingProfile: CustomerProfile | null,
  env: FirestoreEnv,
  weight = 1,
): Promise<Partial<CustomerProfile>> {
  const merged = computeTasteProfileUpdates(
    signals,
    existingProfile?.tasteProfile,
    existingProfile?.persona,
    weight,
  );
  const updates: Partial<CustomerProfile> = {
    tasteProfile: merged.tasteProfile,
    lastActiveAt: merged.lastActiveAt,
  };
  if (merged.persona) updates.persona = merged.persona;

  await updateCustomerProfile(shopifyCustomerId, updates, env);

  // 更新後のプロファイルを返す（Shopify 同期トリガー用）
  return updates;
}

/**
 * 未連携ユーザー（LINE userId のみ）の会話由来嗜好を lineUsers/{lineUserId} に書く（P0-6・欠落(d)）。
 *
 * 設計 §B-5d / I-5: preference-pipeline の skip を撤廃し、診断が既に踏んだ道（lineUsers 書込）を
 *   会話由来にも広げる。weight は会話由来 +1 のまま。users とは computeTasteProfileUpdates を共有し
 *   同一ロジックを保証する。将来 Shopify 連携成立時に lineUsers→users へマージできる同一構造。
 *
 * fail-safe を求めない（呼び出し側 preference-pipeline が try/catch で握るため）。
 */
export async function updateLineUserTasteProfile(
  lineUserId: string,
  signals: PreferenceSignals,
  existingLineProfile: LineUserProfile | null,
  env: FirestoreEnv,
  weight = 1,
): Promise<Partial<LineUserProfile>> {
  const merged = computeTasteProfileUpdates(
    signals,
    existingLineProfile?.tasteProfile,
    existingLineProfile?.persona,
    weight,
  );
  const updates: Partial<LineUserProfile> = {
    lineUserId,
    tasteProfile: merged.tasteProfile,
    lastActiveAt: merged.lastActiveAt,
  };
  if (merged.persona) updates.persona = merged.persona;
  if (!existingLineProfile) updates.createdAt = merged.lastActiveAt;

  await updateLineUserProfile(lineUserId, updates, env);
  return updates;
}
