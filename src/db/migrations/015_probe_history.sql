-- Knowledge Prober: probe_history table
-- Stores AI persona questions, CX Agent responses, and quality evaluations.

CREATE TABLE probe_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  persona TEXT NOT NULL,
  depth_level TEXT NOT NULL,
  question TEXT NOT NULL,
  response TEXT,
  quality_score INT CHECK (quality_score BETWEEN 1 AND 5),
  evaluation_notes TEXT,
  gap_category TEXT,
  article_generated BOOLEAN DEFAULT FALSE,
  content_hub_page_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_probe_history_persona ON probe_history (persona, depth_level, created_at DESC);
CREATE INDEX idx_probe_history_gap ON probe_history (gap_category, quality_score);
