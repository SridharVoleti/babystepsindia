-- AN-002 — minimal operational monitoring projection.
-- Observational only: these rows never drive billing, access, sessions, or progress.

create table operational_monitoring_runs (
  id uuid primary key default gen_random_uuid(),
  operation_key text not null,
  run_key text not null,
  status text not null check (status in ('running','succeeded','failed')),
  processed_count integer not null default 0 check (processed_count >= 0),
  succeeded_count integer not null default 0 check (succeeded_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  retry_count integer not null default 0 check (retry_count >= 0),
  error_class text check (error_class is null or error_class in
    ('dependency_unavailable','timeout','rate_limited','validation','conflict','internal')),
  correlation_id text not null,
  started_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(operation_key, run_key)
);

create index idx_operational_monitoring_runs_operation_started
  on operational_monitoring_runs(operation_key, started_at desc);
create index idx_operational_monitoring_runs_created
  on operational_monitoring_runs(created_at);
alter table operational_monitoring_runs enable row level security;

create table operational_monitoring_monthly (
  month_start date not null,
  operation_key text not null,
  run_count integer not null default 0 check (run_count >= 0),
  success_count integer not null default 0 check (success_count >= 0),
  failure_count integer not null default 0 check (failure_count >= 0),
  processed_count bigint not null default 0 check (processed_count >= 0),
  retry_count bigint not null default 0 check (retry_count >= 0),
  total_duration_ms bigint not null default 0 check (total_duration_ms >= 0),
  last_run_at timestamptz,
  generated_at timestamptz not null default now(),
  primary key(month_start, operation_key)
);

create index idx_operational_monitoring_monthly_month
  on operational_monitoring_monthly(month_start);
alter table operational_monitoring_monthly enable row level security;
