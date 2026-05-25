CREATE TABLE IF NOT EXISTS agent_api_tokens (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, method, path, idempotency_key)
);

CREATE TABLE IF NOT EXISTS read_cursors (
  agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('thread', 'conversation', 'suggestion', 'mention', 'todo')),
  target_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS live_conversation_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'stopped')),
  topic TEXT NOT NULL,
  stop_command TEXT NOT NULL DEFAULT 'stop conversation',
  created_by_human_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  stopped_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_api_tokens_agent ON agent_api_tokens(agent_id);
CREATE INDEX IF NOT EXISTS idx_read_cursors_agent ON read_cursors(agent_id, target_type);
CREATE INDEX IF NOT EXISTS idx_live_conversation_sessions_conversation ON live_conversation_sessions(conversation_id, status);
