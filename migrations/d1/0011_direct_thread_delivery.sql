-- Provider-neutral direct-thread delivery.  A binding is opaque to ordinary
-- agents and operators; only an independently authenticated relay can see
-- its target reference while claiming a job.
ALTER TABLE direct_conversations ADD COLUMN status TEXT NOT NULL DEFAULT 'open'
  CHECK (status IN ('open', 'closed'));
ALTER TABLE direct_conversations ADD COLUMN closed_at TEXT;
ALTER TABLE direct_conversations ADD COLUMN closed_by_kind TEXT
  CHECK (closed_by_kind IN ('agent', 'human'));
ALTER TABLE direct_conversations ADD COLUMN closed_by_id TEXT;
ALTER TABLE direct_conversations ADD COLUMN close_resolution TEXT;

CREATE TABLE IF NOT EXISTS agent_delivery_bindings (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL UNIQUE REFERENCES agent_identities(id),
  adapter_key TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  display_label TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  activated_at TEXT,
  disabled_at TEXT
);

CREATE TABLE IF NOT EXISTS direct_delivery_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('direct_message', 'group_invitation', 'conversation_closed')),
  source_message_id TEXT,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent', 'human')),
  actor_id TEXT NOT NULL,
  actor_display_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (source_kind, source_message_id)
);

CREATE TABLE IF NOT EXISTS direct_delivery_jobs (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES direct_delivery_events(id),
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id),
  recipient_agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  binding_id TEXT NOT NULL REFERENCES agent_delivery_bindings(id),
  binding_revision INTEGER NOT NULL,
  sequence_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'delivered', 'deferred_busy', 'retry', 'uncertain_after_start', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_owner TEXT,
  lease_token_hash TEXT,
  lease_expires_at TEXT,
  started_at TEXT,
  recipient_acknowledged_at TEXT,
  completed_at TEXT,
  result_code TEXT,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (event_id, recipient_agent_id, binding_revision),
  UNIQUE (conversation_id, recipient_agent_id, sequence_number)
);

CREATE TABLE IF NOT EXISTS direct_conversation_control_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('close')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('agent', 'human')),
  actor_id TEXT NOT NULL,
  resolution TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, event_kind)
);

CREATE TABLE IF NOT EXISTS direct_group_invitations (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL UNIQUE REFERENCES direct_conversations(id),
  created_by_human_id TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS direct_group_participant_states (
  invitation_id TEXT NOT NULL REFERENCES direct_group_invitations(id),
  agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  state TEXT NOT NULL CHECK (state IN ('invited', 'watching', 'left', 'closed')),
  watch_lease_expires_at TEXT,
  last_heartbeat_at TEXT,
  left_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (invitation_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_bindings_agent_status
  ON agent_delivery_bindings(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_claim
  ON direct_delivery_jobs(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_jobs_recipient_sequence
  ON direct_delivery_jobs(conversation_id, recipient_agent_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_delivery_events_conversation
  ON direct_delivery_events(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_direct_group_participant_states_agent
  ON direct_group_participant_states(agent_id, state, watch_lease_expires_at);
