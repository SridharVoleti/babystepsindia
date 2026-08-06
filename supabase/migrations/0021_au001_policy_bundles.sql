create table if not exists authorization_policy_bundles (
  id uuid primary key,
  version text not null unique check(version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  digest text not null unique check(digest ~ '^[0-9a-f]{64}$'),
  source_commit_sha text not null check(source_commit_sha ~ '^[0-9a-f]{40}$'),
  policy_json jsonb not null,
  created_at timestamptz not null default now()
);

alter table authorization_policy_bundles enable row level security;

create or replace function reject_authorization_policy_bundle_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'authorization policy bundles are immutable';
end;
$$;

create trigger authorization_policy_bundles_no_update
before update on authorization_policy_bundles
for each row execute function reject_authorization_policy_bundle_mutation();

create trigger authorization_policy_bundles_no_delete
before delete on authorization_policy_bundles
for each row execute function reject_authorization_policy_bundle_mutation();

comment on table authorization_policy_bundles is
  'AU-001 immutable, version-controlled authorization policy definitions. No browser RLS policy is intentional.';
