/**
 * Supabase customer_linkages → Firestore users/ 移行スクリプト
 *
 * 実行手順:
 *   1. `.dev.vars` に以下の環境変数を設定:
 *      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *      FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 *   2. pnpm tsx scripts/migrate-to-firestore.ts
 *      （または --dry-run フラグでドライランのみ実行）
 *
 * 移行ルール:
 *   - Supabase customer_linkages テーブルの全レコードを Firestore users/ に書き込む
 *   - Firestore のドキュメント ID = Shopify Customer ID（数値文字列）
 *   - Supabase の customer_linkages は変更せず（LINE↔Shopify 紐付けフローはそのまま維持）
 *   - Supabase は 会話履歴(conversations)・RAG(knowledge_chunks) 専用として残す
 *
 * 移行フィールドマッピング:
 *   customer_linkages.shopify_customer_id → Firestore document ID
 *   customer_linkages.line_user_id        → users/{id}.lineUserId
 *   customer_linkages.shopify_email       → users/{id}.email
 *   customer_linkages.created_at          → users/{id}.createdAt
 */

import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { SignJWT, importPKCS8 } from "jose";

dotenv.config({ path: ".dev.vars" });

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID!;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL!;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY!;

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 10; // Firestore は並列リクエスト数を制限する

// ---------------------------------------------------------------------------
// Firebase JWT 認証
// ---------------------------------------------------------------------------

async function getFirebaseAccessToken(): Promise<string> {
  const privateKey = FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const key = await importPKCS8(privateKey, "RS256");
  const now = Math.floor(Date.now() / 1000);

  const jwt = await new SignJWT({
    scope: "https://www.googleapis.com/auth/datastore",
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(FIREBASE_CLIENT_EMAIL)
    .setSubject(FIREBASE_CLIENT_EMAIL)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
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
    throw new Error(
      `Failed to get Firebase access token: ${await tokenRes.text()}`,
    );
  }

  const data = (await tokenRes.json()) as { access_token: string };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Firestore ユーティリティ
// ---------------------------------------------------------------------------

function firestoreUrl(customerId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${customerId}`;
}

function toStringValue(v: string): Record<string, string> {
  return { stringValue: v };
}

/** Firestore ドキュメントに顧客プロファイルを書き込む（PATCH = upsert） */
async function writeToFirestore(
  customerId: string,
  lineUserId: string,
  email: string | null,
  createdAt: string | null,
  accessToken: string,
): Promise<void> {
  const fields: Record<string, unknown> = {
    lineUserId: toStringValue(lineUserId),
  };
  if (email) {
    fields.email = toStringValue(email);
  }
  if (createdAt) {
    fields.createdAt = { timestampValue: createdAt };
  }

  // updateMask で既存フィールドを上書きしない（createdAt 等）
  const maskKeys = Object.keys(fields)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join("&");

  const url = `${firestoreUrl(customerId)}?${maskKeys}`;

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
    throw new Error(
      `Firestore PATCH failed for customer ${customerId}: ${res.status} ${err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// メイン処理
// ---------------------------------------------------------------------------

type CustomerLinkage = {
  shopify_customer_id: string;
  line_user_id: string;
  shopify_email: string | null;
  created_at: string | null;
};

async function main(): Promise<void> {
  // 前提チェック
  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY ||
    !FIREBASE_PROJECT_ID ||
    !FIREBASE_CLIENT_EMAIL ||
    !FIREBASE_PRIVATE_KEY
  ) {
    console.error(
      "ERROR: Missing required environment variables.\n" +
        "Required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, " +
        "FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY",
    );
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log("[DRY RUN MODE] Firestore への書き込みはスキップします");
  }

  console.log("Supabase から customer_linkages を取得中...");

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // 全レコードをページネーションで取得
  const PAGE_SIZE = 100;
  let offset = 0;
  const allLinkages: CustomerLinkage[] = [];

  while (true) {
    const { data, error } = await supabase
      .from("customer_linkages")
      .select("shopify_customer_id, line_user_id, shopify_email, created_at")
      .order("created_at", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error("Supabase query error:", error);
      process.exit(1);
    }

    if (!data || data.length === 0) break;

    allLinkages.push(...(data as CustomerLinkage[]));
    offset += PAGE_SIZE;

    if (data.length < PAGE_SIZE) break;
  }

  console.log(`${allLinkages.length} 件のレコードを取得`);

  if (allLinkages.length === 0) {
    console.log("移行するレコードがありません。終了します。");
    return;
  }

  if (DRY_RUN) {
    console.log("\n[DRY RUN] 移行予定レコード（最初の5件）:");
    allLinkages.slice(0, 5).forEach((l) => {
      console.log(
        `  Firestore users/${l.shopify_customer_id} <- lineUserId: ${l.line_user_id}, email: ${l.shopify_email ?? "null"}`,
      );
    });
    if (allLinkages.length > 5) {
      console.log(`  ... 他 ${allLinkages.length - 5} 件`);
    }
    console.log("\nDRY RUN 完了。実際に移行するには --dry-run を外して実行してください。");
    return;
  }

  // Firebase アクセストークン取得
  console.log("Firebase アクセストークンを取得中...");
  const accessToken = await getFirebaseAccessToken();

  // バッチ処理
  let succeeded = 0;
  let failed = 0;
  const errors: string[] = [];

  for (let i = 0; i < allLinkages.length; i += BATCH_SIZE) {
    const batch = allLinkages.slice(i, i + BATCH_SIZE);

    await Promise.allSettled(
      batch.map(async (linkage) => {
        try {
          await writeToFirestore(
            linkage.shopify_customer_id,
            linkage.line_user_id,
            linkage.shopify_email,
            linkage.created_at,
            accessToken,
          );
          succeeded++;
          process.stdout.write(".");
        } catch (err) {
          failed++;
          const msg = `customer ${linkage.shopify_customer_id}: ${String(err)}`;
          errors.push(msg);
          process.stdout.write("E");
        }
      }),
    );
  }

  console.log("\n");
  console.log(`移行完了: 成功 ${succeeded} 件 / 失敗 ${failed} 件`);

  if (errors.length > 0) {
    console.error("\n失敗したレコード:");
    errors.forEach((e) => console.error(`  - ${e}`));
  }

  if (failed === 0) {
    console.log("\n全レコードの移行が完了しました。");
    console.log(
      "Supabase の customer_linkages は LINE↔Shopify 紐付けフローのため残存させています。",
    );
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
