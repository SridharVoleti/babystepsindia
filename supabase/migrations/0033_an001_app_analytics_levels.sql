-- AN-001: platform-owned app level contract. Contributions may use only an
-- active app-scoped level or the reserved `unassigned` fallback enforced by
-- the platform service. Learning apps cannot write this registry directly.
create table if not exists app_analytics_levels (
  app_id uuid not null references app_registry(id) on delete restrict,
  level_key text not null,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (app_id, level_key),
  check (length(btrim(level_key)) > 0 and level_key <> 'unassigned')
);

alter table app_analytics_levels enable row level security;
alter table app_analytics_levels force row level security;
revoke all on table app_analytics_levels from public, anon, authenticated;
grant select, insert, update, delete on table app_analytics_levels to service_role;

-- Down migration (apply manually to reverse; purged pseudonymous buffers are intentionally not restored):
-- drop table if exists app_analytics_levels;
