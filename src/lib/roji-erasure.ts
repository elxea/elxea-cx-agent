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
 * ─ ID の形をここで 1 度だけ揃える（修正 F6 / 2026-08-24）─
 *   Supabase の別名表には EC 上の顧客番号が **2 つの形**で入っている:
 *     "7654321" と "gid://shopify/Customer/7654321"（Shopify の Admin API 由来）。
 *   Firestore の置き場は **数字のほう**（users/7654321）でしか掘れない。
 *   旧実装は「数字でなければ黙って飛ばす」を 3 か所（消す側 2・検算側 1）に散らしていたため、
 *   gid 形式の人は **1 件も消さないのに検算も同じ理由で 0 件と数え、clean=true を返した**
 *   （＝「消しました」という嘘。実データ初期化で実証）。
 *   よって形を揃える関数を **1 つだけ**置き（normalizeShopifyCustomerId）、
 *   消す側・検算側・comments の照合キーを**同じ関数**に通す。
 *   さらに、**揃えられなかった ID は黙って捨てず** residue に unmappable_ids として現れる
 *   （数え漏らしが clean を汚す＝嘘をつけない形にする）。
 *
 * ─ 途中で力尽きたときに「失敗」と言わない（修正 F6 / 2026-08-24）─
 *   1 リクエストで消しきれない量（Cloudflare Workers の subrequest 上限）に当たると、
 *   旧実装は**途中まで消したうえで例外**を投げ、呼び出し側には HTTP 500 だけが見えていた
 *   （実測: 21 doc で発生。再送すれば進むのに「失敗」にしか見えない）。
 *   各段階は元々冪等なので、**上限に当たったら例外にせず「続きが要る」を返す**。
 *   このとき Supabase の消去には進まない（別名表を残す＝再送で必ず同じ人を特定できる）。
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

export type FirestoreErasureReport = {
  deletedDocs: number;
  paths: string[];
  /** 1 リクエストの上限に当たって途中で止めたか（= 続きが要る）。 */
  exhausted: boolean;
};

export type FirestoreResidueReport = { remaining: Record<string, number>; clean: boolean };

export type SupabaseResidueReport = {
  remaining: Record<string, number>;
  preserved: Record<string, number>;
  clean: boolean;
};

export type ErasureResult = {
  /**
   * この 1 リクエストで何が起きたか。
   *   erased            … 消し終わった（検算も clean）
   *   incomplete        … 全経路を回したが消し残しがある（＝異常。呼び出し側は失敗として扱う）
   *   continue_required … 1 リクエストの上限で途中まで。**同じ subject で再送すれば続きから消える**
   */
  status: "erased" | "incomplete" | "continue_required";
  identity: ResolvedIdentity;
  /** continue_required のときは Supabase の消去まで進んでいない（別名表を残すため）。 */
  supabase: { deleted: Record<string, number>; words_deleted: number; ledger_rows_deleted: number } | null;
  firestore: FirestoreErasureReport;
  /** 消したあとに残っているもの。すべて 0 なら clean。continue_required のときは未検算 (null)。 */
  residue: SupabaseResidueReport | null;
  firestoreResidue: FirestoreResidueReport | null;
  /** 続きを消すために同じ subject でもう一度呼ぶ必要があるか。 */
  continueRequired: boolean;
  clean: boolean;
};

// ---------------------------------------------------------------------------
// ID の正規化（修正 F6 — 「黙って捨てる」を無くすための唯一の入口）
// ---------------------------------------------------------------------------

/**
 * EC 上の顧客番号を **Firestore の置き場を掘れる形（数字）** に揃える。
 *
 * 受け付ける形:
 *   "7654321"                              -> "7654321"
 *   "gid://shopify/Customer/7654321"       -> "7654321"
 *   "gid://shopify/Customer/7654321?x=1"   -> "7654321"（Shopify が付ける修飾は落とす）
 * 揃えられない形（"", "abc", "gid://shopify/Order/1" 等）は **null**。
 * null は呼び出し側で「黙って捨てる」のではなく **数えて residue に出す**こと。
 *
 * なぜ 1 か所に置くか: 旧実装は同じ判定（/^\d+$/）を消す側 2 か所・検算側 1 か所に
 * 散らしており、3 か所が同時に同じ理由で取りこぼしたため「消していないのに clean」になった。
 * 判定を 1 つにすれば、消す範囲と検算の範囲が構造的に一致する。
 */
