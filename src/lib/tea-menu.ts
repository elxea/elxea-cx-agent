/**
 * 購入者向け・選択式お茶メニュー案内（タップ主体・状態レス）。
 *
 * 設計方針（オーナー確定 2026-07）:
 *   - 番号手打ちは予備。基本は全部タップ（quick reply）で辿り着く。
 *   - AI 生成を挟まず、Notion Tea Menu DB の中身を整形して直返し（創作ゼロ・費用ゼロ）。
 *   - 会話状態は持たない。直近のお茶は quick reply の message テキストに 5 桁番号を
 *     埋め込むことで引き回す（state レス）。
 *
 * データ源（deterministic・LLM 不使用）:
 *   Notion Tea Menu List DB を Status=販売中 でフィルタして直接読む。
 *   isolate 内メモリに TTL キャッシュし、タップ毎の再取得を避ける。
 *
 * フロー:
 *   entry（トリガー発話 / リッチメニュー①） → 種類（Category）選択
 *     → お茶一覧（quick reply・13 超はページング「次へ」）→ お茶カード
 *       → 🌡温度・抽出時間 / 👃味・香り /（🍵楽しみ方: データがある時のみ）
 *   entry②（予備）: 5 桁番号を含むメッセージ → 該当お茶に直行
 *
 * ⚠ 実配信はしない前提の PoC。push は既存 pushTextMessage 経由。
 */

import type { Env } from "../index";
import { pushTextMessage, type QuickReplyItem } from "./line";

// ---------------------------------------------------------------------------
// データモデル
// ---------------------------------------------------------------------------

export interface TeaItem {
  /** 一意な 5 桁番号（Notion「Menu Name」= title）。例: "11301" */
  number: string;
  /** 表示名（Notion「Menu Name - full」）。無ければ number にフォールバック */
  name: string;
  /** 種類（Notion「Category」select）。例: 緑茶 / 青茶 / 紅茶 */
  category: string;
  /** 味・香りのプロファイル（Notion「Flavor Profile」multi_select） */
  flavorProfiles: string[];
  /** 短い説明（Notion「Menu Description(Short ver.)」）。味・香りの補足に使う */
  descShort: string;
  /** 淹れ方の自由記述（Notion「How to Brew」）。温度・湯量・抽出時間を含む */
  howToBrew: string;
  /** 構造化された抽出条件（現状 DB では空。入っていれば優先表示） */
  temp: string;
  time: string;
  water: string;
  /** 楽しみ方（Notion「楽しみ方」）。現状 0 件。入り次第、自動で選択肢に出す */
  enjoy: string;
}

/** 種類の表示順（DB に存在するものだけ、この順で出す）。 */
const CATEGORY_ORDER = ["緑茶", "青茶", "紅茶"] as const;

/** 一覧 1 ページあたりのお茶数。quick reply 上限 13 からナビ 2 枠を引いて 11。 */
export const TEA_LIST_PAGE_SIZE = 11;

/** LINE quick reply ラベル上限（20 文字）。 */
const QR_LABEL_MAX = 20;

/** message テキストのトークン区切り（ユーザー入力にまず現れない全角縦棒）。 */
const SEP = "｜";

// ---------------------------------------------------------------------------
// トリガー発話（entry）
// ---------------------------------------------------------------------------

/**
 * タップメニューを起動する「入口」発話（完全一致）。
 * リッチメニュー①（setup-richmenu.ts の "お茶のおいしい淹れ方を教えてください"）を含む。
 * 完全一致に限定し、自由入力の淹れ方質問（別文言）は従来どおり AI 対話へ流す。
 */
const ENTRY_PHRASES = new Set<string>([
  "お茶のおいしい淹れ方を教えてください",
  "淹れ方を教えてください",
  "お茶を調べる",
  "お茶メニュー",
  "お茶を選ぶ",
]);

// ---------------------------------------------------------------------------
// アクション解析（純粋・状態レス）
// ---------------------------------------------------------------------------

type Action =
  | { kind: "top" } // 種類選択へ
  | { kind: "list"; category: string; page: number }
  | { kind: "card"; number: string }
  | { kind: "brew"; number: string }
  | { kind: "flavor"; number: string }
  | { kind: "enjoy"; number: string }
  | { kind: "number-exact"; number: string } // 5 桁のみのメッセージ
  | { kind: "number-loose"; number: string }; // 5 桁を含む文中

