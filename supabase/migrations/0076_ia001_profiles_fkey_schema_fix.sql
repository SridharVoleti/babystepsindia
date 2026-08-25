-- 0073_ia001_core_auth_tables.sql intended to repoint profiles_id_fkey
-- from Supabase's built-in auth.users onto this app's own public.users
-- table (the app's real signup/login is custom email/password auth
-- against public.users, not Supabase Auth). Its ALTER TABLE used an
-- unqualified `references users(id)` — confirmed via live introspection
-- (pg_constraint) that this constraint is still pointing at auth.users,
-- even though the sibling CREATE TABLE statements in the same migration
-- (email_verification_tokens, password_reset_tokens) correctly resolved
-- to public.users. Whatever caused the ALTER to resolve differently,
-- the live effect is real: every signUp's createUser() transaction
-- inserts into public.users successfully, then fails the very next
-- insert into profiles with "Key (id)=(...) is not present in table
-- users" — because Postgres is checking against auth.users, which the
-- app never writes to.
--
-- Confirmed via introspection immediately before writing this migration
-- that both profiles and public.users have zero rows in production (no
-- signUp has ever committed past this bug), so repointing the FK is
-- safe. Schema-qualified this time to remove any ambiguity.

begin;

alter table profiles drop constraint if exists profiles_id_fkey;
alter table profiles add constraint profiles_id_fkey
  foreign key (id) references public.users(id) on delete cascade;

commit;
