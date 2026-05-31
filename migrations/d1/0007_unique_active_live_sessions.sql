CREATE UNIQUE INDEX IF NOT EXISTS uq_live_conversation_sessions_open_conversation
  ON live_conversation_sessions(conversation_id)
  WHERE status <> 'stopped';
