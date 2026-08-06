create table if not exists platform_service_principals (
  id uuid primary key,
  service_key text not null unique,
  key_ref text not null,
  status text not null check(status in ('active','revoked')),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  version integer not null default 1
);

create table if not exists platform_service_assertion_replays (
  principal_id uuid not null references platform_service_principals(id) on delete cascade,
  jti text not null,
  expires_at timestamptz not null,
  primary key(principal_id,jti)
);

alter table platform_service_principals enable row level security;
alter table platform_service_assertion_replays enable row level security;

comment on table platform_service_principals is
  'AU-001 separately deployed trusted platform services; intentionally distinct from LA-002 app principals.';
