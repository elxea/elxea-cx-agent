/**
 * Notion → Supabase pgvector 同期スクリプト。
 *
 * elxea の Notion ナレッジ DB からデータを取得し、
 * AI エージェントが検索できる形にチャンク分割 → Embedding → pgvector に保存。
 *
 * 対象 DB:
 *   - Product List（商品タイプ: AI Reference Info, Origin Info）
 *   - Set Menu List（セットメニュー: Concept, Descriptions, Tagline）
 *   - Tea Menu List（個別のお茶: Description, Flavor, How to Brew）
 *
 * Usage:
 *   pnpm sync-knowledge
 *
 * 環境変数（.dev.vars に設定）:
 *   NOTION_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Cloudflare Workers AI の認証は wrangler のOAuth トークンを自動で読み取ります。
 */

import dotenv from "dotenv";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// .dev.vars を読み込む（.env の代わり）
dotenv.config({ path: ".dev.vars" });

const NOTION_API_KEY = process.env.NOTION_TOKEN!;
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const CLOUDFLARE_ACCOUNT_ID =
  process.env.CLOUDFLARE_ACCOUNT_ID || "66e8e422866873db86f63fcf0c09673f";

// --- Notion DB IDs ---
const PRODUCT_LIST_DB = process.env.NOTION_PRODUCT_LIST_DB_ID || "238e2841-a6f1-4941-9653-5f61d5e1f25e";
const SET_MENU_DB = process.env.NOTION_SET_MENU_DB_ID || "0c654752-cf81-4148-91e3-ced7de4b11e4";
const TEA_MENU_DB = process.env.NOTION_TEA_MENU_DB_ID || "ee367f6c-3ff3-4251-ad9e-0bc5a2cc7358";
const CONTENT_HUB_DB = process.env.NOTION_CONTENT_HUB_DB_ID || "16451cee-ec90-4dc0-92d9-85cca2842412";

// -------------------------------------------------------------------
// Cloudflare Workers AI (wrangler OAuth 認証)
// -------------------------------------------------------------------

function getWranglerOAuthToken(): string {
  const configPath = join(
    homedir(),
    "Library",
    "Preferences",
    ".wrangler",
    "config",
    "default.toml",
  );
  try {
    const content = readFileSync(configPath, "utf-8");
    const match = content.match(/oauth_token\s*=\s*"([^"]+)"/);
    if (!match) throw new Error("oauth_token not found in wrangler config");
    return match[1];
  } catch {
    throw new Error(
      "wrangler OAuth token not found. Run `npx wrangler login` first.",
    );
  }
}

// -------------------------------------------------------------------
// Notion API helpers
// -------------------------------------------------------------------

