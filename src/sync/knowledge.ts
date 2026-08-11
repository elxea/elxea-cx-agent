/**
 * ナレッジ同期モジュール（Workers 互換）。
 *
 * MS4 4.1/4.4/4.5/4.7/4.8:
 *   - 増分同期（last_edited_time ベース）
 *   - 削除検知
 *   - Cron Trigger 対応
 *   - 同期ログ記録
 *   - エラーハンドリング
 *
 * Cron Trigger と手動 API の両方から呼び出される。
 * Workers 環境では env.AI バインディングで Embedding を生成。
 */

import type { Env } from "../index";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  BRAND_NAME,
  BRAND_NAME_READING,
  COMPANY_NAME,
  BRAND_STATEMENT_SHORT,
  BRAND_TAGLINE,
  TEA_CATEGORIES,
  SITE_URL_JA,
  SUPPORT_EMAIL,
} from "../lib/brand-copy";
import { guardBrandFacts } from "../lib/brand-guard";

// -------------------------------------------------------------------
// Types
// -------------------------------------------------------------------

type SyncResult = {
  status: "success" | "partial_failure" | "failure";
  syncType: "full" | "incremental";
  totalPages: number;
  addedChunks: number;
  updatedChunks: number;
  deletedChunks: number;
  errorCount: number;
  errorDetails: Array<{ source: string; error: string }>;
  durationMs: number;
};

type NotionPage = {
  id: string;
  last_edited_time: string;
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
  formula?: {
    type: string;
    string?: string | null;
    number?: number | null;
    boolean?: boolean | null;
  };
  status?: { name: string } | null;
  date?: { start: string; end?: string | null } | null;
  [key: string]: unknown;
};

type DBConfig = {
  envKey: keyof Env;
  fallbackId: string;
  sourceType: string;
  label: string;
  extractText: (page: NotionPage) => string;
};

// -------------------------------------------------------------------
// FIX-2 (Spec v3 OPS-1/OPS-5): 同期台帳の失敗を握りつぶさない
// -------------------------------------------------------------------

/** 同期台帳（sync_logs）の記録失敗・必須テーブル不在を表す明示エラー。 */
export class SyncLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncLedgerError";
  }
}

/** 同期に必須のテーブル。preflight で存在を確認する。 */
const REQUIRED_SYNC_TABLES = ["sync_logs", "knowledge_chunks"] as const;

/**
 * 起動時 preflight: 必須テーブルの存在をチェックする。
 * 不在なら理由（テーブル名・エラーメッセージ）を返す。存在すれば null。
 * Supabase JS は不在テーブルへの select を throw せず error オブジェクトで返すため、
 * head select で軽量に存在を確認する。
 */
async function checkRequiredTables(
  supabase: SupabaseClient,
): Promise<string | null> {
  for (const table of REQUIRED_SYNC_TABLES) {
    const { error } = await supabase
      .from(table)
      .select("*", { head: true, count: "exact" });
    if (error) {
      return `required table "${table}" is not accessible: ${error.message}${error.code ? ` (code: ${error.code})` : ""}`;
    }
  }
  return null;
}

// -------------------------------------------------------------------
// Main Entry
// -------------------------------------------------------------------