/** トークン prefix（quick reply の message テキストに埋め込む・可読 + 解析可能）。 */
const TOK = {
  list: "お茶を選ぶ" + SEP, // 例: お茶を選ぶ｜緑茶｜1
  card: "このお茶" + SEP, // 例: このお茶｜11301
  brew: "淹れ方" + SEP, // 例: 淹れ方｜11301
  flavor: "味と香り" + SEP, // 例: 味と香り｜11301
  enjoy: "楽しみ方" + SEP, // 例: 楽しみ方｜11301
  top: "お茶の種類", // 種類選び直し
} as const;

function firstFiveDigits(s: string): string | null {
  const m = s.match(/\d{5}/);
  return m ? m[0] : null;
}

/**
 * ユーザー発話をタップメニューのアクションに解釈する。
 * タップメニューと無関係なら null（＝インターセプトせず AI 対話へ素通り）。
 */
export function parseTeaAction(raw: string): Action | null {
  const t = raw.trim();
  if (!t) return null;

  // 種類選び直し / 入口発話 → 種類選択
  if (t === TOK.top || ENTRY_PHRASES.has(t)) return { kind: "top" };

  // トークン系（タップ由来）
  if (t.startsWith(TOK.list)) {
    const parts = t.split(SEP);
    const category = parts[1] ?? "";
    const page = Math.max(0, (parseInt(parts[2] ?? "1", 10) || 1) - 1);
    if (category) return { kind: "list", category, page };
  }
  if (t.startsWith(TOK.card)) {
    const n = firstFiveDigits(t);
    if (n) return { kind: "card", number: n };
  }
  if (t.startsWith(TOK.brew)) {
    const n = firstFiveDigits(t);
    if (n) return { kind: "brew", number: n };
  }
  if (t.startsWith(TOK.flavor)) {
    const n = firstFiveDigits(t);
    if (n) return { kind: "flavor", number: n };
  }
  if (t.startsWith(TOK.enjoy)) {
    const n = firstFiveDigits(t);
    if (n) return { kind: "enjoy", number: n };
  }

  // 番号直指定（予備）
  if (/^\d{5}$/.test(t)) return { kind: "number-exact", number: t };
  const loose = firstFiveDigits(t);
  if (loose) return { kind: "number-loose", number: loose };

  return null;
}

// ---------------------------------------------------------------------------
// 純粋ビルダー（メッセージ + quick reply）
// ---------------------------------------------------------------------------

/** 送信 1 通分（テキスト + quick reply）。 */
export interface OutMessage {
  text: string;
  quickReplies: QuickReplyItem[];
}

function truncateLabel(s: string): string {
  return s.length > QR_LABEL_MAX ? s.slice(0, QR_LABEL_MAX - 1) + "…" : s;
}

function qr(label: string, text: string): QuickReplyItem {
  return { type: "action", action: { type: "message", label: truncateLabel(label), text } };
}

/** DB に存在する種類を表示順で返す（件数付き）。 */
function orderedCategories(teas: TeaItem[]): Array<{ category: string; count: number }> {
  const counts = new Map<string, number>();
  for (const t of teas) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  const known = CATEGORY_ORDER.filter((c) => counts.has(c)).map((c) => ({
    category: c,
    count: counts.get(c)!,
  }));
  // 表示順に無い種類（将来追加）も末尾に拾う
  const extras = [...counts.keys()]
    .filter((c) => !CATEGORY_ORDER.includes(c as (typeof CATEGORY_ORDER)[number]))
    .sort()
    .map((c) => ({ category: c, count: counts.get(c)! }));
  return [...known, ...extras];
}

function sortedByNumber(teas: TeaItem[]): TeaItem[] {
  return [...teas].sort((a, b) => a.number.localeCompare(b.number));
}

/** 種類選択メッセージ。 */
export function buildCategoryMessage(teas: TeaItem[]): OutMessage {
  const cats = orderedCategories(teas);
  const quickReplies = cats.map((c) => qr(`${c.category}（${c.count}）`, `${TOK.list}${c.category}${SEP}1`));
  const text =
    "どんなお茶をお探しですか？\n種類を選んでください。\n" +
    "（お手元の 5 桁番号を送っていただくと、そのお茶に直接ご案内します）";
  return { text, quickReplies };
}