async function notionFetch(path: string, body?: Record<string, unknown>) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`Notion API error: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

type NotionPage = {
  id: string;
  properties: Record<string, NotionProperty>;
};

type NotionProperty = {
  type: string;
  title?: Array<{ plain_text: string }>;
  rich_text?: Array<{ plain_text: string }>;
  select?: { name: string } | null;
  multi_select?: Array<{ name: string }>;
  number?: number | null;
  checkbox?: boolean;
  url?: string | null;
  rollup?: { array?: NotionProperty[] };
  formula?: { type: string; string?: string | null; number?: number | null; boolean?: boolean | null };
  status?: { name: string } | null;
  date?: { start: string; end?: string | null } | null;
  [key: string]: unknown;
};

/** DB の全ページをプロパティ付きで取得 */
async function queryAllPages(databaseId: string): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let startCursor: string | undefined;

  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;

    const data = (await notionFetch(
      `/databases/${databaseId}/query`,
      body,
    )) as {
      results: NotionPage[];
      has_more: boolean;
      next_cursor?: string;
    };

    pages.push(...data.results);
    startCursor = data.has_more ? data.next_cursor : undefined;
  } while (startCursor);

  return pages;
}

/** プロパティからプレーンテキストを抽出 */
function extractText(prop: NotionProperty | undefined): string {
  if (!prop) return "";
  switch (prop.type) {
    case "title":
      return prop.title?.map((t) => t.plain_text).join("") ?? "";
    case "rich_text":
      return prop.rich_text?.map((t) => t.plain_text).join("") ?? "";
    case "select":
      return prop.select?.name ?? "";
    case "multi_select":
      return prop.multi_select?.map((s) => s.name).join(", ") ?? "";
    case "number":
      return prop.number != null ? String(prop.number) : "";
    case "checkbox":
      return prop.checkbox ? "はい" : "いいえ";
    case "rollup": {
      if (!prop.rollup?.array) return "";
      return prop.rollup.array
        .map((item) => extractText(item))
        .filter(Boolean)
        .join(", ");
    }
    case "formula": {
      if (!prop.formula) return "";
      if (prop.formula.type === "string") return prop.formula.string ?? "";
      if (prop.formula.type === "number") return prop.formula.number != null ? String(prop.formula.number) : "";
      if (prop.formula.type === "boolean") return prop.formula.boolean ? "はい" : "いいえ";
      return "";
    }
    case "status":
      return (prop.status as { name: string } | null)?.name ?? "";
    case "date":
      return prop.date?.start ?? "";
    default:
      return "";
  }
}

/** ページのブロック内容をプレーンテキストとして取得 */
async function getPageContent(pageId: string): Promise<string> {
  const data = (await notionFetch(
    `/blocks/${pageId}/children?page_size=100`,
  )) as {
    results: Array<{ type: string; [key: string]: unknown }>;
  };

  const texts: string[] = [];
  for (const block of data.results) {
    const blockData = block[block.type] as
      | { rich_text?: Array<{ plain_text: string }> }
      | undefined;
    if (blockData?.rich_text) {
      const text = blockData.rich_text.map((t) => t.plain_text).join("");
      if (text.trim()) texts.push(text);
    }
  }
  return texts.join("\n");
}

// -------------------------------------------------------------------
// DB 固有のテキスト抽出
// -------------------------------------------------------------------

/** Product Catalogue → AI 向けテキスト */
function extractProductListText(page: NotionPage): string {
  const p = page.properties;
  const parts: string[] = [];

  const name = extractText(p["商品名_master"]);
  if (name) parts.push(`商品名: ${name}`);

  const displayName = extractText(p["商品名"]);
  if (displayName && displayName !== name) parts.push(`表示名: ${displayName}`);

  const status = extractText(p["販売状況"]);
  if (status) parts.push(`販売状況: ${status}`);

  const series = extractText(p["シリーズ名"]);
  if (series) parts.push(`シリーズ: ${series}`);

  const productType = extractText(p["商品のタイプ"]);
  if (productType) parts.push(`商品タイプ: ${productType}`);

  const teaLeafType = extractText(p["茶葉のタイプ"]);
  if (teaLeafType) parts.push(`茶葉タイプ: ${teaLeafType}`);

  const teaCategory = extractText(p["お茶のカテゴリー"]);
  if (teaCategory) parts.push(`お茶カテゴリー: ${teaCategory}`);

  const vol = extractText(p["Vol"]);
  if (vol) parts.push(`内容量: ${vol}`);

  const menuDetail = extractText(p["メニューの詳細"]);
  if (menuDetail) parts.push(`メニュー詳細: ${menuDetail}`);

  const menuContent = extractText(p["メニュー内容"]);
  if (menuContent) parts.push(`メニュー内容: ${menuContent}`);

  const contents = extractText(p["内容物_master"]);
  if (contents) parts.push(`内容物: ${contents}`);

  const ingredients = extractText(p["原材料"]);
  if (ingredients) parts.push(`原材料: ${ingredients}`);

  const packaging = extractText(p["包装物"]);
  if (packaging) parts.push(`包装: ${packaging}`);

  const size = extractText(p["サイズ"]);
  if (size) parts.push(`サイズ: ${size}`);

  const retailPrice = extractText(p["上代(税抜)"]);
  if (retailPrice) parts.push(`上代(税抜): ¥${retailPrice}`);

  const wholesalePrice = extractText(p["下代(税抜)"]);
  if (wholesalePrice) parts.push(`下代(税抜): ¥${wholesalePrice}`);

  const weight = extractText(p["重量(g)"]);
  if (weight) parts.push(`重量: ${weight}g`);

  const expiry = extractText(p["賞味期限(年)"]);
  if (expiry) parts.push(`賞味期限: ${expiry}`);

  const sku = extractText(p["SKU"]);
  if (sku) parts.push(`SKU: ${sku}`);

  const jan = extractText(p["JAN"]);
  if (jan) parts.push(`JAN: ${jan}`);

  const stockOL = extractText(p["在庫数_OL"]);
  if (stockOL) parts.push(`在庫数(OL): ${stockOL}`);

  const stockFBA = extractText(p["在庫数_FBA"]);
  if (stockFBA) parts.push(`在庫数(FBA): ${stockFBA}`);

  return parts.join("\n");
}

/** Set Menu List → AI 向けテキスト */
function extractSetMenuText(page: NotionPage): string {
  const p = page.properties;
  const parts: string[] = [];

  const name = extractText(p["Name"]);
  if (name) parts.push(`セットメニュー名: ${name}`);

  const newName = extractText(p["Name_NEW"]);
  if (newName && newName !== name) parts.push(`表示名: ${newName}`);

  const series = extractText(p["Series"]);
  if (series) parts.push(`シリーズ: ${series}`);

  const teaType = extractText(p["Type of Tea"]);
  if (teaType) parts.push(`お茶の種類: ${teaType}`);

  const teaKind = extractText(p["お茶の種類"]);
  if (teaKind) parts.push(`お茶の種類(詳細): ${teaKind}`);

  const menuName = extractText(p["Menu Name"]);
  if (menuName) parts.push(`メニュー名: ${menuName}`);

  const tagline = extractText(p["Tagline"]);
  if (tagline) parts.push(`タグライン: ${tagline}`);

  const concept = extractText(p["Concept"]);
  if (concept) parts.push(`コンセプト: ${concept}`);

  const desc = extractText(p["Descriptions"]);
  if (desc) parts.push(`詳細: ${desc}`);

  const descShort = extractText(p["Descriptions_Short ver."]);
  if (descShort) parts.push(`短い説明: ${descShort}`);

  const descAI = extractText(p["Descriptions_Short Ver._AI"]);
  if (descAI) parts.push(`AI用説明: ${descAI}`);

  const vol = extractText(p["Vol"]);
  if (vol) parts.push(`内容量: ${vol}ml`);

  const netWt = extractText(p["Net Wt.｜内容量"]);
  if (netWt) parts.push(`重量: ${netWt}`);

  const netWtG = extractText(p["Net Wt.(g)｜内容量(g)"]);
  if (netWtG) parts.push(`重量(g): ${netWtG}g`);

  const status = extractText(p["Status"]);
  if (status) parts.push(`販売状況: ${status}`);

  const ingredients = extractText(p["Ingredients｜原材料・配合情報"]);
  if (ingredients) parts.push(`原材料: ${ingredients}`);

  const expiry = extractText(p["Best-before Date(Year)｜賞味期限(年)"]);
  if (expiry) parts.push(`賞味期限: ${expiry}年`);

  const preservation = extractText(p["Preservation Method | 保存方法"]);
  if (preservation) parts.push(`保存方法: ${preservation}`);

  const supplier = extractText(p["Supplier"]);
  if (supplier) parts.push(`産地: ${supplier}`);

  return parts.join("\n");
}

/** Tea Menu List → AI 向けテキスト */
function extractTeaMenuText(page: NotionPage): string {
  const p = page.properties;
  const parts: string[] = [];

  const name = extractText(p["Menu Name"]);
  if (name) parts.push(`お茶の名前: ${name}`);

  const fullName = extractText(p["Menu Name - full"]);
  if (fullName && fullName !== name) parts.push(`正式名称: ${fullName}`);

  const grade = extractText(p["Grade"]);
  if (grade) parts.push(`グレード: ${grade}`);

  const variety = extractText(p["Variety"]);
  if (variety) parts.push(`品種: ${variety}`);

  const season = extractText(p["Season"]);
  if (season) parts.push(`シーズン: ${season}`);

  const origin = extractText(p["Origin"]);
  if (origin) parts.push(`産地: ${origin}`);

  const flavor = extractText(p["Flavor Profile "]);
  if (flavor) parts.push(`フレーバー: ${flavor}`);

  const flavorDetail = extractText(p["Flavor Profile - Detailed"]);
  if (flavorDetail) parts.push(`フレーバー詳細: ${flavorDetail}`);

  const descShort = extractText(p["Menu Description(Short ver.) "]);
  if (descShort) parts.push(`短い説明: ${descShort}`);

  const descFormalized = extractText(p["Menu Description(Formalized ver.)"]);
  if (descFormalized) parts.push(`公式説明: ${descFormalized}`);

  const tastingNotes = extractText(p["Tasting Notes"]);
  if (tastingNotes) parts.push(`テイスティングノート: ${tastingNotes}`);

  const overallScore = extractText(p["Overall Score"]);
  if (overallScore) parts.push(`総合スコア: ${overallScore}/5`);

  const tasteScore = extractText(p["味わい：すっきり / しっかり"]);
  if (tasteScore) parts.push(`味わい(すっきり↔しっかり): ${tasteScore}/5`);

  const aromaScore = extractText(p["香り：甘い、熟した / 青い、爽やかな"]);
  if (aromaScore) parts.push(`香り(甘い↔爽やか): ${aromaScore}/5`);

  const howToBrew = extractText(p["How to Brew"]);
  if (howToBrew) parts.push(`淹れ方: ${howToBrew}`);

  const temp = extractText(p["How-to_Temp(℃)"]);
  const time = extractText(p["How-to_Time(Sec)"]);
  const water = extractText(p["How-to_Water(ml)"]);
  if (temp || time || water) {
    parts.push(
      `推奨抽出: ${temp ? `${temp}℃` : ""} ${water ? `${water}ml` : ""} ${time ? `${time}秒` : ""}`.trim(),
    );
  }

  const supplierName = extractText(p["Menu Name - Supplier"]);
  if (supplierName) parts.push(`仕入先名: ${supplierName}`);

  const status = extractText(p["Status"]);
  if (status) parts.push(`販売状況: ${status}`);

  return parts.join("\n");
}

const SYNC_CHANNELS = ["Roji", "LINE CRM"] as const;
type SyncChannel = (typeof SYNC_CHANNELS)[number];

/** Content Hub → AI 向けテキスト（チャンネル指定） */
function extractContentHubText(page: NotionPage, targetChannel: SyncChannel): string {
  const p = page.properties;

  const channel = extractText(p["Channel"]);
  if (channel !== targetChannel) return "";

  // Published または Ready のみ対象
  const status = extractText(p["Status"]);
  if (status !== "Published" && status !== "Ready") return "";

  const parts: string[] = [];

  const title = extractText(p["Title"]);
  if (title) parts.push(`記事タイトル: ${title}`);

  if (targetChannel === "Roji") {
    const intro = extractText(p["🌐 Roji: Intro"]);
    if (intro) parts.push(`イントロ: ${intro}`);

    const draft = extractText(p["🌐 Roji: Draft"]);
    if (draft) parts.push(`本文: ${draft}`);

    const metaDesc = extractText(p["🌐 Roji: Meta Description"]);
    if (metaDesc) parts.push(`概要: ${metaDesc}`);
  }

  const brief = extractText(p["Brief"]);
  if (brief) parts.push(`制作指示: ${brief}`);

  const publishDate = extractText(p["Published Date"]);
  if (publishDate) parts.push(`公開日: ${publishDate}`);

  return parts.join("\n");
}

// -------------------------------------------------------------------
// Embedding (Cloudflare Workers AI REST API)
// -------------------------------------------------------------------

let cachedToken: string | null = null;

async function createEmbedding(text: string): Promise<number[]> {
  if (!cachedToken) {
    cachedToken = getWranglerOAuthToken();
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/baai/bge-m3`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cachedToken}`,
      },
      body: JSON.stringify({ text: [text] }),
    },
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Cloudflare AI API error: ${res.status} ${errorText}`);
  }

  const json = (await res.json()) as {
    result: { data: number[][] };
    success: boolean;
  };

  if (!json.success || !json.result?.data?.[0]) {
    throw new Error(`Cloudflare AI returned unexpected response: ${JSON.stringify(json)}`);
  }

  return json.result.data[0];
}

