CREATE TABLE IF NOT EXISTS direct_operator_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id),
  sender_human_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_direct_operator_messages_conversation_created
  ON direct_operator_messages(conversation_id, created_at);
