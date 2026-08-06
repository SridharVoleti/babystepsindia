alter table learner_sessions add column if not exists interruption_episode_count integer not null default 0;
alter table learner_sessions add column if not exists final_progress_version integer;
alter table learner_sessions add column if not exists finalization_started_at timestamptz;
alter table learner_sessions add column if not exists session_credit_id uuid;

create table if not exists session_finalization_requests (
  learner_session_id uuid not null references learner_sessions(id), app_principal_id uuid not null references app_service_principals(id),
  idempotency_key text not null, request_hash text not null, response_json jsonb not null,
  expires_at timestamptz not null, created_at timestamptz not null default now(),
  primary key(learner_session_id,app_principal_id,idempotency_key)
);
create table if not exists learner_session_credits (
  id uuid primary key default gen_random_uuid(), source_learner_session_id uuid not null references learner_sessions(id),
  learner_id uuid not null references learners(id), app_id uuid not null references app_registry(id) on delete restrict,
  credit_type text not null check(credit_type='technical_replacement'),
  status text not null check(status in ('available','reserved','consumed','expired','revoked')),
  confirmed_by_actor_type text not null check(confirmed_by_actor_type in ('learner','parent')), confirmed_by_actor_id uuid not null,
  confirmation_reason_code text not null check(confirmation_reason_code='technical_issue'), granted_at timestamptz not null,
  expires_at timestamptz not null, reserved_session_id uuid unique, reserved_at timestamptz, consumed_at timestamptz,
  revoked_at timestamptz, version integer not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(source_learner_session_id,credit_type)
);
create table if not exists technical_credit_claim_requests (
  actor_id uuid not null, source_learner_session_id uuid not null references learner_sessions(id), idempotency_key text not null,
  request_hash text not null, response_json jsonb not null, expires_at timestamptz not null, created_at timestamptz not null default now(),
  primary key(actor_id,source_learner_session_id,idempotency_key)
);
alter table session_finalization_requests enable row level security;
alter table learner_session_credits enable row level security;
alter table technical_credit_claim_requests enable row level security;
