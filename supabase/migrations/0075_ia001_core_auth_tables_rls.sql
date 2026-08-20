-- 0073_ia001_core_auth_tables.sql created users/email_verification_tokens/
-- password_reset_tokens but never enabled Row Level Security on them,
-- unlike every other table in this codebase (see access-boundaries.ts's
-- supabaseTableAccess registry, which classifies all three "server_only" —
-- no PostgREST policy is ever meant to exist for them; only the app's own
-- trusted backend connection via SUPABASE_DB_URL reads/writes them).
--
-- Live-database audit on 2026-08-20 found relrowsecurity already true on
-- all three (something — most likely Supabase Studio's own
-- "enable RLS on new tables" default — turned it on out of band, so this
-- was not an active exposure: RLS enabled + zero policies already means
-- default-deny for anon/authenticated). relforcerowsecurity was false,
-- unlike every other server_only table's migration (e.g. entitlement_cycles,
-- staff_accounts). This migration brings all three in line with that
-- established convention and with what access-boundaries.ts now declares.

begin;

alter table users enable row level security;
alter table users force row level security;

alter table email_verification_tokens enable row level security;
alter table email_verification_tokens force row level security;

alter table password_reset_tokens enable row level security;
alter table password_reset_tokens force row level security;

commit;

-- Down migration (apply manually to reverse):
--
-- begin;
-- alter table password_reset_tokens no force row level security;
-- alter table email_verification_tokens no force row level security;
-- alter table users no force row level security;
-- commit;
