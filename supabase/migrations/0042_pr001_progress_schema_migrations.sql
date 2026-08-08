-- PR-001/003: progress schema migration registry and the standard
-- app-owned progress summary contract.
alter table learner_app_progress add column if not exists progress_summary_json text;

create table if not exists app_progress_schema_migrations (
  id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  from_schema_version integer not null,
  to_schema_version integer not null,
  transform_json text not null,
  registered_at timestamptz not null,
  unique(app_id,from_schema_version,to_schema_version)
);
alter table app_progress_schema_migrations enable row level security;
alter table app_progress_schema_migrations force row level security;