/** お茶一覧メッセージ（種類 + ページ）。 */
export function buildTeaListMessage(teas: TeaItem[], category: string, page: number): OutMessage {
  const inCat = sortedByNumber(teas.filter((t) => t.category === category));
  if (inCat.length === 0) {
    return {
      text: `「${category}」のお茶が見つかりませんでした。別の種類をお選びください。`,
      quickReplies: buildCategoryMessage(teas).quickReplies,
    };
  }
  const start = page * TEA_LIST_PAGE_SIZE;
  const slice = inCat.slice(start, start + TEA_LIST_PAGE_SIZE);
  const quickReplies = slice.map((t) => qr(t.name, `${TOK.card}${t.number}`));

  const hasNext = inCat.length > start + TEA_LIST_PAGE_SIZE;
  if (hasNext) {
    quickReplies.push(qr("次へ", `${TOK.list}${category}${SEP}${page + 2}`));
  }
  quickReplies.push(qr("種類に戻る", TOK.top));

  const totalPages = Math.ceil(inCat.length / TEA_LIST_PAGE_SIZE);
  const pageNote = totalPages > 1 ? `（${page + 1}/${totalPages}ページ）` : "";
  const text = `「${category}」のお茶です（全${inCat.length}種）${pageNote}\n気になるお茶を選んでください。`;
  return { text, quickReplies };
}

/** カード用の quick reply（項目タップ）。exclude で自分自身の項目を除ける。 */
function cardItemQuickReplies(tea: TeaItem, exclude?: "brew" | "flavor" | "enjoy"): QuickReplyItem[] {
  const items: QuickReplyItem[] = [];
  if (exclude !== "brew") items.push(qr("🌡 温度・抽出時間", `${TOK.brew}${tea.number}`));
  if (exclude !== "flavor") items.push(qr("👃 味・香り", `${TOK.flavor}${tea.number}`));
  // 楽しみ方はデータがある時のみ表示（無ければ選択肢に出さない）
  if (exclude !== "enjoy" && tea.enjoy.trim()) {
    items.push(qr("🍵 楽しみ方", `${TOK.enjoy}${tea.number}`));
  }
  items.push(qr("🍃 別のお茶を見る", TOK.top));
  return items;
}

/** お茶カード。 */
export function buildTeaCard(tea: TeaItem): OutMessage {
  const desc = tea.descShort.trim() ? `\n${tea.descShort.trim()}` : "";
  const text = `${tea.name}（No.${tea.number}）${desc}\n\n知りたいことをどうぞ。`;
  return { text, quickReplies: cardItemQuickReplies(tea) };
}

function brewText(tea: TeaItem): string {
  const structured =
    tea.temp || tea.time || tea.water
      ? [tea.temp ? `${tea.temp}℃` : "", tea.water ? `${tea.water}ml` : "", tea.time ? `${tea.time}秒` : ""]
          .filter(Boolean)
          .join(" ")
      : "";
  // 自由記述（How to Brew）を第一情報源にする（構造化列は現状空のため）
  if (tea.howToBrew.trim()) return tea.howToBrew.trim();
  return structured;
}

/** 🌡温度・抽出時間の回答。 */
export function buildBrewAnswer(tea: TeaItem): OutMessage {
  const brew = brewText(tea);
  const body = brew
    ? `おすすめの淹れ方はこちらです。\n\n${brew}`
    : "申し訳ありません、このお茶の淹れ方はまだ登録されていません。";
  const text = `【${tea.name}（No.${tea.number}）】\n${body}\n\n他に知りたいことがあれば、下からどうぞ。`;
  return { text, quickReplies: cardItemQuickReplies(tea, "brew") };
}

/** 👃味・香りの回答。 */
export function buildFlavorAnswer(tea: TeaItem): OutMessage {
  const lines: string[] = [];
  if (tea.flavorProfiles.length > 0) lines.push(tea.flavorProfiles.join(" / "));
  if (tea.descShort.trim()) lines.push(tea.descShort.trim());
  const body =
    lines.length > 0
      ? `味わい・香りの特徴です。\n\n${lines.join("\n")}`
      : "申し訳ありません、このお茶の味・香りの情報はまだ登録されていません。";
  const text = `【${tea.name}（No.${tea.number}）】\n${body}\n\n他に知りたいことがあれば、下からどうぞ。`;
  return { text, quickReplies: cardItemQuickReplies(tea, "flavor") };
}

