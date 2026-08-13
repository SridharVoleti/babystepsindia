-- EG-005: per-app learner journey with whole-learner inactivity retention.
create table learner_journey_retention_state (
  learner_id uuid primary key references learners(id) on delete restrict,
  state text not null check(state in ('active','inactive_retention','purged')),
  inactive_since timestamptz,
  journey_delete_after timestamptz,
  retention_generation bigint not null default 1 check(retention_generation>0),
  purged_at timestamptz,
  purged_through_at timestamptz,
  state_version bigint not null default 1 check(state_version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_journey_retention_due
  on learner_journey_retention_state(state,journey_delete_after,learner_id);

create table learner_app_journey_events (
  journey_event_id uuid primary key,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  retention_generation bigint not null check(retention_generation>0),
  event_type text not null check(event_type in ('lesson_completed','achievement_earned','milestone_reached')),
  event_at timestamptz not null,
  source_domain text not null check(source_domain in ('lesson_completion','achievement','app_milestone')),
  source_id text not null,
  title_snapshot text not null check(char_length(title_snapshot) between 1 and 100),
  short_description_snapshot text check(short_description_snapshot is null or char_length(short_description_snapshot)<=240),
  icon_asset_key text,
  source_status text not null default 'active' check(source_status='active'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(learner_id,app_id,source_domain,source_id)
);
create index idx_learner_app_journey_page
  on learner_app_journey_events(learner_id,app_id,retention_generation,event_at desc,journey_event_id desc);

create table journey_mutation_receipts (
  id uuid primary key,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  retention_generation bigint not null check(retention_generation>0),
  source_domain text not null check(source_domain in ('lesson_completion','achievement','app_milestone')),
  source_id text not null,
  action text not null check(action in ('upsert','remove')),
  idempotency_key text not null,
  request_hash text not null,
  result_status text not null check(result_status in ('created','replayed','removed','ignored_purged')),
  created_at timestamptz not null default now(),
  completed_at timestamptz not null,
  unique(learner_id,app_id,retention_generation,source_domain,action,idempotency_key)
);
create index idx_journey_receipts_learner_generation
  on journey_mutation_receipts(learner_id,retention_generation,created_at,id);

create table lesson_journey_projection_outbox (
  id uuid primary key,
  completion_id text not null,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null,
  lesson_key text not null,
  completed_at timestamptz not null,
  title_snapshot text not null,
  short_description_snapshot text,
  icon_asset_key text,
  source_state_hash text not null,
  status text not null default 'pending' check(status in ('pending','processed','failed')),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(learner_id,app_id,completion_id,source_state_hash)
);
create index idx_lesson_journey_outbox_status
  on lesson_journey_projection_outbox(status,created_at,id);

create table app_release_journey_contracts (
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null references app_releases(id) on delete restrict,
  journey_contract_version text not null,
  lesson_display_metadata boolean not null,
  milestone_display_metadata boolean not null,
  allowed_icon_asset_keys_json jsonb not null default '[]'::jsonb,
  validation_report_json jsonb,
  status text not null default 'pending' check(status in ('pending','approved','blocked')),
  validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(app_id,release_id)
);
create index idx_release_journey_contract_status
  on app_release_journey_contracts(app_id,status,release_id);

create table journey_retention_job_runs (
  principal_id uuid not null references platform_service_principals(id) on delete restrict,
  run_idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  result_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(principal_id,run_idempotency_key)
);

alter table learner_journey_retention_state enable row level security;
alter table learner_journey_retention_state force row level security;
alter table learner_app_journey_events enable row level security;
alter table learner_app_journey_events force row level security;
alter table journey_mutation_receipts enable row level security;
alter table journey_mutation_receipts force row level security;
alter table lesson_journey_projection_outbox enable row level security;
alter table lesson_journey_projection_outbox force row level security;
alter table app_release_journey_contracts enable row level security;
alter table app_release_journey_contracts force row level security;
alter table journey_retention_job_runs enable row level security;
alter table journey_retention_job_runs force row level security;
-- Server-role only: no browser PostgREST policies.
