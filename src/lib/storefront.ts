/**
 * 購入先 (storefront) の 1 か所化 — 公式 EC の開店状態・購入先 URL・閉じたサイトへのリンク判定。
 *
 * 背景 (正本):
 *   - Setaka 決定 2026-09-26: 公式 EC (elxea.com) の開店までは、商品をおすすめする文言の行き先を
 *     Amazon の elxea ストアにする。行き先は 1 か所で戻せる形にする。
 *     https://app.notion.com/p/3e770c9d064c81a4906ef7f7326e6950
 *   - 実装設計 rev2 第2章: https://app.notion.com/p/3e770c9d064c81cd8100df0e5775513d
 *   - 文言 v2 (elxea-ccs・copy-as-data): https://app.notion.com/p/3e770c9d064c818eb5eee425b35dba90
 *
 * 使い方:
 *   - 文は「開店時の文 (_OPEN) / 閉店中の文 (_CLOSED)」の対で持ち、`byStore(open, closed)` で選ぶ。
 *     `EC_SITE_OPEN` を true にする 1 行で、文・URL・ボタン名がそろって開店時に戻る
 *     (開店時はメニュー画像の作り直しと再登録も要る)。
 *   - 関数で組み立てる返信は `siteOpen` 引数 (既定 EC_SITE_OPEN) を取り、テストで両方の分岐を固定する。
 *
 * このモジュールは依存を持たない (どこからでも import できるように)。
 * `SITE_URL_JA` (brand-copy.ts) と `DUMMY_ARTICLE_URL_BASE` (journal.ts) は触らない (設計第2章)。
 */

/** 公式 EC (elxea.com) が開店しているか。開店時にこの 1 行を true にする。 */
export const EC_SITE_OPEN: boolean = false;

/** 公式 EC の購入先 (開店時の行き先)。master の SITE_URL_JA / 旧 EC_SITE_URL と同じ値。 */
export const EC_STORE_URL = "https://elxea.com/ja";

/** 正本: Corporate Info「ECサイト」行 https://app.notion.com/p/34170c9d064c815687e5c79236f5472b */
export const AMAZON_STORE_URL =
  "https://www.amazon.co.jp/stores/page/0C75602F-4851-4957-8D54-9A17590AF63C";

/** 開店状態に応じた購入先 URL (テストは siteOpen を渡して両方を固定する)。 */
export function purchaseUrlFor(siteOpen: boolean = EC_SITE_OPEN): string {
  return siteOpen ? EC_STORE_URL : AMAZON_STORE_URL;
}

/** いまの購入先 URL。文言 v2 のプレースホルダ `${PURCHASE_URL}` はこれを差し込む。 */
export const PURCHASE_URL = purchaseUrlFor(EC_SITE_OPEN);

/** 開店時の文と閉店中の文の対から、いまの文を選ぶ (テストは siteOpen を渡して両方を固定する)。 */
export function byStore<T>(open: T, closed: T, siteOpen: boolean = EC_SITE_OPEN): T {
  return siteOpen ? open : closed;
}

// ---------------------------------------------------------------------------
// 閉じたサイトへのリンク判定
// ---------------------------------------------------------------------------

/** 閉店中に「閉じたサイト」とみなすホスト (完全一致)。 */
const CLOSED_HOSTS = ["elxea.com"] as const;
/** 閉店中に「閉じたサイト」とみなすホストの接尾辞 (サブドメイン・Shopify のカートリンク)。 */
const CLOSED_HOST_SUFFIXES = [".elxea.com", ".myshopify.com"] as const;

/** 文字列全体がメールアドレスか (`info@elxea.com` は閉じたリンクではない)。 */
const EMAIL_ONLY_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
/** スキームつきか (`https:` `mailto:` `tel:` `line:` など)。 */
const HAS_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * 閉じたサイトへのリンクか。
 *
 * - `siteOpen` が true なら常に false。
 * - 閉店中は、ホストが `elxea.com` / `*.elxea.com` / `*.myshopify.com` なら true。
 *   スキームの無い `elxea.com/ja` も対象。
 * - メールアドレス (`info@elxea.com`) と `mailto:` は対象外。`tel:` など http(s) 以外のスキームも対象外。
 * - http(s) なのに解析できないものは true (出さない側に倒す)。
 * - `amazon.co.jp` / `*.workers.dev` / `liff.line.me` は当たらない。
 */
