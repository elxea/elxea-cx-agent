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
import {
  computeKarteCarryover,
  type KarteMergeRecord,
  type SpecialFolders,
} from "./karte-merge-rules";

export type { KarteMergeRecord } from "./karte-merge-rules";

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

/**
 * 好みタイプの軸を並べる**固定順**（= 同点になったときの既定の優先順）。
 *
 * なぜ定数が要るか（非決定の封鎖点）:
 *   従来 primary は `Object.entries(scores)` の並び順に依存して決めていた。JS のオブジェクトは
 *   文字列キーの挿入順を保つが、**Firestore から読み直した scores のキー順は保証されない**
 *   （本番で同一ドキュメントを 3 回読んで 3 回とも順序が違うことを実測済み）。
 *   よって同点のとき「読むたびに勝者が変わる」= 人のタイプが理由なく入れ替わる状態だった。
 *   走査を必ずこの配列の順で行うことで、入力のキー順に関わらず結果が一意に決まる。
 */
export const PERSONA_AXES = ["serenity", "explorer", "sensory"] as const;

/**
 * 好みタイプの点を入れた**出所**。どの入力が何点入れたかを内訳として残すための区分。
 *
 * - `diagnosis`     好み診断（weight=3）
 * - `survey`        アンケートの問い3・その訂正（weight=3）
 * - `purchase`      購入商品のタグ由来（weight=3）
 * - `conversation`  会話からの抽出（weight=1）
 *
 * 「出所不明分」は**区分として持たない**。`scores` の合計から下の内訳の合計を引いた残りが
 * 出所不明分であり（`unattributedPersonaScores`）、過去データを遡って割り振ることはしない。
 */
export type PersonaScoreSource = "diagnosis" | "survey" | "purchase" | "conversation";

/**
 * 好みタイプの点の**内訳（出所ごとの積み上げ）**。`persona.scores` とは別に持つ追加の記録。
 *
 * なぜ別に持つか: `persona.scores` は既に多くの読み手（配信の宛先抽出・カルテ表示・metafield 同期）が
 * 使っている。合計の意味と型を変えると読み手が壊れる。よって**合計はそのまま**にして、
 * 「その合計が何で出来ているか」だけを追加で持つ。
 *
 * 不変条件: 各軸で `Σ(内訳) <= scores[軸]`（超えない）。差が出所不明分。
 */
