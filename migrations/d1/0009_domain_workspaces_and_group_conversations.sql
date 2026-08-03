-- Generic deployment-defined workspaces. Existing records safely remain in general.
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  display_order INTEGER NOT NULL DEFAULT 0
);

INSERT INTO domains (id, name, description, display_order)
VALUES ('general', 'General', 'Default workspace for legacy and cross-cutting coordination.', 0)
ON CONFLICT(id) DO NOTHING;

ALTER TABLE agent_identities ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'general';
ALTER TABLE forums ADD COLUMN domain_id TEXT NOT NULL DEFAULT 'general';

CREATE INDEX IF NOT EXISTS idx_agent_identities_domain ON agent_identities(domain_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_forums_domain ON forums(domain_id, name);

-- Rebuild the legacy pair table without its pair-uniqueness constraint. The
-- retained agent_a_id/agent_b_id fields preserve older clients; membership
-- below is authoritative for pairwise and group conversations alike.
CREATE TABLE direct_conversations_new (
  id TEXT PRIMARY KEY,
  agent_a_id TEXT NOT NULL REFERENCES agent_identities(id),
  agent_b_id TEXT NOT NULL REFERENCES agent_identities(id)
);

INSERT INTO direct_conversations_new (id, agent_a_id, agent_b_id)
SELECT id, agent_a_id, agent_b_id FROM direct_conversations;

CREATE TABLE direct_messages_backup AS
SELECT id, conversation_id, sender_agent_id, body, created_at FROM direct_messages;
CREATE TABLE direct_breakpoints_backup AS
SELECT conversation_id, agent_id, message_id, marked_at FROM direct_breakpoints;
CREATE TABLE direct_operator_messages_backup AS
SELECT id, conversation_id, sender_human_id, body, created_at FROM direct_operator_messages;
CREATE TABLE live_conversation_sessions_backup AS
SELECT id, conversation_id, status, topic, stop_command, created_by_human_id, created_at, stopped_at
FROM live_conversation_sessions;
CREATE TABLE live_conversation_receipts_backup AS
SELECT session_id, agent_id, state, note, last_seen_message_id, updated_at
FROM live_conversation_receipts;

DROP TABLE direct_breakpoints;
DROP TABLE direct_messages;
DROP TABLE direct_operator_messages;
DROP TABLE live_conversation_receipts;
DROP TABLE live_conversation_sessions;
DROP TABLE direct_conversations;

ALTER TABLE direct_conversations_new RENAME TO direct_conversations;

CREATE TABLE direct_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id),
  sender_agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE direct_breakpoints (
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id),
  agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  message_id TEXT NOT NULL REFERENCES direct_messages(id),
  marked_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, agent_id)
);

CREATE TABLE direct_operator_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id),
  sender_human_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE live_conversation_sessions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'waiting_on_peer', 'waiting_on_operator', 'settled_by_agent', 'operator_stop_needed', 'stopped')),
  topic TEXT NOT NULL,
  stop_command TEXT NOT NULL DEFAULT 'stop conversation',
  created_by_human_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  stopped_at TEXT
);

CREATE TABLE live_conversation_receipts (
  session_id TEXT NOT NULL REFERENCES live_conversation_sessions(id),
  agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  state TEXT NOT NULL CHECK (state IN ('active', 'waiting_on_peer', 'waiting_on_operator', 'settled_by_agent', 'operator_stop_needed')),
  note TEXT NOT NULL DEFAULT '',
  last_seen_message_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, agent_id)
);

INSERT INTO direct_messages (id, conversation_id, sender_agent_id, body, created_at)
SELECT id, conversation_id, sender_agent_id, body, created_at FROM direct_messages_backup;
INSERT INTO direct_breakpoints (conversation_id, agent_id, message_id, marked_at)
SELECT conversation_id, agent_id, message_id, marked_at FROM direct_breakpoints_backup;
INSERT INTO direct_operator_messages (id, conversation_id, sender_human_id, body, created_at)
SELECT id, conversation_id, sender_human_id, body, created_at FROM direct_operator_messages_backup;
INSERT INTO live_conversation_sessions
  (id, conversation_id, status, topic, stop_command, created_by_human_id, created_at, stopped_at)
SELECT id, conversation_id, status, topic, stop_command, created_by_human_id, created_at, stopped_at
FROM live_conversation_sessions_backup;
INSERT INTO live_conversation_receipts
  (session_id, agent_id, state, note, last_seen_message_id, updated_at)
SELECT session_id, agent_id, state, note, last_seen_message_id, updated_at
FROM live_conversation_receipts_backup;

DROP TABLE direct_messages_backup;
DROP TABLE direct_breakpoints_backup;
DROP TABLE direct_operator_messages_backup;
DROP TABLE live_conversation_sessions_backup;
DROP TABLE live_conversation_receipts_backup;

CREATE INDEX IF NOT EXISTS idx_direct_messages_conversation_created ON direct_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_direct_operator_messages_conversation_created ON direct_operator_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_live_conversation_sessions_conversation ON live_conversation_sessions(conversation_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_live_conversation_sessions_open_conversation
  ON live_conversation_sessions(conversation_id) WHERE status <> 'stopped';
CREATE INDEX IF NOT EXISTS idx_live_conversation_receipts_agent ON live_conversation_receipts(agent_id, state);

CREATE TABLE direct_conversation_participants (
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id),
  agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  PRIMARY KEY (conversation_id, agent_id)
);

INSERT OR IGNORE INTO direct_conversation_participants (conversation_id, agent_id)
SELECT id, agent_a_id FROM direct_conversations;
INSERT OR IGNORE INTO direct_conversation_participants (conversation_id, agent_id)
SELECT id, agent_b_id FROM direct_conversations;

CREATE INDEX IF NOT EXISTS idx_direct_conversation_participants_agent
  ON direct_conversation_participants(agent_id, conversation_id);
