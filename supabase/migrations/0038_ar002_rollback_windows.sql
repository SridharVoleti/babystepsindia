-- AR-002 session 2: allow the rollback outcome as a terminal app_deployments
-- status (business rules 27-29, 33).
alter table app_deployments drop constraint if exists app_deployments_status_check;
alter table app_deployments add constraint app_deployments_status_check
  check (status in ('deploying','validating','published','superseded','failed','rolled_back'));

-- AR-002 session 2: widen the shared idempotency ledger for window
-- scheduling and rollback operations.
alter table deployment_operation_requests drop constraint if exists deployment_operation_requests_operation_check;
alter table deployment_operation_requests add constraint deployment_operation_requests_operation_check
  check (operation in ('bind','verify_binding','create_release','deploy_staging','approve_production',
    'schedule_window','reschedule_window','cancel_window','rollback'));

-- AR-002 session 2, business rules 46-49: which learner_app_progress
-- schema_version values this release's code can still read/migrate
-- (expand/migrate/contract) — CI's own attestation, checked against
-- currently represented versions before staging can verify.
alter table app_releases add column if not exists readable_schema_versions_json jsonb not null default '[]'::jsonb;

-- AR-002 session 2: one pre-scheduled app-specific production slot per
-- window (business rules 50-60). drain_starts_at is always starts_at minus
-- 60 minutes (rule 51), stored rather than computed so the existing
-- app_deployment_launch_controls projection can be upserted from it
-- unchanged.
create table if not exists app_deployment_windows (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null references app_releases(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  drain_starts_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','draining','executing','completed','cancelled','failed','extended_safe_block')),
  failure_code text,
  created_by_admin_id uuid not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Postgres supports a real exclusion constraint for "no overlapping
-- non-final window per app" (SQLite's parallel schema.sql falls back to a
-- partial unique index on app_id instead, since it has neither exclusion
-- constraints nor a partial-predicate btree over an open interval).
-- uuid has no default GiST operator class, so this needs btree_gist for
-- the "app_id with =" equality term (also created, redundantly-but-
-- idempotently, in 0053_ul004_app_availability.sql).
create extension if not exists btree_gist;
alter table app_deployment_windows add constraint app_deployment_windows_one_nonfinal_per_app
  exclude using gist (app_id with =)
  where (status in ('scheduled','draining','executing','extended_safe_block'));

-- AR-002 session 2: restart-safe state for the ten-minute/one-check-per-
-- minute post-publish release-safety observation (business rules 32-33).
-- One row per production deployment publish; the sweep reads status rather
-- than holding anything in memory, so a restart mid-window resumes
-- correctly (NFR: "release-safety observation is restart safe").
create table if not exists app_deployment_safety_observations (
  deployment_id uuid primary key references app_deployments(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  started_at timestamptz not null default now(),
  checks_run integer not null default 0,
  consecutive_critical_failures integer not null default 0,
  identity_failure boolean not null default false,
  status text not null default 'observing' check (status in ('observing','passed','rollback_triggered')),
  last_checked_at timestamptz
);

alter table app_deployment_windows enable row level security;
alter table app_deployment_windows force row level security;
alter table app_deployment_safety_observations enable row level security;
alter table app_deployment_safety_observations force row level security;

-- Server-only: no PostgREST policy. Deployment pipeline administration is
-- available exclusively through the canonical, reauthenticated platform API
-- and the authenticated CI/webhook service principals.