export type PersonaScoreSources = {
  diagnosis?: PersonaScores;
  survey?: PersonaScores;
  purchase?: PersonaScores;
  conversation?: PersonaScores;
  lastUpdated?: string; // ISO 8601
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

// ---------------------------------------------------------------------------
// roji カルテの追加項目（項目 6 / 12 / 13 / 14 / 18 / 19 / 20）
//
// 一次入力（仕様の正本）: rojiカルテの項目 — 最終形の定義
//   https://www.notion.so/3b570c9d064c81669025cdbe1064b12c  第3章 3-1〜3-3 / 第6章 第1段階 順4
//
// なぜ 1 つの型にまとめて両方へ付けるか:
//   定義文書「受け皿は本カルテと未連携カルテの両方に、**同じ形で**足す。片方だけだと合流で落ちる」。
//   CustomerProfile（本カルテ = users/{shopifyCustomerId}）と
//   LineUserProfile（未連携カルテ = lineUsers/{lineUserId}）の**両方に同じ型を交差させる**ことで、
//   片方にだけ項目が足される（＝合流で落ちる）ことを型で防ぐ。
//   併せて「新しい項目は必ず lineUsers 側に置く。3か所目を作らない」（未確定B の確定事項）を守る。
//
// すべての項目に共通する決めごと（定義文書 第3章）:
//   (1) 空を許す。どの項目も空のまま始められる（= すべて optional）
//   (2) 1問ごとに独立して書き込む。まとめて最後に保存しない
//   (3) 申込時に書き込む項目は 1 タップで答えられる形（= 選択肢）。自由記述は申込時に置かない
//
// 置かないもの: 星・点数・満足度・ランキング・連続記録（確定原則の禁じ手。行き着く先の姿でも作らない）。
// 置かないもの: LINE 側の識別子（項目2）/ 合流の状態（項目3）。正本は別名表で、写す理由が書けない。
// ---------------------------------------------------------------------------

/** 項目6: 安全に関する申告（選択肢・複数可）。安全は好みより先に来る。 */
export type SafetyDeclarationTag =
  | "caffeine_sensitive"
  | "pregnant_or_nursing"
  | "allergy"
  | "none";

/**
 * 項目6: 安全に関する申告。
 * 申込時は選択肢のみ（1タップ）。`freeText` は**じぶんのページの常設設定からのみ**書く。
 * 合流時は「両方入れる。片方にでも申告があれば必ず残す。消す方向の統合を絶対にしない」。
 */
export type SafetyDeclaration = {
  tags?: SafetyDeclarationTag[];
  /** 任意の自由記述。じぶんのページの常設設定の側だけ。申込フォームからは書かない。 */
  freeText?: string | null;
  updatedAt?: string; // ISO 8601
};

/** 項目12: 6つの窓それぞれへの傾き（数値）。合流時は「足す」。 */
export type WindowAffinity = {
  tea?: number;
  literature?: number;
  art?: number;
  music?: number;
  farm?: number;
  science?: number;
  lastUpdated?: string; // ISO 8601
};

/** 項目13: お茶ごとの明示指定（また入れてほしい / もういらない）。それぞれ解除できる。 */
export type TeaRequestList = {
  /** また入れてほしいお茶の参照。 */
  moreOf?: string[];
  /** もういらないお茶の参照。割当の必須条件（Q4）。 */
  noneOf?: string[];
  updatedAt?: string; // ISO 8601
};

/**
 * 項目11: 飲む場面・時間帯（選択肢・**複数可**）。
 *
 * なぜ tasteProfile.scenePref と別に持つか（写しではない・母集団が違う）:
 *   `tasteProfile.scenePref` は **単一の文字列**で、会話由来の推定も入る「いまの代表値」。
 *   項目定義の項目11 は「選択肢（複数可）」で、**本人が自分で選んだ答え**そのもの。
 *   単一値に押し込むと (a) 2つ目以降の答えが落ちる (b)「決まっていないと答えた」と
 *   「まだ聞いていない」が同じ空欄になる —— 起きなかったことが記録されない状態になる。
 *   よって本人の答えはここに持ち、`scenePref` は従来どおり代表値として残す（既存の読み手を壊さない）。
 */
export type DrinkingScenes = {
  /** 選んだ記号（複数可・押した順）。 */
  values?: string[];
  /** 〔決まっていない〕を押した（**空欄＝未回答とは別の値**）。 */
  undecided?: boolean;
  updatedAt?: string; // ISO 8601
};

/**
 * 項目9: 好きなカテゴリ（選択肢・複数可: 緑茶 / 烏龍茶 / 紅茶）。
 *
 * なぜ tasteProfile.preferredCategories と別に持つか（写しではない・母集団が違う）:
 *   `preferredCategories` は **お茶の族の照合に使う語彙リスト**で、購入・会話由来の値も混ざる。
 *   ここに「決まっていない」を混ぜると照合語彙が汚れる（どのお茶にも当たらない値が紛れる）。
 *   一方、項目定義は「聞いたが決まっていなかった」を値として持つことを求める。
 *   よって本人の答えはここに持ち、照合に使える値だけを `preferredCategories` にも入れる。
 */
export type TeaCategoryPreference = {
  /** 選んだ記号（green / oolong / black・複数可・押した順）。 */
  values?: string[];
  /** 〔決まっていない〕を押した（**空欄＝未回答とは別の値**）。 */
  undecided?: boolean;
  updatedAt?: string; // ISO 8601
};

/** 項目14: イベントへの関心。出た回の記録からも更新される。 */
export type EventInterest = "onsite" | "online" | "not_now";

/**
 * 項目20: 1行の推定への訂正。
 * 言い換えの候補から1タップ。「まだ、決めていない」「この一行は表示しない」を常設。
 */
export type EstimateCorrection = {
  /** 本人が選んだ言い換えの候補（記号）。 */
  choice?: string | null;
  /** 「まだ、決めていない」を選んだ。 */
  undecided?: boolean;
  /** 「この一行は表示しない」を選んだ。 */
  hidden?: boolean;
  correctedAt?: string; // ISO 8601
};

/**
 * roji カルテの追加項目一式。**本カルテと未連携カルテの両方に同じ形で交差させる。**
 * ここに項目を足すと自動的に両方へ入る（片側だけの追加を型で不可能にしている）。
 */
export type RojiKarteFields = {
  /** 項目6: 安全に関する申告。割当から外す条件・全 Q の前提。 */
  safety?: SafetyDeclaration;
  /** 項目9: 好きなカテゴリ（本人の答え。複数可・「決まっていない」を値として持つ）。 */
  teaCategoryPreference?: TeaCategoryPreference;
  /** 項目11: 飲む場面・時間帯（本人の答え。複数可・「決まっていない」を値として持つ）。 */
  drinkingScenes?: DrinkingScenes;
  /** 項目12: 窓への傾き（お茶・文学・アート・音楽・農・科学）。 */
  windowAffinity?: WindowAffinity;
  /** 項目13: また入れてほしい / もういらない。 */
  teaRequests?: TeaRequestList;
  /** 項目14: イベントへの関心。 */
  eventInterest?: EventInterest | null;
  /**
   * 項目18: 言葉の引用の許可。**既定は「引用しない」= false**。
   * 項目17（気配に含めるか）とは別に持つ。合流時は「制限の強い方」を採る。
   * 言葉 1 件ごとの許可は持たない（人に対する設定。取り消したときに過去の言葉が残るため）。
   */
  quoteConsent?: boolean;
  quoteConsentAskedAt?: string | null; // 初めて言葉を書いたときに一度だけ聞く
  /** 項目19: 1行の推定（いまの値）。**1行**。3行にしない。 */
  estimateLine?: string | null;
  estimateLineUpdatedAt?: string | null;
  /** 項目20: 1行の推定への訂正。合流時は「新しい方」を採る。 */
  estimateCorrection?: EstimateCorrection;
  /**
   * 項目7（好みタイプ）の点の**内訳 = 出所ごとの積み上げ**。カルテの新しい「項目」ではなく、
   * 既にある `persona.scores` が何で出来ているかの記録（合計そのものは一切変えない）。
   *
   * なぜ本カルテと未連携カルテの**両方**に置くか（= ここに置く理由）:
   *   点は未連携のうちにも貯まる（診断・アンケートは連携前に答えられる）。片側にしか無いと
   *   合流の瞬間に内訳だけが落ち、「合計はあるのに誰が入れたか分からない」状態になる。
   *   `RojiKarteFields` に置けば両カルテに同じ形で入り、かつ `KARTE_MERGE_RULES` が
   *   **合流規則を宣言するまで型検査を落とす**（宣言し忘れて黙って落ちる経路を塞ぐ）。
   *
   * 遡っての割り振りはしない: 本項目の導入前に貯まった点は出所不明のまま残す（触らない）。
   */
  personaScoreSources?: PersonaScoreSources;
};

export type CustomerProfile = RojiKarteFields & {
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
export type LineUserProfile = RojiKarteFields & {
  /** LINE userId（= ドキュメントキーの写し。将来マージ処理の可読性のため保持）。 */
  lineUserId?: string;
  /** 好み（ペルソナ）— CustomerProfile.persona と同一構造。 */
  persona?: PersonaProfile;
  /** 会話由来の嗜好 — CustomerProfile.tasteProfile と同一構造（将来拡張用・現状は persona のみ書く）。 */
  tasteProfile?: TasteProfile;
  /**
   * オンボーディング状態 — CustomerProfile.onboarding と同一構造。
   * 未連携ユーザーの入口質問回答（onboarding.source = marche/online/other）をここに残す。
   * 将来 Shopify 連携成立時に users/{shopifyId}.onboarding へマージ可能な同一構造。
   */
  onboarding?: OnboardingStatus;
  createdAt?: string;
  lastActiveAt?: string;
  /**
   * 将来 Shopify 連携時にこのレコードを users/{shopifyId} へ統合したら true にする（TODO）。
   * 未マージ = false / 未設定。
   */
  mergedToShopify?: boolean;
  /**
   * 項目33: 合流の記録（いつ / どちらの記録から / 何を持ち越したか）。
   * 取り消し機能を作らない代わりの足あと。採らなかった未連携側の値（superseded）もここに残す。
   */
  mergeRecord?: KarteMergeRecord;
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
 * persona.primary == <targetPersona> の Firestore structuredQuery を組む（純粋・EQUAL・cursor 対応）。
 *
 * ⚠ 重要（Firestore 仕様 / ブロック1 ライブ E2E で実証・2026-07-16）:
 *   `persona.primary != null`（NOT_EQUAL null）は、フィールドが null の行だけでなく
 *   「フィールド自体が欠落した行」も対象外にする Firestore の実装挙動により、
 *   ライブでは常に 0 件になった（同一データで EQUAL('serenity')=1 件・全件 listAll=2 件・NE-null=0 件を実測）。
 *   よって「!= null で全ペルソナ横断」は使わず、対象ペルソナごとの EQUAL クエリに限定する。
 *   全ペルソナ横断が必要な箇所は、呼び出し側が本クエリを EQUAL×3 で回して和を取る。
 *
 * @param collectionId  対象コレクション（users＝連携済み / lineUsers＝直読み）。
 * @param targetPersona 解決対象ペルソナ（EQUAL 比較値・stringValue で送る）。
 * @param opts.limit    ページサイズ。
 * @param opts.startAfterName 前ページ最終ドキュメント name（cursor・__name__ 昇順の startAt/before:false）。
 */
export function buildPersonaPrimaryEqualQuery(
  collectionId: string,
  targetPersona: PersonaType,
  opts: { limit: number; startAfterName?: string },
): Record<string, unknown> {
  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId, allDescendants: false }],
    where: {
      fieldFilter: {
        field: { fieldPath: "persona.primary" },
        op: "EQUAL",
        value: { stringValue: targetPersona },
      },
    },
    orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
    limit: opts.limit,
  };
  if (opts.startAfterName) {
    structuredQuery.startAt = {
      values: [{ referenceValue: opts.startAfterName }],
      before: false,
    };
  }
  return structuredQuery;
}

