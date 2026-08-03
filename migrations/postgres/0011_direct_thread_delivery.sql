-- Provider-neutral direct-thread delivery. A binding target is opaque and is
-- exposed only through the independently authenticated relay claim endpoint.
ALTER TABLE direct_conversations
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'open'
  CHECK (status IN ('open', 'closed'));
ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS closed_by_kind text
  CHECK (closed_by_kind IN ('agent', 'human'));
ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS closed_by_id text;
ALTER TABLE direct_conversations ADD COLUMN IF NOT EXISTS close_resolution text;

CREATE TABLE IF NOT EXISTS agent_delivery_bindings (
  id text PRIMARY KEY,
  agent_id text NOT NULL UNIQUE REFERENCES agent_identities(id),
  adapter_key text NOT NULL,
  target_ref text NOT NULL,
  display_label text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  activated_at timestamptz,
  disabled_at timestamptz
);

CREATE TABLE IF NOT EXISTS direct_delivery_events (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES direct_conversations(id),
  source_kind text NOT NULL CHECK (source_kind IN ('direct_message', 'group_invitation', 'conversation_closed')),
  source_message_id text,
  actor_kind text NOT NULL CHECK (actor_kind IN ('agent', 'human')),
  actor_id text NOT NULL,
  actor_display_name text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  UNIQUE (source_kind, source_message_id)
);

CREATE TABLE IF NOT EXISTS direct_delivery_jobs (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES direct_delivery_events(id),
  conversation_id text NOT NULL REFERENCES direct_conversations(id),
  recipient_agent_id text NOT NULL REFERENCES agent_identities(id),
  binding_id text NOT NULL REFERENCES agent_delivery_bindings(id),
  binding_revision integer NOT NULL,
  sequence_number integer NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'leased', 'delivered', 'deferred_busy', 'retry', 'uncertain_after_start', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  lease_owner text,
  lease_token_hash text,
  lease_expires_at timestamptz,
  started_at timestamptz,
  recipient_acknowledged_at timestamptz,
  completed_at timestamptz,
  result_code text,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (event_id, recipient_agent_id, binding_revision),
  UNIQUE (conversation_id, recipient_agent_id, sequence_number)
);

CREATE TABLE IF NOT EXISTS direct_conversation_control_events (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES direct_conversations(id),
  event_kind text NOT NULL CHECK (event_kind IN ('close')),
  actor_kind text NOT NULL CHECK (actor_kind IN ('agent', 'human')),
  actor_id text NOT NULL,
  resolution text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL,
  UNIQUE (conversation_id, event_kind)
);

CREATE TABLE IF NOT EXISTS direct_group_invitations (
  id text PRIMARY KEY,
  conversation_id text NOT NULL UNIQUE REFERENCES direct_conversations(id),
  created_by_human_id text NOT NULL,
  topic text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('active', 'closed')),
  created_at timestamptz NOT NULL,
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS direct_group_participant_states (
  invitation_id text NOT NULL REFERENCES direct_group_invitations(id),
  agent_id text NOT NULL REFERENCES agent_identities(id),
  state text NOT NULL CHECK (state IN ('invited', 'watching', 'left', 'closed')),
  watch_lease_expires_at timestamptz,
  last_heartbeat_at timestamptz,
  left_at timestamptz,
  updated_at timestamptz NOT NULL,
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