export function isClosedSiteLink(link: string, siteOpen: boolean = EC_SITE_OPEN): boolean {
  if (siteOpen) return false;
  const s = link.trim();
  if (s === "") return false;
  if (EMAIL_ONLY_RE.test(s)) return false;
  let candidate: string;
  if (HAS_SCHEME_RE.test(s)) {
    if (!/^https?:/i.test(s)) return false; // mailto: / tel: / line: などはサイトへのリンクではない
    candidate = s;
  } else {
    candidate = `https://${s.replace(/^\/\//, "")}`;
  }
  let host: string;
  try {
    host = new URL(candidate).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return true;
  }
  if (host === "") return true;
  if ((CLOSED_HOSTS as readonly string[]).includes(host)) return true;
  return CLOSED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * 文中の URL らしい部分 (スキームつき・スキーム無しのドメイン) を拾う正規表現。
 * 使える文字は ASCII に限る (日本語の本文や全角括弧は URL に含めない)。
 */
const URL_IN_TEXT_RE =
  /(?:https?:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%-]+|(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?(?:[/?#][A-Za-z0-9._~:/?#@!$&*+,;=%-]*)?)/g;

/** 文中の URL らしい部分を位置つきで取り出す (メールアドレスのドメイン部は除く)。 */
function findLinksInText(text: string): Array<{ link: string; start: number; end: number }> {
  const found: Array<{ link: string; start: number; end: number }> = [];
  for (const m of text.matchAll(URL_IN_TEXT_RE)) {
    const start = m.index ?? 0;
    const raw = m[0];
    // 直前が `@` や英数字 = メールアドレスのドメイン部か単語の途中。リンクとして扱わない。
    const prev = start > 0 ? text[start - 1] : "";
    if (prev !== "" && /[A-Za-z0-9@._%+-]/.test(prev)) continue;
    // 文末の句読点 (ASCII) は URL に含めない。
    const link = raw.replace(/[.,;:!?]+$/, "");
    if (link === "") continue;
    found.push({ link, start, end: start + link.length });
  }
  return found;
}

/**
 * 文中の閉じたリンクを消す。消した数も返す (本文はログに出さない)。
 * 消した数が 0 のときは元の文をそのまま返す (決まった文の経路では 0 のはず)。
 */
export function stripClosedLinks(
  text: string,
  siteOpen: boolean = EC_SITE_OPEN,
): { text: string; removed: number } {
  if (siteOpen) return { text, removed: 0 };
  const closed = findLinksInText(text).filter((f) => isClosedSiteLink(f.link, false));
  if (closed.length === 0) return { text, removed: 0 };
  let out = "";
  let cursor = 0;
  for (const f of closed) {
    out += text.slice(cursor, f.start);
    cursor = f.end;
  }
  out += text.slice(cursor);
  // 消した跡の空の括弧・行末の空白・3 行以上の空行を整える (消したときだけ)。
  out = out
    .replace(/（\s*）/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t　]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return { text: out, removed: closed.length };
}

/** 画像・動画など、押せるリンクではない URL を持つキー (collectLinks の対象外)。 */
const MEDIA_KEYS = new Set([
  "url",
  "previewImageUrl",
  "originalContentUrl",
  "thumbnailImageUrl",
  "iconUrl",
  "baseUrl",
]);
/** 値そのものがリンクであるキー (Flex / quickReply / imagemap の action)。 */
const LINK_KEYS = new Set(["uri", "linkUri"]);

/**
 * 送るメッセージ (文字列・LINE のメッセージ・Flex・その配列) から、お客さんが目にするリンクを全部取り出す。
 *
 * - テキスト本文の中の URL (スキーム無しの `elxea.com/...` も含む)
 * - Flex の入れ子を全部たどったすべての `uri` (`linkUri` も)
 * - quickReply の各 action の `uri`
 * - `altText` の本文
 * - メールアドレス (`info@elxea.com` など) は取り出さない
 *
 * 判定は呼び出し側で `isClosedSiteLink` を当てる (文字列の単純一致では判定しない)。
 */
export function collectLinks(message: unknown): string[] {
  const links: string[] = [];
  const walk = (value: unknown, key: string | null): void => {
    if (typeof value === "string") {
      if (key !== null && MEDIA_KEYS.has(key)) return;
      if (key !== null && LINK_KEYS.has(key)) {
        links.push(value);
        return;
      }
      for (const f of findLinksInText(value)) links.push(f.link);
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, null);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k);
    }
  };
  walk(message, null);
  return links;
}
