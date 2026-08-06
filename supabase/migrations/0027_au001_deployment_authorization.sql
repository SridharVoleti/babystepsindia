alter table app_deployment_launch_controls
  add column if not exists version integer not null default 1;

create table if not exists deployment_mutation_requests (
  admin_user_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  operation text not null check (operation in ('schedule','reschedule','cancel','promote','rollback')),
  deployment_id uuid not null references app_deployment_launch_controls(deployment_id) on delete restrict,
  request_hash text not null,
  status text not null check (status in ('processing','completed')),
  response_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(admin_user_id,idempotency_key)
);

create table if not exists deployment_authorization_audit (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references auth.users(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  deployment_id uuid not null references app_deployment_launch_controls(deployment_id) on delete restrict,
  release_id uuid not null,
  operation text not null check (operation in ('schedule','reschedule','cancel','promote','rollback')),
  policy_version text not null,
  policy_digest text not null,
  version_from integer not null,
  version_to integer not null,
  created_at timestamptz not null default now()
);

alter table deployment_mutation_requests enable row level security;
alter table deployment_mutation_requests force row level security;
alter table deployment_authorization_audit enable row level security;
alter table deployment_authorization_audit force row level security;

-- Server-only: no PostgREST policy. Deployment administration is available
-- exclusively through the canonical, reauthenticated platform API.
