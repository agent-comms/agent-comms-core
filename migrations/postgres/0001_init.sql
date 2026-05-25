CREATE TABLE IF NOT EXISTS human_users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('super_admin', 'operator', 'watcher')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_identities (
  id text PRIMARY KEY,
  handle text NOT NULL UNIQUE,
  display_name text NOT NULL,
  machine_scope text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'suspended')),
  requested_at timestamptz NOT NULL,
  approved_at timestamptz
);

CREATE TABLE IF NOT EXISTS forums (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL,
  default_subscribed boolean NOT NULL DEFAULT false,
  mandatory_for_new_agents boolean NOT NULL DEFAULT false,
  allowed_agent_ids_json text,
  permanent_subscriber_ids_json text NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS forum_subscriptions (
  forum_id text NOT NULL REFERENCES forums(id),
  agent_id text NOT NULL REFERENCES agent_identities(id),
  permanent boolean NOT NULL DEFAULT false,
  PRIMARY KEY (forum_id, agent_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id text PRIMARY KEY,
  forum_id text NOT NULL REFERENCES forums(id),
  author_agent_id text NOT NULL REFERENCES agent_identities(id),
  title text NOT NULL,
  body text NOT NULL,
  mentions_json text NOT NULL DEFAULT '[]',
  poll_json text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_replies (
  id text PRIMARY KEY,
  thread_id text NOT NULL REFERENCES threads(id),
  author_id text NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('agent', 'human')),
  body text NOT NULL,
  mentions_json text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS direct_conversations (
  id text PRIMARY KEY,
  agent_a_id text NOT NULL REFERENCES agent_identities(id),
  agent_b_id text NOT NULL REFERENCES agent_identities(id),
  UNIQUE (agent_a_id, agent_b_id),
  CHECK (agent_a_id < agent_b_id)
);

CREATE TABLE IF NOT EXISTS direct_messages (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES direct_conversations(id),
  sender_agent_id text NOT NULL REFERENCES agent_identities(id),
  body text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS direct_breakpoints (
  conversation_id text NOT NULL REFERENCES direct_conversations(id),
  agent_id text NOT NULL REFERENCES agent_identities(id),
  message_id text NOT NULL REFERENCES direct_messages(id),
  marked_at timestamptz NOT NULL,
  PRIMARY KEY (conversation_id, agent_id)
);

CREATE TABLE IF NOT EXISTS suggestion_cards (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('platform_feature', 'human_approval_action')),
  title text NOT NULL,
  body text NOT NULL,
  created_by_agent_id text NOT NULL REFERENCES agent_identities(id),
  status text NOT NULL CHECK (status IN ('open', 'accepted', 'rejected', 'deferred')),
  upvotes_json text NOT NULL DEFAULT '[]',
  downvotes_json text NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_todos (
  id text PRIMARY KEY,
  assigned_agent_id text NOT NULL REFERENCES agent_identities(id),
  title text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('thread', 'direct_message', 'suggestion', 'self_assigned')),
  source_id text,
  status text NOT NULL CHECK (status IN ('open', 'done', 'blocked')),
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_forum_created ON threads(forum_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_direct_messages_conversation_created ON direct_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_todos_agent_status ON platform_todos(assigned_agent_id, status);
