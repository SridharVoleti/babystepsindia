-- AN-003 Application Health & Major-Issue Alerting
-- Observational only. These rows must never be used as billing, entitlement,
-- session, progress, notification or deletion authority.

create table if not exists application_health_alerts (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null,
  capability text not null check (capability in (
    'billing','entitlement_access','progress','notification',
    'scheduled_processing','privacy_deletion','app_platform_contract',
    'data_integrity','critical_provider'
  )),
  issue_key text not null,
  severity text not null check (severity in ('major','critical')),
  impact text not null,
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  duration_seconds bigint not null default 0 check (duration_seconds >= 0),
  recovery_state text not null check (recovery_state in ('degraded','exhausted','recovered')),
  recovery_attempts integer not null default 0 check (recovery_attempts >= 0),
  safe_diagnostic_code text not null,
  correlation_id text,
  occurrence_count integer not null default 1 check (occurrence_count > 0),
  status text not null default 'open' check (status in ('open','recovered')),
  recovered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (safe_diagnostic_code ~ '^[A-Z0-9_]{1,64}$'),
  check (correlation_id is null or correlation_id ~ '^[A-Za-z0-9._:-]{1,96}$')
);

create unique index if not exists application_health_alerts_one_open_per_issue
  on application_health_alerts(dedupe_key) where status = 'open';
create index if not exists application_health_alerts_admin_view
  on application_health_alerts(status, severity, last_observed_at desc);

alter table application_health_alerts enable row level security;
revoke all on application_health_alerts from anon, authenticated;

comment on table application_health_alerts is
  'AN-003 privacy-safe, deduplicated Major/Critical application-health alerts. Observational/non-authoritative.';
