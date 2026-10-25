-- PRG-025: release compatibility gate evidence - read / migration / write checks stored individually per release.
alter table app_release_compatibility_reports add column if not exists read_status text not null default 'skipped' check (read_status in ('passed','failed','skipped'));
alter table app_release_compatibility_reports add column if not exists migration_status text not null default 'skipped' check (migration_status in ('passed','failed','skipped'));
alter table app_release_compatibility_reports add column if not exists write_status text not null default 'skipped' check (write_status in ('passed','failed','skipped'));
alter table app_release_compatibility_reports add column if not exists checks_json text not null default '[]';
