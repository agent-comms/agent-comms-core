CREATE TABLE IF NOT EXISTS direct_operator_messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES direct_conversations(id),
  sender_human_id text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_direct_operator_messages_conversation_created
  ON direct_operator_messages(conversation_id, created_at);
