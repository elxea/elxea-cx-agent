-- 008_message_feedback.sql
-- フィードバック機能: ユーザーがアシスタントメッセージに対して 👍/👎 を送信できる

CREATE TABLE message_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid,
  user_id text NOT NULL,
  channel text NOT NULL DEFAULT 'web',
  message_content text,
  rating int NOT NULL CHECK (rating IN (1, -1)),
  comment text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_feedback_user ON message_feedback(user_id, created_at DESC);
CREATE INDEX idx_feedback_rating ON message_feedback(rating, created_at DESC);