/**
 * コレクションを __name__ 昇順で全件ページングするための structuredQuery を組む（純粋・where 無し）。
 *
 * 用途（ブロック3-B・休眠検知）: lineUsers を全件走査して lastActiveAt を読み、休眠判定を
 *   アプリ側で行う。where フィルタ（lastActiveAt < cutoff）は使わない — 理由:
 *   (1) lastActiveAt は stringValue(ISO) と timestampValue が混在し得るため型に依存した比較を避ける。
 *   (2) `!= null` 等はフィールド欠落行を落とす Firestore 実装挙動（buildPersonaPrimaryEqualQuery の
 *       注記参照）で取りこぼす。全件走査＋アプリ側判定が最も堅牢（対象は友だち数十人規模で軽量）。
 *
 * @param collectionId 対象コレクション（lineUsers 等）。
 * @param opts.limit ページサイズ。
 * @param opts.startAfterName 前ページ最終ドキュメント name（cursor・__name__ 昇順の startAt/before:false）。
 */
export function buildCollectionListQuery(
  collectionId: string,
  opts: { limit: number; startAfterName?: string },
): Record<string, unknown> {
  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId, allDescendants: false }],
    orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
    limit: opts.limit,
  };
  if (opts.startAfterName) {
    structuredQuery.startAt = {
      values: [{ referenceValue: opts.startAfterName }],
      before: false,
    };
  }
  return structuredQuery;
}

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

