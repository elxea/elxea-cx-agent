/**
 * Notion 配信リポジトリ（T5）。
 *
 * 設計: 「Notion駆動 LINE配信 設計確定版 v1.0」§4/§5/§8
 *   配信DB query（Approved AND 日時<=now AND 未送信）／結果 PATCH
 *   （送信済み=true, sent_at, 送信結果, 消費実績, エラー詳細 / PII 非記載）。
 *
 * knowledge.ts の notionFetch（素 REST・2022-06-28）と content-hub-writer.ts の
 * POST パターンを土台に、page query + PATCH を追加する。
 * notionRequest を注入可能にしてユニットテストをネットワーク非接触に保つ。
 *
 * data source: e6b06af8-10d3-4b05-bc98-33b3fe830c9f（配信コンテンツ DB）
 */

import type { Env } from "../index";
import { parseTargetEnv } from "./delivery-channel";

/** 配信コンテンツ DB のプロパティ名（Notion 実スキーマ・日本語）。 */
export const DELIVERY_PROPS = {
  title: "配信タイトル",
  status: "Status",
  scheduled: "配信予定日時",
  audience: "配信対象",
  format: "形式",
  body: "本文",
  /** files 型「画像」。運用者が Notion に直接ドラッグ&ドロップする（URL 手入力は廃止）。 */
  image: "画像",
  estimate: "通数見積",
  consumed: "消費実績",
  contentHash: "コンテンツハッシュ",
  sent: "送信済み",
  sentAt: "sent_at",
  sendResult: "送信結果",
  errorDetail: "エラー詳細",
  assignees: "担当者",
  approvers: "承認者",
} as const;

/**
 * 本番配信 DB の database_id（Notion）。prod ワーカーの既定参照先。
 * env NOTION_DELIVERY_DB_ID で上書き可能。従来の単一 DEFAULT と同一値のため prod 挙動は不変。
 */
export const PROD_DELIVERY_DB_ID = "f95bb981-3c1a-4b6e-abd2-8b39551f6492";

/**
 * @deprecated 後方互換の別名（値は PROD_DELIVERY_DB_ID と同一）。
 * ランタイムの DB 解決は resolveDeliveryDbId(env) を使うこと（env 分離・fail-closed）。
 * repository 関数のデフォルト引数（ユニットテストの明示 dbId 前提）でのみ残す。
 */
export const DEFAULT_DELIVERY_DB_ID = PROD_DELIVERY_DB_ID;

/**
 * 配信 DB 解決の fail-closed エラー。
 * cross-env 誤配線（test ワーカーが prod DB を指す / test で専用 DB 未設定）を送信前に塞ぐ。
 */
export class DeliveryDbConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryDbConfigError";
  }
}

/**
 * 配信ワーカーが読む Notion 配信 DB を env から解決する（純粋・fail-closed）。
 *
 * 背景リスク: test/staging と prod が同一配信 DB を共有すると、テストで作った行が
 *   prod ワーカー（DELIVERY_TARGET_ENV=prod）の 15 分毎 cron に拾われ、送信ON時に
 *   本番 OA へ誤配信されうる（cross-env 送信）。これを「設計として不可能」にする。
 *
 * 不変条件（この 2 つで cross-send を構造的に排除する）:
 *   - prod ワーカー: 明示 NOTION_DELIVERY_DB_ID があればそれ、無ければ PROD_DELIVERY_DB_ID。
 *       現行 prod は NOTION_DELIVERY_DB_ID 未設定 → PROD_DELIVERY_DB_ID（＝従来 DEFAULT・挙動不変）。
 *   - test/staging ワーカー: 専用 NOTION_DELIVERY_DB_ID を必須。prod DB へは絶対にフォールバック
 *       しない。未設定なら throw（fail-closed）。値が PROD_DELIVERY_DB_ID なら throw
 *       （test ワーカーが本番行を拾う逆方向も塞ぐ）。
 *   → 2 つの env が同一 DB を解決することは起こらない（test 未設定は「共有 DB」ではなく「停止」に倒れる）。
 *
 * targetEnv の解釈は parseTargetEnv と同一（未設定・不正値は "test"＝厳しい側）。
 */
