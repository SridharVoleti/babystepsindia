-- UL-003: event-driven conditional launcher freshness metadata only.
-- Authoritative launcher membership, cards and actions remain in EN/SC/
-- session/PR/app domains and are never persisted here.
create table launcher_freshness_metadata (
  learner_id uuid not null references learners(id),
  environment text not null,
  context_generation integer not null default 0,
  launcher_version text,
  source_version_hash text,
  invalidation_version integer not null default 0,
  invalidated_at timestamptz,
  invalidation_reason text,
  source_type text,
  source_version text,
  source_event_id text,
  app_id uuid references app_registry(id) on delete restrict,
  composed_at timestamptz,
  next_recheck_at timestamptz,
  cache_max_age_seconds integer not null default 60 check(cache_max_age_seconds between 1 and 300),
  last_successful_refresh_at timestamptz,
  last_failed_refresh_at timestamptz,
  last_refresh_result text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(learner_id,environment)
);
create index idx_launcher_freshness_invalidated
  on launcher_freshness_metadata(environment,invalidated_at,learner_id);
create index idx_launcher_freshness_boundary
  on launcher_freshness_metadata(environment,next_recheck_at,learner_id);

create table learner_launcher_freshness_receipts (
  principal_id uuid not null references platform_service_principals(id),
  action text not null check(action in ('invalidate','reconcile')),
  idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  response_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(principal_id,action,idempotency_key)
);
create index idx_launcher_freshness_receipts_time
  on learner_launcher_freshness_receipts(action,created_at);

alter table launcher_freshness_metadata enable row level security;
alter table launcher_freshness_metadata force row level security;
alter table learner_launcher_freshness_receipts enable row level security;
alter table learner_launcher_freshness_receipts force row level security;
-- Service-role only; no browser PostgREST policy.

insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
values
  (gen_random_uuid(),'learner-launcher-domain-outbox','kms://babysteps/launcher-domain-outbox/v1','',
   'active',now(),now()+interval '365 days',1),
  (gen_random_uuid(),'learner-launcher-reconciliation','kms://babysteps/launcher-reconciliation/v1','',
   'active',now(),now()+interval '365 days',1)
on conflict(service_key) do nothing;
