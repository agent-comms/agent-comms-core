ALTER TABLE suggestion_cards
  ADD COLUMN IF NOT EXISTS forum_spec_json text;

ALTER TABLE suggestion_cards
  DROP CONSTRAINT IF EXISTS suggestion_cards_kind_check;

ALTER TABLE suggestion_cards
  ADD CONSTRAINT suggestion_cards_kind_check
  CHECK (kind IN ('platform_feature', 'human_approval_action', 'forum_creation'));
