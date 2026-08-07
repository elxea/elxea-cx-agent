/**
 * roji-erasure — 「記録を消す」を全経路に通す唯一の入口。
 *
 * 一次入力（仕様の正本）: rojiカルテの項目 — 最終形の定義
 *   https://www.notion.so/3b570c9d064c81669025cdbe1064b12c  図2「本人が記録を消したとき何が消えて何が残るか」
 * 併読: roji同じ人だと分かる仕組み（置き場の地図）
 *   https://www.notion.so/3b570c9d064c81d68610f9360f50c965
 *
 * ─ なぜこのファイルが要るか ─
 *   記録を**永久に残す**と決めた（031）結果、記録が消える経路は
 *   「お客さんからの削除依頼」だけになった。その 1 本が繋がっていなかった。
 *   消す処理が 2 つの repo に散っていて、どちらも自分の見える範囲しか消していない:
 *     - elxea-web-app の customers/redact  … Firestore の本カルテだけ
 *     - roji_erase_person（034）           … Supabase の roji_* 3 表だけ
 *   **どこが消える範囲かを 1 か所に集約する**のが本ファイルの役割。
 *
 * ─ 消す範囲（図2 の「消える」）─
 *   Supabase : roji_erase_person（036）が全表を消す。定義は SQL 側が正本。
 *   Firestore: 本カルテ users/{shopifyCustomerId} と配下の**全**サブコレクション
 *              未連携カルテ①  lineUsers/{lineUserId}          （cx-agent 側）
 *              未連携カルテ②  users/line:{lineUserId} と配下の**全**サブコレクション（web 側）
 *              comments（authorId が本人のもの）
 *              notificationState/{shopifyCustomerId} と配下
 *
 * ─ 消さないもの（図2 の「残る」）─
 *   本人向け文面の 3 つ。詳細は 036 のコメントを参照（ここでは触れない）。
 *   本ファイルは roji_words の匿名行（person_seq IS NULL）に一切アクセスしない。
 *
 * ─ 「見落とした置き場」を構造で防ぐ ─
 *   サブコレクション名を**ハードコードしない**。Firestore の listCollectionIds で
 *   実際にぶら下がっているものを毎回列挙して消す。
 *   web-app の customers/redact は 6 個の名前をベタ書きしており、
 *   あとから増えた broadcastHistory が消えずに残っていた（本タスクで発見）。
 *   同じ失敗様式を二度と起こさないため、列挙は必ず実行時に行う。
 *
 * ─ 痕跡を残さない（確定原則）─
 *   「削除済み 1 件」を記録するドキュメントを**作らない**。
 *   戻り値は件数のみ。ログにも本人の ID を出さない（出すと Cloudflare のログが痕跡になる）。
 *
 * ─ 匿名の言葉と手元の控えを結ぶ鍵を作らない（確定原則）─
 *   消す前に控えの本文を読んで場の言葉と突き合わせる処理を**書いてはならない**。
 *   本ファイルは言葉の本文を 1 度も読まない（Supabase 側の person_seq だけで消す）。
 */

import {
  firestoreBaseUrl,
  getAccessToken,
  getFirestoreEnv,
  LINE_USERS_COLLECTION,
} from "./firestore";
import type { FirestoreEnv } from "./firestore";
import type { Env } from "../index";

/** 消去の起点。EC 上の顧客番号か、LINE の ID のどちらか。 */
export type EraseSubject = { kind: "shopify"; id: string } | { kind: "line"; id: string };

/** roji_erase_person（036）が解決した、本人が持つ全ての恒久 ID。 */
export type ResolvedIdentity = {
  shopify_ids: string[];
  line_ids: string[];
  web_refs: string[];
  person_seqs: number[];
};

export type ErasureResult = {
  identity: ResolvedIdentity;
  supabase: { deleted: Record<string, number>; words_deleted: number; ledger_rows_deleted: number };
  firestore: { deletedDocs: number; paths: string[] };
  /** 消したあとに残っているもの。すべて 0 なら clean。 */
  residue: { remaining: Record<string, number>; preserved: Record<string, number>; clean: boolean };
  firestoreResidue: { remaining: Record<string, number>; clean: boolean };
  clean: boolean;
};

// ---------------------------------------------------------------------------
// Firestore REST の薄いヘルパ（この用途に必要な分だけ）
// ---------------------------------------------------------------------------

