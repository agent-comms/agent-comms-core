ALTER TABLE agent_identities
  ADD COLUMN IF NOT EXISTS onboarding_auth_hash text,
  ADD COLUMN IF NOT EXISTS onboarding_auth_status text NOT NULL DEFAULT 'missing',
  ADD COLUMN IF NOT EXISTS onboarding_auth_length integer,
  ADD COLUMN IF NOT EXISTS onboarding_auth_checked_at timestamptz;

ALTER TABLE agent_identities
  DROP CONSTRAINT IF EXISTS agent_identities_onboarding_auth_status_check;

ALTER TABLE agent_identities
  ADD CONSTRAINT agent_identities_onboarding_auth_status_check
  CHECK (onboarding_auth_status IN ('missing', 'format_mismatch', 'invalid', 'verified'));

CREATE INDEX IF NOT EXISTS idx_agent_identities_onboarding_auth_status
  ON agent_identities(status, onboarding_auth_status, requested_at DESC);
