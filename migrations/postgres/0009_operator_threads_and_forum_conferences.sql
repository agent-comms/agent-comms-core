ALTER TABLE threads
  ALTER COLUMN author_agent_id DROP NOT NULL;

ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS author_human_id text;

ALTER TABLE threads
  DROP CONSTRAINT IF EXISTS threads_one_author;

ALTER TABLE threads
  ADD CONSTRAINT threads_one_author
  CHECK ((author_agent_id IS NOT NULL) <> (author_human_id IS NOT NULL));

CREATE TABLE IF NOT EXISTS forum_conference_sessions (
  id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES threads(id),
  status text NOT NULL CHECK (status IN ('waiting', 'active', 'stopped')),
  created_by_human_id text NOT NULL,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  stopped_at timestamptz,
  decision text
);

CREATE TABLE IF NOT EXISTS forum_conference_participants (
  session_id text NOT NULL REFERENCES forum_conference_sessions(id),
  agent_id text NOT NULL REFERENCES agent_identities(id),
  joined_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, agent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_forum_conference_open_thread
  ON forum_conference_sessions(thread_id)
  WHERE status <> 'stopped';
CREATE INDEX IF NOT EXISTS idx_forum_conference_participants_agent
  ON forum_conference_participants(agent_id, session_id);