export function normalizeShopifyCustomerId(raw: string | null | undefined): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s === "") return null;
  if (/^\d+$/.test(s)) return s;
  const m = /^gid:\/\/shopify\/Customer\/(\d+)(?:[?#].*)?$/i.exec(s);
  return m?.[1] ?? null;
}

/**
 * Firestore のパス 1 節として使える文字列か（LINE の ID 等）。
 * "/" を含むと別の階層になってしまい、意図しない場所を掘る。空・"." / ".." も不可。
 */
export function isUsablePathSegment(raw: string | null | undefined): boolean {
  const s = typeof raw === "string" ? raw : "";
  if (s === "" || s === "." || s === "..") return false;
  if (s.includes("/")) return false;
  if (/\s/.test(s)) return false;
  return true;
}

/**
 * 本人の ID 群を **Firestore 用の形**にまとめる。消す側と検算側は必ずこれを使う
 * （両者が同じ集合を見ることが「偽の clean」を構造的に防ぐ唯一の方法）。
 */
export function firestoreKeys(identity: ResolvedIdentity): {
  customerIds: string[];
  lineIds: string[];
  /** 形を揃えられず Firestore で扱えなかった ID の数（本人の ID そのものは持ち出さない）。 */
  unmappable: number;
} {
  const customerIds = new Set<string>();
  const lineIds = new Set<string>();
  let unmappable = 0;

  for (const raw of identity.shopify_ids ?? []) {
    const n = normalizeShopifyCustomerId(raw);
    if (n === null) unmappable++;
    else customerIds.add(n);
  }
  for (const raw of identity.line_ids ?? []) {
    if (!isUsablePathSegment(raw)) unmappable++;
    else lineIds.add(raw);
  }
  return { customerIds: [...customerIds], lineIds: [...lineIds], unmappable };
}

/** comments.authorId の照合キー（数字の顧客番号 と "line:xxx"）。消す側・検算側で共用する。 */
function commentAuthorKeys(keys: { customerIds: string[]; lineIds: string[] }): string[] {
  return [...keys.customerIds, ...keys.lineIds.map((l) => `line:${l}`)];
}

// ---------------------------------------------------------------------------
// 1 リクエストで使える呼び出し回数（修正 F6 — 途中終了を「失敗」にしない）
// ---------------------------------------------------------------------------

/**
 * 1 リクエストで外へ投げてよい呼び出し回数の既定上限。
 *
 * Cloudflare Workers は 1 回の実行で出せる subrequest 数に上限がある。上限に当たると
 * fetch が例外を投げ、旧実装ではそれが HTTP 500 になっていた（＝途中まで消したのに「失敗」）。
 * ここでは 2 段で守る:
 *   (1) 予防 — この予算を使い切ったら**自分から**止まる（`ERASE_SUBREQUEST_BUDGET` で上書き可）
 *   (2) 事後 — それでも上限側が先に発火したら、その例外を「予算切れ」として扱う
 * どちらの経路でも結果は同じ「continue_required（続きが要る）」で、例外にはしない。
 *
 * ⚠ 主役は (1) の予防でなければならない。(2) だけに頼ると、上限側が先に発火した瞬間に
 *   **溜めた削除を流す commit も撃てなくなる**（＝その回は 1 件も減らない）。すると再送しても
 *   毎回同じところで止まり、永久に前へ進まない。だから予算は実際の上限より必ず低く置く。
 *
 * 既定値 40 の根拠: 旧実装は 1 doc あたり listCollectionIds + DELETE の 2 回を使い、
 * **21 doc で上限に当たった**（実データ初期化での実測）＝ 実際の上限は 50 前後。40 はその下。
 * 上限がもっと高い環境では `ERASE_SUBREQUEST_BUDGET` で引き上げてよい
 * （引き上げるほど 202 で刻む回数が減るだけで、挙動は変わらない）。
 */
const DEFAULT_SUBREQUEST_BUDGET = 40;

/**
 * 1 回の commit にまとめる削除の数（Firestore の上限は 500 writes/commit）。
 *
 * 小さめにしてこまめに流す。理由は上と同じで、**万一 (2) の経路で止まっても
 * 直前までの分は既に消えている**状態を保つため（＝必ず前に進む）。
 */
const COMMIT_BATCH_SIZE = 20;

/** 1 リクエスト分の呼び出し予算。eraseFirestore と検算で**共有**する。 */
export type SubrequestBudget = { calls: number; limit: number; exhausted: boolean };

/**
 * 予算の下限（＝ `ERASE_SUBREQUEST_BUDGET` は引き上げにしか使えない）。
 *
 * 再送は毎回「起点（users/{顧客番号} / notificationState / lineUsers / users/line:… ）が
 * 消えているか」の確認からやり直す。**もう何も残っていない状態を最後まで確認しきるだけで**
 * 20〜25 回を使う（起点 4 か所 × 消す側 2 回 + 検算側 2 回、comments の照合 2 回、Supabase の RPC 3 回）。
 * 予算がこの固定分を下回ると、毎回その確認の途中で力尽きて **1 件も進まないまま
 * 「続きが要る」を返し続ける**。前に進むことを構造的に保証するための床。
 */
const MIN_SUBREQUEST_BUDGET = 40;

export function createBudget(limit = DEFAULT_SUBREQUEST_BUDGET): SubrequestBudget {
  return { calls: 0, limit: Math.max(MIN_SUBREQUEST_BUDGET, limit), exhausted: false };
}

/** 予算切れ。**例外として外へ出さない**（呼び出し側で continue_required に変換する）。 */
class BudgetExhausted extends Error {
  constructor() {
    super("subrequest budget exhausted");
    this.name = "BudgetExhausted";
  }
}

/**
 * 「1 リクエストで出せる量の上限」に当たったことを示す例外か。
 *
 * ⚠ Firestore/Supabase が返す普通の失敗（"list orders failed (500)" 等）を
 *   ここで拾ってはならない。拾うと**本物の失敗を「続きが要る」に化かして**しまい、
 *   まさに本タスクで潰そうとしている「偽の報告」を別の形で作ることになる。
 */
function isCapacityError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return /too many subrequests|subrequest limit|exceeded (?:the )?(?:\w+ )*(?:limit|quota)|worker exceeded resource limits/i.test(
    message,
  );
}

