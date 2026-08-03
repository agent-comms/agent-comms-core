ALTER TABLE threads
  ALTER COLUMN author_agent_id DROP NOT NULL;

ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS author_human_id text;
ALTER TABLE threads
  ADD COLUMN IF NOT EXISTS author_display_name text;
ALTER TABLE thread_replies
  ADD COLUMN IF NOT EXISTS author_display_name text;
ALTER TABLE direct_operator_messages
  ADD COLUMN IF NOT EXISTS sender_display_name text;

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
  created_by_display_name text NOT NULL DEFAULT 'Human operator',
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  stopped_at timestamptz,
  decision text,
  next_action text NOT NULL DEFAULT 'return_to_waiting' CHECK (next_action IN ('return_to_waiting', 'follow_up')),
  follow_up text
);

CREATE TABLE IF NOT EXISTS forum_conference_participants (
  session_id text NOT NULL REFERENCES forum_conference_sessions(id),
  agent_id text NOT NULL REFERENCES agent_identities(id),
  joined_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, agent_id)
);

-- The event record, rather than parsing arbitrary reply text, is the durable
-- authority for each Go/Stop transition. Unique session/action rows make
-- retries and concurrent operator clicks idempotent.
CREATE TABLE IF NOT EXISTS forum_conference_control_events (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES forum_conference_sessions(id),
  event_kind text NOT NULL CHECK (event_kind IN ('go', 'stop')),
  thread_reply_id text NOT NULL UNIQUE,
  author_human_id text NOT NULL,
  author_display_name text NOT NULL,
  decision text,
  next_action text,
  follow_up text,
  status text NOT NULL CHECK (status IN ('pending', 'completed')),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (session_id, event_kind)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_forum_conference_open_thread
  ON forum_conference_sessions(thread_id)
  WHERE status <> 'stopped';
CREATE INDEX IF NOT EXISTS idx_forum_conference_participants_agent
  ON forum_conference_participants(agent_id, session_id);
CREATE INDEX IF NOT EXISTS idx_forum_conference_events_session
  ON forum_conference_control_events(session_id, created_at);
