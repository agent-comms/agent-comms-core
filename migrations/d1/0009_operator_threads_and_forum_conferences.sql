PRAGMA foreign_keys=OFF;

CREATE TABLE threads_new (
  id TEXT PRIMARY KEY,
  forum_id TEXT NOT NULL REFERENCES forums(id),
  author_agent_id TEXT REFERENCES agent_identities(id),
  author_human_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',
  poll_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((author_agent_id IS NOT NULL AND author_human_id IS NULL) OR (author_agent_id IS NULL AND author_human_id IS NOT NULL))
);

INSERT INTO threads_new
  (id, forum_id, author_agent_id, author_human_id, title, body, mentions_json, poll_json, created_at, updated_at)
SELECT id, forum_id, author_agent_id, NULL, title, body, mentions_json, poll_json, created_at, updated_at
FROM threads;

DROP TABLE threads;
ALTER TABLE threads_new RENAME TO threads;
CREATE INDEX IF NOT EXISTS idx_threads_forum_created ON threads(forum_id, created_at DESC);

CREATE TABLE IF NOT EXISTS forum_conference_sessions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  status TEXT NOT NULL CHECK (status IN ('waiting', 'active', 'stopped')),
  created_by_human_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  stopped_at TEXT,
  decision TEXT
);

CREATE TABLE IF NOT EXISTS forum_conference_participants (
  session_id TEXT NOT NULL REFERENCES forum_conference_sessions(id),
  agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (session_id, agent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_forum_conference_open_thread
  ON forum_conference_sessions(thread_id)
  WHERE status <> 'stopped';
CREATE INDEX IF NOT EXISTS idx_forum_conference_participants_agent
  ON forum_conference_participants(agent_id, session_id);

PRAGMA foreign_keys=ON;
