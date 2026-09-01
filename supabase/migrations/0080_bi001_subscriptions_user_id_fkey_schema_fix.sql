-- Same recurring bug as 0076_ia001_profiles_fkey_schema_fix.sql and
-- 0077_ad001_staff_accounts_fkey_schema_fix.sql: 0003_subscriptions.sql
-- pointed subscriptions.user_id at Supabase's built-in auth.users(id),
-- written before this app pivoted to fully custom email/password auth
-- against its own public.users table. bi001-service.ts's own checkout
-- path (createCheckoutIntent) inserts subscriptions.user_id = the
-- purchaser's public.users id, which this app's custom auth never writes
-- to auth.users -- so the very first real checkout attempt fails this FK
-- outright. Confirmed via live introspection immediately before writing
-- this migration that subscriptions and checkout_intents both have zero
-- rows in production, so repointing the FK is safe.

begin;

alter table subscriptions drop constraint if exists subscriptions_user_id_fkey;
alter table subscriptions add constraint subscriptions_user_id_fkey
  foreign key (user_id) references public.users(id) on delete cascade;

commit;
