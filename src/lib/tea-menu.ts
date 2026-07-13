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
 * フロー（タップ圧縮版・オーナー確定 2026-07-13「3 タップ以内」）:
 *   entry（トリガー発話 / リッチメニュー①） → 販売中のお茶を一覧で直返し
 *     （種類選択層は廃止。quick reply・13 以内、13 超はページング「次へ／前へ」）
 *       → お茶カード → 🌡温度・抽出時間 / 👃味・香り /（🍵楽しみ方: データがある時のみ）
 *   entry②（予備）: 5 桁番号を含むメッセージ → 該当お茶に直行
 *
 *   タップ数（メニュータップ含む happy path）:
 *     ①メニュー → お茶一覧 [1] → お茶タップ → カード [2] → 項目タップ → 回答 [3] = 最大 3 タップ。
 *     ページング（次へ／前へ）と 5 桁直指定は補助経路（happy path の 3 タップ保証外）。
 *
 * 送信は LineResponder 経由（reply 優先・無料化。ターン内 2 通目以降は push フォールバック）。
 */

import type { Env } from "../index";
import { type QuickReplyItem, type LineResponder } from "./line";
import { createSupabaseClient } from "./supabase";
import { logFlowEvent, type FlowEventInput } from "./flow-events";

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
  /**
   * つくり手（農家）の物語（Notion「農家の物語」text）。P0-9。
   * 対応済みメニュー（実話の物語がある農家分）のみ非空。空ならボタンを出さない
   *   （楽しみ方と同じ「データがある時のみ表示」方式）。
   * データ源の設計: Tea Menu → Supplier Name リレーション（充足済）→ 農家の物語。
   *   staging では 3 ホップ解決を避け、スタッフが Notion Tea Menu の本フィールドへ物語要約を直接記入する
   *   （P0-8 楽しみ方と同一運用・最短経路の option b「本文を要約テキストで直接返す」）。
   */
  story: string;
}

/** 種類の並び順（一覧を種類ごとにまとめる際のソートキー。DB にあるものだけ有効）。 */
const CATEGORY_ORDER = ["緑茶", "青茶", "紅茶"] as const;

/** 一覧 1 ページあたりのお茶数。quick reply 上限 13 からナビ 2 枠（前へ／次へ）を引いて 11。 */
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
 * リッチメニュー①（setup-rich-menu.ts の message text "お茶の淹れ方を知りたい"）を含む。
 * 完全一致に限定し、自由入力の淹れ方質問（別文言）は従来どおり AI 対話へ流す。
 */
const ENTRY_PHRASES = new Set<string>([
  "お茶の淹れ方を知りたい", // リッチメニュー①（5 枠版・2026-07-13 確定）
  "お茶のおいしい淹れ方を教えてください", // 旧リッチメニュー①（後方互換）
  "淹れ方を教えてください",
  "お茶を調べる",
  "お茶メニュー",
  "お茶を選ぶ",
]);

/** 旧「種類選択へ戻る」トークン（後方互換: 旧メニュー由来の発話を一覧へ吸収）。 */
const LEGACY_TOP_TOKEN = "お茶の種類";

// ---------------------------------------------------------------------------
// アクション解析（純粋・状態レス）
// ---------------------------------------------------------------------------

type Action =
  | { kind: "entry"; page: number } // 販売中のお茶を一覧表示（種類選択層は廃止）
  | { kind: "card"; number: string }
  | { kind: "brew"; number: string }
  | { kind: "flavor"; number: string }
  | { kind: "enjoy"; number: string }
  | { kind: "story"; number: string } // P0-9: つくり手（農家）の物語
  | { kind: "number-exact"; number: string } // 5 桁のみのメッセージ
  | { kind: "number-loose"; number: string }; // 5 桁を含む文中

/** トークン prefix（quick reply の message テキストに埋め込む・可読 + 解析可能）。 */
const TOK = {
  list: "お茶を選ぶ" + SEP, // 一覧ページ送り。例: お茶を選ぶ｜2（1 始まりのページ番号）
  card: "このお茶" + SEP, // 例: このお茶｜11301
  brew: "淹れ方" + SEP, // 例: 淹れ方｜11301
  flavor: "味と香り" + SEP, // 例: 味と香り｜11301
  enjoy: "楽しみ方" + SEP, // 例: 楽しみ方｜11301
  story: "つくり手の物語" + SEP, // P0-9・例: つくり手の物語｜11301
} as const;

