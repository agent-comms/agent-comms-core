ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS runtime_kind text;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS runtime_profile_label text;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS runtime_session_label text;
