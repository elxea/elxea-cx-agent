/**
 * Survey Route -- POST /api/survey
 *
 * Tasting Note survey responses from the web app.
 * Validates input and inserts into Supabase tasting_note_survey table.
 */
import type { Context } from "hono";
import type { Env } from "../index";
import { createSupabaseClient } from "../lib/supabase";
import { requireSyncApiKey } from "../lib/sync-auth";

const VALID_WOULD_USE_AGAIN = ["yes", "not_sure"];
const VALID_BEST_ASPECTS = [
  "recommendation_accuracy",
  "tea_knowledge",
  "pleasant_conversation",
  "easy_discovery",
  "other",
];

export async function surveyHandler(c: Context<{ Bindings: Env }>) {
  // C: Verify shared secret (SYNC_API_SECRET) via X-API-Key header（fail-closed）。
  // survey は elxea-web-app の Next.js API proxy（サーバ間）経由でのみ呼ばれる。
  // ブラウザ → /api/survey(Next proxy) → cx-agent /api/survey。proxy が X-API-Key を付与する。
  const unauthorized = requireSyncApiKey(c);
  if (unauthorized) return unauthorized;

  try {
    const body = await c.req.json<{
      session_id?: string;
      user_id?: string;
      csat: number;
      would_use_again: string;
      best_aspects: string[];
      improvement_suggestion?: string | null;
      nps: number;
      round?: number;
    }>();

    // Validate required fields
    if (typeof body.csat !== "number" || body.csat < 1 || body.csat > 5) {
      return c.json({ error: "csat must be between 1 and 5" }, 400);
    }

    if (!VALID_WOULD_USE_AGAIN.includes(body.would_use_again)) {
      return c.json({ error: "invalid would_use_again value" }, 400);
    }

    if (!Array.isArray(body.best_aspects) || body.best_aspects.length === 0) {
      return c.json({ error: "best_aspects must be a non-empty array" }, 400);
    }

    for (const aspect of body.best_aspects) {
      if (!VALID_BEST_ASPECTS.includes(aspect)) {
        return c.json({ error: `invalid best_aspect: ${aspect}` }, 400);
      }
    }

    if (typeof body.nps !== "number" || body.nps < 0 || body.nps > 10) {
      return c.json({ error: "nps must be between 0 and 10" }, 400);
    }

    const round = body.round ?? 1;
    if (typeof round !== "number" || round < 1) {
      return c.json({ error: "round must be a positive integer" }, 400);
    }

    const supabase = createSupabaseClient(c.env);

    const { data, error } = await supabase
      .from("tasting_note_survey")
      .insert({
        session_id: body.session_id || null,
        user_id: body.user_id || null,
        csat: body.csat,
        would_use_again: body.would_use_again,
        best_aspects: body.best_aspects,
        improvement_suggestion: body.improvement_suggestion || null,
        nps: body.nps,
        round,
      })
      .select("id")
      .single();

    if (error) {
      console.error("Survey insert error:", error);
      return c.json({ error: "Failed to save survey response" }, 500);
    }

    return c.json({ status: "ok", id: data.id });
  } catch (err) {
    console.error("Survey handler error:", err);
    return c.json({ error: "Internal server error" }, 500);
  }
}
