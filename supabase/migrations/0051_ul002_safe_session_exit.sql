-- UL-002: checkpointed intentional app exit with Resume later or Finish now.
alter table learner_sessions drop constraint if exists learner_sessions_status_check;
alter table learner_sessions add constraint learner_sessions_status_check check (status in
  ('starting','active','disconnected','resumable','completed','interrupted','expired','revoked_by_admin','cancelled_before_launch'));

alter table learner_sessions add column if not exists intentional_exit_state text not null default 'none';
alter table learner_sessions add column if not exists intentional_exit_reason text;
alter table learner_sessions add column if not exists last_exit_acknowledged_progress_version integer;
alter table learner_sessions add column if not exists resumable_marked_at timestamptz;
alter table learner_sessions add column if not exists exit_transition_version integer not null default 0;
alter table learner_sessions drop constraint if exists learner_sessions_intentional_exit_state_check;
alter table learner_sessions add constraint learner_sessions_intentional_exit_state_check check (intentional_exit_state in
  ('none','resumable_requested','resumable','finish_requested','finalized'));
alter table learner_sessions drop constraint if exists learner_sessions_intentional_exit_reason_check;
alter table learner_sessions add constraint learner_sessions_intentional_exit_reason_check check
  (intentional_exit_reason in ('intentional_resume_later','intentional_finish') or intentional_exit_reason is null);

drop index if exists idx_learner_sessions_one_reserved;
create unique index idx_learner_sessions_one_reserved on learner_sessions(learner_id)
  where status in ('starting','active','disconnected','resumable');

create table session_exit_transition_receipts (
  id uuid primary key default gen_random_uuid(),
  learner_session_id uuid not null references learner_sessions(id),
  app_id uuid not null references app_registry(id),
  device_session_id uuid not null,
  release_id uuid,
  app_principal_id uuid not null references app_service_principals(id) on delete restrict,
  action text not null check (action in ('resume_later','finish_now')),
  expected_session_version integer not null,
  prior_session_version integer not null,
  new_session_version integer not null,
  acknowledged_progress_version integer not null,
  idempotency_key uuid not null,
  request_hash text not null,
  result_status text not null,
  response_json jsonb not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz not null,
  unique(learner_session_id, action, idempotency_key)
);
create index idx_session_exit_receipts_session_status_time
  on session_exit_transition_receipts(learner_session_id, action, result_status, created_at);

alter table session_exit_transition_receipts enable row level security;
alter table session_exit_transition_receipts force row level security;
-- Server session/app authorization services only; no browser table policy.
