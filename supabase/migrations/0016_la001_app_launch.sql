-- LA-001 deployment pinning belongs to the LP-004 session and cannot be
-- supplied or changed by the launching browser.
alter table learner_sessions add column if not exists deployment_id uuid;
alter table learner_sessions add column if not exists release_id uuid;
alter table learner_sessions add column if not exists deployment_environment text;
alter table learner_sessions add column if not exists deployment_origin text;
alter table learner_sessions add column if not exists launch_path text;
alter table learner_sessions add column if not exists session_expires_at timestamptz;

create table if not exists learner_session_launch_state (
  learner_session_id uuid primary key references learner_sessions(id) on delete cascade,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  deployment_id uuid not null,
  release_id uuid not null,
  device_session_id uuid not null,
  launch_attempt_id uuid not null unique,
  attempt_version integer not null check (attempt_version > 0),
  code_hash text,
  code_expires_at timestamptz,
  status text not null check (status in ('prepared','exchanged','revoked','expired')),
  exchanged_principal_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  exchanged_at timestamptz,
  check ((status = 'prepared' and code_hash is not null and code_expires_at is not null)
    or status <> 'prepared')
);

create table if not exists app_deployment_launch_controls (
  deployment_id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null,
  environment text not null,
  immutable_origin text not null,
  launch_path text not null,
  api_contract_version text not null default '1.0',
  compatibility_status text not null check (compatibility_status in ('passed','failed','pending')),
  drain_starts_at timestamptz,
  deployment_window_ends_at timestamptz,
  status text not null check (status in ('published','draining','deploying','retired')),
  updated_at timestamptz not null default now()
);

create table if not exists app_service_principals (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  deployment_id uuid not null,
  client_id text not null unique,
  key_ref text not null,
  status text not null check (status in ('active','revoked')),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  version integer not null default 1,
  unique(app_id, environment, deployment_id, key_ref),
  check (valid_until > valid_from)
);

alter table learner_session_launch_state
  add constraint learner_session_launch_state_principal_fk
  foreign key (exchanged_principal_id) references app_service_principals(id) on delete restrict;

create table if not exists app_client_assertion_replays (
  principal_id uuid not null references app_service_principals(id) on delete cascade,
  jti uuid not null,
  expires_at timestamptz not null,
  primary key(principal_id, jti)
);

create index if not exists app_client_assertion_replays_expiry_idx
  on app_client_assertion_replays(expires_at);

create table if not exists app_launch_exchange_receipts (
  principal_id uuid not null references app_service_principals(id) on delete cascade,
  idempotency_key uuid not null,
  request_hash text not null,
  launch_attempt_id uuid not null,
  response_json jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(principal_id, idempotency_key)
);

create index if not exists app_launch_exchange_receipts_expiry_idx
  on app_launch_exchange_receipts(expires_at);

comment on table learner_session_launch_state is
  'Temporary mutable LA-001 launch state; purge after session recovery/support purpose.';
comment on column learner_session_launch_state.code_hash is
  'SHA-256 hash only. Raw launch codes must never be persisted.';
comment on column app_service_principals.key_ref is
  'Managed-secret/key reference only; never a private credential value.';

alter table learner_session_launch_state enable row level security;
alter table app_deployment_launch_controls enable row level security;
alter table app_service_principals enable row level security;
alter table app_client_assertion_replays enable row level security;
alter table app_launch_exchange_receipts enable row level security;
-- No browser policies: launch state, deployment controls, principals and
-- receipts are reachable only through the platform/app-backend services.
