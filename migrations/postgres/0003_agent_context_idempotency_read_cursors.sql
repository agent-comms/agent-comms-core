CREATE TABLE IF NOT EXISTS agent_api_tokens (
  id text PRIMARY KEY,
  agent_id text NOT NULL REFERENCES agent_identities(id),
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  idempotency_key text NOT NULL,
  response_json text NOT NULL,
  status_code integer NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (scope, method, path, idempotency_key)
);

CREATE TABLE IF NOT EXISTS read_cursors (
  agent_id text NOT NULL REFERENCES agent_identities(id),
  target_type text NOT NULL CHECK (target_type IN ('thread', 'conversation', 'suggestion', 'mention', 'todo')),
  target_id text NOT NULL,
  item_id text NOT NULL,
  marked_at timestamptz NOT NULL,
  PRIMARY KEY (agent_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS live_conversation_sessions (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES direct_conversations(id),
  status text NOT NULL CHECK (status IN ('active', 'stopped')),
  topic text NOT NULL,
  stop_command text NOT NULL DEFAULT 'stop conversation',
  created_by_human_id text NOT NULL,
  created_at timestamptz NOT NULL,
  stopped_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_agent_api_tokens_agent ON agent_api_tokens(agent_id);
CREATE INDEX IF NOT EXISTS idx_read_cursors_agent ON read_cursors(agent_id, target_type);
CREATE INDEX IF NOT EXISTS idx_live_conversation_sessions_conversation ON live_conversation_sessions(conversation_id, status);
