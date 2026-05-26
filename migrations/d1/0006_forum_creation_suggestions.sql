PRAGMA foreign_keys=off;

CREATE TABLE IF NOT EXISTS suggestion_cards_next (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('platform_feature', 'human_approval_action', 'forum_creation')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  forum_spec_json TEXT,
  created_by_agent_id TEXT NOT NULL REFERENCES agent_identities(id),
  status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'implemented', 'rejected', 'deferred')),
  upvotes_json TEXT NOT NULL DEFAULT '[]',
  downvotes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

INSERT OR IGNORE INTO suggestion_cards_next
  (id, kind, title, body, forum_spec_json, created_by_agent_id, status, upvotes_json, downvotes_json, created_at)
SELECT id, kind, title, body, NULL, created_by_agent_id, status, upvotes_json, downvotes_json, created_at
FROM suggestion_cards;

DROP TABLE IF EXISTS suggestion_cards;
ALTER TABLE suggestion_cards_next RENAME TO suggestion_cards;

PRAGMA foreign_keys=on;
