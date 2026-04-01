-- 017: Enable Row Level Security on all tables
-- Security fix: Block anon/authenticated key access via RLS.
-- The app uses service_role_key which bypasses RLS, so no policies needed.
-- Without policies, RLS defaults to deny-all for non-service-role connections.

-- schema.sql tables
ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE unanswered_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_identity_map ENABLE ROW LEVEL SECURITY;

-- Migration-created tables
ALTER TABLE message_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasting_note_survey ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_daily_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE probe_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE regression_tests ENABLE ROW LEVEL SECURITY;

-- Note: customer_linkages, sync_logs, pending_follow_refs do not exist
-- in the current database (migrations 002/014 were not applied or tables were dropped).
