-- AN-002: minimal operational-monitoring projection. Observational only,
-- never authoritative — never touches any source-domain job-run table.
create table if not exists monitoring_job_snapshots (
  id text primary key,
  job_key text not null,
  source_run_key text not null,
  status text not null check(status in ('completed','failed','running')),
  run_at text not null,
  duration_ms integer,
  counts_json text not null default '{}',
  correlation_id text,
  created_at text not null default (now()::text),
  unique(job_key,source_run_key)
);
create index if not exists idx_monitoring_job_snapshots_job
  on monitoring_job_snapshots(job_key,run_at desc);
alter table monitoring_job_snapshots enable row level security;
alter table monitoring_job_snapshots force row level security;

create table if not exists monitoring_job_monthly_aggregates (
  job_key text not null,
  month_key text not null,
  run_count integer not null default 0,
  failed_count integer not null default 0,
  created_at text not null default (now()::text),
  updated_at text not null default (now()::text),
  primary key(job_key,month_key)
);
alter table monitoring_job_monthly_aggregates enable row level security;
alter table monitoring_job_monthly_aggregates force row level security;
