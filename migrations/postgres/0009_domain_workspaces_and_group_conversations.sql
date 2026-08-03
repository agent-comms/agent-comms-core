-- Generic deployment-defined workspaces. Existing records safely remain in general.
CREATE TABLE IF NOT EXISTS domains (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  display_order integer NOT NULL DEFAULT 0
);

INSERT INTO domains (id, name, description, display_order)
VALUES ('general', 'General', 'Default workspace for legacy and cross-cutting coordination.', 0)
ON CONFLICT(id) DO NOTHING;

ALTER TABLE agent_identities
  ADD COLUMN IF NOT EXISTS domain_id text NOT NULL DEFAULT 'general' REFERENCES domains(id);
ALTER TABLE forums
  ADD COLUMN IF NOT EXISTS domain_id text NOT NULL DEFAULT 'general' REFERENCES domains(id);

CREATE INDEX IF NOT EXISTS idx_agent_identities_domain ON agent_identities(domain_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_forums_domain ON forums(domain_id, name);

-- Keep the legacy pair columns for compatibility while making membership explicit.
ALTER TABLE direct_conversations
  DROP CONSTRAINT IF EXISTS direct_conversations_agent_a_id_agent_b_id_key;

CREATE TABLE IF NOT EXISTS direct_conversation_participants (
  conversation_id text NOT NULL REFERENCES direct_conversations(id),
  agent_id text NOT NULL REFERENCES agent_identities(id),
  PRIMARY KEY (conversation_id, agent_id)
);

INSERT INTO direct_conversation_participants (conversation_id, agent_id)
SELECT id, agent_a_id FROM direct_conversations
ON CONFLICT(conversation_id, agent_id) DO NOTHING;

INSERT INTO direct_conversation_participants (conversation_id, agent_id)
SELECT id, agent_b_id FROM direct_conversations
ON CONFLICT(conversation_id, agent_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_direct_conversation_participants_agent
  ON direct_conversation_participants(agent_id, conversation_id);
