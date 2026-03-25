/**
 * Content Hub Writer -- Writes generated articles to Notion Content Hub DB
 *
 * Creates pages in the Content Hub database with:
 * - Status: Draft (human review required before knowledge sync)
 * - Channel: LINE CRM
 * - Proper persona/depth/target_layer tags
 * - Brief with traceability info
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GeneratedArticle, ContentHubWriteResult } from "./types";

/** Content Hub DB ID (from Spec) */
const CONTENT_HUB_DB_ID = "16451cee-ec90-4dc0-92d9-85cca2842412";

type NotionCreateResponse = {
  id: string;
  url: string;
};

/**
 * Write a generated article to the Content Hub DB via Notion API.
 *
 * The article is created with Status: Draft so it won't be picked up
 * by knowledge.ts sync until a human reviews and sets it to Ready.
 */
export async function writeToContentHub(
  notionToken: string,
  article: GeneratedArticle,
  question: string,
  dbId: string = CONTENT_HUB_DB_ID,
): Promise<ContentHubWriteResult> {
  const brief = `Knowledge Prober 自動生成。元質問: ${question}`;

  // Build Notion page properties
  const properties: Record<string, unknown> = {
    Title: {
      title: [{ text: { content: article.title } }],
    },
    Status: {
      status: { name: "Draft" },
    },
    Channel: {
      select: { name: article.channel },
    },
    content_persona: {
      multi_select: article.content_persona.map((p) => ({ name: p })),
    },
    depth_level: {
      select: { name: article.depth_level },
    },
    target_layer: {
      multi_select: article.target_layer.map((t) => ({ name: t })),
    },
    Brief: {
      rich_text: [{ text: { content: brief } }],
    },
  };

  // Build page content (article body as paragraph blocks)
  const children = buildContentBlocks(article.content);

  const body = {
    parent: { database_id: dbId },
    properties,
    children,
  };

  const res = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "unknown");
    throw new Error(`Notion API error ${res.status}: ${errBody}`);
  }

  const data = (await res.json()) as NotionCreateResponse;

  return {
    pageId: data.id,
    title: article.title,
    url: data.url,
  };
}

/**
 * Update probe_history record after successful article generation.
 */
export async function markArticleGenerated(
  supabase: SupabaseClient,
  probeHistoryId: string,
  contentHubPageId: string,
): Promise<void> {
  const { error } = await supabase
    .from("probe_history")
    .update({
      article_generated: true,
      content_hub_page_id: contentHubPageId,
    })
    .eq("id", probeHistoryId);

  if (error) {
    console.error(
      "[content-hub] Failed to update probe_history:",
      error,
    );
  }
}

/**
 * Convert article text content into Notion block children.
 * Splits on double newlines into paragraphs.
 */
function buildContentBlocks(
  content: string,
): Array<Record<string, unknown>> {
  const paragraphs = content
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);

  return paragraphs.map((text) => ({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { content: text },
        },
      ],
    },
  }));
}