/** 🍵楽しみ方の回答（データがある時のみ到達）。 */
export function buildEnjoyAnswer(tea: TeaItem): OutMessage {
  const body = tea.enjoy.trim()
    ? `楽しみ方のご提案です。\n\n${tea.enjoy.trim()}`
    : "申し訳ありません、このお茶の楽しみ方はまだ登録されていません。";
  const text = `【${tea.name}（No.${tea.number}）】\n${body}\n\n他に知りたいことがあれば、下からどうぞ。`;
  return { text, quickReplies: cardItemQuickReplies(tea, "enjoy") };
}

/** 番号が見つからないときの正直な案内（創作しない）。 */
export function buildNumberNotFound(teas: TeaItem[], number: string): OutMessage {
  return {
    text:
      `恐れ入ります、番号「${number}」のお茶が見つかりませんでした。\n` +
      `下から種類を選んでお探しください。`,
    quickReplies: buildCategoryMessage(teas).quickReplies,
  };
}

// ---------------------------------------------------------------------------
// プラン（純粋・状態レス）: アクション + 全お茶 → 送信メッセージ列 or null
// ---------------------------------------------------------------------------

export function planTeaFlow(userMessage: string, teas: TeaItem[]): { messages: OutMessage[] } | null {
  const action = parseTeaAction(userMessage);
  if (!action) return null;

  const find = (n: string) => teas.find((t) => t.number === n) ?? null;

  switch (action.kind) {
    case "top":
      return { messages: [buildCategoryMessage(teas)] };

    case "list":
      return { messages: [buildTeaListMessage(teas, action.category, action.page)] };

    case "card": {
      const tea = find(action.number);
      return { messages: [tea ? buildTeaCard(tea) : buildNumberNotFound(teas, action.number)] };
    }
    case "brew": {
      const tea = find(action.number);
      return { messages: [tea ? buildBrewAnswer(tea) : buildNumberNotFound(teas, action.number)] };
    }
    case "flavor": {
      const tea = find(action.number);
      return { messages: [tea ? buildFlavorAnswer(tea) : buildNumberNotFound(teas, action.number)] };
    }
    case "enjoy": {
      const tea = find(action.number);
      return { messages: [tea ? buildEnjoyAnswer(tea) : buildNumberNotFound(teas, action.number)] };
    }

    case "number-exact": {
      const tea = find(action.number);
      // 5 桁のみのメッセージ → 見つからなければ正直な案内（インターセプトする）
      return { messages: [tea ? buildTeaCard(tea) : buildNumberNotFound(teas, action.number)] };
    }
    case "number-loose": {
      const tea = find(action.number);
      // 文中の 5 桁 → 既知のお茶番号に一致した時だけ案内。
      // 一致しなければ null を返し、AI 自由対話へ素通りさせる（自由対話を壊さない）。
      return tea ? { messages: [buildTeaCard(tea)] } : null;
    }
  }
}

// ---------------------------------------------------------------------------
// Notion データ取得（deterministic・LLM 不使用・TTL キャッシュ）
// ---------------------------------------------------------------------------

/** Tea Menu List DB の fallback ID（sync/knowledge.ts と一致）。 */
const TEA_MENU_FALLBACK_DB_ID = "ee367f6c-3ff3-4251-ad9e-0bc5a2cc7358";

/** 販売中の判定に使う Status 値。 */
const STATUS_ON_SALE = "販売中";

/** キャッシュ TTL（10 分）。 */
const CACHE_TTL_MS = 10 * 60 * 1000;

let teaCache: { at: number; items: TeaItem[] } | null = null;

