-- IA-001 — email/password parent registration and login.
-- Adds the profile_type/account_status/onboarding_status/locale/timezone
-- columns the requirement's data model calls for, and makes the
-- auth.users -> profiles trigger explicitly idempotent (ON CONFLICT DO
-- NOTHING) so replayed signup callbacks can never create a duplicate row.
--
-- Mirrors src/lib/db/schema.sql (the local SQLite dev stand-in) column
-- for column; see that file's header comment for the dialect mapping.

alter table profiles
  add column profile_type text not null default 'parent'
    check (profile_type = 'parent');

alter table profiles
  add column account_status text not null default 'active'
    check (account_status in ('active','suspended','deleted'));

alter table profiles
  add column onboarding_status text not null default 'profile_pending'
    check (onboarding_status in ('profile_pending','learner_pending','complete'));

alter table profiles
  add column locale text not null default 'en-IN';

alter table profiles
  add column timezone text not null default 'Asia/Kolkata';

-- Replace handle_new_user() with an idempotent version: ON CONFLICT DO
-- NOTHING means a replayed trigger fire (or any retry that races a
-- recovery upsert) is a no-op instead of an error or a duplicate row.
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name')
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger profiles_set_updated_at
  before update on profiles
  for each row execute procedure set_updated_at();

-- Down migration (apply manually to reverse):
--
-- drop trigger if exists profiles_set_updated_at on profiles;
-- drop function if exists set_updated_at();
-- create or replace function handle_new_user()
-- returns trigger as $$
-- begin
--   insert into public.profiles (id, display_name)
--   values (new.id, new.raw_user_meta_data ->> 'display_name');
--   return new;
-- end;
-- $$ language plpgsql security definer set search_path = public;
-- alter table profiles drop column timezone;
-- alter table profiles drop column locale;
-- alter table profiles drop column onboarding_status;
-- alter table profiles drop column account_status;
-- alter table profiles drop column profile_type;
