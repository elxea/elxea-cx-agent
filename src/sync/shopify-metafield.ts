/**
 * Firestore -> Shopify Customer Metafield 同期レイヤー
 *
 * PersonaProfile と TasteProfile を Shopify Customer Metafields に書き込む。
 *
 * Metafield 定義（namespace: elxea）:
 *   - elxea.taste_profile (json): persona + depthLevel + taste preferences
 *   - elxea.line_linked (boolean): LINE アカウント紐付けフラグ
 *
 * 制約:
 *   - Shopify API レート制限: 100pt/秒（GraphQL Admin API）
 *   - Metafield JSON 上限: 128KB
 *   - customerUpdate mutation: ~10pt/call
 */

import type { Env } from "../index";
import {
  type CustomerProfile,
  type FirestoreEnv,
  type PersonaProfile,
  type TasteProfile,
  getFirestoreEnv,
  getAccessToken,
  fromFirestoreValue,
  fromFirestoreFields,
  firestoreBaseUrl,
} from "../lib/firestore";

// ---------------------------------------------------------------------------
// 無効化フラグ（2026-08-08・判断4）
// ---------------------------------------------------------------------------

/**
 * Shopify 顧客メタフィールドへの**書き出しを無効化する**（削除ではなく無効化）。
 *
 * 一次入力: roji同じ人だと分かる仕組み 判断4
 *   https://www.notion.so/3b570c9d064c81d68610f9360f50c965
 *
 * なぜ止めるか（「読み手がいないから」ではない）:
 *   実測（Shopify 管理 API で顧客 51 件を全件スキャン・読み取りのみ・2026-08-08）で、
 *   **書き出し先のメタフィールド定義そのものが未作成 / 顧客 51 件すべてで実データ 0 件 /
 *   参照する絞り込み条件も 0 件**であることが分かった。書き出し対象が「LINE と EC が紐付いた顧客」に
 *   限られており、その紐付きが実質ゼロだったため 1 滴も流れていない。
 *   **このまま放置すると、本タスクで紐付けを直した瞬間に動き出し、定義も読み手も無いまま
 *   書き込みを始める。** 意味のない通信が走り、後から「これは何だ」という混乱の種になる。
 *
 * 戻し方: 使い道が決まり、**読む相手を 1 つ実装してから** この定数を false にする（コードは残してある）。
 * 併せて Shopify 側のメタフィールド定義（elxea.taste_profile / elxea.line_linked）の作成が要る。
 */
export const SHOPIFY_METAFIELD_SYNC_DISABLED = true;

