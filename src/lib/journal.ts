/**
 * UX④ 読みもの（ジャーナル記事）の出し分け — カルテのペルソナに合う記事を Flex カードで薦める。
 *
 * 狙い（オーナー承認済みデザイン ④）: ユーザーが「読みもの」と送ると、bot が **その人のタイプ
 * （穏やか/探求/感覚 = serenity/explorer/sensory）に合う記事** を、サムネ＋見出し＋抜粋＋「読む」ボタンの
 * カルーセル（最大 3 枚）で返す。**新しい質問はしない**（既に分かっている persona を使う）。合う記事が
 * 無ければ **新しい順** で出す（行き止まりにしない）。**本文は一切出さない**（カードは入口・続きは web）。
 *
 * データ源: Content Hub `16451cee`（`Channel="Roji"`）。web ジャーナルと同じ元ソース（bot は読むだけ・書かない）。
 *   取得は tea-menu の `fetchSellingTeas`（Notion + TTL キャッシュ）を写経。提示は ③ が確立した共有 Flex
 *   送信経路（`LineResponder.flex(altText, contents, quickReplyItems)`）と `articleCard` を再利用する。
 *
 * ダミー（オーナー承認済・テスト環境）: `Published URL` / `Featured Image` は現在空のため、空なら
 *   プレースホルダ URL / サムネで動かす（カードは崩れず成立）。Notion に本物が入れば **自動で本物** に
 *   切り替わる（あとから作り直し不要）。
 *
 * Draft の扱い（オーナー確認済）: 現在 Roji の記事は全て Status=Draft のため、**staging/test では Draft も
 *   含めて表示**（プールが空にならないよう）。**本番（DELIVERY_TARGET_ENV="prod"）では Published/Ready のみ**に
 *   絞る（`shouldIncludeDrafts` で機械ゲート）。
 *
 * v1 スコープ: persona 一次マッチのみ。興味カルテ（interest 軸）拡張は v1.1 フォローアップ（本ファイルは
 *   `interestTags` を受ける口だけ用意し、v1 の呼び出しでは常に空 = persona だけで成立）。
 *
 * ─ 2026-08-11 修正（QA 検出・実スキーマを Notion API で実測して確定）─
 *   Content Hub のプロパティ型が select に揃っていなかったため、select 専用リーダ（`propSelect`）で
 *   読んでいた 3 つが**常に空**になっていた。`propChoice`（select / status / multi_select 兼用）へ差し替え:
 *     - `content_persona` = multi_select → persona が常に null ＝ 出し分けが一度も効かない
 *     - `Status`          = status       → 本番（`includeDrafts=false`）で Published/Ready 判定が常に
 *                                          不成立となり、**記事が 1 本も出ない**
 *     - `target_layer`    = multi_select → 二次マッチ（v1.1）用の値が常に null
 *   select が入っている場合は従来どおり select が勝つため、既存の select 読み（Channel）は不変。
 */

import type { Env } from "../index";
import type { LineResponder, QuickReplyItem } from "./line";
import { createSupabaseClient } from "./supabase";
import { loadCustomerKarte } from "./customer-karte";
import { SITE_URL_JA } from "./brand-copy";
import { articleCarousel, articleCard } from "./flex-templates";
import { parseTargetEnv } from "./delivery-channel";
import type { PersonaType } from "./firestore";

// ---------------------------------------------------------------------------
// 定数（DB / ダミー / トリガー）
// ---------------------------------------------------------------------------

/** Content Hub DB の fallback ID（knowledge.ts と同一・env 未設定でも動く）。 */
const CONTENT_HUB_FALLBACK_DB_ID = "16451cee-ec90-4dc0-92d9-85cca2842412";

/** 記事の対象チャネル（web ジャーナルと同元）。 */
const ARTICLE_CHANNEL = "Roji";

/** 本番で表示を許す公開ステータス（knowledge.ts の extractContentHubText と同一）。 */
const PUBLISHED_STATUSES = new Set(["Published", "Ready"]);

/** 取得キャッシュの TTL（tea-menu と同型・10 分）。 */
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * ダミーのサムネ画像（オーナー承認済・テスト環境）。`Featured Image` が空のときに使う公開 HTTPS 画像。
 * 本物のサムネが Notion に入れば mapArticlePage が自動で本物を採用する（ダミーは出なくなる）。
 */
