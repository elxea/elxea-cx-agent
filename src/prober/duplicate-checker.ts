/**
 * Duplicate Checker -- Prevents redundant article generation
 *
 * Three-layer duplicate check:
 * 1. probe_history: Same gap_category with article generated in last 7 days
 * 2. Title similarity: Claude Haiku judges if title is semantically similar to existing Content Hub articles
 * 3. Daily limit: Max 3 articles per day
 */

import Anthropic from "@anthropic-ai/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type GapCategory,
  DUPLICATE_CHECK_DAYS,
  MAX_DAILY_ARTICLES,
  SKIP_GAP_CATEGORIES,
} from "./types";

export type DuplicateCheckResult = {
  shouldSkip: boolean;
  reason: string | null;
};

/**
 * Run all duplicate/skip checks before generating an article.
 */
export async function checkDuplicates(
  client: Anthropic,
  supabase: SupabaseClient,
  gapCategory: GapCategory,
  proposedTitle: string | null,
  notionToken: string,
  contentHubDbId: string,
  articlesGeneratedToday: number,
): Promise<DuplicateCheckResult> {
  // Check 0: Skip non-content gap categories
  if (SKIP_GAP_CATEGORIES.includes(gapCategory)) {
    return {
      shouldSkip: true,
      reason: `Gap category "${gapCategory}" is not addressable by content`,
    };
  }

  // Check 1: Daily article limit
  if (articlesGeneratedToday >= MAX_DAILY_ARTICLES) {
    return {
      shouldSkip: true,
      reason: `Daily article limit reached (${MAX_DAILY_ARTICLES})`,
    };
  }

  // Check 2: Same gap_category article generated recently
  const recentCheck = await checkRecentArticleForCategory(
    supabase,
    gapCategory,
  );
  if (recentCheck.shouldSkip) return recentCheck;

  // Check 3: Title similarity (only if we have a proposed title)
  if (proposedTitle) {
    const titleCheck = await checkTitleSimilarity(
      client,
      proposedTitle,
      notionToken,
      contentHubDbId,
    );
    if (titleCheck.shouldSkip) return titleCheck;
  }

  return { shouldSkip: false, reason: null };
}

/**
 * Check if an article was recently generated for the same gap category.
 */
async function checkRecentArticleForCategory(
  supabase: SupabaseClient,
  gapCategory: GapCategory,
): Promise<DuplicateCheckResult> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DUPLICATE_CHECK_DAYS);

  const { data, error } = await supabase
    .from("probe_history")
    .select("id, created_at")
    .eq("gap_category", gapCategory)
    .eq("article_generated", true)
    .gte("created_at", cutoffDate.toISOString())
    .limit(1);

  if (error) {
    console.error("[dup-check] Failed to check recent articles:", error);
    // Don't block on DB errors -- allow article generation
    return { shouldSkip: false, reason: null };
  }

  if (data && data.length > 0) {
    return {
      shouldSkip: true,
      reason: `Article already generated for "${gapCategory}" within ${DUPLICATE_CHECK_DAYS} days (probe ${data[0].id})`,
    };
  }

  return { shouldSkip: false, reason: null };
}

/**
 * Check if the proposed title is semantically similar to existing Content Hub articles.
 * Uses Claude Haiku for fast similarity judgment.
 */
async function checkTitleSimilarity(
  client: Anthropic,
  proposedTitle: string,
  notionToken: string,
  contentHubDbId: string,
): Promise<DuplicateCheckResult> {
  // Fetch existing article titles from Content Hub (LINE CRM channel)
  const existingTitles = await fetchContentHubTitles(
    notionToken,
    contentHubDbId,
  );

  if (existingTitles.length === 0) {
    return { shouldSkip: false, reason: null };
  }

  const titleList = existingTitles
    .map((t, i) => `${i + 1}. ${t}`)
    .join("\n");

  const prompt = `以下の「提案タイトル」が、既存の記事タイトルリストのいずれかと意味的に重複しているか判定してください。

[提案タイトル]
${proposedTitle}

[既存の記事タイトル]
${titleList}

同じトピックを扱っていて、新しい記事を追加する価値がない場合は true、異なるトピックなら false を返してください。

JSON のみ出力してください:
{"is_duplicate": true/false, "similar_to": "類似している既存タイトル（該当なしならnull）"}`;

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return { shouldSkip: false, reason: null };
    }

    let jsonStr = textBlock.text.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    const parsed = JSON.parse(jsonStr) as {
      is_duplicate: boolean;
      similar_to: string | null;
    };

    if (parsed.is_duplicate) {
      return {
        shouldSkip: true,
        reason: `Title "${proposedTitle}" is similar to existing: "${parsed.similar_to}"`,
      };
    }
  } catch (err) {
    console.warn(
      "[dup-check] Title similarity check failed, proceeding:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return { shouldSkip: false, reason: null };
}

/**
 * Fetch existing Content Hub article titles (LINE CRM channel).
 * Uses Notion API directly.
 */
async function fetchContentHubTitles(
  notionToken: string,
  dbId: string,
): Promise<string[]> {
  try {
    const res = await fetch(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          filter: {
            property: "Channel",
            select: { equals: "LINE CRM" },
          },
          sorts: [
            { timestamp: "created_time", direction: "descending" },
          ],
          page_size: 50,
        }),
      },
    );

    if (!res.ok) {
      console.error(
        "[dup-check] Failed to fetch Content Hub titles:",
        res.status,
      );
      return [];
    }

    type NotionQueryResult = {
      results: Array<{
        properties: {
          Title: {
            title: Array<{ plain_text: string }>;
          };
        };
      }>;
    };

    const data = (await res.json()) as NotionQueryResult;
    return data.results
      .map((page) => {
        const titleProp = page.properties?.Title;
        if (titleProp?.title?.[0]?.plain_text) {
          return titleProp.title[0].plain_text;
        }
        return "";
      })
      .filter(Boolean);
  } catch (err) {
    console.error(
      "[dup-check] Error fetching Content Hub titles:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}
