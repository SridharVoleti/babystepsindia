-- ============================================================
-- Babysteps Platform — reset the public schema before rerunning
-- setup_all.sql against a Supabase project that already has a
-- partial/failed apply sitting in it.
--
-- Drops every table/function/view etc. in the `public` schema
-- (never touches Supabase's own `auth`/`storage`/`extensions`
-- schemas) and restores the default grants Supabase provisions
-- on a brand-new project, so setup_all.sql can run against a
-- clean slate.
-- ============================================================

drop schema if exists public cascade;
create schema public;

grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres, service_role;

alter default privileges in schema public grant all on tables to postgres, service_role;
alter default privileges in schema public grant all on functions to postgres, service_role;
alter default privileges in schema public grant all on sequences to postgres, service_role;

alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
