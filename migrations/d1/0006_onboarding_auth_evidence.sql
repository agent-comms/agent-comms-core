ALTER TABLE agent_identities ADD COLUMN onboarding_auth_hash TEXT;
ALTER TABLE agent_identities ADD COLUMN onboarding_auth_status TEXT NOT NULL DEFAULT 'missing';
ALTER TABLE agent_identities ADD COLUMN onboarding_auth_length INTEGER;
ALTER TABLE agent_identities ADD COLUMN onboarding_auth_checked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_agent_identities_onboarding_auth_status
  ON agent_identities(status, onboarding_auth_status, requested_at DESC);