interface NotionRichText {
  plain_text: string;
}
interface NotionProp {
  type: string;
  title?: NotionRichText[];
  rich_text?: NotionRichText[];
  select?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
}
interface NotionPage {
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
function propMulti(p?: NotionProp): string[] {
  return (p?.multi_select ?? []).map((s) => s.name);
}

function mapPage(page: NotionPage): TeaItem | null {
  const pr = page.properties;
  const number = propTitle(pr["Menu Name"]);
  if (!/^\d{5}$/.test(number)) return null; // 5 桁番号を持たない行は対象外
  const full = propRich(pr["Menu Name - full"]);
  return {
    number,
    name: full || number,
    category: propSelect(pr["Category"]),
    flavorProfiles: propMulti(pr["Flavor Profile "]),
    descShort: propRich(pr["Menu Description(Short ver.) "]),
    howToBrew: propRich(pr["How to Brew"]),
    temp: propRich(pr["How-to_Temp(℃)"]),
    time: propRich(pr["How-to_Time(Sec)"]),
    water: propRich(pr["How-to_Water(ml)"]),
    enjoy: propRich(pr["楽しみ方"]),
  };
}

async function notionQuerySellingTeas(env: Env): Promise<TeaItem[]> {
  const dbId = env.NOTION_TEA_MENU_DB_ID || TEA_MENU_FALLBACK_DB_ID;
  const items: TeaItem[] = [];
  let cursor: string | undefined;

  do {
    const body: Record<string, unknown> = {
      page_size: 100,
      filter: { property: "Status", select: { equals: STATUS_ON_SALE } },
    };
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
      throw new Error(`Notion Tea Menu query failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const data = (await res.json()) as {
      results: NotionPage[];
      has_more: boolean;
      next_cursor?: string;
    };
    for (const pg of data.results) {
      const item = mapPage(pg);
      if (item) items.push(item);
    }
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return items;
}

/** 販売中のお茶一覧を取得（TTL キャッシュ付き）。 */
export async function fetchSellingTeas(env: Env, forceRefresh = false): Promise<TeaItem[]> {
  const now = Date.now();
  if (!forceRefresh && teaCache && now - teaCache.at < CACHE_TTL_MS) {
    return teaCache.items;
  }
  const items = await notionQuerySellingTeas(env);
  teaCache = { at: now, items };
  return items;
}

/** テスト用: キャッシュを初期化する。 */
export function _resetTeaCache(): void {
  teaCache = null;
}

// ---------------------------------------------------------------------------
// オーケストレーション（インターセプタ本体）
// ---------------------------------------------------------------------------

/**
 * 選択式お茶メニュー案内のインターセプタ。
 *
 * @returns 処理したら true（＝ここで応答完結）。タップメニューと無関係なら false
 *          （＝呼び出し側は既存の AI 自由対話フローへ素通りさせる）。
 *
 * 挙動:
 *   - まず純粋解析（parseTeaAction）で「タップメニューの発話か」を判定し、
 *     無関係なら Notion を叩かず即 false（自由対話を一切妨げない）。
 *   - タップメニューの発話なら Notion（販売中のお茶）を取得して deterministic に整形返答。
 *   - 文中の 5 桁が既知番号でない場合は false（自由対話へ素通り）。
 */
export async function handleTeaMenuFlow(
  lineUserId: string,
  userMessage: string,
  env: Env,
): Promise<boolean> {
  const action = parseTeaAction(userMessage);
  if (!action) return false;

  // 内部トークン / 入口発話 / 5 桁のみ は「メニュー意図が明確」なので、
  // 取得失敗時も AI へ流さず正直に詫びる（トークンを AI に食わせない）。
  const isExplicit =
    action.kind !== "number-loose";

  let teas: TeaItem[];
  try {
    teas = await fetchSellingTeas(env);
  } catch (err) {
    console.warn("[tea-menu] fetch failed:", err instanceof Error ? err.message : err);
    if (isExplicit) {
      await pushTextMessage(
        lineUserId,
        "申し訳ありません、ただいまメニュー情報を取得できませんでした。少し時間をおいてお試しください。",
        env,
      ).catch((e) => console.error("[tea-menu] apology push failed:", e));
      return true;
    }
    return false; // 文中 5 桁の曖昧ケースは自由対話へ素通り
  }

  const plan = planTeaFlow(userMessage, teas);
  if (!plan) return false; // number-loose 不一致など → 素通り

  for (const m of plan.messages) {
    await pushTextMessage(lineUserId, m.text, env, m.quickReplies);
  }
  return true;
}
