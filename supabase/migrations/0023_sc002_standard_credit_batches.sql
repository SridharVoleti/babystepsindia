-- SC-002: eight monthly standard session credits per learner/app, one
-- compact batch row per allocation month, one-month rollover, and
-- catch-up third-session pacing.
alter table learner_app_week_usage add column if not exists standard_sessions_funded
  integer not null default 0 check (standard_sessions_funded between 0 and 3);

create table if not exists learner_app_standard_credit_batches (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  allocation_month date not null,
  timezone text not null,
  granted_count smallint not null default 8 check (granted_count = 8),
  reserved_count smallint not null default 0 check (reserved_count >= 0),
  consumed_count smallint not null default 0 check (consumed_count >= 0),
  effective_at timestamptz not null,
  expires_at timestamptz not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(learner_id, app_id, allocation_month),
  check (reserved_count + consumed_count <= granted_count)
);
create index if not exists idx_standard_credit_batches_lookup
  on learner_app_standard_credit_batches(learner_id, app_id, expires_at);

alter table learner_sessions add column if not exists standard_credit_batch_id
  uuid references learner_app_standard_credit_batches(id);
alter table learner_sessions add column if not exists weekly_session_ordinal
  smallint check (weekly_session_ordinal between 1 and 3);

-- 0014 only ever allowed ('normal','replacement'); 0019 introduced
-- 'technical_credit' as a stored value without widening this constraint.
-- Neither has been applied to a live database yet, so correcting it here
-- (rather than patching 0019) is safe and keeps a from-scratch deploy consistent.
alter table learner_sessions drop constraint if exists learner_sessions_source_check;
alter table learner_sessions add constraint learner_sessions_source_check
  check (source in ('normal','replacement','technical_credit','standard_monthly'));

alter table learner_app_standard_credit_batches enable row level security;
