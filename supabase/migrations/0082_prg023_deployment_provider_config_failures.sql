-- PRG-023: append-only record of deployment attempts blocked by incomplete provider configuration (never stores credentials).
create table if not exists deployment_provider_config_failures (
  id text primary key,
  operation text not null,
  app_id text,
  release_id text,
  admin_user_id text,
  error_code text not null,
  created_at timestamptz not null default now()
);

create or replace function reject_deployment_provider_config_failure_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'deployment provider config failures are immutable (append-only)';
end;
$$;
drop trigger if exists deployment_provider_config_failures_no_update_delete on deployment_provider_config_failures;
create trigger deployment_provider_config_failures_no_update_delete
before update or delete on deployment_provider_config_failures
for each row execute function reject_deployment_provider_config_failure_mutation();

alter table deployment_provider_config_failures enable row level security;
alter table deployment_provider_config_failures force row level security;
