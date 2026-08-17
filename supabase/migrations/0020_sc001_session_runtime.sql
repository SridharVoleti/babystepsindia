-- BR-003: reviewed-breaking-change
-- SC-001: browser-local session runtime, signed envelope and hard server expiry.
-- Recurring heartbeats are removed; the platform now records only the
-- usable-launch moment and a hard expiry, plus the final client-reported vs
-- server-accepted connected seconds at finalization.
alter table learner_sessions drop column if exists last_heartbeat_at;
alter table learner_sessions drop column if exists heartbeat_sequence;

alter table learner_sessions add column if not exists usable_launch_established_at timestamptz;
alter table learner_sessions add column if not exists hard_expires_at timestamptz;
alter table learner_sessions add column if not exists maximum_connected_seconds integer not null default 2700;
alter table learner_sessions add column if not exists final_reported_connected_seconds integer;
alter table learner_sessions add column if not exists final_accepted_connected_seconds integer;

alter table learner_sessions drop constraint if exists learner_sessions_connected_elapsed_seconds_check;
alter table learner_sessions add constraint learner_sessions_connected_elapsed_seconds_check
  check (connected_elapsed_seconds >= 0);
alter table learner_sessions add constraint learner_sessions_connected_within_maximum_check
  check (connected_elapsed_seconds <= maximum_connected_seconds);