export async function runKnowledgeSync(
  env: Env,
  mode: "full" | "incremental" = "incremental",
  supabaseClient?: SupabaseClient,
): Promise<SyncResult> {
  const startTime = Date.now();
  // FIX-2: テスト時はモッククライアントを注入可能にする（本番は createClient）
  const supabase =
    supabaseClient ??
    createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

  const result: SyncResult = {
    status: "success",
    syncType: mode,
    totalPages: 0,
    addedChunks: 0,
    updatedChunks: 0,
    deletedChunks: 0,
    errorCount: 0,
    errorDetails: [],
    durationMs: 0,
  };

  // FIX-2: 台帳/必須テーブルの失敗を「失敗として終了 + 通知」する共通ハンドラ。
  const failLoud = async (reason: string): Promise<never> => {
    result.status = "failure";
    result.durationMs = Date.now() - startTime;
    result.errorCount++;
    result.errorDetails.push({ source: "sync_ledger", error: reason });
    console.error(`[sync] Ledger failure, aborting sync: ${reason}`);
    // 失敗時のみ通知（OPS-2）
    await notifySyncFailure(result, env).catch((err) =>
      console.error("Sync failure notification failed:", err),
    );
    throw new SyncLedgerError(reason);
  };

  // FIX-2: 起動時 preflight — 必須テーブルが無ければ即失敗
  const preflightError = await checkRequiredTables(supabase);
  if (preflightError) await failLoud(preflightError);

  // 同期ログの開始を記録（FIX-2: insert エラーを握りつぶさず失敗終了）
  const { data: syncLog, error: insertError } = await supabase
    .from("sync_logs")
    .insert({
      started_at: new Date().toISOString(),
      status: "running",
      sync_type: mode,
    })
    .select("id")
    .single();
  if (insertError || !syncLog?.id) {
    await failLoud(
      `sync_logs insert failed: ${insertError?.message ?? "no row id returned"}`,
    );
  }
  const syncLogId = syncLog!.id;

  // 最後の成功同期時刻を取得（増分同期用）
  let lastSyncedAt: string | undefined;
  if (mode === "incremental") {
    const { data: lastSync } = await supabase
      .from("sync_logs")
      .select("completed_at")
      .eq("status", "success")
      .order("completed_at", { ascending: false })
      .limit(1)
      .single();
    lastSyncedAt = lastSync?.completed_at ?? undefined;
  }

  // ブランド正本（About elxea + 公開してよい会社事実）を最初に同期する。
  //   商品系 4 DB には無いブランド事実（社名・ステートメント・タグライン・取扱カテゴリ）を
  //   RAG に載せ、AI が空欄を幻覚で埋める構造を断つ（ID-6701）。小さく最重要なので、
  //   重い商品系ループより前に置き、フル再 embed で時間切れになっても確実に着地させる。
  try {
    await syncBrandKnowledge(supabase, env, result);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error("Sync error for ブランド正本（About elxea）:", errMsg);
    result.errorCount++;
    result.errorDetails.push({ source: "brand", error: errMsg });
  }

  const dbConfigs = getDBConfigs(env);

  for (const config of dbConfigs) {
    const dbId = (env[config.envKey] as string) || config.fallbackId;
    if (!dbId) continue;

    try {
      console.log(`Syncing: ${config.label} (${mode})`);

      if (mode === "full") {
        await syncDBFull(dbId, config, supabase, env, result);
      } else {
        await syncDBIncremental(
          dbId,
          config,
          supabase,
          env,
          result,
          lastSyncedAt,
        );
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`Sync error for ${config.label}:`, errMsg);
      result.errorCount++;
      result.errorDetails.push({ source: config.label, error: errMsg });
    }
  }

  // 結果の集計
  result.durationMs = Date.now() - startTime;
  result.status =
    result.errorCount > 0
      ? result.errorCount === dbConfigs.length
        ? "failure"
        : "partial_failure"
      : "success";

  // 同期ログの更新（FIX-2: 更新失敗も台帳の破綻として失敗終了）
  const { error: updateError } = await supabase
    .from("sync_logs")
    .update({
      completed_at: new Date().toISOString(),
      status: result.status,
      total_pages: result.totalPages,
      added_chunks: result.addedChunks,
      updated_chunks: result.updatedChunks,
      deleted_chunks: result.deletedChunks,
      error_count: result.errorCount,
      error_details: result.errorDetails,
      duration_ms: result.durationMs,
    })
    .eq("id", syncLogId);
  if (updateError) {
    await failLoud(`sync_logs completion update failed: ${updateError.message}`);
  }

  console.log(
    `Sync completed: ${result.status} (${result.totalPages} pages, ${result.addedChunks + result.updatedChunks} chunks, ${result.durationMs}ms)`,
  );

  // FIX-2 (OPS-2): 失敗時のみ通知。成功は sync_logs 記録のみ（定常通知は廃止）。
  if (result.status !== "success") {
    await notifySyncFailure(result, env).catch((err) =>
      console.error("Sync failure notification failed:", err),
    );
  }

  return result;
}

