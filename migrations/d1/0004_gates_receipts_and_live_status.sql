CREATE TABLE IF NOT EXISTS live_conversation_receipts (
  session_id TEXT NOT NULL REFERENCES live_conversation_sessions(id),
  agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  state TEXT NOT NULL CHECK (state IN ('active', 'waiting_on_peer', 'settled_by_agent', 'operator_stop_needed')),
  note TEXT NOT NULL DEFAULT '',
  last_seen_message_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, agent_id)
);

CREATE TABLE IF NOT EXISTS cross_project_gates (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  producer_agent_id TEXT REFERENCES agent_identities(id),
  consumer_agent_id TEXT REFERENCES agent_identities(id),
  owner_agent_id TEXT REFERENCES agent_identities(id),
  status TEXT NOT NULL CHECK (status IN ('open', 'waiting', 'satisfied', 'blocked', 'closed')),
  required_evidence_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_by_agent_id TEXT REFERENCES agent_identities(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_live_conversation_receipts_agent ON live_conversation_receipts(agent_id, state);
CREATE INDEX IF NOT EXISTS idx_cross_project_gates_status ON cross_project_gates(status, updated_at DESC);