/** 「別のお茶を見る／一覧に戻る」= 一覧 1 ページ目に戻る message テキスト。 */
const BACK_TO_LIST = `${TOK.list}1`;

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

  // 入口発話 / 旧「種類」トークン → 一覧 1 ページ目（種類選択層は廃止・一覧へ吸収）
  if (t === LEGACY_TOP_TOKEN || ENTRY_PHRASES.has(t)) return { kind: "entry", page: 0 };

  // トークン系（タップ由来）
  if (t.startsWith(TOK.list)) {
    const parts = t.split(SEP);
    // 新形式: お茶を選ぶ｜{page}。旧形式: お茶を選ぶ｜{category}｜{page}（後方互換で末尾をページ扱い）。
    const pageStr = parts.length >= 3 ? (parts[2] ?? "1") : (parts[1] ?? "1");
    const page = Math.max(0, (parseInt(pageStr, 10) || 1) - 1);
    return { kind: "entry", page };
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
  if (t.startsWith(TOK.story)) {
    const n = firstFiveDigits(t);
    if (n) return { kind: "story", number: n };
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

/** 一覧の並び順: 種類（CATEGORY_ORDER）→ 番号。種類ごとにまとまり、読みやすい。 */
function sortForEntry(teas: TeaItem[]): TeaItem[] {
  const rank = (c: string) => {
    const i = CATEGORY_ORDER.indexOf(c as (typeof CATEGORY_ORDER)[number]);
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  return [...teas].sort(
    (a, b) => rank(a.category) - rank(b.category) || a.number.localeCompare(b.number),
  );
}

/**
 * お茶一覧メッセージ（種類選択層なし・販売中のお茶を直接一覧）。
 * Status=販売中 の全お茶を「今お選びいただけるお茶（＝今季のお茶）」として直返しする。
 * 13 超はページング（次へ／前へ）。1 ページ 11 件 + ナビ最大 2 枠で上限 13 に収める。
 */
export function buildEntryMessage(teas: TeaItem[], page = 0): OutMessage {
  const sorted = sortForEntry(teas);
  if (sorted.length === 0) {
    return {
      text: "申し訳ありません、ただいまご案内できるお茶がありません。少し時間をおいてお試しください。",
      quickReplies: [],
    };
  }
  const totalPages = Math.ceil(sorted.length / TEA_LIST_PAGE_SIZE);
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const start = safePage * TEA_LIST_PAGE_SIZE;
  const slice = sorted.slice(start, start + TEA_LIST_PAGE_SIZE);

  const quickReplies: QuickReplyItem[] = [];
  // 前へ（2 ページ目以降）: 現在 1 始まりページ = safePage+1、その前 = safePage
  if (safePage > 0) quickReplies.push(qr("前へ", `${TOK.list}${safePage}`));
  for (const t of slice) quickReplies.push(qr(t.name, `${TOK.card}${t.number}`));
  // 次へ: 次の 1 始まりページ = safePage+2
  if (sorted.length > start + TEA_LIST_PAGE_SIZE) {
    quickReplies.push(qr("次へ", `${TOK.list}${safePage + 2}`));
  }

  const pageNote = totalPages > 1 ? `（${safePage + 1}/${totalPages}ページ）` : "";
  const text =
    `今お選びいただけるお茶です（全${sorted.length}種）${pageNote}。\n` +
    "気になるお茶を選んでください。\n" +
    "（お手元の 5 桁番号を送っていただくと、そのお茶に直接ご案内します）";
  return { text, quickReplies };
}

/** カード用の quick reply（項目タップ）。exclude で自分自身の項目を除ける。 */
function cardItemQuickReplies(
  tea: TeaItem,
  exclude?: "brew" | "flavor" | "enjoy" | "story",
): QuickReplyItem[] {
  const items: QuickReplyItem[] = [];
  if (exclude !== "brew") items.push(qr("🌡 温度・抽出時間", `${TOK.brew}${tea.number}`));
  if (exclude !== "flavor") items.push(qr("👃 味・香り", `${TOK.flavor}${tea.number}`));
  // 楽しみ方はデータがある時のみ表示（無ければ選択肢に出さない）
  if (exclude !== "enjoy" && tea.enjoy.trim()) {
    items.push(qr("🍵 楽しみ方", `${TOK.enjoy}${tea.number}`));
  }
  // P0-9 つくり手の物語: データ（農家の物語）がある時のみ表示（楽しみ方と同方式）。
  if (exclude !== "story" && tea.story.trim()) {
    items.push(qr("🌱 つくり手の物語", `${TOK.story}${tea.number}`));
  }
  items.push(qr("🍃 別のお茶を見る", BACK_TO_LIST));
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

/**
 * 🌱つくり手の物語の回答（P0-9）。データ（農家の物語）がある時はその要約を返し、
 * 無い場合は「物語は準備中です」フォールバック（設計 §A-3 候補4）。
 * 通常は物語がある時のみボタンが出るため到達するが、stale トークン対策で fallback を保持する。
 */
export function buildStoryAnswer(tea: TeaItem): OutMessage {
  const body = tea.story.trim()
    ? `このお茶をつくる農家さんの物語です。\n\n${tea.story.trim()}`
    : "つくり手の物語は、ただいま準備中です。もう少しお待ちくださいね。";
  const text = `【${tea.name}（No.${tea.number}）】\n${body}\n\n他に知りたいことがあれば、下からどうぞ。`;
  return { text, quickReplies: cardItemQuickReplies(tea, "story") };
}

/** 番号が見つからないときの正直な案内（創作しない）。 */
export function buildNumberNotFound(teas: TeaItem[], number: string): OutMessage {
  return {
    text:
      `恐れ入ります、番号「${number}」のお茶が見つかりませんでした。\n` +
      `下の一覧からお探しください。`,
    quickReplies: buildEntryMessage(teas).quickReplies,
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
    case "entry":
      return { messages: [buildEntryMessage(teas, action.page)] };

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
    case "story": {
      const tea = find(action.number);
      return { messages: [tea ? buildStoryAnswer(tea) : buildNumberNotFound(teas, action.number)] };
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
// flow_events 導出（P0-1）: tea.* タップ記録（純粋・テスト可能）
// ---------------------------------------------------------------------------

/**
 * タップメニューの発話から記録すべき flow_events を導出する（純粋・設計 §B-5a の tea.* 系）。
 *   entry           → tea.list_view（step=page{n}）
 *   card            → tea.card_view（value=list・product_no）
 *   number-exact    → 実在: tea.card_view（value=number）/ 不在: tea.number_miss（value=入力番号）
 *   number-loose    → 実在時のみ tea.card_view（value=number）。不在は素通りのため記録しない
 *   brew/flavor/enjoy/story → tea.item_view（value=当該項目・product_no）
 *
 * これで棚卸しの H2（番号直指定 vs 一覧）・H3（ページ到達率）・H4 系が検証可能になる。
 */
export function teaFlowEvents(
  userMessage: string,
  teas: TeaItem[],
  userRef: string,
): FlowEventInput[] {
  const action = parseTeaAction(userMessage);
  if (!action) return [];
  const found = (n: string) => teas.some((t) => t.number === n);
  switch (action.kind) {
    case "entry":
      return [{ eventName: "tea.list_view", userRef, step: `page${action.page + 1}` }];
    case "card":
      return [{ eventName: "tea.card_view", userRef, value: "list", productNo: action.number }];
    case "brew":
    case "flavor":
    case "enjoy":
    case "story":
      return [{ eventName: "tea.item_view", userRef, value: action.kind, productNo: action.number }];
    case "number-exact":
      return found(action.number)
        ? [{ eventName: "tea.card_view", userRef, value: "number", productNo: action.number }]
        : [{ eventName: "tea.number_miss", userRef, value: action.number }];
    case "number-loose":
      return found(action.number)
        ? [{ eventName: "tea.card_view", userRef, value: "number", productNo: action.number }]
        : [];
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
    story: propRich(pr["農家の物語"]),
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
  responder: LineResponder,
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
      await responder
        .text(
          "申し訳ありません、ただいまメニュー情報を取得できませんでした。少し時間をおいてお試しください。",
        )
        .catch((e) => console.error("[tea-menu] apology send failed:", e));
      return true;
    }
    return false; // 文中 5 桁の曖昧ケースは自由対話へ素通り
  }

  const plan = planTeaFlow(userMessage, teas);
  if (!plan) return false; // number-loose 不一致など → 素通り

  // 複数通の場合、最初の 1 通が reply（無料）、以降は push（有料）にフォールバックする。
  for (const m of plan.messages) {
    await responder.text(m.text, m.quickReplies);
  }

  // タップ記録（P0-1・fire-and-forget・失敗は握りつぶし）。応答後に投げっぱなし。
  const supabase = createSupabaseClient(env);
  for (const ev of teaFlowEvents(userMessage, teas, lineUserId)) {
    void logFlowEvent(supabase, ev);
  }
  return true;
}
