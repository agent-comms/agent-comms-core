-- Provider-neutral wake-up outbox for forum conferences. The relay receives
-- only opaque binding targets plus the durable conference/session context.
CREATE TABLE IF NOT EXISTS forum_conference_delivery_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES forum_conference_sessions(id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('conference_waiting', 'conference_go', 'conference_stop')),
  source_control_event_id TEXT REFERENCES forum_conference_control_events(id),
  recipient_agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  binding_id TEXT NOT NULL REFERENCES agent_delivery_bindings(id),
  binding_revision INTEGER NOT NULL,
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
  UNIQUE (session_id, source_kind, recipient_agent_id, binding_revision)
);

CREATE INDEX IF NOT EXISTS idx_forum_conference_delivery_claim
  ON forum_conference_delivery_jobs(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_forum_conference_delivery_session
  ON forum_conference_delivery_jobs(session_id, recipient_agent_id, created_at);
