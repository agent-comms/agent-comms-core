PRAGMA foreign_keys=OFF;

CREATE TABLE threads_new (
  id TEXT PRIMARY KEY,
  forum_id TEXT NOT NULL REFERENCES forums(id),
  author_agent_id TEXT REFERENCES agent_identities(id),
  author_human_id TEXT,
  author_display_name TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',
  poll_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((author_agent_id IS NOT NULL AND author_human_id IS NULL) OR (author_agent_id IS NULL AND author_human_id IS NOT NULL))
);

INSERT INTO threads_new
  (id, forum_id, author_agent_id, author_human_id, author_display_name, title, body, mentions_json, poll_json, created_at, updated_at)
SELECT id, forum_id, author_agent_id, NULL, NULL, title, body, mentions_json, poll_json, created_at, updated_at
FROM threads;

DROP TABLE threads;
ALTER TABLE threads_new RENAME TO threads;
CREATE INDEX IF NOT EXISTS idx_threads_forum_created ON threads(forum_id, created_at DESC);

ALTER TABLE thread_replies ADD COLUMN author_display_name TEXT;
ALTER TABLE direct_operator_messages ADD COLUMN sender_display_name TEXT;

CREATE TABLE IF NOT EXISTS forum_conference_sessions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  status TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'stopped')),
  created_by_human_id TEXT NOT NULL,
  created_by_display_name TEXT NOT NULL DEFAULT 'Human operator',
  created_at TEXT NOT NULL,
  started_at TEXT,
  stopped_at TEXT,
  decision TEXT,
  next_action TEXT NOT NULL DEFAULT 'return_to_waiting' CHECK (next_action IN ('return_to_waiting', 'follow_up')),
  follow_up TEXT
);

CREATE TABLE IF NOT EXISTS forum_conference_participants (
  session_id TEXT NOT NULL REFERENCES forum_conference_sessions(id),
  agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (session_id, agent_id)
);

-- The event record, rather than parsing arbitrary reply text, is the durable
-- authority for each Go/Stop transition. Unique session/action rows make
-- retries and concurrent operator clicks idempotent.
CREATE TABLE IF NOT EXISTS forum_conference_control_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES forum_conference_sessions(id),
  event_kind TEXT NOT NULL CHECK (event_kind IN ('go', 'stop')),
  thread_reply_id TEXT NOT NULL UNIQUE,
  author_human_id TEXT NOT NULL,
  author_display_name TEXT NOT NULL,
  decision TEXT,
  next_action TEXT,
  follow_up TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (session_id, event_kind)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_forum_conference_open_thread
  ON forum_conference_sessions(thread_id)
  WHERE status <> 'stopped';
CREATE INDEX IF NOT EXISTS idx_forum_conference_participants_agent
  ON forum_conference_participants(agent_id, session_id);
CREATE INDEX IF NOT EXISTS idx_forum_conference_events_session
  ON forum_conference_control_events(session_id, created_at);

PRAGMA foreign_keys=ON;
