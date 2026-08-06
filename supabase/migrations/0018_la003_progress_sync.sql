alter table learner_app_progress add column if not exists current_state_json jsonb;
alter table learner_app_progress add column if not exists current_lesson_engaged_seconds integer not null default 0 check (current_lesson_engaged_seconds >= 0);
alter table learner_app_progress add column if not exists current_level_engaged_seconds integer not null default 0 check (current_level_engaged_seconds >= 0);
alter table learner_app_progress add column if not exists progress_version integer not null default 1;
alter table learner_app_progress add column if not exists last_session_id uuid;
alter table learner_app_progress add column if not exists last_checkpoint_sequence integer not null default 0;
alter table learner_app_progress add column if not exists state_hash text;

alter table lesson_completions add column if not exists completion_outcome_code varchar(32) not null default 'completed';
alter table lesson_completions add column if not exists progress_version_after_completion integer;
alter table learner_sessions add column if not exists current_level_key text;
alter table learner_sessions add column if not exists current_lesson_key text;
alter table learner_sessions add column if not exists context_started_verified_seconds integer not null default 0;

create table if not exists app_progress_schemas (
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null,
  schema_version integer not null,
  schema_json jsonb not null,
  schema_digest text not null,
  status text not null check(status in ('active','retired')),
  created_at timestamptz not null default now(),
  primary key(app_id,release_id,schema_version)
);

create table if not exists progress_mutation_requests (
  app_principal_id uuid not null references app_service_principals(id),
  grant_id uuid not null references app_session_grants(id),
  learner_session_id uuid not null references learner_sessions(id),
  idempotency_key text not null,
  operation text not null check(operation in ('checkpoint','lesson_complete')),
  request_hash text not null,
  response_json jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(app_principal_id,grant_id,learner_session_id,idempotency_key)
);

alter table app_progress_schemas enable row level security;
alter table progress_mutation_requests enable row level security;