// -------------------------------------------------------------------
// Full Sync（全件削除→再挿入）
// -------------------------------------------------------------------

async function syncDBFull(
  dbId: string,
  config: DBConfig,
  supabase: SupabaseClient,
  env: Env,
  result: SyncResult,
): Promise<void> {
  // 既存チャンクを削除
  const { data: deleted } = await supabase
    .from("knowledge_chunks")
    .delete()
    .eq("source_type", config.sourceType)
    .select("id");
  result.deletedChunks += deleted?.length ?? 0;

  // Notion から全ページ取得
  const pages = await queryAllPages(dbId, env);
  result.totalPages += pages.length;

  for (const page of pages) {
    await processPage(page, config, supabase, env, result, "add");
  }
}

// -------------------------------------------------------------------
// Incremental Sync（差分のみ更新）
// -------------------------------------------------------------------

async function syncDBIncremental(
  dbId: string,
  config: DBConfig,
  supabase: SupabaseClient,
  env: Env,
  result: SyncResult,
  lastSyncedAt?: string,
): Promise<void> {
  // 全ページ ID を取得（削除検知用）
  const allPages = await queryAllPages(dbId, env);
  result.totalPages += allPages.length;

  // 更新されたページのみフィルタ
  const updatedPages = lastSyncedAt
    ? allPages.filter(
        (p) => new Date(p.last_edited_time) > new Date(lastSyncedAt),
      )
    : allPages;

  console.log(
    `  ${config.label}: ${allPages.length} total, ${updatedPages.length} updated`,
  );

  // 更新されたページを処理
  for (const page of updatedPages) {
    // 既存チャンクを削除（このページの）
    const { data: deletedPageChunks } = await supabase
      .from("knowledge_chunks")
      .delete()
      .eq("notion_page_id", page.id)
      .select("id");
    if (deletedPageChunks && deletedPageChunks.length > 0)
      result.updatedChunks += deletedPageChunks.length;

    await processPage(page, config, supabase, env, result, "update");
  }

  // 削除検知: Notion に存在しないページのチャンクを削除
  const notionPageIds = new Set(allPages.map((p) => p.id));
  const { data: existingChunks } = await supabase
    .from("knowledge_chunks")
    .select("notion_page_id")
    .eq("source_type", config.sourceType);

  if (existingChunks) {
    const orphanIds = [
      ...new Set(
        existingChunks
          .map((c) => c.notion_page_id)
          .filter((id) => !notionPageIds.has(id)),
      ),
    ];
    if (orphanIds.length > 0) {
      const { data: deletedOrphans } = await supabase
        .from("knowledge_chunks")
        .delete()
        .in("notion_page_id", orphanIds)
        .select("id");
      const orphanCount = deletedOrphans?.length ?? 0;
      result.deletedChunks += orphanCount;
      console.log(`  Deleted ${orphanCount} orphan chunks from ${orphanIds.length} removed pages`);
    }
  }
}

// -------------------------------------------------------------------
// Page Processing
// -------------------------------------------------------------------

