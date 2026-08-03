-- IA-002 — mandatory parent mobile number with optional display name.
-- Mirrors src/lib/db/schema.sql column for column.

alter table profiles
  add column phone_e164 text;

alter table profiles
  add column phone_country_code text;

-- Superseded by consent_records: same purpose (record Terms/Privacy
-- acceptance with a version and timestamp) but with the unique
-- (parent, type, version) constraint IA-002 requires for idempotent
-- repeated submissions (AC13). consent_acceptances was created in 0008
-- and never used outside this repo, so it's safe to replace outright
-- rather than carry two consent tables forward.
drop table if exists consent_acceptances;

create table consent_records (
  id uuid primary key default gen_random_uuid(),
  parent_user_id uuid not null references profiles(id) on delete cascade,
  consent_type text not null check (consent_type in ('terms_of_service','privacy_policy')),
  policy_version text not null,
  granted boolean not null default true,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (parent_user_id, consent_type, policy_version)
);

alter table consent_records enable row level security;

create policy "consent records are readable by owner"
  on consent_records for select
  using (auth.uid() = parent_user_id);

-- Down migration (apply manually to reverse):
--
-- drop table if exists consent_records;
-- create table consent_acceptances (
--   id uuid primary key default gen_random_uuid(),
--   user_id uuid not null references auth.users(id) on delete cascade,
--   policy_type text not null check (policy_type in ('terms','privacy')),
--   policy_version text not null,
--   accepted_at timestamptz not null default now()
-- );
-- alter table consent_acceptances enable row level security;
-- create policy "consent acceptances are readable by owner"
--   on consent_acceptances for select
--   using (auth.uid() = user_id);
-- alter table profiles drop column phone_country_code;
-- alter table profiles drop column phone_e164;
