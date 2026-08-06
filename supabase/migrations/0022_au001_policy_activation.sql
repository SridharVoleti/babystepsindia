create table if not exists authorization_policy_active (
  singleton_key text primary key check(singleton_key = 'active'),
  bundle_id uuid not null unique references authorization_policy_bundles(id),
  activated_by uuid not null references auth.users(id),
  activated_at timestamptz not null
);

create table if not exists authorization_policy_activation_history (
  id uuid primary key,
  bundle_id uuid not null references authorization_policy_bundles(id),
  previous_bundle_id uuid references authorization_policy_bundles(id),
  digest text not null check(digest ~ '^[0-9a-f]{64}$'),
  source_commit_sha text not null check(source_commit_sha ~ '^[0-9a-f]{40}$'),
  activated_by uuid not null references auth.users(id),
  activated_at timestamptz not null
);

alter table authorization_policy_active enable row level security;
alter table authorization_policy_activation_history enable row level security;

create or replace function reject_active_authorization_policy_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'active authorization policy cannot be deleted';
end;
$$;

create trigger authorization_policy_active_no_delete
before delete on authorization_policy_active
for each row execute function reject_active_authorization_policy_delete();

create trigger authorization_policy_activation_history_no_update
before update on authorization_policy_activation_history
for each row execute function reject_authorization_policy_bundle_mutation();

create trigger authorization_policy_activation_history_no_delete
before delete on authorization_policy_activation_history
for each row execute function reject_authorization_policy_bundle_mutation();

comment on table authorization_policy_active is
  'AU-001 singleton active policy pointer. Server-side activation only; no browser RLS policy.';