export const DUMMY_ARTICLE_THUMB =
  "https://placehold.co/1024x576/F5F4EE/333333/png?text=elxea+Journal";

/**
 * ダミーの記事 URL のベース。`Published URL` が空のとき `${SITE_URL_JA}/blogs/journal/${slug||id}` を使う。
 * 本物の公開 URL が Notion に入れば自動で本物を採用する。
 */
export const DUMMY_ARTICLE_URL_BASE = `${SITE_URL_JA}/blogs/journal`;

/** 「読みもの」起動トリガー（完全一致）。 */
export const READING_TRIGGER = "読みもの";
/** 予備の言い回し（完全一致）。 */
export const READING_TRIGGER_ALT = "ジャーナル";

/** 「読みもの」を起動する発話か（完全一致・純粋）。 */
export function isReadingTrigger(userMessage: string): boolean {
  const t = userMessage.trim();
  return t === READING_TRIGGER || t === READING_TRIGGER_ALT;
}

// ---------------------------------------------------------------------------
// データモデル
// ---------------------------------------------------------------------------

/** persona 3 値の型ガード（記事側 content_persona を厳格化）。 */
const PERSONAS: readonly PersonaType[] = ["serenity", "explorer", "sensory"];
function toPersona(raw: string): PersonaType | null {
  const v = raw.trim();
  return (PERSONAS as readonly string[]).includes(v) ? (v as PersonaType) : null;
}

/**
 * 候補名の並びから最初の有効な persona を採る（決定的）。
 *
 * `content_persona` は Notion 上 **multi_select**（実測 2026-08-11）で、原則 1 値運用だが
 * 複数入る余地がある。並び順は Notion が返す順をそのまま使い、**最初に 3 値へ当たったもの**を採る
 * （先頭が未知語でも次を見る＝人の付け間違いで null に落ちない）。乱数・時刻を読まない。
 */
function firstPersona(names: string[]): PersonaType | null {
  for (const n of names) {
    const hit = toPersona(n);
    if (hit) return hit;
  }
  return null;
}

/**
 * bot が記事から取り出すフィールド（**本文は持たない**）。
 * title/excerpt/url/thumbnail は提示、persona/targetLayer/tags/publishedAt はマッチング・並べ替え用。
 */
export interface ArticleItem {
  /** Notion page id（内部キー）。 */
  id: string;
  /** 記事タイトル（"Title"）。← 提示 */
  title: string;
  /** 公開 URL（"Published URL" → 空なら DUMMY）。← 提示（「読む」ボタン） */
  url: string;
  /** 抜粋（"🌐 Roji: Meta Description"）。← 提示（1〜2 行） */
  excerpt: string;
  /** サムネ URL（"Featured Image" → 空なら DUMMY_ARTICLE_THUMB）。← 提示（hero） */
  thumbnailUrl: string;
  /** ペルソナ（"content_persona": serenity/explorer/sensory）。← 一次マッチ */
  persona: PersonaType | null;
  /** ターゲットレイヤー（"target_layer": tea_lover/wellbeing/gourmet）。← 二次マッチ（v1.1） */
  targetLayer: string | null;
  /** タグ（"Tags" relation の target id 群）。← 二次マッチ（v1.1・当面は id のみ） */
  tags: string[];
  /** 公開日（"Published Date"・recency 並べ替え）。 */
  publishedAt: string | null;
  // 本文（body）フィールドは持たない（設計上、bot は body を surface しない）。
}

/** マッチング用カルテ（persona 一次 + interest 二次〔v1.1〕）。 */
export interface JournalKarte {
  persona: PersonaType | null;
  /** 興味タグ（target_layer/Tags との二次マッチ用・v1 では空。v1.1 で interest 軸から供給）。 */
  interestTags?: string[];
}

// ---------------------------------------------------------------------------
// Notion 読み取り（tea-menu の写経・純粋なプロパティリーダ）
// ---------------------------------------------------------------------------

interface NotionRichText {
  plain_text: string;
}
interface NotionFile {
  file?: { url: string };
  external?: { url: string };
}
interface NotionProp {
  type?: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  select?: { name: string } | null;
  /** Notion の "status" 型（Content Hub の `Status` はこちら。select ではない）。 */
  status?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
  url?: string | null;
  relation?: Array<{ id: string }>;
  files?: NotionFile[];
  date?: { start?: string } | null;
}
interface NotionPage {
  id?: string;
  properties: Record<string, NotionProp>;
}