async function processPage(
  page: NotionPage,
  config: DBConfig,
  supabase: SupabaseClient,
  env: Env,
  result: SyncResult,
  mode: "add" | "update",
): Promise<void> {
  let text = config.extractText(page);
  if (!text.trim()) return;

  // ページ本文も取得
  try {
    const pageContent = await getPageContent(page.id, env);
    if (pageContent.trim()) {
      text += "\n\n" + pageContent;
    }
  } catch (err) {
    console.warn("[sync] Failed to fetch page content, continuing:", err instanceof Error ? err.message : err);
  }

  // タイトル取得
  const titleProp = Object.values(page.properties).find(
    (p) => p.type === "title",
  );
  const title =
    titleProp?.title?.map((t) => t.plain_text).join("") ?? "Untitled";

  // チャンク分割 + Embedding + 保存
  const chunks = splitIntoChunks(text, title);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    // Workers AI で Embedding 生成
    const embeddingResult = (await env.AI.run("@cf/baai/bge-m3", {
      text: [chunk],
    })) as { data: number[][] };
    const embedding = embeddingResult.data[0];

    const { error } = await supabase.from("knowledge_chunks").upsert(
      {
        notion_page_id: page.id,
        source_type: config.sourceType,
        source_title: title,
        content: chunk,
        embedding: JSON.stringify(embedding),
        metadata: {
          source_db: config.sourceType,
          chunk_index: i,
          total_chunks: chunks.length,
        },
        notion_last_edited_at: page.last_edited_time,
        synced_at: new Date().toISOString(),
      },
      { onConflict: "notion_page_id,content" },
    );

    if (error) {
      console.error(`Upsert failed for ${title}:`, error.message);
      result.errorCount++;
      result.errorDetails.push({ source: title, error: error.message });
    } else {
      if (mode === "add") result.addedChunks++;
    }
  }
}

// -------------------------------------------------------------------
// Brand Knowledge Sync（ブランド正本 → RAG）
// -------------------------------------------------------------------

/** About elxea ページ（ブランド正本の一次情報・公開マーケ本文）。 */
const ABOUT_ELXEA_PAGE_ID = "154f0d9d-e112-457c-83c6-2fb5b56b1788";
/** ブランド正本チャンクの source_type。 */
const BRAND_SOURCE_TYPE = "brand";

/**
 * ブランド正本（About elxea + 公開してよい会社事実）を knowledge_chunks に同期する。
 *
 * 公開情報のみ（社名・ブランドステートメント・タグライン・取扱カテゴリ・サイト・問い合わせ）を、
 * brand-copy.ts の正本から構築して ingest する。Corporate Info DB の生フィールドは引かないため、
 * 財務・個人情報が構造的に混入しない。About elxea ページ本文は公開マーケ本文として付加する。
 * 小さいので mode 非依存で毎回フルリフレッシュ（delete → re-insert）する。
 */
