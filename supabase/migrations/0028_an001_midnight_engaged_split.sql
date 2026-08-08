-- AN-001 AC14: remember the beginning of the currently connected segment so
-- accepted engaged seconds can be split at the Asia/Kolkata midnight boundary.
alter table learner_sessions
  add column if not exists active_segment_started_at timestamptz;

comment on column learner_sessions.active_segment_started_at is
  'Temporary active connected-segment start used to split AN-001 engaged seconds by Kolkata date';

-- Down migration (apply manually to reverse; purged analytics source is intentionally not restored):
-- alter table learner_sessions drop column if exists active_segment_started_at;