export function resolveDeliveryDbId(env: {
  DELIVERY_TARGET_ENV?: string;
  NOTION_DELIVERY_DB_ID?: string;
}): string {
  const targetEnv = parseTargetEnv(env.DELIVERY_TARGET_ENV);
  const explicit = env.NOTION_DELIVERY_DB_ID?.trim();

  if (targetEnv === "prod") {
    // prod: 明示があれば優先、無ければ本番 DB 既定（従来どおり・挙動不変）。
    return explicit && explicit.length > 0 ? explicit : PROD_DELIVERY_DB_ID;
  }

  // test/staging: 専用 DB を必須にし、prod DB へは決してフォールバックしない。
  if (!explicit || explicit.length === 0) {
    throw new DeliveryDbConfigError(
      "test/staging に専用の NOTION_DELIVERY_DB_ID が未設定（prod 配信 DB へフォールバックしない fail-closed）",
    );
  }
  if (explicit === PROD_DELIVERY_DB_ID) {
    throw new DeliveryDbConfigError(
      "test/staging ワーカーが本番配信 DB を参照している（cross-env 誤配線・fail-closed）",
    );
  }
  return explicit;
}

/** query/PATCH 済みの配信ページ（正規化済み）。 */
export interface DeliveryPage {
  id: string;
  title: string;
  status: string;
  audienceRaw: string | null;
  /**
   * 形式。files「画像」が 1 件以上あれば "image"、無ければ "text"（コード自動判定）。
   * Notion「形式」select は読まない（view 非表示・自動判定化）。
   */
  format: "text" | "image" | null;
  body: string | null;
  /**
   * files「画像」の Notion 一時URL（署名・約1時間失効）。順序保持。
   * 承認 pin 時に R2 取込のソースとして使う（送信時は使わない）。
   */
  imageSourceUrls: string[];
  /** files「画像」の枚数（送信時の恒久R2 URL 再構成に使う）。 */
  imageCount: number;
  /**
   * 恒久 R2 公開URL 群（送信・ハッシュ照合で使用）。normalize では埋めず、
   * runtime（R2 公開ベースを知る層）が imageCount から決定的に再構成して埋める。
   */
  imageUrls?: string[];
  scheduledStart: string | null;
  sent: boolean;
  contentHash: string | null;
  estimate: number | null;
  assignees: string[];
  approvers: string[];
  lastEditedTime: string | null;
}

/** 結果書戻しの内容（PII 非記載）。 */
export interface DeliveryResult {
  status: "Sent" | "Failed" | "PartialFail";
  sentAtUtc: string;
  /** 結果サマリ（PII 非記載）。 */
  summary: string;
  /** 実送信人数。 */
  consumed: number;
  /** エラー詳細（PII 非記載）。無ければ空文字。 */
  errorDetail?: string;
}

