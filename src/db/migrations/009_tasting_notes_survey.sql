-- 009_tasting_notes_survey.sql
-- Tasting Note survey table for beta test feedback collection.
-- Stores per-session survey responses (CSAT, NPS, qualitative feedback).

CREATE TABLE IF NOT EXISTS tasting_note_survey (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text,
  user_id text,
  csat int CHECK (csat BETWEEN 1 AND 5),
  would_use_again text,
  best_aspects text[],
  improvement_suggestion text,
  nps int CHECK (nps BETWEEN 0 AND 10),
  round int DEFAULT 1,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_survey_round ON tasting_note_survey(round, created_at DESC);

-- Enable RLS (service role key bypasses RLS, so inserts from cx-agent still work)
ALTER TABLE tasting_note_survey ENABLE ROW LEVEL SECURITY;

-- Allow insert from authenticated or anon (the cx-agent uses service role key)
CREATE POLICY "Allow insert from service"
  ON tasting_note_survey
  FOR INSERT
  WITH CHECK (true);

-- Read access only via service role (no public reads)
CREATE POLICY "Service role read"
  ON tasting_note_survey
  FOR SELECT
  USING (false);