async function syncBrandKnowledge(
  supabase: SupabaseClient,
  env: Env,
  result: SyncResult,
): Promise<void> {
  // (1) brand-copy.ts 正本から「公開してよい会社事実」だけを構築する。
  const canonicalFacts = [
    `ブランド名: ${BRAND_NAME}（${BRAND_NAME_READING}）`,
    `運営会社: ${COMPANY_NAME}`,
    `ブランドステートメント: ${BRAND_STATEMENT_SHORT}`,
    `タグライン: ${BRAND_TAGLINE}`,
    `取扱カテゴリ: ${TEA_CATEGORIES}`,
    `公式サイト: ${SITE_URL_JA}`,
    `お問い合わせ: ${SUPPORT_EMAIL}`,
  ].join("\n");

  // (2) About elxea ページ本文（公開マーケ本文）。取得失敗は正本ファクトのみで続行。
  let aboutBody = "";
  try {
    aboutBody = await getPageContent(ABOUT_ELXEA_PAGE_ID, env);
  } catch (err) {
    console.warn(
      "[sync:brand] About elxea 本文取得に失敗、正本ファクトのみ同期:",
      err instanceof Error ? err.message : err,
    );
  }

  // (3) egress と同じ brand-guard で非正本文言を是正してから ingest（多層防御）。
  const rawText = aboutBody ? `${canonicalFacts}\n\n${aboutBody}` : canonicalFacts;
  const { text, violations } = guardBrandFacts(rawText);
  if (violations.length > 0) {
    console.warn(
      `[sync:brand] About elxea 本文に非正本文言 ${violations.length} 件を検出し是正: ${violations
        .map((v) => v.matched)
        .join(", ")}`,
    );
  }

  const title = "elxea について（ブランド正本）";

  // 既存ブランドチャンクを入れ替え（毎回フルリフレッシュ）。
  const { data: deleted } = await supabase
    .from("knowledge_chunks")
    .delete()
    .eq("source_type", BRAND_SOURCE_TYPE)
    .select("id");
  result.deletedChunks += deleted?.length ?? 0;

  const chunks = splitIntoChunks(text, title);
  result.totalPages += 1;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embeddingResult = (await env.AI.run("@cf/baai/bge-m3", {
      text: [chunk],
    })) as { data: number[][] };
    const embedding = embeddingResult.data[0];

    const { error } = await supabase.from("knowledge_chunks").upsert(
      {
        notion_page_id: ABOUT_ELXEA_PAGE_ID,
        source_type: BRAND_SOURCE_TYPE,
        source_title: title,
        content: chunk,
        embedding: JSON.stringify(embedding),
        metadata: {
          source_db: BRAND_SOURCE_TYPE,
          chunk_index: i,
          total_chunks: chunks.length,
        },
        notion_last_edited_at: new Date().toISOString(),
        synced_at: new Date().toISOString(),
      },
      { onConflict: "notion_page_id,content" },
    );

    if (error) {
      console.error(`Upsert failed for ${title}:`, error.message);
      result.errorCount++;
      result.errorDetails.push({ source: title, error: error.message });
    } else {
      result.addedChunks++;
    }
  }

  console.log(
    `[sync:brand] ブランド正本を同期: ${chunks.length} chunks (about_body=${aboutBody ? "included" : "missing"})`,
  );
}

// -------------------------------------------------------------------
// Notion API helpers
// -------------------------------------------------------------------

