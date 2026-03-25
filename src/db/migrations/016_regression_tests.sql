-- Regression Tests: stores high-quality probe results as regression test cases.
-- Score 4-5 probes are automatically saved here. Weekly regression runs
-- re-send these questions to CX Agent and verify quality is maintained.

CREATE TABLE regression_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question TEXT NOT NULL,
  expected_keywords TEXT[] NOT NULL,
  expected_min_score INT DEFAULT 4,
  persona TEXT NOT NULL,
  depth_level TEXT NOT NULL,
  source_probe_id uuid REFERENCES probe_history(id),
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_regression_tests_active ON regression_tests (active, created_at DESC);
