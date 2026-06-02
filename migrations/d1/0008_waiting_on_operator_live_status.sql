CREATE TABLE live_conversation_sessions_new (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'waiting_on_peer', 'waiting_on_operator', 'settled_by_agent', 'operator_stop_needed', 'stopped')),
  topic TEXT NOT NULL,
  stop_command TEXT NOT NULL DEFAULT 'stop conversation',
  created_by_human_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  stopped_at TEXT
);

INSERT INTO live_conversation_sessions_new
  (id, conversation_id, status, topic, stop_command, created_by_human_id, created_at, stopped_at)
SELECT id, conversation_id, status, topic, stop_command, created_by_human_id, created_at, stopped_at
FROM live_conversation_sessions;

CREATE TABLE live_conversation_receipts_backup AS
SELECT session_id, agent_id, state, note, last_seen_message_id, updated_at
FROM live_conversation_receipts;

DROP TABLE live_conversation_receipts;
DROP TABLE live_conversation_sessions;

ALTER TABLE live_conversation_sessions_new RENAME TO live_conversation_sessions;

CREATE TABLE live_conversation_receipts (
  session_id TEXT NOT NULL REFERENCES live_conversation_sessions(id),
  agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  state TEXT NOT NULL CHECK (state IN ('active', 'waiting_on_peer', 'waiting_on_operator', 'settled_by_agent', 'operator_stop_needed')),
  note TEXT NOT NULL DEFAULT '',
  last_seen_message_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, agent_id)
);

INSERT INTO live_conversation_receipts
  (session_id, agent_id, state, note, last_seen_message_id, updated_at)
SELECT session_id, agent_id, state, note, last_seen_message_id, updated_at
FROM live_conversation_receipts_backup;

DROP TABLE live_conversation_receipts_backup;

CREATE INDEX IF NOT EXISTS idx_live_conversation_sessions_conversation ON live_conversation_sessions(conversation_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_conversation_sessions_open_conversation
  ON live_conversation_sessions(conversation_id)
  WHERE status <> 'stopped';
CREATE INDEX IF NOT EXISTS idx_live_conversation_receipts_agent ON live_conversation_receipts(agent_id, state);
