-- Admin-controlled per-learner exemption from the weekly session cap.
-- Testing repeatedly hit WEEKLY_SESSION_LIMIT_REACHED / a 23505 collision on
-- idx_learner_sessions_normal_slot because the "normal" free-session cap is
-- a real DB-level invariant (learner_sessions_weekly_slot_number_check only
-- allowed 1/2, learner_app_week_usage_normal_sessions_started_check only
-- allowed 0-2), not just an application-level check -- there was no way to
-- give one learner a higher/no cap without relaxing these too. Same story
-- for the standard-credit path's learner_sessions_weekly_session_ordinal_check
-- (1-3) and learner_app_week_usage_standard_sessions_funded_check (0-3).
--
-- New columns are additive and default to today's behavior (unlimited_sessions
-- false, override null); the four constraint relaxations below are widenings
-- only (existing 1/2/3-bounded values all still satisfy the new >=1/>=0
-- checks), so this is backward-compatible with every existing row and every
-- release still reading the old shape.

begin;

alter table learners add column unlimited_sessions boolean not null default false;
alter table learners add column weekly_session_limit_override integer;
alter table learners add constraint learners_weekly_session_limit_override_check
  check (weekly_session_limit_override is null or weekly_session_limit_override >= 1);

alter table learner_sessions drop constraint if exists learner_sessions_weekly_slot_number_check;
alter table learner_sessions add constraint learner_sessions_weekly_slot_number_check
  check (weekly_slot_number >= 1);

alter table learner_sessions drop constraint if exists learner_sessions_weekly_session_ordinal_check;
alter table learner_sessions add constraint learner_sessions_weekly_session_ordinal_check
  check (weekly_session_ordinal >= 1);

alter table learner_app_week_usage drop constraint if exists learner_app_week_usage_normal_sessions_started_check;
alter table learner_app_week_usage add constraint learner_app_week_usage_normal_sessions_started_check
  check (normal_sessions_started >= 0);

alter table learner_app_week_usage drop constraint if exists learner_app_week_usage_standard_sessions_funded_check;
alter table learner_app_week_usage add constraint learner_app_week_usage_standard_sessions_funded_check
  check (standard_sessions_funded >= 0);

commit;
