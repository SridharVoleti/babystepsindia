-- PR-004: fail-closed progress-integrity validation, safely readable
-- continuation and controlled operations incidents over the single
-- learner_app_progress row and immutable lesson_completions. Recovery
-- receipts (PR-002) do not exist in this codebase yet — rule 16 (recovery
-- metadata agreement) is therefore structurally unreachable and is not
-- modeled here; see README for the documented gap.

-- PR-001's own per-learner migration receipt (rules 12, 14, 15) — the
-- existing app_progress_schema_migrations table is only an app-wide
-- transform registry, not an event log of what actually happened to a
-- given learner's row.
create table if not exists learner_progress_migration_receipts (
  id uuid primary key,
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null,
  from_schema_version integer not null,
  to_schema_version integer not null,
  progress_version integer not null,
  state_hash_after text not null,
  migrated_at timestamptz not null,
  unique(learner_id, app_id, release_id, to_schema_version)
);
create index if not exists idx_lpmr_learner_app on learner_progress_migration_receipts(learner_id, app_id);
alter table learner_progress_migration_receipts enable row level security;
alter table learner_progress_migration_receipts force row level security;

alter table learner_app_progress add column if not exists progress_summary_visibility_status text not null default 'current' check (progress_summary_visibility_status in ('current','stale','unavailable'));
alter table learner_app_progress add column if not exists progress_summary_based_on_version integer;
alter table learner_app_progress add column if not exists last_migration_receipt_id uuid references learner_progress_migration_receipts(id);

create table if not exists progress_integrity_incidents (
  id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null check (environment in ('staging','production')),
  learner_id uuid not null references learners(id),
  classification text not null check (classification in
    ('read_only_safe','blocked_repairable_metadata','blocked_conflict','unreadable_corrupt')),
  severity text not null check (severity in ('low','medium','high','critical')),
  status text not null default 'open' check (status in
    ('open','investigating','resolved_repaired','resolved_false_positive',
     'resolved_legacy_policy','routed_disaster_recovery')),
  issue_codes jsonb not null default '[]',
  expected_state_hash text,
  actual_state_hash text,
  expected_progress_version integer,
  actual_progress_version integer,
  expected_schema_version integer,
  actual_schema_version integer,
  source_receipt_type text check (source_receipt_type in ('migration') or source_receipt_type is null),
  source_receipt_id uuid,
  release_id uuid,
  workflow_route text not null default 'none' check (workflow_route in ('none','release_rollback','disaster_recovery')),
  attempt_count integer not null default 0,
  version integer not null default 1,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  resolved_at timestamptz
);
create index if not exists idx_pii_app_env_status on progress_integrity_incidents(app_id, environment, status);
create index if not exists idx_pii_status_created on progress_integrity_incidents(status, created_at);
-- rules 59, 67: exactly one active incident per learner+app; a duplicate
-- detection while one is already open/investigating must aggregate onto it
-- rather than insert a second row.
create unique index if not exists ux_pii_active on progress_integrity_incidents(learner_id, app_id)
  where status in ('open','investigating');
alter table progress_integrity_incidents enable row level security;
alter table progress_integrity_incidents force row level security;

create table if not exists learner_app_progress_integrity (
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null default 'production' check (environment in ('staging','production')),
  integrity_state text not null default 'healthy' check (integrity_state in
    ('healthy','read_only_safe','blocked_repairable_metadata','blocked_conflict','unreadable_corrupt')),
  integrity_version integer not null default 0,
  canonical_state_hash text,
  validated_progress_version integer,
  validated_schema_version integer,
  last_migration_receipt_id uuid references learner_progress_migration_receipts(id),
  issue_codes jsonb not null default '[]',
  mutation_blocked boolean not null default false,
  read_safe boolean not null default true,
  legacy_policy_acknowledged boolean not null default false,
  last_validated_at timestamptz,
  last_validated_source text check (last_validated_source in ('inline_read','inline_write','launch','reconcile') or last_validated_source is null),
  active_incident_id uuid references progress_integrity_incidents(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (learner_id, app_id)
);
create index if not exists idx_lapi_state on learner_app_progress_integrity(integrity_state);
create index if not exists idx_lapi_updated on learner_app_progress_integrity(updated_at);
create index if not exists idx_lapi_incident on learner_app_progress_integrity(active_incident_id);
alter table learner_app_progress_integrity enable row level security;
alter table learner_app_progress_integrity force row level security;

-- Append-only audit/idempotency log for every inline/launch/reconcile
-- validation (rule 6, 60-61: no raw state, ever).
create table if not exists progress_integrity_validation_receipts (
  id uuid primary key,
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  progress_version integer,
  integrity_version integer not null,
  schema_version integer,
  expected_state_hash text,
  actual_state_hash text,
  result text not null check (result in ('pass','fail')),
  classification text not null check (classification in
    ('healthy','read_only_safe','blocked_repairable_metadata','blocked_conflict','unreadable_corrupt')),
  reason text not null check (reason in ('read','write','launch','reconcile')),
  requester_principal_id text,
  request_hash text,
  idempotency_key text,
  created_at timestamptz not null
);
create index if not exists idx_pivr_learner_app_created on progress_integrity_validation_receipts(learner_id, app_id, created_at);
create unique index if not exists ux_pivr_idem on progress_integrity_validation_receipts(requester_principal_id, idempotency_key)
  where idempotency_key is not null;
alter table progress_integrity_validation_receipts enable row level security;
alter table progress_integrity_validation_receipts force row level security;

create table if not exists progress_integrity_incident_actions (
  id uuid primary key,
  incident_id uuid not null references progress_integrity_incidents(id),
  action text not null check (action in
    ('revalidate','retry_safe_metadata_repair','link_matching_receipt',
     'resolve_legacy_policy','open_disaster_recovery_case','resolve_false_positive')),
  actor_admin_id uuid not null references auth.users(id),
  reauthenticated_at timestamptz not null,
  expected_version integer not null,
  idempotency_key text not null,
  reason_category text,
  evidence_refs jsonb not null default '[]',
  result text not null check (result in ('applied','rejected','no_op')),
  result_code text,
  prior_integrity_state text,
  new_integrity_state text,
  prior_incident_status text,
  new_incident_status text,
  created_at timestamptz not null
);
create index if not exists idx_piia_incident_created on progress_integrity_incident_actions(incident_id, created_at);
create unique index if not exists ux_piia_idem on progress_integrity_incident_actions(incident_id, idempotency_key);
alter table progress_integrity_incident_actions enable row level security;
alter table progress_integrity_incident_actions force row level security;

-- Rule 59 dedup at the whole-page-run grain (not per-row, which
-- progress_integrity_validation_receipts already covers) — a retried
-- sweep call with the same runIdempotencyKey+cursor returns the cached
-- page result instead of reprocessing and double-counting.
create table if not exists progress_integrity_sweep_runs (
  run_idempotency_key text not null,
  cursor text not null default '',
  environment text not null,
  app_id text,
  processed integer not null,
  next_cursor text,
  incidents_opened integer not null,
  repairs_applied integer not null,
  created_at timestamptz not null,
  primary key (run_idempotency_key, cursor)
);
alter table progress_integrity_sweep_runs enable row level security;
alter table progress_integrity_sweep_runs force row level security;

insert into platform_service_principals(
  id, service_key, key_ref, status, valid_from, valid_until, version
) values
  ('a1000000-0000-4000-8000-000000000006', 'progress-integrity-reconciler',
   'progress-integrity-reconciler-v1', 'active', now(), 'infinity', 1)
on conflict (service_key) do nothing;