function propTitle(p?: NotionProp): string {
  return (p?.title ?? []).map((t) => t.plain_text).join("").trim();
}
function propRich(p?: NotionProp): string {
  return (p?.rich_text ?? []).map((t) => t.plain_text).join("").trim();
}
function propSelect(p?: NotionProp): string {
  return p?.select?.name ?? "";
}
/** multi_select の値名（Notion が返す順を保つ・空文字は捨てる）。 */
function propMultiSelect(p?: NotionProp): string[] {
  return (p?.multi_select ?? []).map((o) => (o?.name ?? "").trim()).filter((s) => s.length > 0);
}
/**
 * 「1 つの値として読みたい選択系プロパティ」の寛容リーダ（**既存の select 読みを壊さない**）。
 *
 * Content Hub の実スキーマは 1 つの型に揃っていない（2026-08-11 に Notion API で実測）:
 *   - `Channel`         = select
 *   - `Status`          = **status**（select ではない → 旧 `propSelect` は常に "" を返していた）
 *   - `content_persona` = **multi_select**（同上）
 *   - `target_layer`    = **multi_select**（同上）
 * 判定順は select → status → multi_select の先頭。**select が入っていれば従来どおり select が勝つ**ので、
 * 既に select で読めていた箇所（Channel）は挙動が変わらない。プロパティ自体が無ければ ""。
 */
function propChoice(p?: NotionProp): string {
  return propSelect(p) || (p?.status?.name ?? "").trim() || propMultiSelect(p)[0] || "";
}
function propUrl(p?: NotionProp): string {
  return (p?.url ?? "").trim();
}
function propRelation(p?: NotionProp): string[] {
  return (p?.relation ?? []).map((r) => r.id).filter(Boolean);
}
function propDate(p?: NotionProp): string | null {
  return p?.date?.start ?? null;
}
/** file 型プロパティの先頭 URL（file.url / external.url のどちらか）。 */
function propFileUrl(p?: NotionProp): string {
  const f = (p?.files ?? [])[0];
  return (f?.file?.url ?? f?.external?.url ?? "").trim();
}

/**
 * Notion ページ → ArticleItem（純粋・fail-safe）。
 *
 * - `Channel !== "Roji"` は対象外（null）。
 * - Status ゲート: `includeDrafts=false`（本番）は Published/Ready のみ。`true`（staging/test）は
 *   Draft を含む全 Status を受ける（プールが空にならないように・オーナー確認済）。
 * - `Title` 空は対象外（null）。
 * - `Published URL` 空 → ダミー URL（slug or page id）。`Featured Image` 空 → ダミーサムネ。
 *   → 実値が Notion に入れば自動で本物に切り替わる（あとから作り直し不要）。
 */
export function mapArticlePage(
  page: NotionPage,
  opts: { includeDrafts: boolean },
): ArticleItem | null {
  const p = page.properties;

  if (propChoice(p["Channel"]) !== ARTICLE_CHANNEL) return null;

  const status = propChoice(p["Status"]);
  if (!opts.includeDrafts && !PUBLISHED_STATUSES.has(status)) return null;

  const title = propTitle(p["Title"]);
  if (!title) return null;

  const id = page.id ?? "";
  const slug = propRich(p["🌐 Roji: Slug"]);
  const realUrl = propUrl(p["Published URL"]);
  const url = realUrl || `${DUMMY_ARTICLE_URL_BASE}/${slug || id}`;

  const realThumb = propFileUrl(p["Featured Image"]);
  const thumbnailUrl = realThumb || DUMMY_ARTICLE_THUMB;

  return {
    id,
    title,
    url,
    excerpt: propRich(p["🌐 Roji: Meta Description"]),
    thumbnailUrl,
    // content_persona は multi_select（select ではない）。multi_select を先に見て、
    // 万一 select へ戻された場合も拾えるよう select 値を末尾に足す（どちらの型でも読める）。
    persona: firstPersona([...propMultiSelect(p["content_persona"]), propSelect(p["content_persona"])]),
    targetLayer: propChoice(p["target_layer"]) || null,
    tags: propRelation(p["Tags"]),
    publishedAt: propDate(p["Published Date"]),
  };
}