// -------------------------------------------------------------------
// Supabase
// -------------------------------------------------------------------

async function supabaseFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
      ...options.headers,
    },
  });
}

async function upsertChunk(chunk: {
  notion_page_id: string;
  source_type: string;
  source_title: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const res = await supabaseFetch("/knowledge_chunks", {
    method: "POST",
    body: JSON.stringify({
      notion_page_id: chunk.notion_page_id,
      source_type: chunk.source_type,
      source_title: chunk.source_title,
      content: chunk.content,
      embedding: JSON.stringify(chunk.embedding),
      metadata: chunk.metadata ?? {},
      synced_at: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    console.error(`Upsert failed for ${chunk.source_title}:`, error);
  }
}

/** 同期前に既存チャンクを削除（該当 source_type のみ） */
async function deleteChunksBySourceType(sourceType: string): Promise<void> {
  const res = await supabaseFetch(
    `/knowledge_chunks?source_type=eq.${sourceType}`,
    {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    },
  );
  if (!res.ok) {
    console.warn(`Failed to delete old chunks for ${sourceType}`);
  }
}

// -------------------------------------------------------------------
// チャンク分割
// -------------------------------------------------------------------

/**
 * テキストをチャンクに分割する。
 *
 * MS1 1.5: チャンク分割戦略の最適化
 * - タイトルを各チャンクに付与して文脈を保持
 * - 段落境界で分割し、情報の途中切断を防止
 * - maxChars は embedding モデルのトークン効率を考慮した値
 */
function splitIntoChunks(
  text: string,
  title: string,
  maxChars = 800,
): string[] {
  // タイトルプレフィックスを各チャンクに付与
  const titlePrefix = `【${title}】\n`;
  const effectiveMax = maxChars - titlePrefix.length;

  if (text.length <= effectiveMax) return [titlePrefix + text];

  const chunks: string[] = [];
  const paragraphs = text.split("\n");
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 1 > effectiveMax && current) {
      chunks.push(titlePrefix + current.trim());
      current = "";
    }
    current += (current ? "\n" : "") + para;
  }

  if (current.trim()) {
    chunks.push(titlePrefix + current.trim());
  }

  return chunks;
}

// -------------------------------------------------------------------
// Main
// -------------------------------------------------------------------

type DBConfig = {
  id: string;
  sourceType: string;
  label: string;
  extractText: (page: NotionPage) => string;
};

const DB_CONFIGS: DBConfig[] = [
  {
    id: PRODUCT_LIST_DB,
    sourceType: "product",
    label: "Product List（商品タイプ）",
    extractText: extractProductListText,
  },
  {
    id: SET_MENU_DB,
    sourceType: "set_menu",
    label: "Set Menu List（セットメニュー）",
    extractText: extractSetMenuText,
  },
  {
    id: TEA_MENU_DB,
    sourceType: "tea",
    label: "Tea Menu List（個別のお茶）",
    extractText: extractTeaMenuText,
  },
  {
    id: CONTENT_HUB_DB,
    sourceType: "article",
    label: "Content Hub（roji 記事）",
    extractText: (page: NotionPage) => extractContentHubText(page, "Roji"),
  },
  {
    id: CONTENT_HUB_DB,
    sourceType: "crm",
    label: "Content Hub（LINE CRM）",
    extractText: (page: NotionPage) => extractContentHubText(page, "LINE CRM"),
  },
];

async function main() {
  console.log("🔄 Starting knowledge sync...\n");

  if (!NOTION_API_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("❌ Missing required environment variables. Check .dev.vars file.");
    process.exit(1);
  }

  // wrangler 認証チェック
  try {
    getWranglerOAuthToken();
    console.log("✅ Cloudflare Workers AI auth OK (wrangler OAuth)\n");
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }

  let totalChunks = 0;

  for (const config of DB_CONFIGS) {
    console.log(`📚 Syncing: ${config.label}`);

    // 既存チャンクを削除して再同期（差分管理より確実）
    await deleteChunksBySourceType(config.sourceType);

    const pages = await queryAllPages(config.id);
    console.log(`   Found ${pages.length} pages`);

    for (const page of pages) {
      // プロパティからテキスト抽出
      let text = config.extractText(page);

      // ページ本文も取得して追加
      const pageContent = await getPageContent(page.id);
      if (pageContent.trim()) {
        text += "\n\n" + pageContent;
      }

      if (!text.trim()) {
        continue;
      }

      // タイトル取得
      const titleProp = Object.values(page.properties).find(
        (p) => p.type === "title",
      );
      const title =
        titleProp?.title?.map((t) => t.plain_text).join("") ?? "Untitled";

      // チャンク分割 + Embedding + 保存（タイトルコンテキスト付き）
      const chunks = splitIntoChunks(text, title);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = await createEmbedding(chunk);
        await upsertChunk({
          notion_page_id: page.id,
          source_type: config.sourceType,
          source_title: title,
          content: chunk,
          embedding,
          metadata: {
            source_db: config.sourceType,
            chunk_index: i,
            total_chunks: chunks.length,
          },
        });
        totalChunks++;
      }

      console.log(
        `   ✅ ${title} (${chunks.length} chunk${chunks.length > 1 ? "s" : ""})`,
      );

      // レートリミット回避（Notion: 3 req/sec）
      await new Promise((r) => setTimeout(r, 350));
    }

    console.log();
  }

  console.log(`✨ Done! Synced ${totalChunks} chunks total.`);
}

main().catch((err) => {
  console.error("❌ Sync failed:", err);
  process.exit(1);
});