/** 環境変数から予算を作る（未設定・不正値は既定値）。 */
function budgetFromEnv(env: unknown): SubrequestBudget {
  const raw = (env as { ERASE_SUBREQUEST_BUDGET?: string })?.ERASE_SUBREQUEST_BUDGET;
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN;
  return createBudget(Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SUBREQUEST_BUDGET);
}

/**
 * 予算を 1 つ使う。残りが reserve 以下なら BudgetExhausted。
 *
 * ⚠ ここで `budget.exhausted` を条件に入れてはならない。最後の 1 回は
 *   「溜めた削除を流す commit」のために取ってあり（reserve=0 で呼ばれる）、
 *   フラグで先に弾くと **消せるはずの分を消さないまま**終わってしまう。
 */
function spend(budget: SubrequestBudget, reserve = 0): void {
  if (budget.limit - budget.calls <= reserve) {
    budget.exhausted = true;
    throw new BudgetExhausted();
  }
  budget.calls++;
}

// ---------------------------------------------------------------------------
// Firestore REST の薄いヘルパ（この用途に必要な分だけ）
// ---------------------------------------------------------------------------

/**
 * 例外メッセージ・ログに出してよい形にパスを丸める。
 *
 * Firestore のパスは `users/{顧客番号}/orders` のように **本人の ID を含む**。
 * これを例外メッセージに入れると、失敗したときログに残り、
 * 「この人を消そうとした」という痕跡になる（確定原則違反）。
 * **エラーのときこそログは残る**ので、投げる時点で ID を落とす。
 *
 * 置き場の種類（コレクション名）だけを返す:
 *   users/123          -> users
 *   users/123/orders   -> orders
 *   users/123/orders/x -> orders
 *   lineUsers/Uxxx     -> lineUsers
 */
export function pathKind(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return "unknown";
  // ドキュメントのパスは偶数個（collection/doc/...）、コレクションのパスは奇数個。
  return (parts.length % 2 === 0 ? parts[parts.length - 2] : parts[parts.length - 1]) ?? "unknown";
}

