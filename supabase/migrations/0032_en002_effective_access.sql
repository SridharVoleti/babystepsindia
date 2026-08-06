-- EN-002: one materialized effective-access decision per learner/app/
-- environment (unique constraint), kept in sync at write time whenever
-- EN-001 creates a period (business rule 42/43). evaluateAccessFresh()
-- still re-checks access_until vs. now and app_registry status live on
-- every call rather than trusting this row unconditionally (rule 44).
create table if not exists learner_app_effective_entitlements (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  state text not null check(state in
    ('active','approved_grace','inactive','inactive_refunded','suspended_financial','suspended_security','overlap_resolution')),
  allocation_source_entitlement_period_id uuid references learner_app_entitlement_periods(id),
  access_until timestamptz,
  effective_version integer not null default 1,
  source_set_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(learner_id, app_id, environment)
);
alter table learner_app_effective_entitlements enable row level security;
alter table learner_app_effective_entitlements force row level security;

create table if not exists learner_app_effective_sources (
  effective_entitlement_id uuid not null references learner_app_effective_entitlements(id),
  entitlement_period_id uuid not null references learner_app_entitlement_periods(id),
  role text not null check(role in ('allocation_bearing','access_supporting','overlap_suppressed')),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  primary key(effective_entitlement_id, entitlement_period_id)
);
alter table learner_app_effective_sources enable row level security;
alter table learner_app_effective_sources force row level security;

-- Close the circular reference from 0031: learner_app_entitlement_periods
-- can now point at the effective-entitlement row it belongs to.
alter table learner_app_entitlement_periods
  add constraint learner_app_entitlement_periods_effective_entitlement_fk
  foreign key (effective_entitlement_id) references learner_app_effective_entitlements(id);

-- EN-001: the same compact-batch shape used by SC-002's calendar-month
-- batches also backs one independent 8-credit batch per allocation-bearing
-- entitlement app-period (entitlement_period_id populated, allocation_month/
-- timezone left null instead). allocation_month was previously not null;
-- relaxed here since an entitlement-period-keyed row has no calendar month.
alter table learner_app_standard_credit_batches alter column allocation_month drop not null;
alter table learner_app_standard_credit_batches alter column timezone drop not null;
alter table learner_app_standard_credit_batches add column if not exists entitlement_period_id
  uuid unique references learner_app_entitlement_periods(id);
alter table learner_app_standard_credit_batches
  add constraint learner_app_standard_credit_batches_month_xor_period
  check ((allocation_month is not null) <> (entitlement_period_id is not null));

alter table learner_app_entitlement_periods
  add constraint learner_app_entitlement_periods_standard_credit_batch_fk
  foreign key (standard_credit_batch_id) references learner_app_standard_credit_batches(id);

-- EN-002: the effective-entitlement binding fresh-evaluated and persisted
-- at Start (business rule 21).
alter table learner_sessions add column if not exists effective_entitlement_id
  uuid references learner_app_effective_entitlements(id);
alter table learner_sessions add column if not exists effective_entitlement_version_at_start integer;
alter table learner_sessions add column if not exists allocation_source_entitlement_period_id
  uuid references learner_app_entitlement_periods(id);

insert into platform_service_principals(
  id, service_key, key_ref, status, valid_from, valid_until, version
) values
  ('a1000000-0000-4000-8000-000000000004', 'entitlement-access-evaluator',
   'entitlement-access-evaluator-v1', 'active', now(), 'infinity', 1)
on conflict (service_key) do nothing;
