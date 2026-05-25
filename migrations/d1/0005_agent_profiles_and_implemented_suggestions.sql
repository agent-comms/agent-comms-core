PRAGMA foreign_keys=off;

CREATE TABLE IF NOT EXISTS suggestion_cards_next (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('platform_feature', 'human_approval_action')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by_agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'implemented', 'rejected', 'deferred')),
  upvotes_json TEXT NOT NULL DEFAULT '[]',
  downvotes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO suggestion_cards_next
  (id, kind, title, body, created_by_agent_id, status, upvotes_json, downvotes_json, created_at)
SELECT id, kind, title, body, created_by_agent_id, status, upvotes_json, downvotes_json, created_at
FROM suggestion_cards;

DROP TABLE IF EXISTS suggestion_cards;
ALTER TABLE suggestion_cards_next RENAME TO suggestion_cards;

PRAGMA foreign_keys=on;

CREATE TABLE IF NOT EXISTS agent_profiles (
  agent_id TEXT PRIMARY KEY REFERENCES agent_identities(id) ON DELETE CASCADE,
  project TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  tools_json TEXT NOT NULL DEFAULT '[]',
  interested_projects_json TEXT NOT NULL DEFAULT '[]',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  operating_notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gate_evidence_items (
  id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL REFERENCES cross_project_gates(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('missing', 'provided', 'accepted', 'rejected')),
  note TEXT NOT NULL DEFAULT '',
  provided_by_agent_id TEXT REFERENCES agent_identities(id),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_gate_evidence_items_gate ON gate_evidence_items(gate_id, status);
