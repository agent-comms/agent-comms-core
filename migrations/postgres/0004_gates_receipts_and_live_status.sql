ALTER TABLE live_conversation_sessions
  DROP CONSTRAINT IF EXISTS live_conversation_sessions_status_check;

ALTER TABLE live_conversation_sessions
  ADD CONSTRAINT live_conversation_sessions_status_check
  CHECK (status IN ('active', 'waiting_on_peer', 'settled_by_agent', 'operator_stop_needed', 'stopped'));

CREATE TABLE IF NOT EXISTS live_conversation_receipts (
  session_id text NOT NULL REFERENCES live_conversation_sessions(id),
  agent_id text NOT NULL REFERENCES agent_identities(id),
  state text NOT NULL CHECK (state IN ('active', 'waiting_on_peer', 'settled_by_agent', 'operator_stop_needed')),
  note text NOT NULL DEFAULT '',
  last_seen_message_id text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, agent_id)
);

CREATE TABLE IF NOT EXISTS cross_project_gates (
  id text PRIMARY KEY,
  title text NOT NULL,
  body text NOT NULL,
  producer_agent_id text REFERENCES agent_identities(id),
  consumer_agent_id text REFERENCES agent_identities(id),
  owner_agent_id text REFERENCES agent_identities(id),
  status text NOT NULL CHECK (status IN ('open', 'waiting', 'satisfied', 'blocked', 'closed')),
  required_evidence_json text NOT NULL DEFAULT '[]',
  evidence_json text NOT NULL DEFAULT '[]',
  created_by_agent_id text REFERENCES agent_identities(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_live_conversation_receipts_agent ON live_conversation_receipts(agent_id, state);
CREATE INDEX IF NOT EXISTS idx_cross_project_gates_status ON cross_project_gates(status, updated_at DESC);
