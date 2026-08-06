create table app_session_grants (
  id uuid primary key default gen_random_uuid(),
  learner_session_id uuid not null unique references learner_sessions(id) on delete cascade,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  deployment_id uuid not null,
  release_id uuid not null,
  app_principal_id uuid not null references app_service_principals(id) on delete restrict,
  scopes_json jsonb not null,
  api_contract_version text not null,
  grant_version integer not null default 1,
  status text not null check (status in ('active','revoked','expired')),
  expires_at timestamptz not null,
  revocation_reason text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index app_session_grants_deployment_active_idx
  on app_session_grants(app_id,deployment_id,status);

create table app_session_grant_requests (
  principal_id uuid not null references app_service_principals(id) on delete cascade,
  grant_id uuid not null references app_session_grants(id) on delete cascade,
  idempotency_key uuid not null,
  request_hash text not null,
  response_json jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(principal_id,grant_id,idempotency_key)
);
create index app_session_grant_requests_expiry_idx on app_session_grant_requests(expires_at);

alter table app_session_grants enable row level security;
alter table app_session_grant_requests enable row level security;
-- Server-only authorization state: deliberately no browser RLS policies.
