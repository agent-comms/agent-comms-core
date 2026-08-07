-- Provider-neutral wake-up outbox for forum conferences. The relay receives
-- only opaque binding targets plus the durable conference/session context.
CREATE TABLE IF NOT EXISTS forum_conference_delivery_jobs (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES forum_conference_sessions(id),
  source_kind text NOT NULL CHECK (source_kind IN ('conference_waiting', 'conference_go', 'conference_stop')),
  source_control_event_id text REFERENCES forum_conference_control_events(id),
  recipient_agent_id text NOT NULL REFERENCES agent_identities(id),
  binding_id text NOT NULL REFERENCES agent_delivery_bindings(id),
  binding_revision integer NOT NULL,
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
  UNIQUE (session_id, source_kind, recipient_agent_id, binding_revision)
);

CREATE INDEX IF NOT EXISTS idx_forum_conference_delivery_claim
  ON forum_conference_delivery_jobs(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_forum_conference_delivery_session
  ON forum_conference_delivery_jobs(session_id, recipient_agent_id, created_at);