async function fsFetch(
  env: FirestoreEnv,
  path: string,
  init: RequestInit & { method: string },
): Promise<Response> {
  const token = await getAccessToken(env);
  return fetch(`${firestoreBaseUrl(env.FIREBASE_PROJECT_ID)}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

/**
 * ドキュメント直下のサブコレクション名を **実行時に列挙する**。
 * 名前をベタ書きしないための要。増えた置き場を自動的に拾う。
 */
async function listSubcollections(env: FirestoreEnv, docPath: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const body: Record<string, unknown> = { pageSize: 300 };
    if (pageToken) body.pageToken = pageToken;
    const res = await fsFetch(env, `/${docPath}:listCollectionIds`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // ドキュメントが無い場合もサブコレクションは在りうるため、404 は空扱いにしない。
      if (res.status === 404) return ids;
      throw new Error(`listCollectionIds failed (${res.status}) for ${docPath}`);
    }
    const json = (await res.json()) as { collectionIds?: string[]; nextPageToken?: string };
    ids.push(...(json.collectionIds ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return ids;
}

/** コレクション配下の全ドキュメントを消す（サブコレクションがあれば再帰）。 */
async function deleteCollection(
  env: FirestoreEnv,
  collectionPath: string,
  counter: { n: number },
  depth = 0,
): Promise<void> {
  if (depth > 5) throw new Error(`deleteCollection: depth limit exceeded at ${collectionPath}`);
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({ pageSize: "300", "mask.fieldPaths": "__name__" });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await fsFetch(env, `/${collectionPath}?${qs}`, { method: "GET" });
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`list ${collectionPath} failed (${res.status})`);
    const json = (await res.json()) as { documents?: Array<{ name: string }>; nextPageToken?: string };
    for (const doc of json.documents ?? []) {
      const rel = doc.name.split("/documents/")[1];
      await deleteDocumentDeep(env, rel, counter, depth + 1);
    }
    pageToken = json.nextPageToken;
  } while (pageToken);
}

/** ドキュメントと、その配下の全サブコレクションを消す。 */
async function deleteDocumentDeep(
  env: FirestoreEnv,
  docPath: string,
  counter: { n: number },
  depth = 0,
): Promise<void> {
  for (const sub of await listSubcollections(env, docPath)) {
    await deleteCollection(env, `${docPath}/${sub}`, counter, depth + 1);
  }
  const res = await fsFetch(env, `/${docPath}`, { method: "DELETE" });
  // 既に無い場合も成功扱い（冪等）。
  if (res.ok || res.status === 404) {
    if (res.ok) counter.n++;
    return;
  }
  throw new Error(`delete ${docPath} failed (${res.status})`);
}

/** ある値のフィールドに一致するトップレベルのドキュメントを消す（comments.authorId 用）。 */
async function deleteByFieldEquals(
  env: FirestoreEnv,
  collection: string,
  field: string,
  values: string[],
  counter: { n: number },
): Promise<void> {
  for (const value of values) {
    let done = false;
    while (!done) {
      const res = await fsFetch(env, `:runQuery`, {
        method: "POST",
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: collection }],
            where: {
              fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: value } },
            },
            limit: 300,
          },
        }),
      });
      if (!res.ok) throw new Error(`runQuery ${collection}.${field} failed (${res.status})`);
      const rows = (await res.json()) as Array<{ document?: { name: string } }>;
      const docs = rows.filter((r) => r.document).map((r) => r.document!.name.split("/documents/")[1]);
      if (docs.length === 0) break;
      for (const d of docs) await deleteDocumentDeep(env, d, counter);
      done = docs.length < 300;
    }
  }
}

/** そのフィールド値を持つドキュメントが何件残っているかを数える（検算用・読み取りのみ）。 */
async function countByFieldEquals(
  env: FirestoreEnv,
  collection: string,
  field: string,
  values: string[],
): Promise<number> {
  let total = 0;
  for (const value of values) {
    const res = await fsFetch(env, `:runQuery`, {
      method: "POST",
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: collection }],
          where: { fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value: { stringValue: value } } },
          limit: 1000,
        },
      }),
    });
    if (!res.ok) throw new Error(`runQuery count ${collection}.${field} failed (${res.status})`);
    const rows = (await res.json()) as Array<{ document?: { name: string } }>;
    total += rows.filter((r) => r.document).length;
  }
  return total;
}

/** ドキュメントが存在するか（検算用・読み取りのみ）。 */
async function docExists(env: FirestoreEnv, docPath: string): Promise<boolean> {
  const res = await fsFetch(env, `/${docPath}?mask.fieldPaths=__name__`, { method: "GET" });
  if (res.ok) return true;
  if (res.status === 404) {
    // ドキュメント本体が無くてもサブコレクションが残っていれば「残っている」と数える。
    return (await listSubcollections(env, docPath)).length > 0;
  }
  throw new Error(`get ${docPath} failed (${res.status})`);
}

// ---------------------------------------------------------------------------
// Firestore 側の消去 / 検算
// ---------------------------------------------------------------------------

/** 本人の全 ID について、Firestore 上の置き場を消す。 */
export async function eraseFirestore(
  env: FirestoreEnv,
  identity: ResolvedIdentity,
): Promise<{ deletedDocs: number; paths: string[] }> {
  const counter = { n: 0 };
  const paths: string[] = [];

  // 本カルテ + 配下の全サブコレクション（列挙するので broadcastHistory 等も自動で入る）
  for (const cid of identity.shopify_ids) {
    if (!/^\d+$/.test(cid)) continue; // 合成 ID を Firestore に投げない
    await deleteDocumentDeep(env, `users/${cid}`, counter);
    paths.push(`users/${cid}`);
    await deleteDocumentDeep(env, `notificationState/${cid}`, counter);
    paths.push(`notificationState/${cid}`);
  }

  // 未連携カルテ①（cx-agent）と ②（web-app）
  for (const lid of identity.line_ids) {
    await deleteDocumentDeep(env, `${LINE_USERS_COLLECTION}/${lid}`, counter);
    paths.push(`${LINE_USERS_COLLECTION}/${lid}`);
    await deleteDocumentDeep(env, `users/line:${lid}`, counter);
    paths.push(`users/line:${lid}`);
  }

  // コメント（本人が書いた本文が残る。userKey は数値 ID か "line:xxx"）
  const userKeys = [...identity.shopify_ids.filter((c) => /^\d+$/.test(c)), ...identity.line_ids.map((l) => `line:${l}`)];
  if (userKeys.length > 0) {
    await deleteByFieldEquals(env, "comments", "authorId", userKeys, counter);
    paths.push(`comments(authorId)`);
  }

  return { deletedDocs: counter.n, paths };
}

/** 消したあと、Firestore に何が残っているかを数える（読み取りのみ）。 */
export async function firestoreResidue(
  env: FirestoreEnv,
  identity: ResolvedIdentity,
): Promise<{ remaining: Record<string, number>; clean: boolean }> {
  const remaining: Record<string, number> = {
    karte: 0,
    notificationState: 0,
    lineUsers: 0,
    users_line_prefixed: 0,
    comments: 0,
  };
  for (const cid of identity.shopify_ids) {
    if (!/^\d+$/.test(cid)) continue;
    if (await docExists(env, `users/${cid}`)) remaining.karte++;
    if (await docExists(env, `notificationState/${cid}`)) remaining.notificationState++;
  }
  for (const lid of identity.line_ids) {
    if (await docExists(env, `${LINE_USERS_COLLECTION}/${lid}`)) remaining.lineUsers++;
    if (await docExists(env, `users/line:${lid}`)) remaining.users_line_prefixed++;
  }
  const userKeys = [...identity.shopify_ids.filter((c) => /^\d+$/.test(c)), ...identity.line_ids.map((l) => `line:${l}`)];
  if (userKeys.length > 0) remaining.comments = await countByFieldEquals(env, "comments", "authorId", userKeys);

  return { remaining, clean: Object.values(remaining).every((v) => v === 0) };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

type SupabaseEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string };

async function rpc<T>(env: SupabaseEnv, fn: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${fn} failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * 本人の記録を全経路から消し、**残っているものを列挙して返す**。
 *
 * 「消しました」と言うだけにしないため、戻り値には必ず residue（検算結果）を含める。
 * clean が false のときは呼び出し側で失敗として扱うこと。
 */
export async function erasePerson(env: Env, subject: EraseSubject): Promise<ErasureResult> {
  const fsEnv = getFirestoreEnv(env);
  const sbEnv = env as unknown as SupabaseEnv;

  // 1. Supabase。identity の解決も SQL 側で行う（別名表を消す前に集める必要があるため）。
  const sb = await rpc<{
    words_deleted: number;
    ledger_rows_deleted: number;
    person_deleted: number;
    identity: ResolvedIdentity;
    deleted: Record<string, number>;
  }>(sbEnv, "roji_erase_person", { p_subject_kind: subject.kind, p_subject_id: subject.id });

  const identity = sb.identity;

  // 2. Firestore。Supabase が解決した全 ID を使う（起点が LINE でも本カルテに届く）。
  const firestore = await eraseFirestore(fsEnv, identity);

  // 3. 検算。消したあとに何が残っているかを両側で数える。
  const residue = await rpc<{ remaining: Record<string, number>; preserved: Record<string, number>; clean: boolean }>(
    sbEnv,
    "roji_erasure_residue",
    { p_shopify_ids: identity.shopify_ids, p_line_ids: identity.line_ids, p_web_refs: identity.web_refs },
  );
  const fsResidue = await firestoreResidue(fsEnv, identity);

  return {
    identity,
    supabase: { deleted: sb.deleted, words_deleted: sb.words_deleted, ledger_rows_deleted: sb.ledger_rows_deleted },
    firestore,
    residue,
    firestoreResidue: fsResidue,
    clean: residue.clean && fsResidue.clean,
  };
}
