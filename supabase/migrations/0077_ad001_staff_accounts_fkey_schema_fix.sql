-- 0061_ad001_staff_identity.sql pointed staff_accounts.auth_user_id at
-- Supabase's built-in auth.users(id), written before this app pivoted to
-- fully custom email/password auth against its own public.users table
-- (0073_ia001_core_auth_tables.sql, later confirmed in
-- 0076_ia001_profiles_fkey_schema_fix.sql — the same "still points at
-- auth.users, should point at public.users" bug, there for profiles).
-- staff-identity/auth-service.ts's own sign-in query
-- (`select password_hash from users where id=?`) already assumes
-- staff_accounts.auth_user_id resolves against public.users, not
-- Supabase Auth, which this app's custom auth never writes to — so any
-- attempt to create a staff account (e.g. the first-admin bootstrap)
-- fails this FK check outright in production.
--
-- Confirmed via live introspection immediately before writing this
-- migration that staff_accounts and staff_role_assignments both have
-- zero rows in production (no staff account has ever been created), so
-- repointing the FK is safe. Schema-qualified to match 0076's fix.

begin;

alter table staff_accounts drop constraint if exists staff_accounts_auth_user_id_fkey;
alter table staff_accounts add constraint staff_accounts_auth_user_id_fkey
  foreign key (auth_user_id) references public.users(id) on delete cascade;

commit;
