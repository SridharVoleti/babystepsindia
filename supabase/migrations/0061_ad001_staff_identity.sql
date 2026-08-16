-- AD-001: separate MFA staff identity, capability-based roles, recent
-- reauthentication and immutable audit. Mirrors src/lib/db/schema.sql
-- column for column; see that file's header comment for the dialect
-- mapping (uuid vs text ids, boolean vs 0/1, timestamptz vs text).
--
-- KNOWN FOLLOW-UP (not applied here — no live Supabase deployment exists
-- yet to migrate): every "admin actor" column across earlier migrations
-- (0014 granted_by_admin_id, 0022 activated_by x2, 0027 admin_user_id x2,
-- 0043 actor_admin_id, 0044 administrator_id x2, 0049 administrator_id,
-- 0050 assigned_operator_id/actor_admin_id) still FKs to auth.users(id) —
-- the pre-AD-001 assumption that an admin actor was an is_admin=1 auth
-- user. Post-AD-001 these actor ids are staff_accounts.id values instead,
-- a different id space. src/lib/db/schema.sql's SQLite mirror already
-- dropped the equivalent FK constraints entirely (an unconstrained actor-
-- label column, matching this codebase's existing refund_cases.
-- administrator_id precedent) rather than repointing them, since these
-- columns are widely reused as generic test-fixture actor ids across
-- many unrelated domains and a hard FK proved too costly to maintain.
-- Postgres should follow the same drop-the-FK approach here before any
-- real Supabase environment goes live with staff auth.

create table if not exists staff_accounts (
  id uuid primary key,
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  normalized_email text not null unique,
  display_name text,
  status text not null check(status in ('invited','active','suspended','revoked')),
  authorization_generation bigint not null default 1,
  invited_by_staff_id uuid references staff_accounts(id),
  invitation_expires_at timestamptz,
  activated_at timestamptz,
  suspended_at timestamptz,
  revoked_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table staff_accounts enable row level security;
alter table staff_accounts force row level security;

-- One auth identity can never be both a parent and staff (business rules
-- 4-5, 121-123), enforced both directions so insert order never matters.
create or replace function staff_accounts_no_parent_conflict()
returns trigger as $$
begin
  if exists (select 1 from public.profiles where id = new.auth_user_id) then
    raise exception 'STAFF_AUTH_USER_ALREADY_PARENT';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_staff_accounts_no_parent_conflict
  before insert on staff_accounts
  for each row execute procedure staff_accounts_no_parent_conflict();

create or replace function profiles_no_staff_conflict()
returns trigger as $$
begin
  if exists (select 1 from public.staff_accounts where auth_user_id = new.id) then
    raise exception 'PARENT_AUTH_USER_ALREADY_STAFF';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger trg_profiles_no_staff_conflict
  before insert on profiles
  for each row execute procedure profiles_no_staff_conflict();

-- Skip parent-profile auto-creation for privileged staff provisioning
-- (business rule 119) — a staff auth.users row is created with
-- raw_user_meta_data->>'account_kind' = 'staff' by the server-side
-- staff-provisioning path, never by public signup.
create or replace function handle_new_user()
returns trigger as $$
begin
  if new.raw_user_meta_data ->> 'account_kind' = 'staff' then
    return new;
  end if;
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create table if not exists staff_role_assignments (
  id uuid primary key,
  staff_account_id uuid not null references staff_accounts(id) on delete cascade,
  role_key text not null check(role_key in
    ('support_agent','billing_administrator','operations_administrator','platform_administrator')),
  role_version integer not null default 1,
  assigned_by_staff_id uuid references staff_accounts(id),
  assigned_at timestamptz not null,
  removed_at timestamptz
);
create unique index if not exists idx_staff_role_assignments_active
  on staff_role_assignments(staff_account_id, role_key) where removed_at is null;
create index if not exists idx_staff_role_assignments_staff
  on staff_role_assignments(staff_account_id);
alter table staff_role_assignments enable row level security;
alter table staff_role_assignments force row level security;

create table if not exists staff_passkey_credentials (
  id uuid primary key,
  staff_account_id uuid not null references staff_accounts(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  sign_count bigint not null default 0,
  transports_json text not null default '[]',
  device_type text not null,
  backed_up boolean not null default false,
  label text not null,
  status text not null check(status in ('active','revoked')),
  created_at timestamptz not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  revocation_reason text
);
create index if not exists idx_staff_passkey_credentials_staff
  on staff_passkey_credentials(staff_account_id,status);
alter table staff_passkey_credentials enable row level security;
alter table staff_passkey_credentials force row level security;

create table if not exists staff_auth_challenges (
  id uuid primary key,
  purpose text not null check(purpose in ('login','register','reauth')),
  staff_account_id uuid not null references staff_accounts(id) on delete cascade,
  challenge_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index if not exists idx_staff_auth_challenges_expiry
  on staff_auth_challenges(expires_at,consumed_at);
alter table staff_auth_challenges enable row level security;
alter table staff_auth_challenges force row level security;

create table if not exists staff_reauth_receipts (
  id uuid primary key,
  staff_session_id text not null,
  staff_account_id uuid not null references staff_accounts(id) on delete cascade,
  reauth_at timestamptz not null,
  valid_until timestamptz not null,
  factors_json text not null default '{}'
);
create index if not exists idx_staff_reauth_receipts_session
  on staff_reauth_receipts(staff_session_id,valid_until);
alter table staff_reauth_receipts enable row level security;
alter table staff_reauth_receipts force row level security;

create table if not exists staff_audit_log (
  id uuid primary key,
  actor_staff_account_id uuid references staff_accounts(id),
  target_staff_account_id uuid references staff_accounts(id),
  canonical_action text not null,
  resource_type text,
  resource_safe_id text,
  reason text,
  result text not null,
  request_id text,
  policy_version integer,
  role_version integer,
  created_at timestamptz not null default now()
);
create index if not exists idx_staff_audit_log_actor
  on staff_audit_log(actor_staff_account_id,created_at);
alter table staff_audit_log enable row level security;
alter table staff_audit_log force row level security;

create table if not exists staff_mutation_requests (
  actor_staff_account_id uuid not null references staff_accounts(id),
  idempotency_key text not null,
  canonical_action text not null,
  target_staff_account_id uuid not null references staff_accounts(id),
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  response_json text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (actor_staff_account_id, idempotency_key)
);
alter table staff_mutation_requests enable row level security;
alter table staff_mutation_requests force row level security;

-- Down migration (apply manually to reverse):
--
-- drop table if exists staff_mutation_requests;
-- drop table if exists staff_audit_log;
-- drop table if exists staff_reauth_receipts;
-- drop table if exists staff_auth_challenges;
-- drop table if exists staff_passkey_credentials;
-- drop table if exists staff_role_assignments;
-- drop trigger if exists trg_profiles_no_staff_conflict on profiles;
-- drop function if exists profiles_no_staff_conflict();
-- drop trigger if exists trg_staff_accounts_no_parent_conflict on staff_accounts;
-- drop function if exists staff_accounts_no_parent_conflict();
-- drop table if exists staff_accounts;
-- create or replace function handle_new_user()
-- returns trigger as $$
-- begin
--   insert into public.profiles (id, display_name)
--   values (new.id, new.raw_user_meta_data ->> 'display_name')
--   on conflict (id) do nothing;
--   return new;
-- end;
-- $$ language plpgsql security definer set search_path = public;
