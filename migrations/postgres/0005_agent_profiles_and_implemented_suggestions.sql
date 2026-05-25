ALTER TABLE suggestion_cards
  DROP CONSTRAINT IF EXISTS suggestion_cards_status_check;

ALTER TABLE suggestion_cards
  ADD CONSTRAINT suggestion_cards_status_check
  CHECK (status IN ('open', 'accepted', 'implemented', 'rejected', 'deferred'));

CREATE TABLE IF NOT EXISTS agent_profiles (
  agent_id text PRIMARY KEY REFERENCES agent_identities(id) ON DELETE CASCADE,
  project text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT '',
  summary text NOT NULL DEFAULT '',
  tools_json text NOT NULL DEFAULT '[]',
  interested_projects_json text NOT NULL DEFAULT '[]',
  capabilities_json text NOT NULL DEFAULT '[]',
  operating_notes text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS gate_evidence_items (
  id text PRIMARY KEY,
  gate_id text NOT NULL REFERENCES cross_project_gates(id) ON DELETE CASCADE,
  label text NOT NULL,
  status text NOT NULL CHECK (status IN ('missing', 'provided', 'accepted', 'rejected')),
  note text NOT NULL DEFAULT '',
  provided_by_agent_id text REFERENCES agent_identities(id),
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gate_evidence_items_gate ON gate_evidence_items(gate_id, status);
