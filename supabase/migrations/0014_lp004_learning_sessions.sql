-- LP-004 learner selection and server-authoritative learning-session gateway.
create table learner_selection_contexts (
  parent_session_id uuid primary key,
  parent_user_id uuid not null references profiles(id),
  selected_learner_id uuid not null references learners(id),
  selected_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index idx_learner_selection_contexts_expiry on learner_selection_contexts(expires_at);

create table learner_app_week_usage (
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id),
  week_key text not null,
  week_timezone text not null,
  normal_sessions_started smallint not null default 0 check (normal_sessions_started between 0 and 2),
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (learner_id, app_id, week_key)
);

create table learner_sessions (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id),
  parent_user_id uuid not null references profiles(id),
  parent_session_id uuid,
  device_session_id uuid not null,
  week_key text not null,
  week_timezone text not null,
  weekly_slot_number smallint check (weekly_slot_number in (1,2)),
  replacement_credit_id uuid,
  source text not null check (source in ('normal','replacement')),
  status text not null check (status in ('starting','active','disconnected','completed','interrupted','expired','revoked_by_admin')),
  schedule_authorization_id text not null,
  started_at timestamptz not null,
  last_heartbeat_at timestamptz not null,
  disconnected_at timestamptz,
  resume_deadline timestamptz,
  cumulative_disconnected_seconds integer not null default 0 check (cumulative_disconnected_seconds between 0 and 900),
  connected_elapsed_seconds integer not null default 0 check (connected_elapsed_seconds between 0 and 2700),
  verified_active_seconds integer not null default 0 check (verified_active_seconds >= 0),
  heartbeat_sequence bigint not null default 0,
  resume_token_hash text not null,
  ended_at timestamptz,
  end_reason text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((source='normal' and weekly_slot_number is not null and replacement_credit_id is null)
    or (source='replacement' and weekly_slot_number is null and replacement_credit_id is not null))
);
create unique index idx_learner_sessions_one_reserved on learner_sessions(learner_id)
  where status in ('starting','active','disconnected');
create unique index idx_learner_sessions_normal_slot
  on learner_sessions(learner_id,app_id,week_key,weekly_slot_number) where source='normal';

create table session_start_requests (
  actor_session_id uuid not null,
  learner_id uuid not null references learners(id),
  idempotency_key uuid not null,
  request_hash text not null,
  session_id uuid references learner_sessions(id),
  status text not null check (status in ('processing','completed','failed')),
  safe_response_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(actor_session_id,learner_id,idempotency_key)
);

create table session_replacement_credits (
  id uuid primary key default gen_random_uuid(),
  original_session_id uuid not null unique references learner_sessions(id),
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id),
  granted_by_admin_id uuid not null references auth.users(id),
  reason_code text not null,
  evidence_summary text not null,
  granted_at timestamptz not null default now(),
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'available' check (status in ('available','consumed','expired','revoked')),
  consumed_session_id uuid unique references learner_sessions(id),
  consumed_at timestamptz
);
alter table learner_sessions add constraint learner_sessions_replacement_credit_fk
  foreign key (replacement_credit_id) references session_replacement_credits(id);
create unique index idx_learner_sessions_credit on learner_sessions(replacement_credit_id)
  where replacement_credit_id is not null;

alter table learner_selection_contexts enable row level security;
alter table learner_app_week_usage enable row level security;
alter table learner_sessions enable row level security;
alter table session_start_requests enable row level security;
alter table session_replacement_credits enable row level security;
-- Server gateway only: no direct browser mutation policies.

-- Down migration (apply manually to reverse):
-- alter table learner_sessions drop constraint learner_sessions_replacement_credit_fk;
-- drop table if exists session_replacement_credits;
-- drop table if exists session_start_requests;
-- drop table if exists learner_sessions;
-- drop table if exists learner_app_week_usage;
-- drop table if exists learner_selection_contexts;