/** Notion REST 呼び出しポート（テストは fake を注入）。 */
export type NotionRequest = (
  path: string,
  method: "GET" | "POST" | "PATCH",
  body?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** 実 Notion REST 実装（2022-06-28・knowledge.ts と同一方針）。 */
export function createNotionRequest(env: Env): NotionRequest {
  return async (path, method, body) => {
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`Notion API error ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// プロパティ抽出ヘルパー（純粋）
// ---------------------------------------------------------------------------

type RawProp = Record<string, unknown>;

function selectName(p: RawProp | undefined): string | null {
  const sel = p?.select as { name?: string } | null | undefined;
  return sel?.name ?? null;
}
function statusName(p: RawProp | undefined): string {
  // 配信DB の Status は Notion「select」型（status 型ではない）。select.name を読む。
  const s = p?.select as { name?: string } | null | undefined;
  return s?.name ?? "";
}
function richText(p: RawProp | undefined): string | null {
  const arr = p?.rich_text as Array<{ plain_text?: string }> | undefined;
  if (!arr || arr.length === 0) return null;
  const t = arr.map((x) => x.plain_text ?? "").join("");
  return t.length > 0 ? t : null;
}
function titleText(p: RawProp | undefined): string {
  const arr = p?.title as Array<{ plain_text?: string }> | undefined;
  return (arr ?? []).map((x) => x.plain_text ?? "").join("") || "Untitled";
}
function numberVal(p: RawProp | undefined): number | null {
  const n = p?.number as number | null | undefined;
  return typeof n === "number" ? n : null;
}
function checkboxVal(p: RawProp | undefined): boolean {
  return (p?.checkbox as boolean | undefined) ?? false;
}
function dateStart(p: RawProp | undefined): string | null {
  const d = p?.date as { start?: string | null } | null | undefined;
  return d?.start ?? null;
}
function peopleIds(p: RawProp | undefined): string[] {
  const arr = p?.people as Array<{ id?: string }> | undefined;
  return (arr ?? []).map((x) => x.id ?? "").filter((x) => x.length > 0);
}
/**
 * files 型プロパティの URL 群を順序保持で取り出す（純粋）。
 * Notion のアップロードファイルは type="file"（file.url = 一時署名URL）、
 * 外部リンクは type="external"（external.url）。両対応で順に返す。
 */
function filesUrls(p: RawProp | undefined): string[] {
  const arr = p?.files as
    | Array<{ type?: string; file?: { url?: string }; external?: { url?: string } }>
    | undefined;
  if (!arr) return [];
  return arr
    .map((f) => f?.file?.url ?? f?.external?.url ?? "")
    .filter((u) => typeof u === "string" && u.length > 0);
}

/** Notion page オブジェクトを DeliveryPage に正規化する（純粋）。 */
export function normalizeDeliveryPage(page: {
  id: string;
  last_edited_time?: string;
  properties: Record<string, RawProp>;
}): DeliveryPage {
  const p = page.properties;
  const P = DELIVERY_PROPS;
  // 形式は自動判定: files「画像」が 1 件以上あれば image、無ければ text。
  // Notion「形式」select は読まない（廃止・view 非表示）。
  const imageSourceUrls = filesUrls(p[P.image]);
  const imageCount = imageSourceUrls.length;
  return {
    id: page.id,
    title: titleText(p[P.title]),
    status: statusName(p[P.status]),
    audienceRaw: selectName(p[P.audience]),
    format: imageCount > 0 ? "image" : "text",
    body: richText(p[P.body]),
    imageSourceUrls,
    imageCount,
    scheduledStart: dateStart(p[P.scheduled]),
    sent: checkboxVal(p[P.sent]),
    contentHash: richText(p[P.contentHash]),
    estimate: numberVal(p[P.estimate]),
    assignees: peopleIds(p[P.assignees]),
    approvers: peopleIds(p[P.approvers]),
    lastEditedTime: page.last_edited_time ?? null,
  };
}

// ---------------------------------------------------------------------------
// query / PATCH
// ---------------------------------------------------------------------------

/**
 * 送信候補を取得する: Status=Approved AND 送信済み != true。
 *
 * ⚠ 2026-08-22（完全オンデマンド化・Setaka 指示）: **配信予定日時の条件を外した**。
 *   以前は `配信予定日時 <= now` を AND していたが、配信は cron の自動発火ではなく
 *   `POST /api/delivery/run` を明示的に叩いたときにだけ走るようになったため、
 *   「承認済み＝送る準備ができている」を送信条件にする。予定日時が未来でも空でも拾う。
 *   予定日時（P.scheduled）は運用者の記録用メモとして残るだけで、送信判定には使わない。
 */
export async function queryApprovedDeliveries(
  request: NotionRequest,
  dbId: string = DEFAULT_DELIVERY_DB_ID,
): Promise<DeliveryPage[]> {
  const P = DELIVERY_PROPS;
  const pages: DeliveryPage[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      page_size: 100,
      filter: {
        and: [
          { property: P.status, select: { equals: "Approved" } },
          { property: P.sent, checkbox: { equals: false } },
        ],
      },
    };
    if (cursor) body.start_cursor = cursor;

    const data = (await request(`/databases/${dbId}/query`, "POST", body)) as {
      results: Array<{
        id: string;
        last_edited_time?: string;
        properties: Record<string, RawProp>;
      }>;
      has_more: boolean;
      next_cursor?: string;
    };

    for (const r of data.results) pages.push(normalizeDeliveryPage(r));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return pages;
}

/** Status=Sending のページを取得（reaper 用）。 */
export async function querySendingDeliveries(
  request: NotionRequest,
  dbId: string = DEFAULT_DELIVERY_DB_ID,
): Promise<DeliveryPage[]> {
  const P = DELIVERY_PROPS;
  const body: Record<string, unknown> = {
    page_size: 100,
    filter: { property: P.status, select: { equals: "Sending" } },
  };
  const data = (await request(`/databases/${dbId}/query`, "POST", body)) as {
    results: Array<{
      id: string;
      last_edited_time?: string;
      properties: Record<string, RawProp>;
    }>;
  };
  return data.results.map(normalizeDeliveryPage);
}

/** Status を変更する（Approved→Sending, Sending→Approved の reaper 復旧等）。 */
export async function setStatus(
  request: NotionRequest,
  pageId: string,
  status: string,
): Promise<void> {
  await request(`/pages/${pageId}`, "PATCH", {
    properties: { [DELIVERY_PROPS.status]: { select: { name: status } } },
  });
}

/** 結果を書き戻す（送信済み=true, sent_at, 送信結果, 消費実績, エラー詳細）。 */
export async function writeDeliveryResult(
  request: NotionRequest,
  pageId: string,
  result: DeliveryResult,
): Promise<void> {
  const P = DELIVERY_PROPS;
  const props: Record<string, unknown> = {
    [P.status]: { select: { name: result.status } },
    [P.sent]: { checkbox: true },
    [P.sentAt]: { date: { start: result.sentAtUtc } },
    [P.sendResult]: {
      rich_text: [{ text: { content: result.summary.slice(0, 1900) } }],
    },
    [P.consumed]: { number: result.consumed },
  };
  if (result.errorDetail) {
    props[P.errorDetail] = {
      rich_text: [{ text: { content: result.errorDetail.slice(0, 1900) } }],
    };
  }
  await request(`/pages/${pageId}`, "PATCH", { properties: props });
}

/**
 * 承認時のコンテンツ pinning（T12）: 現在の本文＋画像（R2 URL 群）のハッシュを
 * 「コンテンツハッシュ」列に保存し、Status=Approved にする。
 *
 * これが承認時スナップショット。送信側はこの値と送信直前のハッシュを照合し、
 * 承認後に編集されたら不一致 → 承認自動リセットで送信中止する。
 *
 * 運用: 承認者が Notion で承認するときにこの経路を必ず通す（手動 approve API /
 *   将来の Notion ボタン automation）。ハッシュ計算は呼び出し側（content-hash.ts）で行い、
 *   この関数は書き込みのみを担う（テスト容易性のため）。
 */
export async function pinApproval(
  request: NotionRequest,
  pageId: string,
  contentHash: string,
): Promise<void> {
  const P = DELIVERY_PROPS;
  await request(`/pages/${pageId}`, "PATCH", {
    properties: {
      [P.contentHash]: { rich_text: [{ text: { content: contentHash } }] },
      [P.status]: { select: { name: "Approved" } },
    },
  });
}

/** 単一ページを取得して正規化する（承認 pin で現在値を読むのに使う）。 */
export async function fetchDeliveryPage(
  request: NotionRequest,
  pageId: string,
): Promise<DeliveryPage> {
  const data = (await request(`/pages/${pageId}`, "GET")) as {
    id: string;
    last_edited_time?: string;
    properties: Record<string, RawProp>;
  };
  return normalizeDeliveryPage(data);
}

/**
 * エラー詳細をクリアする（承認 pin 成功時の後始末）。
 * 直前の失敗（HEIC 等）で書かれた赤字が、修正後の承認済み行に残って
 * 運用者を混乱させないように空にする。Status は触らない（pin 側が設定済み）。
 */
export async function clearDeliveryError(
  request: NotionRequest,
  pageId: string,
): Promise<void> {
  await request(`/pages/${pageId}`, "PATCH", {
    properties: {
      [DELIVERY_PROPS.errorDetail]: { rich_text: [] },
    },
  });
}

/**
 * 承認を自動リセットする（コンテンツ pinning 不一致時）。
 * Status を Draft に戻し、エラー詳細に理由を残す（送信はしない）。
 */
export async function resetApproval(
  request: NotionRequest,
  pageId: string,
  reason: string,
): Promise<void> {
  const P = DELIVERY_PROPS;
  await request(`/pages/${pageId}`, "PATCH", {
    properties: {
      [P.status]: { select: { name: "Draft" } },
      [P.errorDetail]: {
        rich_text: [{ text: { content: reason.slice(0, 1900) } }],
      },
    },
  });
}
