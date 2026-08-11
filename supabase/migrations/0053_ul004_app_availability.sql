-- UL-004: manual/event-driven operational availability and planned maintenance.
create extension if not exists btree_gist;
create table app_launch_availability (
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null check(environment in ('development','staging','production')),
  operational_state text not null default 'available'
    check(operational_state in ('available','maintenance','temporarily_unavailable','restoring','security_blocked')),
  availability_version bigint not null default 1,
  reason_category text,
  safe_learner_message text check(safe_learner_message is null or char_length(safe_learner_message)<=160),
  expected_return_at timestamptz,
  source_reference text,
  updated_by text not null default 'system',
  updated_by_type text not null default 'system'
    check(updated_by_type in ('system','administrator','security','deployment')),
  updated_at timestamptz not null default now(),
  primary key(app_id,environment)
);
create index idx_app_launch_availability_state
  on app_launch_availability(environment,operational_state,app_id);

create table app_maintenance_windows (
  id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null check(environment in ('development','staging','production')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled' check(status in ('scheduled','cancelled','completed')),
  reason_category text not null,
  safe_learner_message text check(safe_learner_message is null or char_length(safe_learner_message)<=160),
  window_version bigint not null default 1,
  created_by uuid not null references users(id),
  updated_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(ends_at>starts_at)
);
create index idx_app_maintenance_windows_lookup
  on app_maintenance_windows(app_id,environment,status,starts_at,ends_at);
alter table app_maintenance_windows add constraint app_maintenance_windows_no_overlap
  exclude using gist (app_id with =, environment with =, tstzrange(starts_at,ends_at,'[)') with &&)
  where (status='scheduled');

create table app_availability_mutation_receipts (
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  action text not null check(action in ('schedule','update','cancel','transition')),
  window_id uuid,
  target_state text,
  availability_version_from bigint not null,
  availability_version_to bigint,
  request_hash text not null,
  idempotency_key text not null,
  status text not null check(status in ('processing','completed')),
  response_json jsonb,
  actor_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(app_id,environment,idempotency_key)
);
create index idx_app_availability_receipts_time
  on app_availability_mutation_receipts(app_id,environment,action,created_at);

create table app_availability_events (
  id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  availability_version bigint not null,
  event_type text not null,
  created_at timestamptz not null default now(),
  unique(app_id,environment,availability_version)
);

insert into app_launch_availability(app_id,environment,updated_by,updated_by_type)
select id,'production','migration','system' from app_registry where registry_status='active'
on conflict(app_id,environment) do nothing;

create or replace function initialize_app_launch_availability() returns trigger language plpgsql as $$
begin
  if new.registry_status='active' then
    insert into app_launch_availability(app_id,environment,updated_by,updated_by_type)
    values(new.id,'production','app-registry','system') on conflict(app_id,environment) do nothing;
  end if;
  return new;
end $$;
create trigger trg_initialize_app_launch_availability
after insert or update of registry_status on app_registry
for each row execute function initialize_app_launch_availability();

alter table app_launch_availability enable row level security;
alter table app_launch_availability force row level security;
alter table app_maintenance_windows enable row level security;
alter table app_maintenance_windows force row level security;
alter table app_availability_mutation_receipts enable row level security;
alter table app_availability_mutation_receipts force row level security;
alter table app_availability_events enable row level security;
alter table app_availability_events force row level security;
-- Server-role only; no browser PostgREST policies.

insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
values(gen_random_uuid(),'app-availability-reader','kms://babysteps/app-availability-reader/v1','',
  'active',now(),now()+interval '365 days',1)
on conflict(service_key) do nothing;