/** 無効化時に返す「何もしなかった」結果（呼び出し側の型・ログを変えないため成功扱いにはしない）。 */
function disabledSyncResult(customerId: string): MetafieldSyncResult {
  return {
    customerId,
    success: false,
    error: "shopify metafield sync is disabled (roji 判断4)",
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shopify metafield 同期結果 */
export type MetafieldSyncResult = {
  customerId: string;
  success: boolean;
  error?: string;
};

/** バッチ同期の全体結果 */
export type BatchSyncResult = {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  results: MetafieldSyncResult[];
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Metafield 値構築
// ---------------------------------------------------------------------------

/**
 * Firestore の CustomerProfile から Shopify taste_profile metafield の JSON 値を構築する。
 *
 * 128KB 制限を考慮し、必要最小限のフィールドのみ含める。
 */
export function buildTasteProfileMetafield(
  profile: CustomerProfile,
): string | null {
  const persona = profile.persona;
  const taste = profile.tasteProfile;
  const depthLevel = profile.depthLevel;

  // persona も taste も未設定なら同期不要
  if (!persona && !taste && !depthLevel) {
    return null;
  }

  const metafieldValue: Record<string, unknown> = {};

  if (persona) {
    metafieldValue.persona = persona.primary;
    metafieldValue.depthLevel = depthLevel ?? "entry";
    metafieldValue.lastUpdated = persona.lastUpdated;
  }

  if (taste) {
    metafieldValue.preferredCategories = taste.preferredCategories;
    metafieldValue.flavorPreferences = taste.flavorPreferences;
    metafieldValue.scenePref = taste.scenePref;
  }

  const json = JSON.stringify(metafieldValue);
  const encoder = new TextEncoder();
  const MAX_BYTES = 128 * 1024;

  // 128KB ガードレール（byte 単位で計測 — Shopify は UTF-8 byte で制限）
  if (encoder.encode(json).byteLength > MAX_BYTES) {
    console.warn(
      `[shopify-metafield] taste_profile JSON exceeds 128KB (${encoder.encode(json).byteLength} bytes), truncating arrays`,
    );
    // 配列を短縮して再構築
    if (taste) {
      metafieldValue.preferredCategories = taste.preferredCategories.slice(0, 20);
      metafieldValue.flavorPreferences = taste.flavorPreferences.slice(0, 20);
    }
    const truncatedJson = JSON.stringify(metafieldValue);
    // truncation 後の再チェック
    if (encoder.encode(truncatedJson).byteLength > MAX_BYTES) {
      console.error(
        `[shopify-metafield] taste_profile JSON still exceeds 128KB after truncation (${encoder.encode(truncatedJson).byteLength} bytes)`,
      );
      return null;
    }
    return truncatedJson;
  }

  return json;
}

// ---------------------------------------------------------------------------
// 単一顧客の Metafield 同期
// ---------------------------------------------------------------------------

/**
 * 1人の顧客の Firestore プロファイルを Shopify Customer Metafields に同期する。
 *
 * Shopify Admin GraphQL API の customerUpdate mutation を使用。
 *
 * @param shopifyCustomerId Shopify Customer ID（数値文字列）
 * @param profile Firestore の CustomerProfile
 * @param env Workers 環境変数
 */
export async function syncCustomerMetafields(
  shopifyCustomerId: string,
  profile: CustomerProfile,
  env: Env,
): Promise<MetafieldSyncResult> {
  // 判断4: EC 側の「名刺」欄への書き出しは無効化中。**Shopify へ 1 度も通信しない**。
  //   紐付けが直った瞬間に勝手に動き出すのを防ぐため、資格情報チェックより前で止める。
  if (SHOPIFY_METAFIELD_SYNC_DISABLED) {
    return disabledSyncResult(shopifyCustomerId);
  }

  if (!env.SHOPIFY_ADMIN_ACCESS_TOKEN || !env.SHOPIFY_STORE_DOMAIN) {
    return {
      customerId: shopifyCustomerId,
      success: false,
      error: "Shopify Admin API credentials not configured",
    };
  }

  try {
    const metafields: Array<{
      namespace: string;
      key: string;
      value: string;
      type: string;
    }> = [];

    // taste_profile metafield
    const tasteProfileJson = buildTasteProfileMetafield(profile);
    if (tasteProfileJson) {
      metafields.push({
        namespace: "elxea",
        key: "taste_profile",
        value: tasteProfileJson,
        type: "json",
      });
    }

    // line_linked metafield
    if (profile.lineUserId !== undefined) {
      metafields.push({
        namespace: "elxea",
        key: "line_linked",
        value: profile.lineUserId ? "true" : "false",
        type: "boolean",
      });
    }

    if (metafields.length === 0) {
      return {
        customerId: shopifyCustomerId,
        success: true, // nothing to sync
      };
    }

    const mutation = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const customerGid = `gid://shopify/Customer/${shopifyCustomerId}`;

    const res = await fetch(
      `https://${env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": env.SHOPIFY_ADMIN_ACCESS_TOKEN,
        },
        body: JSON.stringify({
          query: mutation,
          variables: {
            input: {
              id: customerGid,
              metafields: metafields.map((mf) => ({
                namespace: mf.namespace,
                key: mf.key,
                value: mf.value,
                type: mf.type,
              })),
            },
          },
        }),
      },
    );

    if (!res.ok) {
      const errText = await res.text();
      return {
        customerId: shopifyCustomerId,
        success: false,
        error: `Shopify API HTTP ${res.status}: ${errText}`,
      };
    }

    const json = (await res.json()) as {
      data?: {
        customerUpdate?: {
          customer?: { id: string };
          userErrors?: Array<{ field: string[]; message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (json.errors?.length) {
      return {
        customerId: shopifyCustomerId,
        success: false,
        error: `GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`,
      };
    }

    const userErrors = json.data?.customerUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      return {
        customerId: shopifyCustomerId,
        success: false,
        error: `User errors: ${userErrors.map((e) => e.message).join(", ")}`,
      };
    }

    return {
      customerId: shopifyCustomerId,
      success: true,
    };
  } catch (err) {
    return {
      customerId: shopifyCustomerId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// イベントドリブン同期（ペルソナ更新後に即時同期）
// ---------------------------------------------------------------------------

/**
 * ペルソナ / TasteProfile 更新後に Shopify metafield へ即時同期する。
 *
 * fire-and-forget で呼ぶことを想定:
 *   c.executionCtx.waitUntil(syncAfterProfileUpdate(...))
 *
 * @param shopifyCustomerId Shopify Customer ID（数値文字列）
 * @param profile 更新後の CustomerProfile
 * @param env Workers 環境変数
 */
export async function syncAfterProfileUpdate(
  shopifyCustomerId: string,
  profile: CustomerProfile,
  env: Env,
): Promise<void> {
  // 判断4: 無効化中は Firestore 読み取りも Shopify 通信も一切しない（静かに戻る）。
  if (SHOPIFY_METAFIELD_SYNC_DISABLED) return;

  try {
    const result = await syncCustomerMetafields(shopifyCustomerId, profile, env);

    if (result.success) {
      console.log(
        `[shopify-metafield] Synced metafields for customer ${shopifyCustomerId}`,
      );
    } else {
      console.warn(
        `[shopify-metafield] Failed to sync metafields for customer ${shopifyCustomerId}: ${result.error}`,
      );
    }
  } catch (err) {
    console.warn(
      "[shopify-metafield] syncAfterProfileUpdate failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// バッチ同期（日次 cron で全顧客を同期）
// ---------------------------------------------------------------------------

/**
 * Firestore の全顧客プロファイルを Shopify metafield にバッチ同期する。
 *
 * 処理フロー:
 *   1. Firestore users コレクションから persona.lastUpdated が since 以降の顧客を取得
 *   2. 各顧客の metafield を同期
 *   3. Shopify API レート制限を考慮して順次処理（バッチサイズ 5件ずつ）
 *
 * @param env Workers 環境変数
 * @param since この日時以降に更新された顧客のみ同期（省略時: 過去25時間）
 */
export async function runBatchMetafieldSync(
  env: Env,
  since?: string,
): Promise<BatchSyncResult> {
  const startTime = Date.now();

  // 判断4: 無効化中は Firestore の全顧客走査ごと止める（日次 cron から呼ばれるため、
  //   ここで止めないと読み取りだけが毎日走り続ける）。
  if (SHOPIFY_METAFIELD_SYNC_DISABLED) {
    console.log(
      "[shopify-metafield] batch sync skipped: disabled (roji 判断4 — 読む相手を実装してから戻す)",
    );
    return {
      total: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      results: [],
      durationMs: Date.now() - startTime,
    };
  }

  let fsEnv: FirestoreEnv;
  try {
    fsEnv = getFirestoreEnv(env);
  } catch {
    return {
      total: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      results: [],
      durationMs: Date.now() - startTime,
    };
  }

  // デフォルト: 過去25時間（日次バッチの余裕マージン）
  const sinceDate = since ?? new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();

  // Firestore REST API で更新された顧客を取得
  const customers = await queryUpdatedCustomers(fsEnv, sinceDate);

  if (customers.length === 0) {
    console.log("[shopify-metafield] No customers updated since", sinceDate);
    return {
      total: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      results: [],
      durationMs: Date.now() - startTime,
    };
  }

  console.log(
    `[shopify-metafield] Batch sync: ${customers.length} customers to process`,
  );

  const results: MetafieldSyncResult[] = [];
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  // バッチサイズ 5件ずつ処理（Shopify API レート制限: 100pt/秒、customerUpdate ~10pt）
  const BATCH_SIZE = 5;
  for (let i = 0; i < customers.length; i += BATCH_SIZE) {
    const batch = customers.slice(i, i + BATCH_SIZE);

    const batchResults = await Promise.allSettled(
      batch.map(async ({ customerId, profile }) => {
        // persona も taste も未設定ならスキップ
        if (!profile.persona && !profile.tasteProfile && !profile.depthLevel) {
          skipped++;
          return {
            customerId,
            success: true,
          } as MetafieldSyncResult;
        }

        return syncCustomerMetafields(customerId, profile, env);
      }),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled") {
        results.push(result.value);
        if (result.value.success) {
          succeeded++;
        } else {
          failed++;
        }
      } else {
        failed++;
        results.push({
          customerId: "unknown",
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    // バッチ間の待機（レート制限回避: 5件/秒ペース）
    if (i + BATCH_SIZE < customers.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  const duration = Date.now() - startTime;
  console.log(
    `[shopify-metafield] Batch sync complete: ${succeeded}/${customers.length} succeeded, ${failed} failed, ${skipped} skipped (${duration}ms)`,
  );

  return {
    total: customers.length,
    succeeded,
    failed,
    skipped,
    results,
    durationMs: duration,
  };
}

// ---------------------------------------------------------------------------
// Firestore クエリ: 更新された顧客を取得
// ---------------------------------------------------------------------------


/**
 * Firestore REST API で persona.lastUpdated が since 以降の顧客を取得する。
 *
 * runQuery を使って users コレクションをフィルタ・ソートする。
 */
async function queryUpdatedCustomers(
  env: FirestoreEnv,
  since: string,
): Promise<Array<{ customerId: string; profile: CustomerProfile }>> {
  const accessToken = await getAccessToken(env);
  const baseUrl = firestoreBaseUrl(env.FIREBASE_PROJECT_ID);

  const body = JSON.stringify({
    structuredQuery: {
      from: [{ collectionId: "users", allDescendants: false }],
      where: {
        fieldFilter: {
          field: { fieldPath: "persona.lastUpdated" },
          op: "GREATER_THAN_OR_EQUAL",
          value: { stringValue: since },
        },
      },
      orderBy: [
        {
          field: { fieldPath: "persona.lastUpdated" },
          direction: "ASCENDING",
        },
      ],
      limit: 500, // 安全上限 — 200人規模では十分
    },
  });

  const res = await fetch(`${baseUrl}:runQuery`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`[shopify-metafield] Firestore runQuery error (${res.status}):`, err);
    return [];
  }

  const results = (await res.json()) as Array<{
    document?: {
      name?: string;
      fields?: Record<string, Record<string, unknown>>;
    };
  }>;

  return results
    .filter((r) => r.document?.name && r.document?.fields)
    .map((r) => {
      // name 形式: projects/{pid}/databases/(default)/documents/users/{customerId}
      const nameParts = r.document!.name!.split("/");
      const customerId = nameParts[nameParts.length - 1];

      const fields = r.document!.fields!;
      const profile = fromFirestoreDocument(fields);

      return { customerId, profile };
    });
}

// ---------------------------------------------------------------------------
// Firestore ドキュメント -> CustomerProfile 変換
// ---------------------------------------------------------------------------

function fromFirestoreDocument(
  fields: Record<string, Record<string, unknown>>,
): CustomerProfile {
  return fromFirestoreFields(fields) as CustomerProfile;
}