/** 数値として読む（非数値・非有限は 0）。壊れた保存値で勝者決定を巻き込まないため。 */
function numeric(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * 点数から**いまの好みタイプ（primary）を決める**（純粋・決定的）。
 *
 * ■ 何を直したか（この関数が在る理由）
 *   従来は `Object.entries(scores).reduce(...)` で最大軸を選んでいた。最大が 1 つに決まる限りは
 *   これで正しいが、**同点のときはキーの並び順が勝者を決めていた**。Firestore から読み直した
 *   scores のキー順は保証されず（本番で同一ドキュメントを 3 回読んで 3 回とも順序が違った）、
 *   同点の人はタイプ判定が読むたびに変わりうる状態だった。
 *
 * ■ 同点になったときの決め方（この順に見る）
 *   1. **いまの primary が同点集合に居るならそれを残す**。人のタイプが、本人が何もしていないのに
 *      入れ替わらないことを最優先する（新しい入力が古い入力を押しのける形にしない）。
 *   2. いまの primary が同点集合に居ない / そもそも無い場合だけ、固定順
 *      （serenity → explorer → sensory）の先頭を採る。
 *   どちらの経路も入力のキー順に依存しない = 何度呼んでも同じ答えになる。
 *
 * @param scores 判定対象の点数
 * @param currentPrimary 更新**前**の primary（未設定なら null）
 */
export function pickPrimaryPersona(
  scores: PersonaScores,
  currentPrimary: PersonaType | null | undefined,
): PersonaType {
  // 走査は必ず固定順で行う（Object.keys の順に依存しない）。
  let max = Number.NEGATIVE_INFINITY;
  for (const axis of PERSONA_AXES) {
    const v = numeric(scores[axis]);
    if (v > max) max = v;
  }
  const tied = PERSONA_AXES.filter((axis) => numeric(scores[axis]) === max);

  // 同点なら、いまの primary を維持する（居なければ固定順の先頭）。
  if (currentPrimary && tied.includes(currentPrimary)) return currentPrimary;
  return tied[0];
}

/**
 * ペルソナシグナルを既存スコアに「加算」してマージする（純粋）。
 *
 * 重要（属性整合の要）: これは「上書き」ではなく「別軸への累積加算」である。
 * - 各ペルソナ軸（serenity / explorer / sensory）は独立に累積する。
 * - 会話由来（weight=1）と購入由来（weight=3）は同じ軸に足し込まれるだけで、
 *   一方が他方を消すことはない（例: 会話で serenity+1 済みのユーザーが explorer 商品を
 *   購入しても serenity は保持され、explorer に +3 されるだけ）。
 * - primary は `pickPrimaryPersona` で再計算する（同点はいまの primary を維持・決定的）。
 *
 * この不変条件により「購入判定が会話シグナルを上書きする」事故を構造的に防ぐ。
 *
 * @param existingScores 既存のペルソナスコア
 * @param personaSignals 今回のシグナル（重複含みうる。含まれた回数だけ加算する）
 * @param weight シグナル 1 件あたりの加算値（会話=1 / 購入=3）
 * @param currentPrimary 更新**前**の primary。同点時にこれを維持する。
 *        **省略不可**（省略できると呼び出し元ごとに同点の答えがぶれるため、型で必須にしている）
 */
export function mergePersonaScores(
  existingScores: PersonaScores,
  personaSignals: PersonaType[],
  weight: number,
  currentPrimary: PersonaType | null,
): { scores: PersonaScores; primary: PersonaType } {
  const scores: PersonaScores = { ...existingScores };

  // 各シグナルに +weight（既存軸は保持したまま加算 = 上書きしない）
  for (const signal of personaSignals) {
    scores[signal] = (scores[signal] ?? 0) + weight;
  }

  return { scores, primary: pickPrimaryPersona(scores, currentPrimary) };
}

// ---------------------------------------------------------------------------
// 点の出所の記録（純粋 — I/O なし）
// ---------------------------------------------------------------------------

/** 出所ごとの内訳 1 バケツを 0 埋めで読む（保存値が欠けていても軸を落とさない）。 */
function readSourceBucket(bucket: PersonaScores | undefined): PersonaScores {
  return {
    serenity: numeric(bucket?.serenity),
    explorer: numeric(bucket?.explorer),
    sensory: numeric(bucket?.sensory),
  };
}

/**
 * ある出所のバケツに増減を反映する（純粋）。
 *
 * 増減が全部 0 のときは何も足さない（`lastUpdated` も動かさない = 意味のない書き込みを作らない）。
 * バケツは 0 未満にしない（押し替えの取り消しが、その出所が入れた以上に引かないようにする）。
 */
export function addPersonaScoreSourceDeltas(
  sources: PersonaScoreSources | undefined,
  source: PersonaScoreSource,
  deltas: Partial<Record<PersonaType, number>>,
  now: string,
): PersonaScoreSources {
  const bucket = readSourceBucket(sources?.[source]);
  let changed = false;
  for (const axis of PERSONA_AXES) {
    const d = numeric(deltas[axis]);
    if (d === 0) continue;
    bucket[axis] = Math.max(0, bucket[axis] + d);
    changed = true;
  }
  if (!changed) return sources ?? {};
  return { ...(sources ?? {}), [source]: bucket, lastUpdated: now };
}

/**
 * 点数を足しつつ、**同じ 1 回の計算で出所の内訳も更新する**（純粋・Firestore の往復を増やさない）。
 *
 * 合計（`scores`）の作り方は従来と 1 点も変えていない。増えるのは `sources`（内訳）だけ。
 *
 * @param args.undo 押し替えの取り消し（アンケートで別の答えに押し替えたとき）。
 *        この軸から weight 分を戻す（合計は 0 未満にしない = 従来の `Math.max(0, x - weight)` と同じ）。
 */
export function mergePersonaScoresWithSource(args: {
  existingScores: PersonaScores;
  existingSources: PersonaScoreSources | undefined;
  /** 更新**前**の primary。同点時にこれを維持する。 */
  currentPrimary: PersonaType | null;
  signals: PersonaType[];
  weight: number;
  source: PersonaScoreSource;
  undo?: PersonaType | null;
  now: string;
}): { scores: PersonaScores; primary: PersonaType; sources: PersonaScoreSources } {
  const scores: PersonaScores = { ...args.existingScores };
  const deltas: Partial<Record<PersonaType, number>> = {};

  // 押し替えの取り消し（引く分）。合計から実際に引けた分だけ内訳からも引く（ずれを作らない）。
  if (args.undo) {
    const dec = Math.min(numeric(scores[args.undo]), args.weight);
    if (dec > 0) {
      scores[args.undo] = numeric(scores[args.undo]) - dec;
      deltas[args.undo] = (deltas[args.undo] ?? 0) - dec;
    }
  }

  for (const signal of args.signals) {
    scores[signal] = (scores[signal] ?? 0) + args.weight;
    deltas[signal] = (deltas[signal] ?? 0) + args.weight;
  }

  return {
    scores,
    primary: pickPrimaryPersona(scores, args.currentPrimary),
    sources: addPersonaScoreSourceDeltas(args.existingSources, args.source, deltas, args.now),
  };
}

/**
 * 出所が分からない分（＝内訳のどのバケツにも属さない点）を軸ごとに出す（純粋）。
 *
 * 記録を始める前から貯まっていた点はここに出る。**遡って割り振ることはしない**ので、
 * 「昔からある分」はこの残差として見えるだけでよい。負にはしない（内訳が合計を超えて見えても 0 に倒す）。
 */
export function unattributedPersonaScores(
  scores: PersonaScores,
  sources: PersonaScoreSources | undefined,
): PersonaScores {
  const out: PersonaScores = { serenity: 0, explorer: 0, sensory: 0 };
  for (const axis of PERSONA_AXES) {
    let attributed = 0;
    for (const source of ["diagnosis", "survey", "purchase", "conversation"] as const) {
      attributed += numeric(sources?.[source]?.[axis]);
    }
    out[axis] = Math.max(0, numeric(scores[axis]) - attributed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 連携時の好み引き継ぎ（lineUsers → users マージ）— QA S-1（連携で好みが消える問題）
// ---------------------------------------------------------------------------

/** ペルソナ scores を「軸ごとに累積加算」する（純粋・mergePersonaScores と同じ流儀・上書きしない）。 */
function addPersonaScores(a: PersonaScores, b: PersonaScores): PersonaScores {
  return {
    serenity: (a.serenity ?? 0) + (b.serenity ?? 0),
    explorer: (a.explorer ?? 0) + (b.explorer ?? 0),
    sensory: (a.sensory ?? 0) + (b.sensory ?? 0),
  };
}

/**
 * 2 つの PersonaProfile を累積統合する（純粋・I/O なし）。
 * scores は軸ごとに加算（`mergePersonaScores` 流儀・どちらも上書きしない）、primary は加算後の最大軸で再計算。
 * 同点のときは `pickPrimaryPersona` に従い**base 側のいまの primary を維持**する（統合したというだけで
 * 人のタイプが入れ替わらないようにする）。base に primary が無ければ incoming 側を候補にする。
 * どちらか一方が未定義ならもう一方をそのまま返す（統合すべき好みが無いときは base を返す）。
 */
export function mergePersonaProfiles(
  base: PersonaProfile | undefined,
  incoming: PersonaProfile | undefined,
): PersonaProfile | undefined {
  if (!incoming) return base;
  if (!base) return incoming;
  const scores = addPersonaScores(base.scores, incoming.scores);
  const primary = pickPrimaryPersona(scores, base.primary ?? incoming.primary ?? null);
  return { primary, scores, lastUpdated: new Date().toISOString() };
}

/**
 * 2 つの TasteProfile を union 統合する（純粋・I/O なし・computeTasteProfileUpdates と同じ union 流儀）。
 * 配列は重複排除して結合（上限50・古いものから削除）、scenePref は既存が空なら incoming を採る。
 */
export function mergeTasteProfiles(
  base: TasteProfile | undefined,
  incoming: TasteProfile | undefined,
): TasteProfile | undefined {
  if (!incoming) return base;
  if (!base) return incoming;
  const MAX = 50;
  return {
    preferredCategories: [
      ...new Set([...base.preferredCategories, ...incoming.preferredCategories]),
    ].slice(-MAX),
    flavorPreferences: [
      ...new Set([...base.flavorPreferences, ...incoming.flavorPreferences]),
    ].slice(-MAX),
    scenePref: base.scenePref ?? incoming.scenePref ?? null,
  };
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
 *   同点時は既存 primary を維持し、点の出所（既定は会話由来）も内訳に積む。
 * - lastActiveAt を常に更新。
 *
 * @param personaOpts 点の出所の記録用。`source` 未指定は会話由来（この関数の既定の呼ばれ方）。
 *   `existingSources` は既存の内訳（渡さないと内訳が毎回作り直しになるので、呼び出し側は必ず渡す）。
 */
export function computeTasteProfileUpdates(
  signals: PreferenceSignals,
  existingTaste: TasteProfile | undefined,
  existingPersona: PersonaProfile | undefined,
  weight = 1,
  personaOpts?: {
    source?: PersonaScoreSource;
    existingSources?: PersonaScoreSources;
  },
): {
  tasteProfile: TasteProfile;
  persona?: PersonaProfile;
  personaScoreSources?: PersonaScoreSources;
  lastActiveAt: string;
} {
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

  const result: {
    tasteProfile: TasteProfile;
    persona?: PersonaProfile;
    personaScoreSources?: PersonaScoreSources;
    lastActiveAt: string;
  } = {
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
    const { scores, primary, sources } = mergePersonaScoresWithSource({
      existingScores: basePersona.scores,
      existingSources: personaOpts?.existingSources,
      currentPrimary: basePersona.primary,
      signals: signals.persona_signals,
      weight,
      source: personaOpts?.source ?? "conversation",
      now,
    });
    result.persona = { primary, scores, lastUpdated: now };
    result.personaScoreSources = sources;
  }

  return result;
}

export async function updateTasteProfile(
  shopifyCustomerId: string,
  signals: PreferenceSignals,
  existingProfile: CustomerProfile | null,
  env: FirestoreEnv,
  weight = 1,
  source: PersonaScoreSource = "conversation",
): Promise<Partial<CustomerProfile>> {
  const merged = computeTasteProfileUpdates(
    signals,
    existingProfile?.tasteProfile,
    existingProfile?.persona,
    weight,
    { source, existingSources: existingProfile?.personaScoreSources },
  );
  const updates: Partial<CustomerProfile> = {
    tasteProfile: merged.tasteProfile,
    lastActiveAt: merged.lastActiveAt,
  };
  if (merged.persona) updates.persona = merged.persona;
  // 点の内訳は persona と**同じ 1 回の書き込み**に載せる（往復を増やさない）。
  if (merged.personaScoreSources) updates.personaScoreSources = merged.personaScoreSources;

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
  source: PersonaScoreSource = "conversation",
): Promise<Partial<LineUserProfile>> {
  const merged = computeTasteProfileUpdates(
    signals,
    existingLineProfile?.tasteProfile,
    existingLineProfile?.persona,
    weight,
    { source, existingSources: existingLineProfile?.personaScoreSources },
  );
  const updates: Partial<LineUserProfile> = {
    lineUserId,
    tasteProfile: merged.tasteProfile,
    lastActiveAt: merged.lastActiveAt,
  };
  if (merged.persona) updates.persona = merged.persona;
  // 点の内訳は persona と**同じ 1 回の書き込み**に載せる（往復を増やさない）。
  if (merged.personaScoreSources) updates.personaScoreSources = merged.personaScoreSources;
  if (!existingLineProfile) updates.createdAt = merged.lastActiveAt;

  await updateLineUserProfile(lineUserId, updates, env);
  return updates;
}

// ---------------------------------------------------------------------------
// 連携成立時の好み引き継ぎ（carryover）— lineUsers/{lineUserId} → users/{shopifyCustomerId}
//
// 設計正本: personalization-spec §3 引き継ぎ / ジャーニー S5「会員とつながったら好みが
//   引き継がれた」/ 突合表 Table A #16（❌ 未実装だった箇所）/ 監査 #10 改善案。
//   未連携時に貯めた好み（persona/tasteProfile）を、連携成立の瞬間に連携済みカルテへ統合し、
//   「つながると自分向けに深まる」到達点を成立させる。data-only（Firestore のみ・外部送信なし）。
// ---------------------------------------------------------------------------

/**
 * PersonaScores を mergePersonaScores 用の PersonaType[] シグナル列へ展開する（純粋）。
 *
 * 各軸のスコア n を「その軸トークン n 個」に開くことで、mergePersonaScores(base, signals, 1)
 * が「別軸への累積加算」流儀のまま lineUsers 分を users の各軸へ正確に足し込めるようにする
 * （＝上書きではなく加算・weight は展開済みなので 1）。非有限・0 以下の軸は無視する。
 */
export function personaScoresToSignals(scores: PersonaScores): PersonaType[] {
  const signals: PersonaType[] = [];
  for (const axis of ["serenity", "explorer", "sensory"] as const) {
    const n = Math.floor(scores[axis] ?? 0);
    if (!Number.isFinite(n) || n <= 0) continue;
    for (let i = 0; i < n; i++) signals.push(axis);
  }
  return signals;
}

/** persona に意味のあるスコアが 1 つでもあるか（純粋）。 */
function personaHasScore(persona: PersonaProfile | undefined): boolean {
  const s = persona?.scores;
  if (!s) return false;
  return (s.serenity ?? 0) > 0 || (s.explorer ?? 0) > 0 || (s.sensory ?? 0) > 0;
}

/** tasteProfile に引き継ぐべき手がかりが 1 つでもあるか（純粋）。 */
function tasteHasSignal(taste: TasteProfile | undefined): boolean {
  if (!taste) return false;
  return (
    (taste.preferredCategories?.length ?? 0) > 0 ||
    (taste.flavorPreferences?.length ?? 0) > 0 ||
    !!taste.scenePref
  );
}

/**
 * mergeLineUserIntoShopify の第4引数（opts）型。2 つの役割を 1 つに束ねる（統合済み）:
 *   1. 依存注入シーム（DI）— getLineUser/getCustomer/updateCustomer/updateLineUser。本番は未指定で
 *      実 Firestore I/O を使う。ハーメティックテストは in-memory な get/update を注入し、実ネットワーク
 *      非接触で「連携時に好みが users へ畳まれる」ことを検証する（Firestore REST はモック対象外＝要 DI）。
 *   2. 読み取りキャッシュ — existingShopify/existingLine。呼び出し側が既に読み込んだプロファイルを
 *      渡して二度読みを避ける（core.ts の QA S-1 読み取りフォールバック / 既マージ短絡の I/O ゼロ化）。
 *      `existingLine`/`existingShopify` が「指定された（undefined でない・null も可）」ときは対応する
 *      getter を呼ばずその値を使う。
 *
 * 型名は歴史的経緯で `CarryoverDeps`（DI 由来）。cache フィールドは後付けで加えた superset。
 */
export type CarryoverDeps = {
  getLineUser?: (
    lineUserId: string,
    env: FirestoreEnv,
  ) => Promise<LineUserProfile | null>;
  getCustomer?: (
    shopifyCustomerId: string,
    env: FirestoreEnv,
  ) => Promise<CustomerProfile | null>;
  updateCustomer?: (
    shopifyCustomerId: string,
    updates: Partial<CustomerProfile>,
    env: FirestoreEnv,
  ) => Promise<void>;
  updateLineUser?: (
    lineUserId: string,
    updates: Partial<LineUserProfile>,
    env: FirestoreEnv,
  ) => Promise<void>;
  /** 読み取りキャッシュ: 既読の連携済みカルテ。指定時は getCustomer を呼ばずこれを使う。 */
  existingShopify?: CustomerProfile | null;
  /** 読み取りキャッシュ: 既読の未連携カルテ。指定時は getLineUser を呼ばずこれを使う。 */
  existingLine?: LineUserProfile | null;
};

/**
 * 連携成立時に未連携カルテ（lineUsers/{lineUserId}）の好みを、連携済みカルテ
 * （users/{shopifyCustomerId}）へ統合する（設計 §3 引き継ぎ・S5「引き継がれた」の成立）。
 *
 * ■ 2026-08-08 改修（穴1・穴2 の封鎖）— roji同じ人だと分かる仕組み 第3章
 *   https://www.notion.so/3b570c9d064c81d68610f9360f50c965
 *
 *   穴1（持ち越しが 2 項目に固定）: 従来この関数は persona と tasteProfile だけを処理の中に
 *     直接書いて持ち越していたため、**カルテに項目を足すたびにここも直さないと、足した項目は
 *     合流の瞬間に黙って落ちた**（入口の答え onboarding.source がまさにそれ）。
 *     → 持ち越し規則を宣言的な表（karte-merge-rules.ts の `KARTE_MERGE_RULES`）へ外出しし、
 *       **走査対象を「未連携カルテに実在する全キー」**（`Object.keys`）にした。表に無いキーは
 *       既定で持ち越す。表は型で網羅を強制する（項目を足すと型検査が落ちる）。
 *
 *   穴2（好みが空だと何もせず終わる）: 従来は persona も taste も空なら早期 return し、
 *     **合流済みの印すら書かなかった**。「まだ買っていないがアンケートには答えた人」が
 *     永久に孤児化する。→ 早期 return を撤去し、**好みが空でも合流を成立させて印を付ける**。
 *
 * 統合方針（詳細な種類別ルールは karte-merge-rules.ts の表が正本）:
 *   - persona: 既存 `mergePersonaScores` の「別軸への累積加算」流儀で、lineUsers の各軸スコアを
 *     users の各軸へ足し込む（上書きしない＝会員側の既存スコアを消さない）。primary は最大軸を再計算。
 *   - tasteProfile: `computeTasteProfileUpdates` を共有し union（重複排除・上限50）。scenePref は
 *     lineUsers 側があれば最新として採用。他の出し分けと同一ロジックを保証する（SoT 分裂しない）。
 *   - それ以外の全項目: 表の規則（足す / 両方入れる / 安全は消さない / 制限の強い方 / 新しい方 /
 *     本カルテ優先）。**既存の値を削除する経路は 1 つも無い**（追加と、衝突時の足あと記録のみ）。
 *   - lineUsers.mergedToShopify=true と mergeRecord（項目33）を立てる。
 *
 * 冪等性: mergedToShopify===true のとき no-op（再連携・再送で二重加算しない）。
 * graceful: lineUsers ドキュメント不在のときだけ no-op（印を立てる先が無いため）。
 *   **好みが空のカルテは no-op にしない**（穴2 の封鎖点）。
 * 順序: users を先に統合してから mergedToShopify を立てる（途中失敗時に「フラグだけ立って
 *   引き継ぎ未了」を避ける。最悪でも mergedToShopify 未設定なら再連携時に再試行できる）。
 *
 * GA 状態: Shopify 連携（LIFF）は GA 前で、唯一の呼び出し元 identity/link-liff は本番で未発火。
 *   本関数は「連携が GA したとき正しく動く」ことを保証する（hermetic mocked-link で実証）。
 *
 * @param env Firestore 資格情報（未設定なら呼び出し側 route が getFirestoreEnv で弾く）。
 * @param opts テスト用 DI + 読み取りキャッシュ（本番は省略）。詳細は CarryoverDeps 参照。
 * @returns 統合後の連携済みカルテ（no-op 時は現状の users カルテ・不在なら null）。
 *          `existingShopify` を渡した no-op 短絡ではそのオブジェクトを同一参照で返す。
 */
export async function mergeLineUserIntoShopify(
  lineUserId: string,
  shopifyCustomerId: string,
  env: FirestoreEnv,
  opts?: CarryoverDeps,
): Promise<CustomerProfile | null> {
  const getLineUser = opts?.getLineUser ?? getLineUserProfile;
  const getCustomer = opts?.getCustomer ?? getCustomerProfile;
  const updateCustomer = opts?.updateCustomer ?? updateCustomerProfile;
  const updateLineUser = opts?.updateLineUser ?? updateLineUserProfile;

  // 読み取りキャッシュ: existingLine/existingShopify が指定されていれば getter を呼ばない
  //   （core.ts の読み取りフォールバックや既マージ短絡での I/O ゼロ化）。undefined 判定なので null も尊重。
  const resolveLine = (): Promise<LineUserProfile | null> =>
    opts?.existingLine !== undefined
      ? Promise.resolve(opts.existingLine)
      : getLineUser(lineUserId, env);
  const resolveCustomer = (): Promise<CustomerProfile | null> =>
    opts?.existingShopify !== undefined
      ? Promise.resolve(opts.existingShopify)
      : getCustomer(shopifyCustomerId, env);

  const lineProfile = await resolveLine();

  // graceful: 未連携カルテそのものが無い → 引き継ぐものが無い（no-op）。
  if (!lineProfile) return resolveCustomer();

  // 冪等性: 既にマージ済み → 二重加算しない（no-op）。
  if (lineProfile.mergedToShopify === true) {
    return resolveCustomer();
  }

  const customerProfile = await resolveCustomer();
  const now = new Date().toISOString();

  // persona / taste の畳み込みは既存ロジックをそのまま使う（SoT を分裂させない）。
  //   規則の表は「どの項目にどの戦略を当てるか」だけを持ち、畳み方の実体はここに残す。
  const folders: SpecialFolders = {
    foldPersona: (linePersona, customerPersona) => {
      // 意味のあるスコアが 1 つも無ければ持ち越さない（0 加算の空更新を避ける）。
      if (!personaHasScore(linePersona)) return undefined;
      const baseScores = customerPersona?.scores ?? {
        serenity: 0,
        explorer: 0,
        sensory: 0,
      };
      // 同点になったら本カルテ側のいまの primary を維持する（合流したというだけで
      //   会員のタイプが入れ替わらないようにする）。本カルテに primary が無ければ未連携側を候補にする。
      const { scores, primary } = mergePersonaScores(
        baseScores,
        personaScoresToSignals(linePersona!.scores),
        1,
        customerPersona?.primary ?? linePersona?.primary ?? null,
      );
      return { primary, scores, lastUpdated: now };
    },
    foldTaste: (lineTaste, customer) => {
      if (!tasteHasSignal(lineTaste)) return undefined;
      const t = lineTaste!;
      // persona は foldPersona 側で処理済みなので persona_signals は空にして二重加算を避ける。
      const tasteSignals: PreferenceSignals = {
        preferred_categories: t.preferredCategories ?? [],
        flavor_preferences: t.flavorPreferences ?? [],
        scene_preferences: t.scenePref ? [t.scenePref] : [],
        persona_signals: [],
        explicit_statements: [],
      };
      const mergedTaste = computeTasteProfileUpdates(
        tasteSignals,
        customer?.tasteProfile,
        customer?.persona,
        1,
        // persona_signals は空なので内訳は動かないが、既存の内訳を渡して不要な作り直しを防ぐ。
        { existingSources: customer?.personaScoreSources },
      );
      return mergedTaste.tasteProfile;
    },
  };

  // 未連携カルテに実在する**全キー**を規則の表に照らして畳む（穴1 の封鎖点）。
  const { updates: carried, record } = computeKarteCarryover(
    lineProfile,
    customerProfile,
    { lineUserId, shopifyCustomerId, now },
    folders,
  );

  const updates: Partial<CustomerProfile> = { ...carried, lastActiveAt: now };

  // 連携済みカルテへ統合を書く（PATCH・部分更新）。
  //   ★ 穴2 の封鎖点: 持ち越すものがゼロ（好みも入口の答えも空）でもここを通る。
  //     早期 return しないので、下の「合流済みの印」が必ず立つ。
  await updateCustomer(shopifyCustomerId, updates, env);

  // 未連携カルテに「統合済み」と合流の記録（項目33）を立てる。
  //   mergedToShopify は二重加算防止フラグ＝冪等性の機械的担保。
  //   mergeRecord は「いつ / どちらから / 何を持ち越したか / 採らなかった値」の足あと。
  await updateLineUser(lineUserId, { mergedToShopify: true, mergeRecord: record }, env);

  // 統合後の連携済みカルテを返す（既存に updates を重ねた状態）。
  return { ...(customerProfile ?? {}), ...updates };
}
