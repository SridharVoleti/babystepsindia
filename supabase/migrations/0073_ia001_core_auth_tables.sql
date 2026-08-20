-- Backfill for the app's own password-based auth tables. 0001_profiles.sql
-- was written assuming Supabase's built-in Auth (profiles.id referencing
-- auth.users(id)), but the app's actual signup/login (src/lib/db/users.ts)
-- implements its own email/password auth against a self-managed `users`
-- table (mirrors src/lib/db/schema.sql) — that table was never created in
-- this project, and nothing else in supabase/migrations/*.sql creates it
-- either. This is why production signUp fails with
-- 'relation "users" does not exist'.
--
-- Confirmed via introspection immediately before writing this migration
-- that `profiles` has zero rows in production, so repointing its FK below
-- is safe — there are no existing rows that could violate it.

begin;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  email_verified_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists email_verification_tokens (
  token uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists password_reset_tokens (
  token uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table profiles drop constraint if exists profiles_id_fkey;
alter table profiles add constraint profiles_id_fkey
  foreign key (id) references users(id) on delete cascade;

commit;

-- Down migration (apply manually to reverse):
--
-- begin;
-- alter table profiles drop constraint if exists profiles_id_fkey;
-- alter table profiles add constraint profiles_id_fkey
--   foreign key (id) references auth.users(id) on delete cascade;
-- drop table if exists password_reset_tokens;
-- drop table if exists email_verification_tokens;
-- drop table if exists users;
-- commit;