async function notionFetch(
  path: string,
  env: Env,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    throw new Error(`Notion API error: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function queryAllPages(
  databaseId: string,
  env: Env,
): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let startCursor: string | undefined;

  do {
    const body: Record<string, unknown> = { page_size: 100 };
    if (startCursor) body.start_cursor = startCursor;

    const data = (await notionFetch(
      `/databases/${databaseId}/query`,
      env,
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

async function getPageContent(
  pageId: string,
  env: Env,
): Promise<string> {
  const data = (await notionFetch(
    `/blocks/${pageId}/children?page_size=100`,
    env,
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
// Text Extraction (same as standalone script)
// -------------------------------------------------------------------

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
      if (prop.formula.type === "number")
        return prop.formula.number != null ? String(prop.formula.number) : "";
      if (prop.formula.type === "boolean")
        return prop.formula.boolean ? "はい" : "いいえ";
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

function extractProductListText(page: NotionPage): string {
  const p = page.properties;
  const parts: string[] = [];
  const add = (label: string, key: string, suffix = "") => {
    const val = extractText(p[key]);
    if (val) parts.push(`${label}: ${val}${suffix}`);
  };

  add("商品名", "商品名_master");
  const displayName = extractText(p["商品名"]);
  const masterName = extractText(p["商品名_master"]);
  if (displayName && displayName !== masterName) parts.push(`表示名: ${displayName}`);
  add("販売状況", "販売状況");
  add("シリーズ", "シリーズ名");
  add("商品タイプ", "商品のタイプ");
  add("茶葉タイプ", "茶葉のタイプ");
  add("お茶カテゴリー", "お茶のカテゴリー");
  add("内容量", "Vol");
  add("メニュー詳細", "メニューの詳細");
  add("メニュー内容", "メニュー内容");
  add("内容物", "内容物_master");
  add("原材料", "原材料");
  add("包装", "包装物");
  add("サイズ", "サイズ");
  add("上代(税抜)", "上代(税抜)", "円");
  add("下代(税抜)", "下代(税抜)", "円");
  add("重量", "重量(g)", "g");
  add("賞味期限", "賞味期限(年)");
  add("SKU", "SKU");
  add("JAN", "JAN");
  add("在庫数(OL)", "在庫数_OL");
  add("在庫数(FBA)", "在庫数_FBA");

  return parts.join("\n");
}

function extractSetMenuText(page: NotionPage): string {
  const p = page.properties;
  const parts: string[] = [];
  const add = (label: string, key: string, suffix = "") => {
    const val = extractText(p[key]);
    if (val) parts.push(`${label}: ${val}${suffix}`);
  };

  add("セットメニュー名", "Name");
  const newName = extractText(p["Name_NEW"]);
  const name = extractText(p["Name"]);
  if (newName && newName !== name) parts.push(`表示名: ${newName}`);
  add("シリーズ", "Series");
  add("お茶の種類", "Type of Tea");
  add("お茶の種類(詳細)", "お茶の種類");
  add("メニュー名", "Menu Name");
  add("タグライン", "Tagline");
  add("コンセプト", "Concept");
  add("詳細", "Descriptions");
  add("短い説明", "Descriptions_Short ver.");
  add("AI用説明", "Descriptions_Short Ver._AI");
  add("内容量", "Vol", "ml");
  add("重量", "Net Wt.｜内容量");
  add("重量(g)", "Net Wt.(g)｜内容量(g)", "g");
  add("販売状況", "Status");
  add("原材料", "Ingredients｜原材料・配合情報");
  add("賞味期限", "Best-before Date(Year)｜賞味期限(年)", "年");
  add("保存方法", "Preservation Method | 保存方法");
  add("産地", "Supplier");

  return parts.join("\n");
}

function extractTeaMenuText(page: NotionPage): string {
  const p = page.properties;
  const parts: string[] = [];
  const add = (label: string, key: string, suffix = "") => {
    const val = extractText(p[key]);
    if (val) parts.push(`${label}: ${val}${suffix}`);
  };

  add("お茶の名前", "Menu Name");
  const fullName = extractText(p["Menu Name - full"]);
  const menuName = extractText(p["Menu Name"]);
  if (fullName && fullName !== menuName) parts.push(`正式名称: ${fullName}`);
  add("グレード", "Grade");
  add("品種", "Variety");
  add("シーズン", "Season");
  add("産地", "Origin");
  add("フレーバー", "Flavor Profile ");
  add("フレーバー詳細", "Flavor Profile - Detailed");
  add("短い説明", "Menu Description(Short ver.) ");
  add("公式説明", "Menu Description(Formalized ver.)");
  add("テイスティングノート", "Tasting Notes");
  add("楽しみ方", "楽しみ方");
  add("総合スコア", "Overall Score", "/5");
  add("味わい(すっきり↔しっかり)", "味わい：すっきり / しっかり", "/5");
  add("香り(甘い↔爽やか)", "香り：甘い、熟した / 青い、爽やかな", "/5");
  add("淹れ方", "How to Brew");

  const temp = extractText(p["How-to_Temp(℃)"]);
  const time = extractText(p["How-to_Time(Sec)"]);
  const water = extractText(p["How-to_Water(ml)"]);
  if (temp || time || water) {
    // 語り口（Phase 0 タスク5）: 「推奨」＝正解の提示に読めるため「目安」に置き換える。
    //   数値そのもの（Notion の温度・湯量・秒数）は変えない。ラベルだけを変える。
    parts.push(
      `淹れ方の目安: ${temp ? `${temp}℃` : ""} ${water ? `${water}ml` : ""} ${time ? `${time}秒` : ""}`.trim(),
    );
  }

  add("仕入先名", "Menu Name - Supplier");
  add("販売状況", "Status");

  return parts.join("\n");
}

const SYNC_CHANNELS = ["Roji", "LINE CRM"] as const;
type SyncChannel = (typeof SYNC_CHANNELS)[number];

function extractContentHubText(page: NotionPage, targetChannel: SyncChannel): string {
  const p = page.properties;
  const channel = extractText(p["Channel"]);
  if (channel !== targetChannel) return "";
  const status = extractText(p["Status"]);
  if (status !== "Published" && status !== "Ready") return "";

  const parts: string[] = [];
  const add = (label: string, key: string) => {
    const val = extractText(p[key]);
    if (val) parts.push(`${label}: ${val}`);
  };

  add("記事タイトル", "Title");
  add("ペルソナ", "content_persona");
  add("深度レベル", "depth_level");
  add("ターゲットレイヤー", "target_layer");

  if (targetChannel === "Roji") {
    add("イントロ", "🌐 Roji: Intro");
    add("本文", "🌐 Roji: Draft");
    add("概要", "🌐 Roji: Meta Description");
  }

  add("制作指示", "Brief");
  add("公開日", "Published Date");

  return parts.join("\n");
}

// -------------------------------------------------------------------
// Chunk Splitting
// -------------------------------------------------------------------

function splitIntoChunks(
  text: string,
  title: string,
  maxChars = 800,
): string[] {
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
// DB Configs
// -------------------------------------------------------------------

function getDBConfigs(env: Env): DBConfig[] {
  return [
    {
      envKey: "NOTION_PRODUCT_LIST_DB_ID",
      fallbackId: "238e2841-a6f1-4941-9653-5f61d5e1f25e",
      sourceType: "product",
      label: "Product List（商品タイプ）",
      extractText: extractProductListText,
    },
    {
      envKey: "NOTION_SET_MENU_DB_ID",
      fallbackId: "0c654752-cf81-4148-91e3-ced7de4b11e4",
      sourceType: "set_menu",
      label: "Set Menu List（セットメニュー）",
      extractText: extractSetMenuText,
    },
    {
      envKey: "NOTION_TEA_MENU_DB_ID",
      fallbackId: "ee367f6c-3ff3-4251-ad9e-0bc5a2cc7358",
      sourceType: "tea",
      label: "Tea Menu List（個別のお茶）",
      extractText: extractTeaMenuText,
    },
    {
      envKey: "NOTION_CONTENT_HUB_DB_ID",
      fallbackId: "16451cee-ec90-4dc0-92d9-85cca2842412",
      sourceType: "article",
      label: "Content Hub（roji 記事）",
      extractText: (page: NotionPage) => extractContentHubText(page, "Roji"),
    },
    {
      envKey: "NOTION_CONTENT_HUB_DB_ID",
      fallbackId: "16451cee-ec90-4dc0-92d9-85cca2842412",
      sourceType: "crm",
      label: "Content Hub（LINE CRM）",
      extractText: (page: NotionPage) => extractContentHubText(page, "LINE CRM"),
    },
  ];
}

// -------------------------------------------------------------------
// Slack 通知（FIX-2 / OPS-2: 失敗時のみ発報。成功の定常通知は廃止）
// -------------------------------------------------------------------

/**
 * 同期の「失敗」を Slack に通知する（呼び出し側で status !== "success" のときのみ呼ぶ）。
 * 成否を絵文字で表さず、見出しで「ナレッジ同期失敗」と明示する。
 */
async function notifySyncFailure(
  result: SyncResult,
  env: Env,
): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) return;

  const durationSec = (result.durationMs / 1000).toFixed(1);
  const label =
    result.status === "partial_failure"
      ? "ナレッジ同期 部分失敗"
      : "ナレッジ同期失敗";

  let text = `[${label}] status=${result.status} [${result.syncType}]\n`;
  text += `- ページ数: ${result.totalPages}\n`;
  text += `- 追加: ${result.addedChunks} / 更新: ${result.updatedChunks} / 削除: ${result.deletedChunks}\n`;
  text += `- 所要時間: ${durationSec}秒\n`;
  text += `- エラー: ${result.errorCount}件`;
  for (const err of result.errorDetails.slice(0, 5)) {
    text += `\n  - ${err.source}: ${err.error.slice(0, 150)}`;
  }

  await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}
