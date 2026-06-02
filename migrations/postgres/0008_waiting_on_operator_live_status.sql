ALTER TABLE live_conversation_sessions
  DROP CONSTRAINT IF EXISTS live_conversation_sessions_status_check;

ALTER TABLE live_conversation_sessions
  ADD CONSTRAINT live_conversation_sessions_status_check
  CHECK (status IN ('active', 'waiting_on_peer', 'waiting_on_operator', 'settled_by_agent', 'operator_stop_needed', 'stopped'));

ALTER TABLE live_conversation_receipts
  DROP CONSTRAINT IF EXISTS live_conversation_receipts_state_check;

ALTER TABLE live_conversation_receipts
  ADD CONSTRAINT live_conversation_receipts_state_check
  CHECK (state IN ('active', 'waiting_on_peer', 'waiting_on_operator', 'settled_by_agent', 'operator_stop_needed'));