/** 本番で Draft を除外し Published/Ready のみにするか否か（staging/test は Draft も含む）。 */
export function shouldIncludeDrafts(env: Env): boolean {
  return parseTargetEnv(env.DELIVERY_TARGET_ENV) !== "prod";
}

let journalCache: { at: number; items: ArticleItem[] } | null = null;

async function notionQueryArticles(env: Env, includeDrafts: boolean): Promise<ArticleItem[]> {
  const dbId = env.NOTION_CONTENT_HUB_DB_ID || CONTENT_HUB_FALLBACK_DB_ID;
  const items: ArticleItem[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        `Notion Content Hub query failed: ${res.status} ${await res.text().catch(() => "")}`,
      );
    }
    const data = (await res.json()) as {
      results: NotionPage[];
      has_more: boolean;
      next_cursor?: string;
    };
    for (const pg of data.results) {
      const item = mapArticlePage(pg, { includeDrafts });
      if (item) items.push(item);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return items;
}

/**
 * ジャーナル記事一覧を取得（TTL キャッシュ付き・fail-safe で空配列に倒す）。fetchSellingTeas のミラー。
 * Draft ゲートは env（DELIVERY_TARGET_ENV）で決まる（本番=Published/Ready のみ / staging=Draft も含む）。
 */
export async function fetchJournalArticles(env: Env, forceRefresh = false): Promise<ArticleItem[]> {
  const now = Date.now();
  if (!forceRefresh && journalCache && now - journalCache.at < CACHE_TTL_MS) {
    return journalCache.items;
  }
  try {
    const items = await notionQueryArticles(env, shouldIncludeDrafts(env));
    journalCache = { at: now, items };
    return items;
  } catch (err) {
    // 取得失敗はレコメンドを黙って出さない（フローは止めない・tea-menu と同型の fail-safe）。
    console.warn(
      "[journal] fetch failed, returning empty (non-blocking):",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** テスト用: 取得キャッシュを初期化する。 */
export function _resetJournalCache(): void {
  journalCache = null;
}

// ---------------------------------------------------------------------------
// マッチング（純粋・決定的・非負整数）
// ---------------------------------------------------------------------------

/**
 * 記事とカルテの親和度（純粋・決定的・非負整数）。
 *   - 一次: persona 一致 → +3（v1 の主軸・診断済みユーザーは既に persona を保持）。
 *   - 二次（v1.1）: target_layer が interestTags に一致 → +2 / Tags 交差 → +2×件。
 *     v1 は interestTags 空のため常に 0（＝persona だけで成立）。
 * カルテ無し（persona=null かつ interestTags 空）→ 常に 0 → pickArticles で最新順にフォールバック。
 */
export function articleAffinity(article: ArticleItem, karte: JournalKarte | null): number {
  if (!karte) return 0;
  let score = 0;
  if (karte.persona && article.persona === karte.persona) score += 3;

  const interest = new Set((karte.interestTags ?? []).map((t) => t.toLowerCase()));
  if (interest.size > 0) {
    if (article.targetLayer && interest.has(article.targetLayer.toLowerCase())) score += 2;
    for (const tag of article.tags) {
      if (interest.has(tag.toLowerCase())) score += 2;
    }
  }
  return score;
}

/**
 * 上位 N 件を選ぶ（決定的）。親和度降順 → 公開日新しい順 → id 昇順の安定順序。
 * URL 無しは除外（ダミーで常に URL は入るが安全のためガード）。カルテ無し → 全 0 → 最新順フォールバック。
 */
export function pickArticles(
  articles: ArticleItem[],
  karte: JournalKarte | null,
  n = 3,
): ArticleItem[] {
  return [...articles]
    .filter((a) => a.url)
    .sort((a, b) => {
      const d = articleAffinity(b, karte) - articleAffinity(a, karte);
      if (d !== 0) return d;
      const t = (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "");
      if (t !== 0) return t;
      return a.id.localeCompare(b.id);
    })
    .slice(0, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// 提示（③ 共有の Flex）
// ---------------------------------------------------------------------------

/** 読みものの表示結果（記事なし=テキスト / それ以外=カルーセル）。 */
export type JournalView =
  | { kind: "empty"; text: string; quickReplies: QuickReplyItem[] }
  | {
      kind: "cards";
      altText: string;
      contents: Record<string, unknown>;
      quickReplies: QuickReplyItem[];
    };

function qr(label: string, text: string): QuickReplyItem {
  return { type: "action", action: { type: "message", label, text } };
}

/** 抜粋を 1〜2 行想定に整える（本文ではなくメタ説明・空なら控えめな既定文）。 */
function articleExcerpt(a: ArticleItem): string {
  const e = a.excerpt.trim();
  return e || "お茶と暮らしにまつわる読みもの。";
}

/**
 * 選定済み記事 → 読みものの表示（純粋・**本文は出さない**）。
 * 1 件でもカルーセル形（articleCard の家族）で返す。0 件はテキストで graceful（行き止まりにしない）。
 */
export function buildJournalView(articles: ArticleItem[]): JournalView {
  if (articles.length === 0) {
    return {
      kind: "empty",
      text: "いまお届けできる読みものが見つかりませんでした。また覗いてみてください。",
      quickReplies: [qr("お茶を選ぶ", "お茶を選ぶ")],
    };
  }

  const cards = articles.map((a) =>
    articleCard({
      title: a.title,
      description: articleExcerpt(a),
      imageUrl: a.thumbnailUrl,
      articleUrl: a.url,
    }),
  );
  // 1 件でも carousel 形（先頭カードを単体で使うより家族としての一貫性を優先）。
  const contents =
    cards.length === 1
      ? cards[0]
      : articleCarousel(
          articles.map((a) => ({
            title: a.title,
            description: articleExcerpt(a),
            imageUrl: a.thumbnailUrl,
            articleUrl: a.url,
          })),
        );

  return {
    kind: "cards",
    altText: "あなたに合いそうな読みものをお届けします",
    contents,
    quickReplies: [qr("お茶を選ぶ", "お茶を選ぶ")],
  };
}

// ---------------------------------------------------------------------------
// オーケストレーション（インターセプタ本体・read-only）
// ---------------------------------------------------------------------------

/** handleJournalFlow の依存注入（テストは fake を注入し Notion/Firestore 非接触にする）。 */
export interface JournalFlowDeps {
  /** カルテ（persona）のローダ。既定は loadCustomerKarte（Firestore/Supabase 由来）。 */
  loadKarte?: (lineUserId: string, env: Env) => Promise<JournalKarte>;
  /** 記事一覧のローダ。既定は fetchJournalArticles（Content Hub + TTL キャッシュ）。 */
  loadArticles?: (env: Env) => Promise<ArticleItem[]>;
}

/**
 * 「読みもの」完全一致インターセプタ（read-only）。
 *
 * ペルソナ一致で上位 3 件（合わなければ最新順）を ③ 共有の Flex カルーセルで返す。実送信は
 * 既存 responder（staging では送信 OFF フラグ準拠）に委ねる。**本文は出さない**。
 *
 * @returns 処理したら true（＝ここで応答完結）。対象トリガーでなければ false（＝AI 会話へ素通り）。
 */
export async function handleJournalFlow(
  lineUserId: string,
  userMessage: string,
  env: Env,
  responder: LineResponder,
  deps?: JournalFlowDeps,
): Promise<boolean> {
  if (!isReadingTrigger(userMessage)) return false;

  const loadKarte =
    deps?.loadKarte ??
    (async (id: string, e: Env): Promise<JournalKarte> => {
      const k = await loadCustomerKarte(id, e, createSupabaseClient(e));
      return { persona: k.persona };
    });
  const loadArticles = deps?.loadArticles ?? ((e: Env) => fetchJournalArticles(e));

  let karte: JournalKarte;
  try {
    karte = await loadKarte(lineUserId, env);
  } catch {
    karte = { persona: null }; // カルテ読取失敗 → persona なし → 最新順フォールバック。
  }

  let articles: ArticleItem[];
  try {
    articles = await loadArticles(env);
  } catch {
    articles = [];
  }

  const picked = pickArticles(articles, karte, 3);
  const view = buildJournalView(picked);
  if (view.kind === "empty") {
    await responder.text(view.text, view.quickReplies);
  } else {
    await responder.flex(view.altText, view.contents, view.quickReplies);
  }
  return true;
}
