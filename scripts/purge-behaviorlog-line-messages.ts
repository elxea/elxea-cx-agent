/**
 * P0-11 / §B-7 / I-10: behaviorLog の「発話全文（line_message）」バックフィル削除ツール。
 *
 *   目的: 過去に behaviorLog へ蓄積された line_message イベント（metadata.query = 発話全文）のうち
 *         90日を超えたものを削除し、Supabase 会話ログ（90日 purge）との非対称を解消する。
 *
 * ⚠ 安全設計（I-10 の必須手順を機械強制）:
 *   - 既定は **dry-run**（数えるだけ・1 件も削除しない）。
 *   - 実削除には **すべての明示フラグ** が必要: `--execute --i-understand --confirm-staging`。
 *   - 実削除の前に必ず「対象件数」を集計して表示する（いきなり削除しない）。
 *   - **staging データのみを対象**とする運用。--confirm-staging は「これは staging である」の人手確認。
 *     本番 Firestore に対しては実行しない（本タスクのスコープ外・オーナー承認前）。
 *
 * 使い方:
 *   dry-run（既定・安全）:  npx tsx scripts/purge-behaviorlog-line-messages.ts
 *   実削除（staging のみ）:  npx tsx scripts/purge-behaviorlog-line-messages.ts --execute --i-understand --confirm-staging
 *
 * 必要 env: FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
 *   （.dev.vars 等から export しておくこと。値はログに出さない）。
 */

import {
  getAccessToken,
  firestoreBaseUrl,
  type FirestoreEnv,
} from "../src/lib/firestore";

const RETENTION_DAYS = 90;

function readFirestoreEnv(): FirestoreEnv {
  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } =
    process.env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error(
      "FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY を env に設定してください（値は出力しません）",
    );
  }
  return {
    FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY,
  } as FirestoreEnv;
}

/**
 * collectionGroup(behaviorLog) を allDescendants で走査し、
 * action=line_message かつ createdAt < cutoff の document 名（削除対象）を集める。
 */
async function collectTargets(
  env: FirestoreEnv,
  cutoffIso: string,
): Promise<string[]> {
  const accessToken = await getAccessToken(env);
  const url = `${firestoreBaseUrl(env.FIREBASE_PROJECT_ID)}:runQuery`;
  const targets: string[] = [];
  let cursor: string | undefined;

  // ページング（__name__ 昇順で startAfter）。1 ページ 300 件。
  for (let page = 0; page < 10000; page++) {
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: "behaviorLog", allDescendants: true }],
      where: {
        compositeFilter: {
          op: "AND",
          filters: [
            {
              fieldFilter: {
                field: { fieldPath: "action" },
                op: "EQUAL",
                value: { stringValue: "line_message" },
              },
            },
            {
              fieldFilter: {
                field: { fieldPath: "createdAt" },
                op: "LESS_THAN",
                value: { stringValue: cutoffIso },
              },
            },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: "__name__" }, direction: "ASCENDING" }],
      limit: 300,
    };
    if (cursor) {
      structuredQuery.startAt = {
        values: [{ referenceValue: cursor }],
        before: false,
      };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) {
      throw new Error(`runQuery 失敗 (${res.status}): ${await res.text()}`);
    }
    const rows = (await res.json()) as Array<{ document?: { name: string } }>;
    let count = 0;
    for (const r of rows) {
      if (!r.document?.name) continue;
      count++;
      cursor = r.document.name;
      targets.push(r.document.name);
    }
    if (count < 300) break;
  }
  return targets;
}

async function deleteDoc(
  env: FirestoreEnv,
  accessToken: string,
  docName: string,
): Promise<void> {
  // docName は "projects/.../documents/users/{id}/behaviorLog/{auto}" のフル名。
  const res = await fetch(
    `https://firestore.googleapis.com/v1/${docName}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    throw new Error(`DELETE 失敗 (${res.status}): ${await res.text()}`);
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const execute = args.has("--execute");
  const understood = args.has("--i-understand");
  const confirmedStaging = args.has("--confirm-staging");

  const env = readFirestoreEnv();
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();

  console.log(
    `[purge] behaviorLog line_message (発話全文) 削除ツール — retention=${RETENTION_DAYS}日`,
  );
  console.log(`[purge] cutoff（これより古い line_message が対象）: ${cutoffIso}`);
  console.log(`[purge] project: ${env.FIREBASE_PROJECT_ID}`);

  // I-10: まず必ず対象件数を集計して表示する（いきなり削除しない）。
  console.log("[purge] 対象件数を集計中…");
  const targets = await collectTargets(env, cutoffIso);
  console.log(`[purge] 削除対象（90日超の line_message イベント）: ${targets.length} 件`);

  if (!(execute && understood && confirmedStaging)) {
    console.log(
      "[purge] DRY-RUN のため削除しません。実削除は --execute --i-understand --confirm-staging を全て付与（staging のみ）。",
    );
    return;
  }

  if (targets.length === 0) {
    console.log("[purge] 対象 0 件のため何もしません。");
    return;
  }

  console.log(`[purge] 実削除を開始します（staging 確認済み）… ${targets.length} 件`);
  const accessToken = await getAccessToken(env);
  let deleted = 0;
  for (const name of targets) {
    await deleteDoc(env, accessToken, name);
    deleted++;
    if (deleted % 100 === 0) console.log(`[purge] ${deleted}/${targets.length} 削除`);
  }
  console.log(`[purge] 完了: ${deleted} 件削除`);
}

main().catch((err) => {
  console.error("[purge] エラー:", err instanceof Error ? err.message : err);
  process.exit(1);
});
