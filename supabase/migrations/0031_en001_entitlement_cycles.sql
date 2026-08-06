-- EN-001: subscription-cycle app entitlements, immutable app-snapshot per
-- paid cycle, and one independent full per-app allocation. Consumes a
-- caller-supplied paid-cycle event (no BI-002/BI-005 producer exists yet in
-- this codebase; app_ids_json is the event's own immutable snapshot, not
-- re-derived from a bundle catalog that doesn't exist yet either).
create table if not exists entitlement_cycles (
  id uuid primary key default gen_random_uuid(),
  paid_cycle_id text not null unique,
  subscription_id text not null,
  purchaser_parent_id uuid not null references profiles(id),
  assigned_learner_id uuid not null references learners(id),
  product_id text not null,
  product_version integer not null,
  app_ids_json jsonb not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  billing_anchor text not null,
  status text not null check(status in ('creating','ready','failed')),
  source_event_id text not null,
  source_event_version integer not null,
  source_event_hash text not null,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  version integer not null default 1
);
create index if not exists idx_entitlement_cycles_learner on entitlement_cycles(assigned_learner_id);
alter table entitlement_cycles enable row level security;
alter table entitlement_cycles force row level security;

-- One per-app entitlement period per paid cycle (business rule 3, 34; unique
-- paid_cycle+app). effective_entitlement_id/standard_credit_batch_id FKs are
-- added in 0032 once their target tables exist (circular reference between
-- this table and learner_app_effective_entitlements).
create table if not exists learner_app_entitlement_periods (
  id uuid primary key default gen_random_uuid(),
  entitlement_cycle_id uuid not null references entitlement_cycles(id),
  subscription_id text not null,
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  product_version integer not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null default 'ready' check(status in ('ready')),
  effective_source_role text not null check(effective_source_role in
    ('allocation_bearing','access_supporting','overlap_suppressed')),
  effective_entitlement_id uuid,
  standard_credit_batch_id uuid,
  created_at timestamptz not null default now(),
  unique(entitlement_cycle_id, app_id)
);
create index if not exists idx_entitlement_periods_learner_app
  on learner_app_entitlement_periods(learner_id, app_id, period_start, period_end);
alter table learner_app_entitlement_periods enable row level security;
alter table learner_app_entitlement_periods force row level security;

create table if not exists entitlement_application_receipts (
  paid_cycle_id text not null,
  event_id text not null,
  request_hash text not null,
  result_json jsonb not null,
  status text not null check(status in ('ready','failed','quarantined')),
  created_at timestamptz not null default now(),
  primary key(paid_cycle_id, event_id)
);
alter table entitlement_application_receipts enable row level security;
alter table entitlement_application_receipts force row level security;

insert into platform_service_principals(
  id, service_key, key_ref, status, valid_from, valid_until, version
) values
  ('a1000000-0000-4000-8000-000000000003', 'entitlement-cycle-applier',
   'entitlement-cycle-applier-v1', 'active', now(), 'infinity', 1)
on conflict (service_key) do nothing;