/** 1 リクエスト分の作業状態（環境 + 予算 + 遅延削除キュー）。 */
type Session = {
  env: FirestoreEnv;
  budget: SubrequestBudget;
  /** commit でまとめて消すために溜めたドキュメントのパス（存在が確認済みのものだけ）。 */
  pending: string[];
};

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
 * 予算を数えながら Firestore を叩く。
 * 溜めた削除がある間は 1 回分を「最後の commit 用」に残す（消したのに数えられない状態を作らない）。
 */
async function sFetch(
  s: Session,
  path: string,
  init: RequestInit & { method: string },
  opts: { reserve?: number } = {},
): Promise<Response> {
  spend(s.budget, opts.reserve ?? (s.pending.length > 0 ? 1 : 0));
  try {
    return await fsFetch(s.env, path, init);
  } catch (e) {
    if (isCapacityError(e)) {
      s.budget.exhausted = true;
      throw new BudgetExhausted();
    }
    throw e;
  }
}

/**
 * ドキュメント直下のサブコレクション名を **実行時に列挙する**。
 * 名前をベタ書きしないための要。増えた置き場を自動的に拾う。
 */
async function listSubcollections(s: Session, docPath: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const body: Record<string, unknown> = { pageSize: 300 };
    if (pageToken) body.pageToken = pageToken;
    const res = await sFetch(s, `/${docPath}:listCollectionIds`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // ドキュメントが無い場合もサブコレクションは在りうるため、404 は空扱いにしない。
      if (res.status === 404) return ids;
      throw new Error(`listCollectionIds failed (${res.status}) for ${pathKind(docPath)}`);
    }
    const json = (await res.json()) as { collectionIds?: string[]; nextPageToken?: string };
    ids.push(...(json.collectionIds ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);
  return ids;
}

/**
 * 溜めた削除を commit でまとめて流す（1 回の呼び出しで最大 COMMIT_BATCH_SIZE 件）。
 *
 * なぜまとめるか: 1 doc = listCollectionIds + DELETE の 2 回だったものが約 1 回になり、
 * 1 リクエストで消しきれる量が倍になる（＝続きが要る場面そのものを減らす）。
 * キューに入るのは**列挙で存在を確認したドキュメントだけ**なので、件数の意味は変わらない。
 */
async function flushDeletes(s: Session, counter: { n: number }): Promise<void> {
  const prefix = `projects/${s.env.FIREBASE_PROJECT_ID}/databases/(default)/documents/`;
  while (s.pending.length > 0) {
    const chunk = s.pending.slice(0, COMMIT_BATCH_SIZE);
    const res = await sFetch(
      s,
      `:commit`,
      { method: "POST", body: JSON.stringify({ writes: chunk.map((p) => ({ delete: `${prefix}${p}` })) }) },
      { reserve: 0 },
    );
    if (!res.ok) throw new Error(`commit delete failed (${res.status})`);
    s.pending.splice(0, chunk.length);
    counter.n += chunk.length;
  }
}

/** 消す予定に積む（存在が確認済みのドキュメントのみ）。溜まったら流す。 */
async function queueDelete(s: Session, docPath: string, counter: { n: number }): Promise<void> {
  s.pending.push(docPath);
  if (s.pending.length >= COMMIT_BATCH_SIZE) await flushDeletes(s, counter);
}

/** コレクション配下の全ドキュメントを消す（サブコレクションがあれば再帰）。 */
async function deleteCollection(
  s: Session,
  collectionPath: string,
  counter: { n: number },
  depth = 0,
): Promise<void> {
  if (depth > 5) throw new Error(`deleteCollection: depth limit exceeded at ${pathKind(collectionPath)}`);
  let pageToken: string | undefined;
  do {
    const qs = new URLSearchParams({ pageSize: "300", "mask.fieldPaths": "__name__" });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = await sFetch(s, `/${collectionPath}?${qs}`, { method: "GET" });
    if (res.status === 404) return;
    if (!res.ok) throw new Error(`list ${pathKind(collectionPath)} failed (${res.status})`);
    const json = (await res.json()) as { documents?: Array<{ name: string }>; nextPageToken?: string };
    for (const doc of json.documents ?? []) {
      const rel = doc.name.split("/documents/")[1];
      if (!rel) continue;
      await deleteDocumentDeep(s, rel, counter, depth + 1, true);
    }
    pageToken = json.nextPageToken;
  } while (pageToken);
}

/**
 * ドキュメントと、その配下の全サブコレクションを消す。
 *
 * `batched=true` は「列挙で存在が確認できたドキュメント」用（commit にまとめる）。
 * 起点（users/{顧客番号} 等・そもそも在るか分からない）は false で 1 件ずつ消し、
 * **実際に消えたものだけ**を数える（従来の件数の意味を変えない）。
 */
async function deleteDocumentDeep(
  s: Session,
  docPath: string,
  counter: { n: number },
  depth = 0,
  batched = false,
): Promise<void> {
  for (const sub of await listSubcollections(s, docPath)) {
    await deleteCollection(s, `${docPath}/${sub}`, counter, depth + 1);
  }
  if (batched) {
    await queueDelete(s, docPath, counter);
    return;
  }
  const res = await sFetch(s, `/${docPath}`, { method: "DELETE" });
  // 既に無い場合も成功扱い（冪等）。
  if (res.ok || res.status === 404) {
    if (res.ok) counter.n++;
    return;
  }
  throw new Error(`delete ${pathKind(docPath)} failed (${res.status})`);
}

/** ある値のフィールドに一致するトップレベルのドキュメントを消す（comments.authorId 用）。 */
async function deleteByFieldEquals(
  s: Session,
  collection: string,
  field: string,
  values: string[],
  counter: { n: number },
): Promise<void> {
  for (const value of values) {
    let done = false;
    while (!done) {
      const res = await sFetch(s, `:runQuery`, {
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
      const docs = rows.filter((r) => r.document).map((r) => r.document!.name.split("/documents/")[1]!);
      if (docs.length === 0) break;
      for (const d of docs) await deleteDocumentDeep(s, d, counter, 0, true);
      // ⚠ この検索はカーソルを持たない（毎回同じ条件で引き直す）。溜めた削除を流さずに
      //   引き直すと**同じ 300 件がまた返って永久に終わらない**。ページごとに必ず流す。
      await flushDeletes(s, counter);
      done = docs.length < 300;
    }
  }
}

/** そのフィールド値を持つドキュメントが何件残っているかを数える（検算用・読み取りのみ）。 */
async function countByFieldEquals(
  s: Session,
  collection: string,
  field: string,
  values: string[],
): Promise<number> {
  let total = 0;
  for (const value of values) {
    const res = await sFetch(s, `:runQuery`, {
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
async function docExists(s: Session, docPath: string): Promise<boolean> {
  const res = await sFetch(s, `/${docPath}?mask.fieldPaths=__name__`, { method: "GET" });
  if (res.ok) return true;
  if (res.status === 404) {
    // ドキュメント本体が無くてもサブコレクションが残っていれば「残っている」と数える。
    return (await listSubcollections(s, docPath)).length > 0;
  }
  throw new Error(`get ${pathKind(docPath)} failed (${res.status})`);
}

// ---------------------------------------------------------------------------
// Firestore 側の消去 / 検算
// ---------------------------------------------------------------------------

/**
 * 本人の全 ID について、Firestore 上の置き場を消す。
 *
 * 1 リクエストの上限に当たったときは例外にせず `exhausted: true` を返す
 * （途中まで消えている＝再送で続きから消える。各段階は冪等）。
 * Firestore 自体の失敗（500 等）は従来どおり例外のまま外に出す。
 */
export async function eraseFirestore(
  env: FirestoreEnv,
  identity: ResolvedIdentity,
  budget: SubrequestBudget = createBudget(),
): Promise<FirestoreErasureReport> {
  const s: Session = { env, budget, pending: [] };
  const counter = { n: 0 };
  const paths: string[] = [];
  const keys = firestoreKeys(identity);

  try {
    // 本カルテ + 配下の全サブコレクション（列挙するので broadcastHistory 等も自動で入る）
    for (const cid of keys.customerIds) {
      await deleteDocumentDeep(s, `users/${cid}`, counter);
      paths.push(`users/${cid}`);
      await deleteDocumentDeep(s, `notificationState/${cid}`, counter);
      paths.push(`notificationState/${cid}`);
    }

    // 未連携カルテ①（cx-agent）と ②（web-app）
    for (const lid of keys.lineIds) {
      await deleteDocumentDeep(s, `${LINE_USERS_COLLECTION}/${lid}`, counter);
      paths.push(`${LINE_USERS_COLLECTION}/${lid}`);
      await deleteDocumentDeep(s, `users/line:${lid}`, counter);
      paths.push(`users/line:${lid}`);
    }

    // コメント（本人が書いた本文が残る。userKey は数字の顧客番号か "line:xxx"）
    const userKeys = commentAuthorKeys(keys);
    if (userKeys.length > 0) {
      await deleteByFieldEquals(s, "comments", "authorId", userKeys, counter);
      paths.push(`comments(authorId)`);
    }

    await flushDeletes(s, counter);
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e;
    // 予算切れ。**溜めた分だけでも消してから**「続きが要る」を返す。
    try {
      await flushDeletes(s, counter);
    } catch {
      // 予算を完全に使い切っている。消せなかった分は再送で消える（冪等）。
    }
  }

  return { deletedDocs: counter.n, paths, exhausted: budget.exhausted };
}

/**
 * 消したあと、Firestore に何が残っているかを数える（読み取りのみ）。
 *
 * ⚠ 消す側と**同じ** firestoreKeys を使う。両者の見る範囲がずれると
 *   「消していないのに 0 件」という偽の clean が生まれる（修正 F6 の原因そのもの）。
 * 数え切れなかったとき（予算切れ）は unchecked を立てて clean=false にする
 *   — 数えられなかったものを「無い」と言わない。
 */
export async function firestoreResidue(
  env: FirestoreEnv,
  identity: ResolvedIdentity,
  budget: SubrequestBudget = createBudget(),
): Promise<FirestoreResidueReport> {
  const s: Session = { env, budget, pending: [] };
  const keys = firestoreKeys(identity);
  const remaining: Record<string, number> = {
    karte: 0,
    notificationState: 0,
    lineUsers: 0,
    users_line_prefixed: 0,
    comments: 0,
    // 形を揃えられず Firestore で扱えなかった ID（黙って捨てない）。
    unmappable_ids: keys.unmappable,
    // 予算切れ等で数え切れなかった項目の数。
    unchecked: 0,
  };

  try {
    for (const cid of keys.customerIds) {
      if (await docExists(s, `users/${cid}`)) remaining.karte++;
      if (await docExists(s, `notificationState/${cid}`)) remaining.notificationState++;
    }
    for (const lid of keys.lineIds) {
      if (await docExists(s, `${LINE_USERS_COLLECTION}/${lid}`)) remaining.lineUsers++;
      if (await docExists(s, `users/line:${lid}`)) remaining.users_line_prefixed++;
    }
    const userKeys = commentAuthorKeys(keys);
    if (userKeys.length > 0) remaining.comments = await countByFieldEquals(s, "comments", "authorId", userKeys);
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e;
    remaining.unchecked = 1;
  }

  return { remaining, clean: Object.values(remaining).every((v) => v === 0) };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

type SupabaseEnv = { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string };

async function rpc<T>(
  env: SupabaseEnv,
  fn: string,
  args: Record<string, unknown>,
  budget?: SubrequestBudget,
): Promise<T> {
  if (budget) spend(budget);
  let res: Response;
  try {
    res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
  } catch (e) {
    if (budget && isCapacityError(e)) {
      budget.exhausted = true;
      throw new BudgetExhausted();
    }
    throw e;
  }
  // 応答本文は載せない。Postgres のエラーは違反した値（＝本人の ID）を
  // そのまま引用することがあり、それがログに残ると痕跡になる（確定原則）。
  if (!res.ok) throw new Error(`rpc ${fn} failed (${res.status})`);
  return (await res.json()) as T;
}

/**
 * 本人の記録を全経路から消し、**残っているものを列挙して返す**。
 *
 * 「消しました」と言うだけにしないため、戻り値には必ず residue（検算結果）を含める。
 * clean が false のときは呼び出し側で失敗として扱うこと。
 * ただし `continueRequired` が true のときは「失敗」ではなく「途中」— 同じ subject で
 * 再送すれば続きから消える（各段階は冪等。別名表もまだ生きている）。
 */
export async function erasePerson(env: Env, subject: EraseSubject): Promise<ErasureResult> {
  const fsEnv = getFirestoreEnv(env);
  const sbEnv = env as unknown as SupabaseEnv;
  const budget = budgetFromEnv(env);

  // ── 順番が仕様の一部である（変えてはならない）────────────────────
  //
  //   特定 → Firestore → Supabase の順で行う。理由は「**本人を特定する手がかりを
  //   最後に消す**」ため。別名表（customer_linkages / user_identity_map）は
  //   「LINE の ID ↔ EC 上の顧客番号」の対応そのもので、これが消えると
  //   **もう誰なのか分からなくなる**。
  //
  //   逆順（Supabase を先に消す）にすると、途中で Firestore の消去が失敗したとき、
  //   再送しても LINE の ID を辿れず、未連携カルテが**永久に消えないまま**
  //   「消えました」と報告される。約束が嘘になる、まさにその経路。
  //
  //   この順なら、どの段階で落ちても別名表が生きているので、
  //   **何度でも安全に再送できる**（各段階は冪等）。

  // 1. 特定（読み取りのみ）。別名表が生きているうちに、本人の全 ID を集める。
  const identity = await rpc<ResolvedIdentity>(sbEnv, "roji_resolve_identity", {
    p_subject_kind: subject.kind,
    p_subject_id: subject.id,
  });

  // 2. Firestore。失敗したら例外を投げてここで止まる（Supabase には進まない）。
  //    別名表はまだ生きているので、再送で同じ人を必ず特定できる。
  const firestore = await eraseFirestore(fsEnv, identity, budget);

  // 2'. 1 リクエストで消しきれなかった場合は **ここで止める**。
  //     Supabase（別名表を含む）に進むと、次に呼ばれたとき本人を特定できず
  //     未連携カルテが永久に残る。止めても各段階は冪等なので、再送で続きから消える。
  if (firestore.exhausted) {
    return {
      status: "continue_required",
      identity,
      supabase: null,
      firestore,
      residue: null,
      firestoreResidue: null,
      continueRequired: true,
      clean: false,
    };
  }

  try {
    // 3. Supabase。特定に使う別名表を含め、ここで初めて消す。
    const sb = await rpc<{
      words_deleted: number;
      ledger_rows_deleted: number;
      person_deleted: number;
      identity: ResolvedIdentity;
      deleted: Record<string, number>;
    }>(sbEnv, "roji_erase_person", { p_subject_kind: subject.kind, p_subject_id: subject.id }, budget);

    // 消す直前に SQL 側が解決した ID と突き合わせ、**広いほう**で検算する。
    // 1 と 3 の間に増えた ID があっても取りこぼさないため。
    // ⚠ ここは **Supabase に入っている生の形のまま**保つ（gid 形式もそのまま）。
    //   Supabase 側の検算は文字列一致で引くため、正規化すると引けなくなる。
    //   Firestore 用の形への変換は firestoreKeys が消す側・検算側の両方で行う。
    const merged: ResolvedIdentity = {
      shopify_ids: [...new Set([...identity.shopify_ids, ...(sb.identity?.shopify_ids ?? [])])],
      line_ids: [...new Set([...identity.line_ids, ...(sb.identity?.line_ids ?? [])])],
      web_refs: [...new Set([...identity.web_refs, ...(sb.identity?.web_refs ?? [])])],
      person_seqs: [...new Set([...identity.person_seqs, ...(sb.identity?.person_seqs ?? [])])],
    };

    // 4. 検算。消したあとに何が残っているかを両側で数える。
    //    別名表を消したあとでは同じ ID 群を二度と復元できないため、
    //    ここで必ず控えておいた merged を使う。
    const residue = await rpc<SupabaseResidueReport>(
      sbEnv,
      "roji_erasure_residue",
      { p_shopify_ids: merged.shopify_ids, p_line_ids: merged.line_ids, p_web_refs: merged.web_refs },
      budget,
    );
    const fsResidue = await firestoreResidue(fsEnv, merged, budget);
    const clean = residue.clean && fsResidue.clean;

    return {
      status: clean ? "erased" : "incomplete",
      identity: merged,
      supabase: { deleted: sb.deleted, words_deleted: sb.words_deleted, ledger_rows_deleted: sb.ledger_rows_deleted },
      firestore,
      residue,
      firestoreResidue: fsResidue,
      continueRequired: false,
      clean,
    };
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e;
    // Firestore は消し終えたが、Supabase の消去／検算まで届かなかった。
    // 「失敗」ではなく「続きが要る」— 再送すれば同じ人を特定して続きから消せる。
    return {
      status: "continue_required",
      identity,
      supabase: null,
      firestore,
      residue: null,
      firestoreResidue: null,
      continueRequired: true,
      clean: false,
    };
  }
}
