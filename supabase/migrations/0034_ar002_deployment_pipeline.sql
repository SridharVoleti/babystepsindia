-- AR-002 business rule 6: minimal admin-curated list of domains a
-- provider-confirmed production origin is allowed to resolve under. Same
-- "small stand-in registry" shape as approved_app_icons (AR-001) for a
-- precondition the spec assumes exists.
create table if not exists approved_domains (
  id uuid primary key default gen_random_uuid(),
  domain_suffix text not null unique,
  status text not null default 'active' check (status in ('active','retired')),
  created_at timestamptz not null default now()
);

-- AR-002: verified provider (Vercel) project binding, one per app+environment.
create table if not exists app_deployment_bindings (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null check (environment in ('development','staging','production')),
  provider text not null,
  provider_team_id text not null,
  provider_project_id text not null,
  expected_repository text not null,
  approved_domain_id uuid,
  binding_status text not null default 'unverified' check (binding_status in ('unverified','verified','disabled')),
  deployment_enabled boolean not null default true,
  verified_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(app_id, environment),
  unique(provider, provider_team_id, provider_project_id, environment)
);

-- AR-002: immutable release. Created only by an authenticated CI principal
-- from an approved repository commit (business rule 11); build-once, same
-- artifact_digest promoted through staging and production (rule 14).
create table if not exists app_releases (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references app_registry(id) on delete restrict,
  source_repository text not null,
  source_commit_sha text not null,
  dependency_lock_hash text not null,
  build_input_hash text not null,
  artifact_digest text not null,
  provider_artifact_id text,
  manifest_json jsonb not null,
  gate_results_json jsonb not null,
  status text not null default 'created'
    check (status in ('created','gate_failed','staging_deploying','staging_failed','verified','promoted')),
  created_by_ci_principal text not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  failed_at timestamptz,
  unique(app_id, source_commit_sha, artifact_digest)
);

create index if not exists idx_app_releases_app on app_releases(app_id, status);

-- AR-002: one row per environment deployment of a release (staging or
-- production). validation_summary_json is compact pass/fail codes only,
-- never full logs (business rule 40).
create table if not exists app_deployments (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null references app_releases(id) on delete restrict,
  binding_id uuid not null references app_deployment_bindings(id) on delete restrict,
  environment text not null,
  provider_deployment_id text not null unique,
  verified_origin text not null,
  status text not null check (status in ('deploying','validating','published','superseded','failed')),
  validation_summary_json jsonb not null default '{}'::jsonb,
  investigation_hold boolean not null default false,
  started_at timestamptz not null default now(),
  validated_at timestamptz,
  published_at timestamptz,
  superseded_at timestamptz,
  ended_at timestamptz
);

create index if not exists idx_app_deployments_app_env on app_deployments(app_id, environment, status);

-- AR-002: atomic current/previous-healthy publication pointer per
-- app+environment (business rule 28, 31). This is the source of truth that
-- production promotion/rollback updates; app_deployment_launch_controls is
-- kept as a derived projection so LA-001/LP-004's existing read path
-- (resolveTrustedDeployment) is unaffected.
create table if not exists app_environment_publications (
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  current_published_deployment_id uuid references app_deployments(id),
  previous_healthy_deployment_id uuid references app_deployments(id),
  version integer not null default 1,
  published_at timestamptz,
  primary key(app_id, environment)
);

-- AR-002: actor+app-scoped idempotency for binding/release/staging/
-- production operations (business rule 43) — same request-hash/receipt
-- shape as deployment_mutation_requests and entitlement_application_receipts.
create table if not exists deployment_operation_requests (
  actor_principal_id text not null,
  app_id uuid not null,
  idempotency_key uuid not null,
  operation text not null
    check (operation in ('bind','verify_binding','create_release','deploy_staging','approve_production')),
  request_hash text not null,
  release_id uuid,
  deployment_id uuid,
  result_id uuid,
  status text not null check (status in ('processing','completed')),
  safe_response_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(actor_principal_id, idempotency_key)
);

-- AR-002: short-retention provider webhook idempotency ledger (business
-- rule 37, 40). Populated by the webhook ingestion route (deferred to a
-- follow-up session); table created now so the retention/idempotency shape
-- is fixed ahead of that work.
create table if not exists deployment_webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received' check (status in ('received','processed','rejected')),
  unique(provider, provider_event_id)
);

-- AR-002: compact backward-compatibility report per release (business
-- rules 46-49). Table created now; the read/migrate/write test runner that
-- populates it is deferred to a follow-up session (see README).
create table if not exists app_release_compatibility_reports (
  release_id uuid primary key references app_releases(id) on delete restrict,
  platform_contract_version text not null,
  represented_progress_schema_versions_json jsonb not null default '[]'::jsonb,
  status text not null default 'skipped' check (status in ('passed','failed','skipped')),
  generated_at timestamptz not null default now()
);

alter table approved_domains enable row level security;
alter table approved_domains force row level security;
alter table app_deployment_bindings enable row level security;
alter table app_deployment_bindings force row level security;
alter table app_releases enable row level security;
alter table app_releases force row level security;
alter table app_deployments enable row level security;
alter table app_deployments force row level security;
alter table app_environment_publications enable row level security;
alter table app_environment_publications force row level security;
alter table deployment_operation_requests enable row level security;
alter table deployment_operation_requests force row level security;
alter table deployment_webhook_receipts enable row level security;
alter table deployment_webhook_receipts force row level security;
alter table app_release_compatibility_reports enable row level security;
alter table app_release_compatibility_reports force row level security;

-- Server-only: no PostgREST policy. Deployment pipeline administration is
-- available exclusively through the canonical, reauthenticated platform API
-- and the authenticated CI/webhook service principals.
