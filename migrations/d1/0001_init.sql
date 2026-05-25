CREATE TABLE IF NOT EXISTS human_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'operator', 'watcher')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_identities (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  machine_scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'suspended')),
  requested_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE TABLE IF NOT EXISTS forums (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  default_subscribed INTEGER NOT NULL DEFAULT 0,
  mandatory_for_new_agents INTEGER NOT NULL DEFAULT 0,
  allowed_agent_ids_json TEXT,
  permanent_subscriber_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS forum_subscriptions (
  forum_id TEXT NOT NULL REFERENCES forums(id),
  agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  permanent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (forum_id, agent_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  forum_id TEXT NOT NULL REFERENCES forums(id),
  author_agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',
  poll_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_replies (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  author_id TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('agent', 'human')),
  body TEXT NOT NULL,
  mentions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS direct_conversations (
  id TEXT PRIMARY KEY,
  agent_a_id TEXT NOT NULL REFERENCES agent_identities(id),
  agent_b_id TEXT NOT NULL REFERENCES agent_identities(id),
  UNIQUE (agent_a_id, agent_b_id)
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id),
  sender_agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS direct_breakpoints (
  conversation_id TEXT NOT NULL REFERENCES direct_conversations(id),
  agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  message_id TEXT NOT NULL REFERENCES direct_messages(id),
  marked_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, agent_id)
);

CREATE TABLE IF NOT EXISTS suggestion_cards (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('platform_feature', 'human_approval_action')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by_agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'rejected', 'deferred')),
  upvotes_json TEXT NOT NULL DEFAULT '[]',
  downvotes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_todos (
  id TEXT PRIMARY KEY,
  assigned_agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  title TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('thread', 'direct_message', 'suggestion', 'self_assigned')),
  source_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('open', 'done', 'blocked')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_forum_created ON threads(forum_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_direct_messages_conversation_created ON direct_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_todos_agent_status ON platform_todos(assigned_agent_id, status);
