-- ============================================================
-- Babysteps Platform — consolidated Supabase setup script
-- Generated from supabase/migrations/*.sql, concatenated in
-- filename order (the same order the individual migrations
-- were written/applied in). Safe to run once against a fresh
-- Supabase project's SQL editor.
-- ============================================================


-- ============================================================
-- Source: supabase/migrations/0001_profiles.sql
-- ============================================================
-- REQ-08 §3.1 — one row per user, no parent/child modeling.

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "profiles are readable by owner"
  on profiles for select
  using (auth.uid() = id);

-- Keep profiles in lockstep with auth.users so every signup path
-- (password, magic link, OAuth) ends up with a row here.
create function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, new.raw_user_meta_data ->> 'display_name');
  return new;
end;
$$ language plpgsql security definer set search_path = public;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure handle_new_user();


-- ============================================================
-- Source: supabase/migrations/0002_products.sql
-- ============================================================
-- REQ-08 §3.2 — the product registry. New products are rows, not code.

create table products (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,             -- 'chess', 'magical-math', 'speed-reading'
  name text not null,
  subdomain text not null,               -- 'chess.babysteps.in'
  razorpay_plan_id text not null,        -- single-product plan
  price_inr integer not null,
  status text not null default 'active'  -- active | coming_soon | archived
    check (status in ('active','coming_soon','archived')),
  created_at timestamptz not null default now()
);

alter table products enable row level security;

create policy "products are publicly readable"
  on products for select
  using (true);


-- ============================================================
-- Source: supabase/migrations/0003_subscriptions.sql
-- ============================================================
-- REQ-08 §3.3 — multi-entitlement model. A user may hold several
-- single-product rows or one bundle row.

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('bundle','single')),
  product_id uuid references products(id),   -- null when type = 'bundle'
  status text not null default 'active'
    check (status in ('active','cancelling','cancelled','expired','past_due')),
  cancel_at_period_end boolean not null default false,
  razorpay_subscription_id text unique not null,
  started_at timestamptz not null default now(),
  current_period_end timestamptz not null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint single_requires_product
    check (type = 'bundle' or product_id is not null)
);

create index idx_subscriptions_user on subscriptions(user_id);
create index idx_subscriptions_product on subscriptions(product_id);
create index idx_subscriptions_status on subscriptions(status);

alter table subscriptions enable row level security;

create policy "subscriptions are readable by owner"
  on subscriptions for select
  using (auth.uid() = user_id);

-- No insert/update/delete policy for regular users: subscriptions are
-- written only by the (service-role) webhook handler and admin actions.


-- ============================================================
-- Source: supabase/migrations/0004_payments.sql
-- ============================================================
-- REQ-08 §3.4 — one row per actual charge. Reporting is built from this
-- table, never from `subscriptions`.

create table payments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  amount_inr integer not null,
  razorpay_payment_id text unique not null,
  paid_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index idx_payments_paid_at on payments(paid_at);
create index idx_payments_subscription on payments(subscription_id);

alter table payments enable row level security;

create policy "payments are readable by owner"
  on payments for select
  using (
    exists (
      select 1 from subscriptions s
      where s.id = payments.subscription_id
        and s.user_id = auth.uid()
    )
  );

-- Written only by the (service-role) webhook handler.


-- ============================================================
-- Source: supabase/migrations/0005_entitlement_function.sql
-- ============================================================
-- REQ-08 §3.5 — single shared function; every access decision, including
-- the JWT claims generator (§4.1), calls this.

create or replace function fn_has_product_access(p_user_id uuid, p_product_slug text)
returns boolean as $$
  select exists (
    select 1
    from subscriptions s
    join products p on p.slug = p_product_slug
    where s.user_id = p_user_id
      and s.status in ('active','cancelling','past_due')
      and (
        s.type = 'bundle'
        or s.product_id = p.id
      )
      and s.current_period_end > now()
  );
$$ language sql stable security definer;


-- ============================================================
-- Source: supabase/migrations/0006_subscription_audit_log.sql
-- ============================================================
-- REQ-08 §7 — safety net for "webhook silently failed", since there is no
-- local double-verification in product apps.

create table subscription_audit_log (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references subscriptions(id),
  changed_by text not null,        -- 'webhook' | 'admin:<email>' | 'system:cron'
  change_type text not null,       -- 'created' | 'status_change' | 'manual_override'
  old_status text,
  new_status text,
  note text,
  created_at timestamptz not null default now()
);

alter table subscription_audit_log enable row level security;

-- No public policies: readable/writable only via service role (admin
-- dashboard, webhook handler).


-- ============================================================
-- Source: supabase/migrations/0007_reporting_views.sql
-- ============================================================
-- REQ-08 §8 — admin reporting dashboard views.

create view v_daily_revenue_by_product as
select
  date_trunc('day', p.paid_at) as day,
  coalesce(pr.slug, 'bundle') as product_slug,
  sum(p.amount_inr) as revenue_inr,
  count(*) as payment_count
from payments p
join subscriptions s on s.id = p.subscription_id
left join products pr on pr.id = s.product_id
group by 1, 2;

create view v_active_subscribers_by_product as
select
  coalesce(pr.slug, 'bundle') as product_slug,
  count(*) as active_subscribers
from subscriptions s
left join products pr on pr.id = s.product_id
where s.status in ('active','cancelling')
group by 1;

-- Views inherit RLS from their underlying tables only when
-- security_invoker is set; the admin dashboard queries these with the
-- service-role key, so that's the intended access path rather than
-- per-row policies here.


-- ============================================================
-- Source: supabase/migrations/0008_ia001_parent_profile_status.sql
-- ============================================================
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

-- IA-001 security note: "Record privacy and terms acceptance separately
-- with policy version and timestamp" — independent of auth.users/Auth
-- metadata so it remains the authoritative consent record.
create table consent_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  policy_type text not null check (policy_type in ('terms','privacy')),
  policy_version text not null,
  accepted_at timestamptz not null default now()
);

alter table consent_acceptances enable row level security;

create policy "consent acceptances are readable by owner"
  on consent_acceptances for select
  using (auth.uid() = user_id);

-- Down migration (apply manually to reverse):
--
-- drop table if exists consent_acceptances;
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


-- ============================================================
-- Source: supabase/migrations/0009_ia002_parent_phone_consent.sql
-- ============================================================
-- IA-002 — mandatory parent mobile number with optional display name.
-- Mirrors src/lib/db/schema.sql column for column.

alter table profiles
  add column phone_e164 text;

alter table profiles
  add column phone_country_code text;

-- BR-003: reviewed-breaking-change
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


-- ============================================================
-- Source: supabase/migrations/0010_ia003_account_security.sql
-- ============================================================
-- IA-003 — parent credential changes and soft account deletion.
-- Mirrors src/lib/db/schema.sql column for column.

alter table profiles
  add column deleted_at timestamptz;

alter table profiles
  add column deleted_by_user_id uuid;

-- Authoritative "sessions issued at or before this instant are invalid"
-- gate — checked against the session JWT's iat even after account_status
-- is later restored to 'active' by an admin, which is what forces a
-- fresh login post-restore (business rule 14) without needing a separate
-- session-revocation table.
alter table profiles
  add column auth_revoked_before timestamptz;

-- Mirrors Supabase's own email_change flow so the product can show
-- pending state/expiry/resend/cancel — Supabase doesn't expose that as
-- queryable state itself. Only one row may be 'pending' per parent; a new
-- request cancels the previous one first rather than being blocked by it.
create table email_change_requests (
  id uuid primary key default gen_random_uuid(),
  parent_user_id uuid not null references profiles(id) on delete cascade,
  old_email text not null,
  new_email text not null,
  status text not null default 'pending'
    check (status in ('pending','verified','expired','cancelled')),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  verified_at timestamptz,
  cancelled_at timestamptz,
  supabase_request_nonce text
);

create unique index idx_email_change_requests_one_pending
  on email_change_requests(parent_user_id)
  where status = 'pending';

alter table email_change_requests enable row level security;

create policy "email change requests are readable by owner"
  on email_change_requests for select
  using (auth.uid() = parent_user_id);

-- Append-only.
create table parent_email_history (
  id uuid primary key default gen_random_uuid(),
  parent_user_id uuid not null references profiles(id) on delete cascade,
  email text not null,
  archived_at timestamptz not null default now(),
  reason text not null default 'email_changed'
);

alter table parent_email_history enable row level security;

create policy "parent email history is readable by owner"
  on parent_email_history for select
  using (auth.uid() = parent_user_id);

-- Lightweight, queryable audit trail (no message broker in this stack).
-- Never stores passwords or tokens (AC15) — metadata is a small JSON blob
-- of non-sensitive context.
create table account_events (
  id uuid primary key default gen_random_uuid(),
  parent_user_id uuid not null references profiles(id) on delete cascade,
  event_type text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create index idx_account_events_parent on account_events(parent_user_id);

alter table account_events enable row level security;

create policy "account events are readable by owner"
  on account_events for select
  using (auth.uid() = parent_user_id);

-- Down migration (apply manually to reverse):
--
-- drop table if exists account_events;
-- drop table if exists parent_email_history;
-- drop table if exists email_change_requests;
-- alter table profiles drop column auth_revoked_before;
-- alter table profiles drop column deleted_by_user_id;
-- alter table profiles drop column deleted_at;


-- ============================================================
-- Source: supabase/migrations/0011_lp001_learners.sql
-- ============================================================
-- LP-001: permanent, directly parent-owned learner profiles.

create table approved_avatars (
  id text primary key,
  label text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table learners (
  id uuid primary key default gen_random_uuid(),
  owner_parent_id uuid not null references profiles(id),
  display_name text not null,
  normalized_display_name text not null,
  date_of_birth date not null,
  avatar_id text references approved_avatars(id),
  version integer not null default 1 check (version > 0),
  locale text not null,
  timezone text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_parent_id, normalized_display_name)
);

create index idx_learners_owner on learners(owner_parent_id);

create trigger learners_set_updated_at
  before update on learners
  for each row execute procedure set_updated_at();

create table learner_creation_requests (
  parent_user_id uuid not null references profiles(id),
  idempotency_key uuid not null,
  request_hash text not null,
  learner_id uuid references learners(id),
  status text not null check (status in ('processing','completed','failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (parent_user_id, idempotency_key)
);

create index idx_learner_creation_requests_status
  on learner_creation_requests(status, created_at);

alter table approved_avatars enable row level security;
alter table learners enable row level security;
alter table learner_creation_requests enable row level security;

create policy "active parents can read approved avatars"
  on approved_avatars for select
  using (
    active and exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.account_status = 'active'
    )
  );

create policy "active parents can read owned learners"
  on learners for select
  using (
    owner_parent_id = auth.uid() and exists (
      select 1 from profiles
      where profiles.id = auth.uid() and profiles.account_status = 'active'
    )
  );

-- Learner writes and idempotency rows are intentionally service-only. The
-- transaction service derives owner_parent_id from the verified session;
-- browser clients have no INSERT/UPDATE policy and therefore fail closed.

-- Down migration (apply manually to reverse):
-- drop table if exists learner_creation_requests;
-- drop trigger if exists learners_set_updated_at on learners;
-- drop table if exists learners;
-- drop table if exists approved_avatars;


-- ============================================================
-- Source: supabase/migrations/0012_lp002_learner_profile_updates.sql
-- ============================================================
-- LP-002: optimistic, parent+learner-scoped correction idempotency.
create table learner_profile_update_requests (
  parent_user_id uuid not null references profiles(id),
  learner_id uuid not null references learners(id),
  idempotency_key uuid not null,
  request_hash text not null,
  expected_version integer not null check (expected_version > 0),
  result_version integer,
  status text not null check (status in ('processing','completed','failed')),
  response_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (parent_user_id, learner_id, idempotency_key)
);

create index idx_learner_profile_update_requests_status
  on learner_profile_update_requests(status, created_at);

alter table learner_profile_update_requests enable row level security;

-- No browser policies: the server transaction is the sole writer/reader.

-- Down migration (apply manually to reverse):
-- drop table if exists learner_profile_update_requests;


-- ============================================================
-- Source: supabase/migrations/0013_ar001_app_registry.sql
-- ============================================================
-- AR-001 — admin-managed canonical app registration and soft deletion.
-- Mirrors src/lib/db/schema.sql column for column.

create table app_registry (
  id uuid primary key default gen_random_uuid(),
  app_key text not null unique
    check (app_key ~ '^[a-z][a-z0-9-]{1,49}$'),
  display_name text not null
    check (char_length(display_name) between 1 and 80),
  short_description text
    check (short_description is null or char_length(short_description) between 1 and 240),
  icon_asset_key text,
  category text,
  owning_team text,
  internal_notes text,
  registry_status text not null default 'draft'
    check (registry_status in ('draft','active','soft_deleted')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz,
  soft_deleted_at timestamptz,
  soft_delete_reason_code text
);

create index idx_app_registry_status on app_registry(registry_status);

alter table app_registry enable row level security;

-- Safe-metadata read policy: anyone (including anon/learning-app
-- credentials) may read active apps' non-sensitive columns. internal_notes
-- is excluded at the application/query layer (the safe read model never
-- selects it), not by RLS column masking — Postgres RLS is row-level only.
create policy "active apps are readable"
  on app_registry for select
  using (registry_status = 'active');

-- No insert/update/delete policy for anon/authenticated: all mutation
-- goes through the service-role-backed admin API, never client-side.

-- Admin-scoped idempotency for every registry mutation (create/edit/
-- activate/soft-delete/restore share one table, distinguished by
-- `operation`).
create table app_registry_mutation_requests (
  admin_user_id uuid not null,
  idempotency_key uuid not null,
  operation text not null
    check (operation in ('create','edit','activate','soft_delete','restore')),
  app_id uuid references app_registry(id),
  request_hash text not null,
  result_app_id uuid,
  result_version integer,
  status text not null check (status in ('processing','completed','failed')),
  safe_response_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (admin_user_id, idempotency_key)
);

alter table app_registry_mutation_requests enable row level security;

-- Minimal local stand-in for the "approved platform asset registry"
-- AR-001 assumes exists (business rule 8).
create table approved_app_icons (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table approved_app_icons enable row level security;

create policy "approved app icons are readable"
  on approved_app_icons for select
  using (true);

-- Minimal, queryable audit trail (business rule 32 / AC25/AC30): IDs,
-- key, operation, admin, reason code, version transition, timestamp
-- only — never a full metadata snapshot.
create table app_registry_audit_log (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null,
  app_key text not null,
  operation text not null,
  admin_user_id uuid not null,
  reason_code text,
  version_from integer,
  version_to integer,
  created_at timestamptz not null default now()
);

create index idx_app_registry_audit_log_app on app_registry_audit_log(app_id);

alter table app_registry_audit_log enable row level security;

-- Granular admin permissions layered on top of the existing coarse
-- "is platform admin" flag.
create table admin_permissions (
  user_id uuid not null references auth.users(id) on delete cascade,
  permission text not null,
  granted_at timestamptz not null default now(),
  primary key (user_id, permission)
);

alter table admin_permissions enable row level security;

-- Down migration (apply manually to reverse):
--
-- drop table if exists admin_permissions;
-- drop table if exists app_registry_audit_log;
-- drop table if exists approved_app_icons;
-- drop table if exists app_registry_mutation_requests;
-- drop table if exists app_registry;


-- ============================================================
-- Source: supabase/migrations/0014_lp004_learning_sessions.sql
-- ============================================================
-- LP-004 learner selection and server-authoritative learning-session gateway.
create table learner_selection_contexts (
  parent_session_id uuid primary key,
  parent_user_id uuid not null references profiles(id),
  selected_learner_id uuid not null references learners(id),
  selected_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index idx_learner_selection_contexts_expiry on learner_selection_contexts(expires_at);

create table learner_app_week_usage (
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id),
  week_key text not null,
  week_timezone text not null,
  normal_sessions_started smallint not null default 0 check (normal_sessions_started between 0 and 2),
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (learner_id, app_id, week_key)
);

create table learner_sessions (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id),
  parent_user_id uuid not null references profiles(id),
  parent_session_id uuid,
  device_session_id uuid not null,
  week_key text not null,
  week_timezone text not null,
  weekly_slot_number smallint check (weekly_slot_number in (1,2)),
  replacement_credit_id uuid,
  source text not null check (source in ('normal','replacement')),
  status text not null check (status in ('starting','active','disconnected','completed','interrupted','expired','revoked_by_admin')),
  schedule_authorization_id text not null,
  started_at timestamptz not null,
  last_heartbeat_at timestamptz not null,
  disconnected_at timestamptz,
  resume_deadline timestamptz,
  cumulative_disconnected_seconds integer not null default 0 check (cumulative_disconnected_seconds between 0 and 900),
  connected_elapsed_seconds integer not null default 0 check (connected_elapsed_seconds between 0 and 2700),
  verified_active_seconds integer not null default 0 check (verified_active_seconds >= 0),
  heartbeat_sequence bigint not null default 0,
  resume_token_hash text not null,
  ended_at timestamptz,
  end_reason text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((source='normal' and weekly_slot_number is not null and replacement_credit_id is null)
    or (source='replacement' and weekly_slot_number is null and replacement_credit_id is not null))
);
create unique index idx_learner_sessions_one_reserved on learner_sessions(learner_id)
  where status in ('starting','active','disconnected');
create unique index idx_learner_sessions_normal_slot
  on learner_sessions(learner_id,app_id,week_key,weekly_slot_number) where source='normal';

create table session_start_requests (
  actor_session_id uuid not null,
  learner_id uuid not null references learners(id),
  idempotency_key uuid not null,
  request_hash text not null,
  session_id uuid references learner_sessions(id),
  status text not null check (status in ('processing','completed','failed')),
  safe_response_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(actor_session_id,learner_id,idempotency_key)
);

create table session_replacement_credits (
  id uuid primary key default gen_random_uuid(),
  original_session_id uuid not null unique references learner_sessions(id),
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id),
  granted_by_admin_id uuid not null references auth.users(id),
  reason_code text not null,
  evidence_summary text not null,
  granted_at timestamptz not null default now(),
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'available' check (status in ('available','consumed','expired','revoked')),
  consumed_session_id uuid unique references learner_sessions(id),
  consumed_at timestamptz
);
alter table learner_sessions add constraint learner_sessions_replacement_credit_fk
  foreign key (replacement_credit_id) references session_replacement_credits(id);
create unique index idx_learner_sessions_credit on learner_sessions(replacement_credit_id)
  where replacement_credit_id is not null;

alter table learner_selection_contexts enable row level security;
alter table learner_app_week_usage enable row level security;
alter table learner_sessions enable row level security;
alter table session_start_requests enable row level security;
alter table session_replacement_credits enable row level security;
-- Server gateway only: no direct browser mutation policies.

-- Down migration (apply manually to reverse):
-- alter table learner_sessions drop constraint learner_sessions_replacement_credit_fk;
-- drop table if exists session_replacement_credits;
-- drop table if exists session_start_requests;
-- drop table if exists learner_sessions;
-- drop table if exists learner_app_week_usage;
-- drop table if exists learner_selection_contexts;


-- ============================================================
-- Source: supabase/migrations/0015_an001_analytics.sql
-- ============================================================
-- AN-001 — minimal-data daily analytics aggregation. Mirrors
-- src/lib/db/schema.sql column for column. Row Level Security is enabled
-- on every table below with no anon/authenticated policies: all reads and
-- writes go through the service-role-backed internal/admin APIs, never
-- client-side (business rule 31/AC31).

-- Temporary pseudonymous source data. learner_daily_key is an HMAC over
-- (learner_id, activity_date) with a dedicated analytics secret (business
-- rule 6) — never the raw learner UUID. Deleted in full once its date's
-- run completes (business rule 25).
create table analytics_daily_buffer (
  activity_date date not null,
  learner_daily_key text not null,
  app_id uuid not null references app_registry(id) on delete restrict,
  level_key text not null,
  age_band text not null check (age_band in
    ('under_6','6_7','8_9','10_12','13_15','16_18','19_29','30_49','50_plus')),
  engaged_seconds integer not null default 0 check (engaged_seconds >= 0),
  sessions_started integer not null default 0 check (sessions_started >= 0),
  sessions_completed integer not null default 0 check (sessions_completed >= 0),
  sessions_interrupted integer not null default 0 check (sessions_interrupted >= 0),
  lessons_completed integer not null default 0 check (lessons_completed >= 0),
  updated_at timestamptz not null default now(),
  primary key (activity_date, learner_daily_key, app_id, level_key)
);

create index idx_analytics_daily_buffer_date on analytics_daily_buffer(activity_date);

alter table analytics_daily_buffer enable row level security;

-- Exact-once contribution tracking (business rule 11). Deleted together
-- with its date's buffer rows once the run completes (business rule 6).
create table analytics_contribution_receipts (
  contribution_id text primary key,
  activity_date date not null,
  created_at timestamptz not null default now()
);

create index idx_analytics_contribution_receipts_date
  on analytics_contribution_receipts(activity_date);

alter table analytics_contribution_receipts enable row level security;

-- Permanent, anonymous. No learner/parent identifier of any kind — grain
-- is date + app + level + age band only (business rule 5, 18).
create table analytics_daily_level (
  activity_date date not null,
  app_id uuid not null references app_registry(id) on delete restrict,
  level_key text not null,
  age_band text not null,
  active_learners integer not null default 0,
  sessions_started integer not null default 0,
  sessions_completed integer not null default 0,
  sessions_interrupted integer not null default 0,
  engaged_seconds integer not null default 0,
  lessons_completed integer not null default 0,
  generated_at timestamptz not null,
  run_version integer not null default 1,
  primary key (activity_date, app_id, level_key, age_band)
);

alter table analytics_daily_level enable row level security;

-- Same grain as analytics_daily_level but rolled up to app+age_band so a
-- learner active across several levels in one day is counted once
-- (business rule 19 / AT-AN-001-12), not once per level.
create table analytics_daily_app (
  activity_date date not null,
  app_id uuid not null references app_registry(id) on delete restrict,
  age_band text not null,
  active_learners integer not null default 0,
  sessions_started integer not null default 0,
  sessions_completed integer not null default 0,
  sessions_interrupted integer not null default 0,
  engaged_seconds integer not null default 0,
  lessons_completed integer not null default 0,
  generated_at timestamptz not null,
  run_version integer not null default 1,
  primary key (activity_date, app_id, age_band)
);

alter table analytics_daily_app enable row level security;

-- Run tracking/lock (business rules 16, 17, 26). Deliberately holds only
-- control totals and status — no learner information, ever.
create table analytics_daily_runs (
  activity_date date primary key,
  status text not null check (status in ('running','completed','failed')),
  run_version integer not null default 1,
  source_row_count integer not null default 0,
  source_engaged_seconds integer not null default 0,
  source_sessions_started integer not null default 0,
  source_sessions_completed integer not null default 0,
  source_sessions_interrupted integer not null default 0,
  source_lessons_completed integer not null default 0,
  started_at timestamptz not null,
  completed_at timestamptz,
  failure_code text
);

alter table analytics_daily_runs enable row level security;

-- Minimal admin-alert stand-in for "an administrator alert is emitted"
-- (business rule 24). Never carries learner information.
create table platform_alerts (
  id uuid primary key default gen_random_uuid(),
  alert_type text not null,
  message text not null,
  metadata jsonb,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

alter table platform_alerts enable row level security;

-- AN-001 business rule 29: current state only, one row per learner+app,
-- overwritten in place — deliberately not append-only/versioned history.
create table learner_app_progress (
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  current_level_key text,
  current_lesson_key text,
  current_engaged_seconds integer not null default 0 check (current_engaged_seconds >= 0),
  app_state jsonb,
  schema_version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (learner_id, app_id)
);

alter table learner_app_progress enable row level security;

-- AN-001 business rule 30: one row per learner/app/lesson. completion_id
-- is the caller's deterministic idempotency key so a retried submission
-- neither duplicates the row nor double-counts into the buffer.
create table lesson_completions (
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  lesson_key text not null,
  completion_id text not null unique,
  level_key text not null,
  completed_at timestamptz not null,
  engaged_seconds integer not null default 0 check (engaged_seconds >= 0),
  result text,
  primary key (learner_id, app_id, lesson_key)
);

alter table lesson_completions enable row level security;

-- Down migration (apply manually to reverse):
--
-- drop table if exists lesson_completions;
-- drop table if exists learner_app_progress;
-- drop table if exists platform_alerts;
-- drop table if exists analytics_daily_runs;
-- drop table if exists analytics_daily_app;
-- drop table if exists analytics_daily_level;
-- drop table if exists analytics_contribution_receipts;
-- drop table if exists analytics_daily_buffer;


-- ============================================================
-- Source: supabase/migrations/0016_la001_app_launch.sql
-- ============================================================
-- LA-001 deployment pinning belongs to the LP-004 session and cannot be
-- supplied or changed by the launching browser.
alter table learner_sessions add column if not exists deployment_id uuid;
alter table learner_sessions add column if not exists release_id uuid;
alter table learner_sessions add column if not exists deployment_environment text;
alter table learner_sessions add column if not exists deployment_origin text;
alter table learner_sessions add column if not exists launch_path text;
alter table learner_sessions add column if not exists session_expires_at timestamptz;

create table if not exists learner_session_launch_state (
  learner_session_id uuid primary key references learner_sessions(id) on delete cascade,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  deployment_id uuid not null,
  release_id uuid not null,
  device_session_id uuid not null,
  launch_attempt_id uuid not null unique,
  attempt_version integer not null check (attempt_version > 0),
  code_hash text,
  code_expires_at timestamptz,
  status text not null check (status in ('prepared','exchanged','revoked','expired')),
  exchanged_principal_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  exchanged_at timestamptz,
  check ((status = 'prepared' and code_hash is not null and code_expires_at is not null)
    or status <> 'prepared')
);

create table if not exists app_deployment_launch_controls (
  deployment_id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null,
  environment text not null,
  immutable_origin text not null,
  launch_path text not null,
  api_contract_version text not null default '1.0',
  compatibility_status text not null check (compatibility_status in ('passed','failed','pending')),
  drain_starts_at timestamptz,
  deployment_window_ends_at timestamptz,
  status text not null check (status in ('published','draining','deploying','retired')),
  updated_at timestamptz not null default now()
);

create table if not exists app_service_principals (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  deployment_id uuid not null,
  client_id text not null unique,
  key_ref text not null,
  status text not null check (status in ('active','revoked')),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  version integer not null default 1,
  unique(app_id, environment, deployment_id, key_ref),
  check (valid_until > valid_from)
);

alter table learner_session_launch_state
  add constraint learner_session_launch_state_principal_fk
  foreign key (exchanged_principal_id) references app_service_principals(id) on delete restrict;

create table if not exists app_client_assertion_replays (
  principal_id uuid not null references app_service_principals(id) on delete cascade,
  jti uuid not null,
  expires_at timestamptz not null,
  primary key(principal_id, jti)
);

create index if not exists app_client_assertion_replays_expiry_idx
  on app_client_assertion_replays(expires_at);

create table if not exists app_launch_exchange_receipts (
  principal_id uuid not null references app_service_principals(id) on delete cascade,
  idempotency_key uuid not null,
  request_hash text not null,
  launch_attempt_id uuid not null,
  response_json jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(principal_id, idempotency_key)
);

create index if not exists app_launch_exchange_receipts_expiry_idx
  on app_launch_exchange_receipts(expires_at);

comment on table learner_session_launch_state is
  'Temporary mutable LA-001 launch state; purge after session recovery/support purpose.';
comment on column learner_session_launch_state.code_hash is
  'SHA-256 hash only. Raw launch codes must never be persisted.';
comment on column app_service_principals.key_ref is
  'Managed-secret/key reference only; never a private credential value.';

alter table learner_session_launch_state enable row level security;
alter table app_deployment_launch_controls enable row level security;
alter table app_service_principals enable row level security;
alter table app_client_assertion_replays enable row level security;
alter table app_launch_exchange_receipts enable row level security;
-- No browser policies: launch state, deployment controls, principals and
-- receipts are reachable only through the platform/app-backend services.


-- ============================================================
-- Source: supabase/migrations/0017_la002_app_session_grants.sql
-- ============================================================
create table app_session_grants (
  id uuid primary key default gen_random_uuid(),
  learner_session_id uuid not null unique references learner_sessions(id) on delete cascade,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  deployment_id uuid not null,
  release_id uuid not null,
  app_principal_id uuid not null references app_service_principals(id) on delete restrict,
  scopes_json jsonb not null,
  api_contract_version text not null,
  grant_version integer not null default 1,
  status text not null check (status in ('active','revoked','expired')),
  expires_at timestamptz not null,
  revocation_reason text,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index app_session_grants_deployment_active_idx
  on app_session_grants(app_id,deployment_id,status);

create table app_session_grant_requests (
  principal_id uuid not null references app_service_principals(id) on delete cascade,
  grant_id uuid not null references app_session_grants(id) on delete cascade,
  idempotency_key uuid not null,
  request_hash text not null,
  response_json jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(principal_id,grant_id,idempotency_key)
);
create index app_session_grant_requests_expiry_idx on app_session_grant_requests(expires_at);

alter table app_session_grants enable row level security;
alter table app_session_grant_requests enable row level security;
-- Server-only authorization state: deliberately no browser RLS policies.


-- ============================================================
-- Source: supabase/migrations/0018_la003_progress_sync.sql
-- ============================================================
alter table learner_app_progress add column if not exists current_state_json jsonb;
alter table learner_app_progress add column if not exists current_lesson_engaged_seconds integer not null default 0 check (current_lesson_engaged_seconds >= 0);
alter table learner_app_progress add column if not exists current_level_engaged_seconds integer not null default 0 check (current_level_engaged_seconds >= 0);
alter table learner_app_progress add column if not exists progress_version integer not null default 1;
alter table learner_app_progress add column if not exists last_session_id uuid;
alter table learner_app_progress add column if not exists last_checkpoint_sequence integer not null default 0;
alter table learner_app_progress add column if not exists state_hash text;

alter table lesson_completions add column if not exists completion_outcome_code varchar(32) not null default 'completed';
alter table lesson_completions add column if not exists progress_version_after_completion integer;
alter table learner_sessions add column if not exists current_level_key text;
alter table learner_sessions add column if not exists current_lesson_key text;
alter table learner_sessions add column if not exists context_started_verified_seconds integer not null default 0;

create table if not exists app_progress_schemas (
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null,
  schema_version integer not null,
  schema_json jsonb not null,
  schema_digest text not null,
  status text not null check(status in ('active','retired')),
  created_at timestamptz not null default now(),
  primary key(app_id,release_id,schema_version)
);

create table if not exists progress_mutation_requests (
  app_principal_id uuid not null references app_service_principals(id),
  grant_id uuid not null references app_session_grants(id),
  learner_session_id uuid not null references learner_sessions(id),
  idempotency_key text not null,
  operation text not null check(operation in ('checkpoint','lesson_complete')),
  request_hash text not null,
  response_json jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(app_principal_id,grant_id,learner_session_id,idempotency_key)
);

alter table app_progress_schemas enable row level security;
alter table progress_mutation_requests enable row level security;


-- ============================================================
-- Source: supabase/migrations/0019_la004_finalization_technical_credits.sql
-- ============================================================
alter table learner_sessions add column if not exists interruption_episode_count integer not null default 0;
alter table learner_sessions add column if not exists final_progress_version integer;
alter table learner_sessions add column if not exists finalization_started_at timestamptz;
alter table learner_sessions add column if not exists session_credit_id uuid;

create table if not exists session_finalization_requests (
  learner_session_id uuid not null references learner_sessions(id), app_principal_id uuid not null references app_service_principals(id),
  idempotency_key text not null, request_hash text not null, response_json jsonb not null,
  expires_at timestamptz not null, created_at timestamptz not null default now(),
  primary key(learner_session_id,app_principal_id,idempotency_key)
);
create table if not exists learner_session_credits (
  id uuid primary key default gen_random_uuid(), source_learner_session_id uuid not null references learner_sessions(id),
  learner_id uuid not null references learners(id), app_id uuid not null references app_registry(id) on delete restrict,
  credit_type text not null check(credit_type='technical_replacement'),
  status text not null check(status in ('available','reserved','consumed','expired','revoked')),
  confirmed_by_actor_type text not null check(confirmed_by_actor_type in ('learner','parent')), confirmed_by_actor_id uuid not null,
  confirmation_reason_code text not null check(confirmation_reason_code='technical_issue'), granted_at timestamptz not null,
  expires_at timestamptz not null, reserved_session_id uuid unique, reserved_at timestamptz, consumed_at timestamptz,
  revoked_at timestamptz, version integer not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(source_learner_session_id,credit_type)
);
create table if not exists technical_credit_claim_requests (
  actor_id uuid not null, source_learner_session_id uuid not null references learner_sessions(id), idempotency_key text not null,
  request_hash text not null, response_json jsonb not null, expires_at timestamptz not null, created_at timestamptz not null default now(),
  primary key(actor_id,source_learner_session_id,idempotency_key)
);
alter table session_finalization_requests enable row level security;
alter table learner_session_credits enable row level security;
alter table technical_credit_claim_requests enable row level security;


-- ============================================================
-- Source: supabase/migrations/0020_au002_parent_learner_modes.sql
-- ============================================================
create table if not exists learner_unlock_contexts (
  parent_session_id uuid not null, device_session_id uuid not null,
  parent_user_id uuid not null references profiles(id) on delete cascade,
  learner_id uuid not null references learners(id), credential_id uuid not null,
  status text not null check(status in ('active','revoked','expired')), expires_at timestamptz not null,
  version integer not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  revoked_at timestamptz, revocation_reason text, primary key(parent_session_id,device_session_id)
);
create index if not exists idx_learner_unlock_context_credential on learner_unlock_contexts(credential_id,status);
create table if not exists authorization_actions (
  action_key text primary key, required_mode text not null check(required_mode in ('parent_management','learner_mode','app_service')),
  resource_type text not null, sensitive boolean not null default false, version integer not null default 1, active boolean not null default true
);
alter table learner_unlock_contexts enable row level security;
alter table authorization_actions enable row level security;


-- ============================================================
-- Source: supabase/migrations/0020_sc001_session_runtime.sql
-- ============================================================
-- BR-003: reviewed-breaking-change
-- SC-001: browser-local session runtime, signed envelope and hard server expiry.
-- Recurring heartbeats are removed; the platform now records only the
-- usable-launch moment and a hard expiry, plus the final client-reported vs
-- server-accepted connected seconds at finalization.
alter table learner_sessions drop column if exists last_heartbeat_at;
alter table learner_sessions drop column if exists heartbeat_sequence;

alter table learner_sessions add column if not exists usable_launch_established_at timestamptz;
alter table learner_sessions add column if not exists hard_expires_at timestamptz;
alter table learner_sessions add column if not exists maximum_connected_seconds integer not null default 2700;
alter table learner_sessions add column if not exists final_reported_connected_seconds integer;
alter table learner_sessions add column if not exists final_accepted_connected_seconds integer;

alter table learner_sessions drop constraint if exists learner_sessions_connected_elapsed_seconds_check;
alter table learner_sessions add constraint learner_sessions_connected_elapsed_seconds_check
  check (connected_elapsed_seconds >= 0);
alter table learner_sessions add constraint learner_sessions_connected_within_maximum_check
  check (connected_elapsed_seconds <= maximum_connected_seconds);


-- ============================================================
-- Source: supabase/migrations/0021_au001_policy_bundles.sql
-- ============================================================
create table if not exists authorization_policy_bundles (
  id uuid primary key,
  version text not null unique check(version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  digest text not null unique check(digest ~ '^[0-9a-f]{64}$'),
  source_commit_sha text not null check(source_commit_sha ~ '^[0-9a-f]{40}$'),
  policy_json jsonb not null,
  created_at timestamptz not null default now()
);

alter table authorization_policy_bundles enable row level security;

create or replace function reject_authorization_policy_bundle_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'authorization policy bundles are immutable';
end;
$$;

create trigger authorization_policy_bundles_no_update
before update on authorization_policy_bundles
for each row execute function reject_authorization_policy_bundle_mutation();

create trigger authorization_policy_bundles_no_delete
before delete on authorization_policy_bundles
for each row execute function reject_authorization_policy_bundle_mutation();

comment on table authorization_policy_bundles is
  'AU-001 immutable, version-controlled authorization policy definitions. No browser RLS policy is intentional.';


-- ============================================================
-- Source: supabase/migrations/0022_au001_policy_activation.sql
-- ============================================================
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


-- ============================================================
-- Source: supabase/migrations/0023_au001_canonical_api_actions.sql
-- ============================================================
alter table authorization_actions
  drop constraint if exists authorization_actions_required_mode_check;

alter table authorization_actions
  add constraint authorization_actions_required_mode_check
  check(required_mode in ('parent_management','learner_mode','app_service','administrator','service'));

comment on table authorization_actions is
  'AU-001 permanent canonical action catalog covering parent, learner, administrator and managed-service APIs.';


-- ============================================================
-- Source: supabase/migrations/0023_sc002_standard_credit_batches.sql
-- ============================================================
-- SC-002: eight monthly standard session credits per learner/app, one
-- compact batch row per allocation month, one-month rollover, and
-- catch-up third-session pacing.
alter table learner_app_week_usage add column if not exists standard_sessions_funded
  integer not null default 0 check (standard_sessions_funded between 0 and 3);

create table if not exists learner_app_standard_credit_batches (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  allocation_month date not null,
  timezone text not null,
  granted_count smallint not null default 8 check (granted_count = 8),
  reserved_count smallint not null default 0 check (reserved_count >= 0),
  consumed_count smallint not null default 0 check (consumed_count >= 0),
  effective_at timestamptz not null,
  expires_at timestamptz not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(learner_id, app_id, allocation_month),
  check (reserved_count + consumed_count <= granted_count)
);
create index if not exists idx_standard_credit_batches_lookup
  on learner_app_standard_credit_batches(learner_id, app_id, expires_at);

alter table learner_sessions add column if not exists standard_credit_batch_id
  uuid references learner_app_standard_credit_batches(id);
alter table learner_sessions add column if not exists weekly_session_ordinal
  smallint check (weekly_session_ordinal between 1 and 3);

-- 0014 only ever allowed ('normal','replacement'); 0019 introduced
-- 'technical_credit' as a stored value without widening this constraint.
-- Neither has been applied to a live database yet, so correcting it here
-- (rather than patching 0019) is safe and keeps a from-scratch deploy consistent.
alter table learner_sessions drop constraint if exists learner_sessions_source_check;
alter table learner_sessions add constraint learner_sessions_source_check
  check (source in ('normal','replacement','technical_credit','standard_monthly'));

alter table learner_app_standard_credit_batches enable row level security;


-- ============================================================
-- Source: supabase/migrations/0024_au001_unified_principals.sql
-- ============================================================
alter table authorization_actions
  drop constraint if exists authorization_actions_required_mode_check;

alter table authorization_actions
  add constraint authorization_actions_required_mode_check
  check(required_mode in ('parent_management','learner_mode','app_service','administrator','support','service'));

comment on column authorization_actions.required_mode is
  'AU-001 unified verified principal category required for the canonical action.';


-- ============================================================
-- Source: supabase/migrations/0024_sc003_start_reservation.sql
-- ============================================================
-- SC-003: five-minute atomic session reservation and usable-launch
-- establishment. A session starts 'starting'/reserved and only becomes
-- 'active'/consumed once the app backend confirms usable launch (browser
-- runtime initialized); an unconfirmed reservation expires after 300s.
alter table learner_sessions drop constraint if exists learner_sessions_status_check;
alter table learner_sessions add constraint learner_sessions_status_check
  check (status in ('starting','active','disconnected','completed','interrupted','expired','revoked_by_admin','cancelled_before_launch'));

alter table learner_sessions add column if not exists funding_state text not null default 'reserved'
  check (funding_state in ('reserved','consumed','released','expired'));
alter table learner_sessions add column if not exists reserved_at timestamptz;
alter table learner_sessions add column if not exists reservation_expires_at timestamptz;
create index if not exists idx_learner_sessions_reservation_expiry
  on learner_sessions(reservation_expires_at) where status = 'starting';

create table if not exists usable_launch_requests (
  learner_session_id uuid not null references learner_sessions(id),
  app_principal_id uuid not null references app_service_principals(id),
  idempotency_key text not null,
  request_hash text not null,
  response_json jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key(learner_session_id,app_principal_id,idempotency_key)
);
alter table usable_launch_requests enable row level security;


-- ============================================================
-- Source: supabase/migrations/0025_au001_internal_authorization_decision.sql
-- ============================================================
create table if not exists platform_service_principals (
  id uuid primary key,
  service_key text not null unique,
  key_ref text not null,
  status text not null check(status in ('active','revoked')),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  version integer not null default 1
);

create table if not exists platform_service_assertion_replays (
  principal_id uuid not null references platform_service_principals(id) on delete cascade,
  jti text not null,
  expires_at timestamptz not null,
  primary key(principal_id,jti)
);

alter table platform_service_principals enable row level security;
alter table platform_service_assertion_replays enable row level security;

comment on table platform_service_principals is
  'AU-001 separately deployed trusted platform services; intentionally distinct from LA-002 app principals.';


-- ============================================================
-- Source: supabase/migrations/0026_au001_rls_repository_scope.sql
-- ============================================================
-- AU-001: make RLS apply even when a table-owning role executes a query.
-- Service-role connections retain PostgreSQL BYPASSRLS and are constrained by
-- the application repository-scope registry and authorization layer.
alter table account_events force row level security;
alter table admin_permissions force row level security;
alter table analytics_contribution_receipts force row level security;
alter table analytics_daily_app force row level security;
alter table analytics_daily_buffer force row level security;
alter table analytics_daily_level force row level security;
alter table analytics_daily_runs force row level security;
alter table app_client_assertion_replays force row level security;
alter table app_deployment_launch_controls force row level security;
alter table app_launch_exchange_receipts force row level security;
alter table app_progress_schemas force row level security;
alter table app_registry force row level security;
alter table app_registry_audit_log force row level security;
alter table app_registry_mutation_requests force row level security;
alter table app_service_principals force row level security;
alter table app_session_grant_requests force row level security;
alter table app_session_grants force row level security;
alter table approved_app_icons force row level security;
alter table approved_avatars force row level security;
alter table authorization_actions force row level security;
alter table authorization_policy_activation_history force row level security;
alter table authorization_policy_active force row level security;
alter table authorization_policy_bundles force row level security;
alter table consent_records force row level security;
alter table email_change_requests force row level security;
alter table learner_app_progress force row level security;
alter table learner_app_standard_credit_batches force row level security;
alter table learner_app_week_usage force row level security;
alter table learner_creation_requests force row level security;
alter table learner_profile_update_requests force row level security;
alter table learner_selection_contexts force row level security;
alter table learner_session_credits force row level security;
alter table learner_session_launch_state force row level security;
alter table learner_sessions force row level security;
alter table learner_unlock_contexts force row level security;
alter table learners force row level security;
alter table lesson_completions force row level security;
alter table parent_email_history force row level security;
alter table payments force row level security;
alter table platform_alerts force row level security;
alter table platform_service_assertion_replays force row level security;
alter table platform_service_principals force row level security;
alter table products force row level security;
alter table profiles force row level security;
alter table progress_mutation_requests force row level security;
alter table session_finalization_requests force row level security;
alter table session_replacement_credits force row level security;
alter table session_start_requests force row level security;
alter table subscription_audit_log force row level security;
alter table subscriptions force row level security;
alter table technical_credit_claim_requests force row level security;
alter table usable_launch_requests force row level security;


-- ============================================================
-- Source: supabase/migrations/0027_au001_deployment_authorization.sql
-- ============================================================
alter table app_deployment_launch_controls
  add column if not exists version integer not null default 1;

create table if not exists deployment_mutation_requests (
  admin_user_id uuid not null references auth.users(id) on delete restrict,
  idempotency_key uuid not null,
  operation text not null check (operation in ('schedule','reschedule','cancel','promote','rollback')),
  deployment_id uuid not null references app_deployment_launch_controls(deployment_id) on delete restrict,
  request_hash text not null,
  status text not null check (status in ('processing','completed')),
  response_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(admin_user_id,idempotency_key)
);

create table if not exists deployment_authorization_audit (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references auth.users(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  deployment_id uuid not null references app_deployment_launch_controls(deployment_id) on delete restrict,
  release_id uuid not null,
  operation text not null check (operation in ('schedule','reschedule','cancel','promote','rollback')),
  policy_version text not null,
  policy_digest text not null,
  version_from integer not null,
  version_to integer not null,
  created_at timestamptz not null default now()
);

alter table deployment_mutation_requests enable row level security;
alter table deployment_mutation_requests force row level security;
alter table deployment_authorization_audit enable row level security;
alter table deployment_authorization_audit force row level security;

-- Server-only: no PostgREST policy. Deployment administration is available
-- exclusively through the canonical, reauthenticated platform API.


-- ============================================================
-- Source: supabase/migrations/0028_an001_midnight_engaged_split.sql
-- ============================================================
-- AN-001 AC14: remember the beginning of the currently connected segment so
-- accepted engaged seconds can be split at the Asia/Kolkata midnight boundary.
alter table learner_sessions
  add column if not exists active_segment_started_at timestamptz;

comment on column learner_sessions.active_segment_started_at is
  'Temporary active connected-segment start used to split AN-001 engaged seconds by Kolkata date';

-- Down migration (apply manually to reverse; purged analytics source is intentionally not restored):
-- alter table learner_sessions drop column if exists active_segment_started_at;


-- ============================================================
-- Source: supabase/migrations/0029_an001_atomic_daily_run_claim.sql
-- ============================================================
-- AN-001 AC10: exactly one scheduler worker may claim an activity date.
-- INSERT conflict handling serializes first creation; FOR UPDATE serializes
-- failed-run reclamation and ensures only one worker increments run_version.
create or replace function claim_analytics_daily_run(
  p_activity_date date,
  p_started_at timestamptz default now()
)
returns table(claimed boolean, run_row analytics_daily_runs)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run analytics_daily_runs;
begin
  insert into analytics_daily_runs(activity_date, status, run_version, started_at)
  values (p_activity_date, 'running', 1, p_started_at)
  on conflict (activity_date) do nothing;

  if found then
    select * into v_run
      from analytics_daily_runs
      where activity_date = p_activity_date;
    return query select true, v_run;
    return;
  end if;

  select * into v_run
    from analytics_daily_runs
    where activity_date = p_activity_date
    for update;

  if v_run.status = 'failed' then
    update analytics_daily_runs
      set status = 'running',
          run_version = run_version + 1,
          started_at = p_started_at,
          completed_at = null,
          failure_code = null
      where activity_date = p_activity_date
        and status = 'failed'
      returning * into v_run;
    return query select true, v_run;
  else
    return query select false, v_run;
  end if;
end;
$$;

revoke all on function claim_analytics_daily_run(date, timestamptz) from public, anon, authenticated;
grant execute on function claim_analytics_daily_run(date, timestamptz) to service_role;

-- Down migration (apply manually to reverse; existing run/aggregate rows remain intact):
-- drop function if exists claim_analytics_daily_run(date, timestamptz);


-- ============================================================
-- Source: supabase/migrations/0030_an001_analytics_service_principals.sql
-- ============================================================
-- AN-001: scheduler and contribution services are separate managed identities.
-- Secrets are never stored here; key_ref resolves through the production
-- secret manager / PLATFORM_SERVICE_SECRETS and can be rotated independently.
insert into platform_service_principals(
  id, service_key, key_ref, status, valid_from, valid_until, version
) values
  ('a1000000-0000-4000-8000-000000000001', 'analytics-scheduler',
   'analytics-scheduler-v1', 'active', now(), 'infinity', 1),
  ('a1000000-0000-4000-8000-000000000002', 'analytics-contributor',
   'analytics-contributor-v1', 'active', now(), 'infinity', 1)
on conflict (service_key) do nothing;

-- Down migration (apply manually only after disabling scheduler/contributor traffic):
-- delete from platform_service_principals
-- where id in ('a1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000002')
--   and service_key in ('analytics-scheduler', 'analytics-contributor');


-- ============================================================
-- Source: supabase/migrations/0031_en001_entitlement_cycles.sql
-- ============================================================
-- EN-001: subscription-cycle app entitlements, immutable app-snapshot per
-- paid cycle, and one independent full per-app allocation. Consumes a
-- caller-supplied paid-cycle event (no BI-002/BI-005 producer exists yet in
-- this codebase; app_ids_json is the event's own immutable snapshot, not
-- re-derived from a bundle catalog that doesn't exist yet either).
create table if not exists entitlement_cycles (
  id uuid primary key default gen_random_uuid(),
  paid_cycle_id text not null unique,
  subscription_id text not null,
  purchaser_parent_id uuid not null references profiles(id),
  assigned_learner_id uuid not null references learners(id),
  product_id text not null,
  product_version integer not null,
  app_ids_json jsonb not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  billing_anchor text not null,
  status text not null check(status in ('creating','ready','failed')),
  source_event_id text not null,
  source_event_version integer not null,
  source_event_hash text not null,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  version integer not null default 1
);
create index if not exists idx_entitlement_cycles_learner on entitlement_cycles(assigned_learner_id);
alter table entitlement_cycles enable row level security;
alter table entitlement_cycles force row level security;

-- One per-app entitlement period per paid cycle (business rule 3, 34; unique
-- paid_cycle+app). effective_entitlement_id/standard_credit_batch_id FKs are
-- added in 0032 once their target tables exist (circular reference between
-- this table and learner_app_effective_entitlements).
create table if not exists learner_app_entitlement_periods (
  id uuid primary key default gen_random_uuid(),
  entitlement_cycle_id uuid not null references entitlement_cycles(id),
  subscription_id text not null,
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  product_version integer not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  status text not null default 'ready' check(status in ('ready')),
  effective_source_role text not null check(effective_source_role in
    ('allocation_bearing','access_supporting','overlap_suppressed')),
  effective_entitlement_id uuid,
  standard_credit_batch_id uuid,
  created_at timestamptz not null default now(),
  unique(entitlement_cycle_id, app_id)
);
create index if not exists idx_entitlement_periods_learner_app
  on learner_app_entitlement_periods(learner_id, app_id, period_start, period_end);
alter table learner_app_entitlement_periods enable row level security;
alter table learner_app_entitlement_periods force row level security;

create table if not exists entitlement_application_receipts (
  paid_cycle_id text not null,
  event_id text not null,
  request_hash text not null,
  result_json jsonb not null,
  status text not null check(status in ('ready','failed','quarantined')),
  created_at timestamptz not null default now(),
  primary key(paid_cycle_id, event_id)
);
alter table entitlement_application_receipts enable row level security;
alter table entitlement_application_receipts force row level security;

insert into platform_service_principals(
  id, service_key, key_ref, status, valid_from, valid_until, version
) values
  ('a1000000-0000-4000-8000-000000000003', 'entitlement-cycle-applier',
   'entitlement-cycle-applier-v1', 'active', now(), 'infinity', 1)
on conflict (service_key) do nothing;


-- ============================================================
-- Source: supabase/migrations/0032_en002_effective_access.sql
-- ============================================================
-- EN-002: one materialized effective-access decision per learner/app/
-- environment (unique constraint), kept in sync at write time whenever
-- EN-001 creates a period (business rule 42/43). evaluateAccessFresh()
-- still re-checks access_until vs. now and app_registry status live on
-- every call rather than trusting this row unconditionally (rule 44).
create table if not exists learner_app_effective_entitlements (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  state text not null check(state in
    ('active','approved_grace','inactive','inactive_refunded','suspended_financial','suspended_security','overlap_resolution')),
  allocation_source_entitlement_period_id uuid references learner_app_entitlement_periods(id),
  access_until timestamptz,
  effective_version integer not null default 1,
  source_set_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(learner_id, app_id, environment)
);
alter table learner_app_effective_entitlements enable row level security;
alter table learner_app_effective_entitlements force row level security;

create table if not exists learner_app_effective_sources (
  effective_entitlement_id uuid not null references learner_app_effective_entitlements(id),
  entitlement_period_id uuid not null references learner_app_entitlement_periods(id),
  role text not null check(role in ('allocation_bearing','access_supporting','overlap_suppressed')),
  valid_from timestamptz not null,
  valid_until timestamptz not null,
  primary key(effective_entitlement_id, entitlement_period_id)
);
alter table learner_app_effective_sources enable row level security;
alter table learner_app_effective_sources force row level security;

-- Close the circular reference from 0031: learner_app_entitlement_periods
-- can now point at the effective-entitlement row it belongs to.
alter table learner_app_entitlement_periods
  add constraint learner_app_entitlement_periods_effective_entitlement_fk
  foreign key (effective_entitlement_id) references learner_app_effective_entitlements(id);

-- EN-001: the same compact-batch shape used by SC-002's calendar-month
-- batches also backs one independent 8-credit batch per allocation-bearing
-- entitlement app-period (entitlement_period_id populated, allocation_month/
-- timezone left null instead). allocation_month was previously not null;
-- relaxed here since an entitlement-period-keyed row has no calendar month.
alter table learner_app_standard_credit_batches alter column allocation_month drop not null;
alter table learner_app_standard_credit_batches alter column timezone drop not null;
alter table learner_app_standard_credit_batches add column if not exists entitlement_period_id
  uuid unique references learner_app_entitlement_periods(id);
alter table learner_app_standard_credit_batches
  add constraint learner_app_standard_credit_batches_month_xor_period
  check ((allocation_month is not null) <> (entitlement_period_id is not null));

alter table learner_app_entitlement_periods
  add constraint learner_app_entitlement_periods_standard_credit_batch_fk
  foreign key (standard_credit_batch_id) references learner_app_standard_credit_batches(id);

-- EN-002: the effective-entitlement binding fresh-evaluated and persisted
-- at Start (business rule 21).
alter table learner_sessions add column if not exists effective_entitlement_id
  uuid references learner_app_effective_entitlements(id);
alter table learner_sessions add column if not exists effective_entitlement_version_at_start integer;
alter table learner_sessions add column if not exists allocation_source_entitlement_period_id
  uuid references learner_app_entitlement_periods(id);

insert into platform_service_principals(
  id, service_key, key_ref, status, valid_from, valid_until, version
) values
  ('a1000000-0000-4000-8000-000000000004', 'entitlement-access-evaluator',
   'entitlement-access-evaluator-v1', 'active', now(), 'infinity', 1)
on conflict (service_key) do nothing;


-- ============================================================
-- Source: supabase/migrations/0033_an001_app_analytics_levels.sql
-- ============================================================
-- AN-001: platform-owned app level contract. Contributions may use only an
-- active app-scoped level or the reserved `unassigned` fallback enforced by
-- the platform service. Learning apps cannot write this registry directly.
create table if not exists app_analytics_levels (
  app_id uuid not null references app_registry(id) on delete restrict,
  level_key text not null,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (app_id, level_key),
  check (length(btrim(level_key)) > 0 and level_key <> 'unassigned')
);

alter table app_analytics_levels enable row level security;
alter table app_analytics_levels force row level security;
revoke all on table app_analytics_levels from public, anon, authenticated;
grant select, insert, update, delete on table app_analytics_levels to service_role;

-- Down migration (apply manually to reverse; purged pseudonymous buffers are intentionally not restored):
-- drop table if exists app_analytics_levels;


-- ============================================================
-- Source: supabase/migrations/0034_ar002_deployment_pipeline.sql
-- ============================================================
-- AR-002 business rule 6: minimal admin-curated list of domains a
-- provider-confirmed production origin is allowed to resolve under. Same
-- "small stand-in registry" shape as approved_app_icons (AR-001) for a
-- precondition the spec assumes exists.
create table if not exists approved_domains (
  id uuid primary key default gen_random_uuid(),
  domain_suffix text not null unique,
  status text not null default 'active' check (status in ('active','retired')),
  created_at timestamptz not null default now()
);

-- AR-002: verified provider (Vercel) project binding, one per app+environment.
create table if not exists app_deployment_bindings (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null check (environment in ('development','staging','production')),
  provider text not null,
  provider_team_id text not null,
  provider_project_id text not null,
  expected_repository text not null,
  approved_domain_id uuid,
  binding_status text not null default 'unverified' check (binding_status in ('unverified','verified','disabled')),
  deployment_enabled boolean not null default true,
  verified_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(app_id, environment),
  unique(provider, provider_team_id, provider_project_id, environment)
);

-- AR-002: immutable release. Created only by an authenticated CI principal
-- from an approved repository commit (business rule 11); build-once, same
-- artifact_digest promoted through staging and production (rule 14).
create table if not exists app_releases (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references app_registry(id) on delete restrict,
  source_repository text not null,
  source_commit_sha text not null,
  dependency_lock_hash text not null,
  build_input_hash text not null,
  artifact_digest text not null,
  provider_artifact_id text,
  manifest_json jsonb not null,
  gate_results_json jsonb not null,
  status text not null default 'created'
    check (status in ('created','gate_failed','staging_deploying','staging_failed','verified','promoted')),
  created_by_ci_principal text not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  verified_at timestamptz,
  failed_at timestamptz,
  unique(app_id, source_commit_sha, artifact_digest)
);

create index if not exists idx_app_releases_app on app_releases(app_id, status);

-- AR-002: one row per environment deployment of a release (staging or
-- production). validation_summary_json is compact pass/fail codes only,
-- never full logs (business rule 40).
create table if not exists app_deployments (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null references app_releases(id) on delete restrict,
  binding_id uuid not null references app_deployment_bindings(id) on delete restrict,
  environment text not null,
  provider_deployment_id text not null unique,
  verified_origin text not null,
  status text not null check (status in ('deploying','validating','published','superseded','failed')),
  validation_summary_json jsonb not null default '{}'::jsonb,
  investigation_hold boolean not null default false,
  started_at timestamptz not null default now(),
  validated_at timestamptz,
  published_at timestamptz,
  superseded_at timestamptz,
  ended_at timestamptz
);

create index if not exists idx_app_deployments_app_env on app_deployments(app_id, environment, status);

-- AR-002: atomic current/previous-healthy publication pointer per
-- app+environment (business rule 28, 31). This is the source of truth that
-- production promotion/rollback updates; app_deployment_launch_controls is
-- kept as a derived projection so LA-001/LP-004's existing read path
-- (resolveTrustedDeployment) is unaffected.
create table if not exists app_environment_publications (
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  current_published_deployment_id uuid references app_deployments(id),
  previous_healthy_deployment_id uuid references app_deployments(id),
  version integer not null default 1,
  published_at timestamptz,
  primary key(app_id, environment)
);

-- AR-002: actor+app-scoped idempotency for binding/release/staging/
-- production operations (business rule 43) — same request-hash/receipt
-- shape as deployment_mutation_requests and entitlement_application_receipts.
create table if not exists deployment_operation_requests (
  actor_principal_id text not null,
  app_id uuid not null,
  idempotency_key uuid not null,
  operation text not null
    check (operation in ('bind','verify_binding','create_release','deploy_staging','approve_production')),
  request_hash text not null,
  release_id uuid,
  deployment_id uuid,
  result_id uuid,
  status text not null check (status in ('processing','completed')),
  safe_response_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(actor_principal_id, idempotency_key)
);

-- AR-002: short-retention provider webhook idempotency ledger (business
-- rule 37, 40). Populated by the webhook ingestion route (deferred to a
-- follow-up session); table created now so the retention/idempotency shape
-- is fixed ahead of that work.
create table if not exists deployment_webhook_receipts (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received' check (status in ('received','processed','rejected')),
  unique(provider, provider_event_id)
);

-- AR-002: compact backward-compatibility report per release (business
-- rules 46-49). Table created now; the read/migrate/write test runner that
-- populates it is deferred to a follow-up session (see README).
create table if not exists app_release_compatibility_reports (
  release_id uuid primary key references app_releases(id) on delete restrict,
  platform_contract_version text not null,
  represented_progress_schema_versions_json jsonb not null default '[]'::jsonb,
  status text not null default 'skipped' check (status in ('passed','failed','skipped')),
  generated_at timestamptz not null default now()
);

alter table approved_domains enable row level security;
alter table approved_domains force row level security;
alter table app_deployment_bindings enable row level security;
alter table app_deployment_bindings force row level security;
alter table app_releases enable row level security;
alter table app_releases force row level security;
alter table app_deployments enable row level security;
alter table app_deployments force row level security;
alter table app_environment_publications enable row level security;
alter table app_environment_publications force row level security;
alter table deployment_operation_requests enable row level security;
alter table deployment_operation_requests force row level security;
alter table deployment_webhook_receipts enable row level security;
alter table deployment_webhook_receipts force row level security;
alter table app_release_compatibility_reports enable row level security;
alter table app_release_compatibility_reports force row level security;

-- Server-only: no PostgREST policy. Deployment pipeline administration is
-- available exclusively through the canonical, reauthenticated platform API
-- and the authenticated CI/webhook service principals.


-- ============================================================
-- Source: supabase/migrations/0035_an001_analytics_admin_read_permission.sql
-- ============================================================
-- AN-001: separate cohort-analytics reads from run retry authority.
-- Existing retry operators keep read access; future grants may assign
-- analytics_read independently without granting mutation authority.
insert into admin_permissions (user_id, permission)
select user_id, 'analytics_read'
from admin_permissions
where permission = 'analytics_run_retry'
on conflict (user_id, permission) do nothing;

-- Down migration (apply manually to reverse):
-- delete from admin_permissions where permission = 'analytics_read';


-- ============================================================
-- Source: supabase/migrations/0036_au002_passkey_verification_receipts.sql
-- ============================================================
create table if not exists learner_mode_unlock_receipts (
  id uuid primary key,
  parent_user_id uuid not null references profiles(id) on delete cascade,
  parent_session_id uuid not null,
  device_session_id uuid not null,
  learner_id uuid not null references learners(id),
  credential_id uuid not null,
  verified_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > verified_at),
  check (expires_at <= verified_at + interval '60 seconds')
);
create index if not exists idx_learner_mode_unlock_receipt_expiry
  on learner_mode_unlock_receipts(expires_at,consumed_at);
alter table learner_mode_unlock_receipts enable row level security;
alter table learner_mode_unlock_receipts force row level security;


-- ============================================================
-- Source: supabase/migrations/0037_ia002_remove_parent_learner_fields.sql
-- ============================================================
-- BR-003: reviewed-breaking-change
-- IA-002 stores learner attributes on learners, never on the parent profile.
-- The baseline migration no longer creates these legacy columns; this
-- forward migration reconciles databases created from an older baseline.

alter table profiles
  drop column if exists date_of_birth,
  drop column if exists class_level;

-- Profile writes must pass through the server endpoint so E.164 validation,
-- consent recording, status transition and auditing remain one operation.
-- Service-role repository access bypasses RLS; browser clients retain only
-- the owner-select policy from the baseline migration.
drop policy if exists "profiles are updatable by owner" on profiles;

-- Down migration (apply manually to reverse):
-- alter table profiles add column date_of_birth date;
-- alter table profiles add column class_level text;
-- create policy "profiles are updatable by owner" on profiles for update using (auth.uid() = id);


-- ============================================================
-- Source: supabase/migrations/0038_ar002_rollback_windows.sql
-- ============================================================
-- AR-002 session 2: allow the rollback outcome as a terminal app_deployments
-- status (business rules 27-29, 33).
alter table app_deployments drop constraint if exists app_deployments_status_check;
alter table app_deployments add constraint app_deployments_status_check
  check (status in ('deploying','validating','published','superseded','failed','rolled_back'));

-- AR-002 session 2: widen the shared idempotency ledger for window
-- scheduling and rollback operations.
alter table deployment_operation_requests drop constraint if exists deployment_operation_requests_operation_check;
alter table deployment_operation_requests add constraint deployment_operation_requests_operation_check
  check (operation in ('bind','verify_binding','create_release','deploy_staging','approve_production',
    'schedule_window','reschedule_window','cancel_window','rollback'));

-- AR-002 session 2, business rules 46-49: which learner_app_progress
-- schema_version values this release's code can still read/migrate
-- (expand/migrate/contract) — CI's own attestation, checked against
-- currently represented versions before staging can verify.
alter table app_releases add column if not exists readable_schema_versions_json jsonb not null default '[]'::jsonb;

-- AR-002 session 2: one pre-scheduled app-specific production slot per
-- window (business rules 50-60). drain_starts_at is always starts_at minus
-- 60 minutes (rule 51), stored rather than computed so the existing
-- app_deployment_launch_controls projection can be upserted from it
-- unchanged.
create table if not exists app_deployment_windows (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null references app_releases(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  drain_starts_at timestamptz not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','draining','executing','completed','cancelled','failed','extended_safe_block')),
  failure_code text,
  created_by_admin_id uuid not null,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Postgres supports a real exclusion constraint for "no overlapping
-- non-final window per app" (SQLite's parallel schema.sql falls back to a
-- partial unique index on app_id instead, since it has neither exclusion
-- constraints nor a partial-predicate btree over an open interval).
-- uuid has no default GiST operator class, so this needs btree_gist for
-- the "app_id with =" equality term (also created, redundantly-but-
-- idempotently, in 0053_ul004_app_availability.sql).
create extension if not exists btree_gist;
alter table app_deployment_windows add constraint app_deployment_windows_one_nonfinal_per_app
  exclude using gist (app_id with =)
  where (status in ('scheduled','draining','executing','extended_safe_block'));

-- AR-002 session 2: restart-safe state for the ten-minute/one-check-per-
-- minute post-publish release-safety observation (business rules 32-33).
-- One row per production deployment publish; the sweep reads status rather
-- than holding anything in memory, so a restart mid-window resumes
-- correctly (NFR: "release-safety observation is restart safe").
create table if not exists app_deployment_safety_observations (
  deployment_id uuid primary key references app_deployments(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  started_at timestamptz not null default now(),
  checks_run integer not null default 0,
  consecutive_critical_failures integer not null default 0,
  identity_failure boolean not null default false,
  status text not null default 'observing' check (status in ('observing','passed','rollback_triggered')),
  last_checked_at timestamptz
);

alter table app_deployment_windows enable row level security;
alter table app_deployment_windows force row level security;
alter table app_deployment_safety_observations enable row level security;
alter table app_deployment_safety_observations force row level security;

-- Server-only: no PostgREST policy. Deployment pipeline administration is
-- available exclusively through the canonical, reauthenticated platform API
-- and the authenticated CI/webhook service principals.


-- ============================================================
-- Source: supabase/migrations/0039_sc003_provisional_app_grants.sql
-- ============================================================
-- GAP-048/089 (SC-003 amendment): a session-start grant must begin
-- provisional — scoped only to session.usable_launch — and be atomically
-- upgraded to 'active' with the full app-service scope set only once
-- confirmUsableLaunch succeeds. 0017 only allowed ('active','revoked',
-- 'expired'); this widens the check constraint to add 'provisional'.
alter table app_session_grants drop constraint app_session_grants_status_check;
alter table app_session_grants add constraint app_session_grants_status_check
  check (status in ('provisional','active','revoked','expired'));


-- ============================================================
-- Source: supabase/migrations/0040_au004_managed_key_identity.sql
-- ============================================================
-- AU-004: managed Ed25519 machine identity. Both machine-principal tables
-- move from an HS256 shared secret (resolved out of an env-var JSON map at
-- verify time) to a per-principal Ed25519 public key stored directly on the
-- row. The private key never touches the platform — it is generated and
-- held by whichever service (app backend, internal scheduler/worker) the
-- principal represents, and handed to the platform only as a public key at
-- onboarding. key_ref remains a human-readable rotation label.
alter table app_service_principals add column if not exists public_key text not null default '';
alter table platform_service_principals add column if not exists public_key text not null default '';


-- ============================================================
-- Source: supabase/migrations/0041_ia004_webauthn_passkeys.sql
-- ============================================================
-- IA-004: real WebAuthn passkey credential registry and challenge lifecycle,
-- backing the learner_mode_unlock_receipts seam that AU-002 already
-- consumes (0036_au002_passkey_verification_receipts.sql).
create table if not exists learner_passkey_credentials (
  id uuid primary key,
  learner_id uuid not null references learners(id),
  owner_parent_id uuid not null references profiles(id) on delete cascade,
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
create index if not exists idx_learner_passkey_credentials_learner
  on learner_passkey_credentials(learner_id,status);
alter table learner_passkey_credentials enable row level security;
alter table learner_passkey_credentials force row level security;

create table if not exists webauthn_challenges (
  id uuid primary key,
  purpose text not null check(purpose in ('registration','authentication')),
  parent_user_id uuid not null references profiles(id) on delete cascade,
  parent_session_id uuid not null,
  device_session_id uuid not null,
  learner_id uuid not null references learners(id),
  challenge_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index if not exists idx_webauthn_challenges_expiry
  on webauthn_challenges(expires_at,consumed_at);
alter table webauthn_challenges enable row level security;
alter table webauthn_challenges force row level security;


-- ============================================================
-- Source: supabase/migrations/0042_pr001_progress_schema_migrations.sql
-- ============================================================
-- PR-001/003: progress schema migration registry and the standard
-- app-owned progress summary contract.
alter table learner_app_progress add column if not exists progress_summary_json text;

create table if not exists app_progress_schema_migrations (
  id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  from_schema_version integer not null,
  to_schema_version integer not null,
  transform_json text not null,
  registered_at timestamptz not null,
  unique(app_id,from_schema_version,to_schema_version)
);
alter table app_progress_schema_migrations enable row level security;
alter table app_progress_schema_migrations force row level security;


-- ============================================================
-- Source: supabase/migrations/0043_pr004_progress_integrity.sql
-- ============================================================
-- PR-004: fail-closed progress-integrity validation, safely readable
-- continuation and controlled operations incidents over the single
-- learner_app_progress row and immutable lesson_completions. Recovery
-- receipts (PR-002) do not exist in this codebase yet — rule 16 (recovery
-- metadata agreement) is therefore structurally unreachable and is not
-- modeled here; see README for the documented gap.

-- PR-001's own per-learner migration receipt (rules 12, 14, 15) — the
-- existing app_progress_schema_migrations table is only an app-wide
-- transform registry, not an event log of what actually happened to a
-- given learner's row.
create table if not exists learner_progress_migration_receipts (
  id uuid primary key,
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null,
  from_schema_version integer not null,
  to_schema_version integer not null,
  progress_version integer not null,
  state_hash_after text not null,
  migrated_at timestamptz not null,
  unique(learner_id, app_id, release_id, to_schema_version)
);
create index if not exists idx_lpmr_learner_app on learner_progress_migration_receipts(learner_id, app_id);
alter table learner_progress_migration_receipts enable row level security;
alter table learner_progress_migration_receipts force row level security;

alter table learner_app_progress add column if not exists progress_summary_visibility_status text not null default 'current' check (progress_summary_visibility_status in ('current','stale','unavailable'));
alter table learner_app_progress add column if not exists progress_summary_based_on_version integer;
alter table learner_app_progress add column if not exists last_migration_receipt_id uuid references learner_progress_migration_receipts(id);

create table if not exists progress_integrity_incidents (
  id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null check (environment in ('staging','production')),
  learner_id uuid not null references learners(id),
  classification text not null check (classification in
    ('read_only_safe','blocked_repairable_metadata','blocked_conflict','unreadable_corrupt')),
  severity text not null check (severity in ('low','medium','high','critical')),
  status text not null default 'open' check (status in
    ('open','investigating','resolved_repaired','resolved_false_positive',
     'resolved_legacy_policy','routed_disaster_recovery')),
  issue_codes jsonb not null default '[]',
  expected_state_hash text,
  actual_state_hash text,
  expected_progress_version integer,
  actual_progress_version integer,
  expected_schema_version integer,
  actual_schema_version integer,
  source_receipt_type text check (source_receipt_type in ('migration') or source_receipt_type is null),
  source_receipt_id uuid,
  release_id uuid,
  workflow_route text not null default 'none' check (workflow_route in ('none','release_rollback','disaster_recovery')),
  attempt_count integer not null default 0,
  version integer not null default 1,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  resolved_at timestamptz
);
create index if not exists idx_pii_app_env_status on progress_integrity_incidents(app_id, environment, status);
create index if not exists idx_pii_status_created on progress_integrity_incidents(status, created_at);
-- rules 59, 67: exactly one active incident per learner+app; a duplicate
-- detection while one is already open/investigating must aggregate onto it
-- rather than insert a second row.
create unique index if not exists ux_pii_active on progress_integrity_incidents(learner_id, app_id)
  where status in ('open','investigating');
alter table progress_integrity_incidents enable row level security;
alter table progress_integrity_incidents force row level security;

create table if not exists learner_app_progress_integrity (
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null default 'production' check (environment in ('staging','production')),
  integrity_state text not null default 'healthy' check (integrity_state in
    ('healthy','read_only_safe','blocked_repairable_metadata','blocked_conflict','unreadable_corrupt')),
  integrity_version integer not null default 0,
  canonical_state_hash text,
  validated_progress_version integer,
  validated_schema_version integer,
  last_migration_receipt_id uuid references learner_progress_migration_receipts(id),
  issue_codes jsonb not null default '[]',
  mutation_blocked boolean not null default false,
  read_safe boolean not null default true,
  legacy_policy_acknowledged boolean not null default false,
  last_validated_at timestamptz,
  last_validated_source text check (last_validated_source in ('inline_read','inline_write','launch','reconcile') or last_validated_source is null),
  active_incident_id uuid references progress_integrity_incidents(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (learner_id, app_id)
);
create index if not exists idx_lapi_state on learner_app_progress_integrity(integrity_state);
create index if not exists idx_lapi_updated on learner_app_progress_integrity(updated_at);
create index if not exists idx_lapi_incident on learner_app_progress_integrity(active_incident_id);
alter table learner_app_progress_integrity enable row level security;
alter table learner_app_progress_integrity force row level security;

-- Append-only audit/idempotency log for every inline/launch/reconcile
-- validation (rule 6, 60-61: no raw state, ever).
create table if not exists progress_integrity_validation_receipts (
  id uuid primary key,
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  progress_version integer,
  integrity_version integer not null,
  schema_version integer,
  expected_state_hash text,
  actual_state_hash text,
  result text not null check (result in ('pass','fail')),
  classification text not null check (classification in
    ('healthy','read_only_safe','blocked_repairable_metadata','blocked_conflict','unreadable_corrupt')),
  reason text not null check (reason in ('read','write','launch','reconcile')),
  requester_principal_id text,
  request_hash text,
  idempotency_key text,
  created_at timestamptz not null
);
create index if not exists idx_pivr_learner_app_created on progress_integrity_validation_receipts(learner_id, app_id, created_at);
create unique index if not exists ux_pivr_idem on progress_integrity_validation_receipts(requester_principal_id, idempotency_key)
  where idempotency_key is not null;
alter table progress_integrity_validation_receipts enable row level security;
alter table progress_integrity_validation_receipts force row level security;

create table if not exists progress_integrity_incident_actions (
  id uuid primary key,
  incident_id uuid not null references progress_integrity_incidents(id),
  action text not null check (action in
    ('revalidate','retry_safe_metadata_repair','link_matching_receipt',
     'resolve_legacy_policy','open_disaster_recovery_case','resolve_false_positive')),
  actor_admin_id uuid not null references auth.users(id),
  reauthenticated_at timestamptz not null,
  expected_version integer not null,
  idempotency_key text not null,
  reason_category text,
  evidence_refs jsonb not null default '[]',
  result text not null check (result in ('applied','rejected','no_op')),
  result_code text,
  prior_integrity_state text,
  new_integrity_state text,
  prior_incident_status text,
  new_incident_status text,
  created_at timestamptz not null
);
create index if not exists idx_piia_incident_created on progress_integrity_incident_actions(incident_id, created_at);
create unique index if not exists ux_piia_idem on progress_integrity_incident_actions(incident_id, idempotency_key);
alter table progress_integrity_incident_actions enable row level security;
alter table progress_integrity_incident_actions force row level security;

-- Rule 59 dedup at the whole-page-run grain (not per-row, which
-- progress_integrity_validation_receipts already covers) — a retried
-- sweep call with the same runIdempotencyKey+cursor returns the cached
-- page result instead of reprocessing and double-counting.
create table if not exists progress_integrity_sweep_runs (
  run_idempotency_key text not null,
  cursor text not null default '',
  environment text not null,
  app_id text,
  processed integer not null,
  next_cursor text,
  incidents_opened integer not null,
  repairs_applied integer not null,
  created_at timestamptz not null,
  primary key (run_idempotency_key, cursor)
);
alter table progress_integrity_sweep_runs enable row level security;
alter table progress_integrity_sweep_runs force row level security;

insert into platform_service_principals(
  id, service_key, key_ref, status, valid_from, valid_until, version
) values
  ('a1000000-0000-4000-8000-000000000006', 'progress-integrity-reconciler',
   'progress-integrity-reconciler-v1', 'active', now(), 'infinity', 1)
on conflict (service_key) do nothing;


-- ============================================================
-- Source: supabase/migrations/0044_bi001_subscription_assignment.sql
-- ============================================================
-- BI-001 / V49: one immutable purchaser, one assigned learner, immutable
-- checkout context and narrow case-based administrator reassignment.

alter table products
  add column if not exists product_type text not null default 'individual_app'
    check (product_type in ('individual_app','bundle')),
  add column if not exists version integer not null default 1 check (version > 0);

-- Preserve historical REQ-08 bundle rows by assigning them a real product
-- identity before product_id becomes mandatory.
insert into products(slug,name,subdomain,razorpay_plan_id,price_inr,status,product_type,version)
select 'legacy-bundle','Legacy bundle','bundle.babysteps.in','legacy_bundle',0,'archived','bundle',1
where exists(select 1 from subscriptions where product_id is null)
on conflict(slug) do nothing;

update subscriptions
set product_id=(select id from products where slug='legacy-bundle')
where product_id is null;

alter table subscriptions
  add column if not exists purchaser_parent_id uuid references profiles(id),
  add column if not exists assigned_learner_id uuid references learners(id),
  add column if not exists product_version integer not null default 1 check (product_version > 0),
  add column if not exists provider_customer_ref text,
  add column if not exists current_period_start timestamptz,
  add column if not exists pending_reassignment_learner_id uuid references learners(id),
  add column if not exists pending_reassignment_effective_at timestamptz,
  add column if not exists assignment_version integer not null default 1 check (assignment_version > 0),
  add column if not exists version integer not null default 1 check (version > 0);

update subscriptions set purchaser_parent_id=user_id where purchaser_parent_id is null;
update subscriptions set current_period_start=started_at where current_period_start is null;

-- A deterministic one-learner backfill is safe only when a legacy parent
-- owns exactly one learner. Ambiguous/no-learner legacy access is ended;
-- it is never silently assigned to an arbitrary child.
update subscriptions s
set assigned_learner_id=(
  select min(l.id) from learners l where l.owner_parent_id=s.user_id
  having count(*)=1
)
where assigned_learner_id is null;

update subscriptions
set status='expired'
where assigned_learner_id is null and status in ('active','cancelling','past_due');

alter table subscriptions
  alter column purchaser_parent_id set not null,
  alter column product_id set not null,
  alter column current_period_start set not null;

alter table subscriptions drop constraint if exists subscriptions_status_check;
alter table subscriptions add constraint subscriptions_status_check check (status in
  ('pending_payment','active','cancelling','cancelled','expired','past_due',
   'refunded','charged_back','disputed','suspended_fraud'));
alter table subscriptions add constraint subscriptions_bi001_active_assignment check (
  assigned_learner_id is not null or status in ('cancelled','expired','refunded','charged_back','disputed','suspended_fraud')
);
alter table subscriptions add constraint subscriptions_bi001_identity_alias check (user_id=purchaser_parent_id);
alter table subscriptions add constraint subscriptions_bi001_pending_pair check (
  (pending_reassignment_learner_id is null)=(pending_reassignment_effective_at is null)
);
alter table subscriptions add constraint subscriptions_bi001_pending_distinct check (
  pending_reassignment_learner_id is null or pending_reassignment_learner_id<>assigned_learner_id
);

create or replace function prevent_subscription_purchaser_change()
returns trigger language plpgsql as $$
begin
  if new.purchaser_parent_id<>old.purchaser_parent_id or new.user_id<>old.user_id then
    raise exception 'subscription purchaser is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists subscriptions_purchaser_immutable on subscriptions;
create trigger subscriptions_purchaser_immutable
before update of purchaser_parent_id,user_id on subscriptions
for each row execute function prevent_subscription_purchaser_change();

create index if not exists idx_subscriptions_purchaser on subscriptions(purchaser_parent_id,status,id);
create index if not exists idx_subscriptions_learner on subscriptions(assigned_learner_id,status,id);
create index if not exists idx_subscriptions_pending_reassignment
  on subscriptions(pending_reassignment_effective_at)
  where pending_reassignment_learner_id is not null;

drop policy if exists "subscriptions are readable by owner" on subscriptions;
create policy "subscriptions are readable by purchaser" on subscriptions for select
  using (auth.uid()=purchaser_parent_id);

create table product_version_apps (
  product_id uuid not null references products(id),
  product_version integer not null check(product_version>0),
  app_id uuid not null references app_registry(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key(product_id,product_version,app_id)
);
create index idx_product_version_apps_app on product_version_apps(app_id,product_id,product_version);

insert into product_version_apps(product_id,product_version,app_id)
select p.id,p.version,a.id from products p join app_registry a on
  (p.slug='chess' and a.app_key='chess-master') or
  (p.slug='magical-math' and a.app_key='magical-math') or
  (p.slug='speed-reading' and a.app_key='speed-reader')
on conflict do nothing;

create table checkout_intents (
  id uuid primary key default gen_random_uuid(),
  purchaser_parent_id uuid not null references profiles(id),
  assigned_learner_id uuid not null references learners(id),
  product_id uuid not null references products(id),
  product_version integer not null check(product_version>0),
  provider text not null,
  provider_checkout_ref text not null unique,
  provider_handoff_json jsonb not null,
  status text not null default 'pending_provider'
    check(status in ('pending_provider','payment_failed','activated','expired')),
  idempotency_key text not null,
  request_hash text not null,
  expires_at timestamptz not null,
  subscription_id uuid references subscriptions(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(purchaser_parent_id,idempotency_key)
);
create index idx_checkout_intents_status_expiry on checkout_intents(status,expires_at);

create or replace function prevent_checkout_context_change()
returns trigger language plpgsql as $$
begin
  raise exception 'checkout context is immutable';
end;
$$;
create trigger checkout_intents_context_immutable
before update of purchaser_parent_id,assigned_learner_id,product_id,product_version,
  provider,provider_checkout_ref,idempotency_key,request_hash on checkout_intents
for each row execute function prevent_checkout_context_change();

create table checkout_activation_receipts (
  provider text not null,
  provider_event_id text not null,
  request_hash text not null,
  checkout_intent_id uuid not null references checkout_intents(id),
  subscription_id uuid references subscriptions(id),
  result_code text not null,
  response_json jsonb,
  created_at timestamptz not null default now(),
  primary key(provider,provider_event_id)
);

create table subscription_reassignment_cases (
  id uuid primary key default gen_random_uuid(),
  purchaser_parent_id uuid not null references profiles(id),
  subscription_id uuid not null references subscriptions(id),
  source_learner_id uuid not null references learners(id),
  target_learner_id uuid not null references learners(id),
  reason_code text not null,
  notes text,
  status text not null default 'open'
    check(status in ('open','scheduled','executed','rejected','closed','expired')),
  requested_effective_mode text check(requested_effective_mode in ('immediate_if_unused','next_period')),
  effective_at timestamptz,
  administrator_id uuid references auth.users(id),
  resolution_code text,
  version integer not null default 1 check(version>0),
  idempotency_key text not null,
  request_hash text not null,
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  executed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(purchaser_parent_id,idempotency_key),
  check(source_learner_id<>target_learner_id)
);
create index idx_reassignment_cases_subscription on subscription_reassignment_cases(subscription_id,status);
create index idx_reassignment_cases_admin on subscription_reassignment_cases(administrator_id,status);

create table subscription_reassignment_requests (
  administrator_id uuid not null references auth.users(id),
  idempotency_key text not null,
  case_id uuid not null references subscription_reassignment_cases(id),
  subscription_id uuid not null references subscriptions(id),
  request_hash text not null,
  response_json jsonb,
  status text not null check(status in ('processing','completed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(administrator_id,idempotency_key)
);

create table subscription_assignment_audit (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  case_id uuid references subscription_reassignment_cases(id),
  event_type text not null check(event_type in
    ('subscription_activated','reassignment_case_created','reassignment_scheduled','reassignment_executed')),
  actor_type text not null check(actor_type in ('parent','administrator','billing_service')),
  actor_id text not null,
  purchaser_parent_id uuid not null,
  source_learner_id uuid,
  target_learner_id uuid,
  product_id uuid not null,
  effective_at timestamptz,
  result_code text not null,
  created_at timestamptz not null default now()
);
create index idx_subscription_assignment_audit_subscription on subscription_assignment_audit(subscription_id,created_at);

create or replace function reject_subscription_assignment_audit_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'subscription assignment audit is immutable';
end;
$$;
create trigger subscription_assignment_audit_no_update_delete
before update or delete on subscription_assignment_audit
for each row execute function reject_subscription_assignment_audit_mutation();

alter table product_version_apps enable row level security;
alter table checkout_intents enable row level security;
alter table checkout_activation_receipts enable row level security;
alter table subscription_reassignment_cases enable row level security;
alter table subscription_reassignment_requests enable row level security;
alter table subscription_assignment_audit enable row level security;

alter table product_version_apps force row level security;
alter table checkout_intents force row level security;
alter table checkout_activation_receipts force row level security;
alter table subscription_reassignment_cases force row level security;
alter table subscription_reassignment_requests force row level security;
alter table subscription_assignment_audit force row level security;

create policy "checkout intents are readable by purchaser" on checkout_intents for select
  using(auth.uid()=purchaser_parent_id);
create policy "reassignment cases are readable by purchaser" on subscription_reassignment_cases for select
  using(auth.uid()=purchaser_parent_id);
create policy "assignment audit is readable by purchaser" on subscription_assignment_audit for select
  using(auth.uid()=purchaser_parent_id);

-- Browser/authenticated roles receive no insert/update/delete policies.
-- Billing and authorized administrator services write through service-role
-- repositories only; learning apps receive entitlement APIs, never these tables.


-- ============================================================
-- Source: supabase/migrations/0045_bi002_payment_auto_renew.sql
-- ============================================================
-- BI-002 / V49: immutable priced consent, provider-verified activation and
-- renewal, paid-period ledger, reconciliation and one T-7 reminder per cycle.

create table product_prices (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  currency text not null check(length(currency)=3 and currency=upper(currency)),
  billing_interval text not null check(billing_interval in ('month','year')),
  interval_count integer not null default 1 check(interval_count>0),
  unit_amount bigint not null check(unit_amount>=0),
  pricing_rule_version text not null,
  supports_non_renewing boolean not null default true,
  status text not null default 'active' check(status in ('active','retired')),
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  version integer not null check(version>0),
  created_at timestamptz not null default now(),
  unique(product_id,currency,billing_interval,interval_count,version)
);
create index idx_product_prices_catalog on product_prices(product_id,status,currency,version);

insert into product_prices(product_id,currency,billing_interval,interval_count,unit_amount,
  pricing_rule_version,supports_non_renewing,status,effective_from,version)
select id,'INR','month',1,price_inr*100,'product-v'||version,true,'active',now(),version
from products
on conflict(product_id,currency,billing_interval,interval_count,version) do nothing;

alter table subscriptions
  add column if not exists auto_renew_enabled boolean not null default false,
  add column if not exists provider text not null default 'legacy',
  add column if not exists provider_environment text not null default 'test'
    check(provider_environment in ('test','production')),
  add column if not exists provider_account_id text,
  add column if not exists provider_payment_method_ref text,
  add column if not exists provider_mandate_ref text,
  add column if not exists provider_subscription_ref text,
  add column if not exists billing_price_id uuid references product_prices(id),
  add column if not exists billing_price_version integer,
  add column if not exists payment_state text not null default 'paid'
    check(payment_state in ('pending','paid','renewal_failed','failed','overlap_resolution_required')),
  add column if not exists next_renewal_at timestamptz,
  add column if not exists billing_anchor_at timestamptz,
  add column if not exists original_anchor_day integer check(original_anchor_day between 1 and 31),
  add column if not exists original_anchor_time time;

update subscriptions set provider_subscription_ref=razorpay_subscription_id
where provider_subscription_ref is null;
update subscriptions set billing_anchor_at=current_period_start
where billing_anchor_at is null;
update subscriptions set original_anchor_day=extract(day from billing_anchor_at)::integer,
  original_anchor_time=billing_anchor_at::time
where billing_anchor_at is not null and original_anchor_day is null;
update subscriptions s set billing_price_id=pp.id,billing_price_version=pp.version
from product_prices pp where s.billing_price_id is null and pp.product_id=s.product_id
  and pp.version=s.product_version and pp.status='active';

create index idx_subscriptions_next_renewal on subscriptions(next_renewal_at,id)
where auto_renew_enabled=true and cancel_at_period_end=false;

alter table checkout_intents
  add column if not exists price_id uuid references product_prices(id),
  add column if not exists price_version integer,
  add column if not exists amount bigint,
  add column if not exists currency text,
  add column if not exists billing_interval text,
  add column if not exists interval_count integer,
  add column if not exists auto_renew_enabled boolean,
  add column if not exists consent_disclosure_version text,
  add column if not exists consented_at timestamptz,
  add column if not exists provider_environment text,
  add column if not exists provider_account_id text,
  add column if not exists provider_payment_ref text,
  add column if not exists provider_mandate_ref text,
  add column if not exists overlap_source_hash text;

drop trigger if exists checkout_intents_context_immutable on checkout_intents;
create trigger checkout_intents_context_immutable
before update of purchaser_parent_id,assigned_learner_id,product_id,product_version,
  price_id,price_version,amount,currency,billing_interval,interval_count,auto_renew_enabled,
  consent_disclosure_version,consented_at,provider,provider_environment,provider_account_id,
  provider_checkout_ref,idempotency_key,request_hash,overlap_source_hash on checkout_intents
for each row execute function prevent_checkout_context_change();

create table billing_periods (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  period_start timestamptz not null,
  period_end timestamptz not null,
  provider_payment_ref text not null unique,
  amount bigint not null check(amount>=0),
  currency text not null,
  price_id uuid not null references product_prices(id),
  price_version integer not null,
  status text not null check(status in ('paid','failed','refunded','disputed')),
  source_provider_event_id text not null,
  created_at timestamptz not null default now(),
  unique(subscription_id,period_start,period_end)
);
create index idx_billing_periods_subscription on billing_periods(subscription_id,period_start,status);

create table payment_provider_events (
  provider text not null,
  environment text not null check(environment in ('test','production')),
  account_id text not null,
  provider_event_id text not null,
  event_type text not null,
  payload_hash text not null,
  checkout_intent_id uuid references checkout_intents(id),
  subscription_id uuid references subscriptions(id),
  provider_checkout_ref text,
  provider_payment_ref text,
  status text not null check(status in ('received','processed','duplicate','ignored','rejected','deferred')),
  result_code text,
  result_json jsonb,
  error_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key(provider,environment,account_id,provider_event_id)
);
create index idx_payment_provider_events_status on payment_provider_events(status,received_at);

create table billing_mutation_requests (
  actor_id uuid not null,
  subscription_id uuid not null references subscriptions(id),
  idempotency_key text not null,
  operation text not null,
  request_hash text not null,
  result_json jsonb,
  status text not null check(status in ('processing','completed','failed')),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  expires_at timestamptz not null,
  primary key(actor_id,subscription_id,idempotency_key)
);
create index idx_billing_mutation_requests_expiry on billing_mutation_requests(expires_at,status);

create table subscription_renewal_reminders (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  renewal_cycle_at timestamptz not null,
  reminder_due_at timestamptz not null,
  expected_amount bigint not null,
  currency text not null,
  price_id uuid not null references product_prices(id),
  price_version integer not null,
  channel text not null default 'email' check(channel in ('email','in_product')),
  status text not null default 'pending'
    check(status in ('pending','sending','sent','retry_pending','cancelled','skipped')),
  attempt_count integer not null default 0,
  sent_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(subscription_id,renewal_cycle_at)
);
create index idx_subscription_renewal_reminders_due
  on subscription_renewal_reminders(status,reminder_due_at,id);

create table billing_job_runs (
  principal_id uuid not null references platform_service_principals(id),
  job_type text not null check(job_type in ('reconcile','renewal_reminder')),
  run_idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('running','completed','failed')),
  result_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(principal_id,job_type,run_idempotency_key)
);

insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
values
  (gen_random_uuid(),'billing-reconciliation-service','kms://babysteps/billing-reconciliation/v1','',
   'active',now(),now()+interval '365 days',1),
  (gen_random_uuid(),'billing-notification-service','kms://babysteps/billing-notification/v1','',
   'active',now(),now()+interval '365 days',1)
on conflict(service_key) do nothing;

alter table product_prices enable row level security;
alter table billing_periods enable row level security;
alter table payment_provider_events enable row level security;
alter table billing_mutation_requests enable row level security;
alter table subscription_renewal_reminders enable row level security;
alter table billing_job_runs enable row level security;

alter table product_prices force row level security;
alter table billing_periods force row level security;
alter table payment_provider_events force row level security;
alter table billing_mutation_requests force row level security;
alter table subscription_renewal_reminders force row level security;
alter table billing_job_runs force row level security;

create policy "active product prices are publicly readable" on product_prices for select
  using(status='active' and (effective_to is null or effective_to>now()));
create policy "billing periods are readable by purchaser" on billing_periods for select
  using(exists(select 1 from subscriptions s where s.id=subscription_id and s.purchaser_parent_id=auth.uid()));

-- No browser policies exist for provider events, mutation receipts,
-- reminders or job runs. Trusted service repositories remain the only write
-- path; learning applications receive entitlement APIs, never billing data.


-- ============================================================
-- Source: supabase/migrations/0046_bi003_failed_renewal_grace.sql
-- ============================================================
-- BI-003 / V49: exact 168-hour failed-renewal grace, provider recovery,
-- existing-credit-only access and deterministic nonpayment cutoff.

alter table subscriptions drop constraint if exists subscriptions_payment_state_check;
alter table subscriptions
  add column if not exists grace_started_at timestamptz,
  add column if not exists grace_ends_at timestamptz,
  add column if not exists renewal_failure_at timestamptz,
  add column if not exists last_recovery_attempt_at timestamptz,
  add column if not exists recovery_version integer not null default 1 check(recovery_version>0),
  add column if not exists nonpayment_ended_at timestamptz,
  add column if not exists provider_retry_stop_state text
    check(provider_retry_stop_state in ('pending','confirmed','unsupported','failed')),
  add constraint subscriptions_payment_state_check check(payment_state in
    ('pending','paid','renewal_failed','past_due_grace','inactive_nonpayment','failed','overlap_resolution_required'));

create index if not exists idx_subscriptions_grace_expiry on subscriptions(grace_ends_at,id)
where payment_state='past_due_grace';

create table renewal_payment_attempts (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  provider text not null,
  environment text not null check(environment in ('test','production')),
  account_id text not null,
  provider_invoice_ref text,
  provider_payment_ref text not null,
  provider_attempt_ref text,
  attempt_number integer not null default 1 check(attempt_number>0),
  status text not null check(status in ('failed','settled','late_exception')),
  amount bigint not null check(amount>=0),
  currency text not null,
  price_id uuid not null references product_prices(id),
  price_version integer not null,
  attempted_at timestamptz not null,
  settled_at timestamptz,
  failure_code text,
  provider_event_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider,environment,account_id,provider_payment_ref),
  unique(provider,environment,account_id,provider_attempt_ref)
);
create index idx_renewal_payment_attempts_subscription
  on renewal_payment_attempts(subscription_id,status,attempted_at);

create table payment_method_update_sessions (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references profiles(id),
  subscription_id uuid not null references subscriptions(id),
  provider text not null,
  environment text not null check(environment in ('test','production')),
  provider_session_ref text not null unique,
  provider_handoff_url text not null,
  status text not null check(status in ('created','completed','expired','failed')),
  idempotency_key text not null,
  request_hash text not null,
  expires_at timestamptz not null,
  result_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(parent_id,subscription_id,idempotency_key)
);
create index idx_payment_method_update_sessions_expiry
  on payment_method_update_sessions(status,expires_at);

create table billing_recovery_notifications (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  notification_type text not null
    check(notification_type in ('initial_failure','routine_recovery','recovered','expired')),
  channel text not null check(channel in ('email','in_product')),
  window_key text not null,
  status text not null check(status in ('pending','sending','sent','retry_pending','cancelled')),
  attempt_count integer not null default 0,
  sent_at timestamptz,
  last_error_code text,
  safe_context_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(subscription_id,notification_type,channel,window_key)
);
create index idx_billing_recovery_notifications_status
  on billing_recovery_notifications(status,created_at,id);

create table billing_grace_job_runs (
  principal_id uuid not null references platform_service_principals(id),
  run_idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('running','completed','failed')),
  result_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(principal_id,run_idempotency_key)
);

insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
values(gen_random_uuid(),'billing-recovery-service','kms://babysteps/billing-recovery/v1','',
  'active',now(),now()+interval '365 days',1)
on conflict(service_key) do nothing;

alter table renewal_payment_attempts enable row level security;
alter table payment_method_update_sessions enable row level security;
alter table billing_recovery_notifications enable row level security;
alter table billing_grace_job_runs enable row level security;
alter table renewal_payment_attempts force row level security;
alter table payment_method_update_sessions force row level security;
alter table billing_recovery_notifications force row level security;
alter table billing_grace_job_runs force row level security;

-- No browser policies: parent recovery is exposed only through scoped API
-- services, and learning applications receive entitlement decisions only.


-- ============================================================
-- Source: supabase/migrations/0047_pr002_progress_recovery.sql
-- ============================================================
-- PR-002: original-browser pre-expiry recovery of pending meaningful
-- progress, with server-authoritative conflict protection. Genuinely
-- greenfield — PR-004 (0043) explicitly modeled PR-002 as absent.

alter table learner_sessions add column if not exists last_acknowledged_progress_version integer;
alter table learner_sessions add column if not exists last_acknowledged_progress_hash text;
alter table learner_sessions add column if not exists recovery_closed_at timestamptz;
alter table learner_sessions add column if not exists recovery_closed_reason text
  check (recovery_closed_reason in ('finalized','secure_exit','hard_expired','security_revoked','irrecoverable')
    or recovery_closed_reason is null);

-- Append-only, metadata-only per rule 45 — no raw pendingState/current_state
-- is ever persisted here.
create table if not exists progress_recovery_receipts (
  id uuid primary key,
  learner_session_id uuid not null references learner_sessions(id),
  learner_id uuid not null references learners(id),
  app_id uuid not null references app_registry(id) on delete restrict,
  device_session_id text not null,
  recovery_capsule_id text not null,
  recovery_sequence integer not null,
  base_progress_version integer not null,
  base_state_hash text not null,
  new_progress_version integer,
  new_state_hash text,
  release_id uuid,
  deployment_id uuid,
  request_hash text not null,
  idempotency_key text not null,
  result text not null check (result in ('recovered','stale','rejected')),
  result_code text,
  created_at timestamptz not null,
  unique(learner_session_id, idempotency_key)
);
create index if not exists idx_prr_session_sequence on progress_recovery_receipts(learner_session_id, recovery_sequence);
alter table progress_recovery_receipts enable row level security;
alter table progress_recovery_receipts force row level security;

-- Safe metadata-only recovery-attempt incidents (rule 63) — a discrete
-- per-attempt problem log, not a persistent per-learner-app state machine
-- like PR-004's progress_integrity_incidents, so dedup is scoped to
-- (session, category) rather than (learner, app).
create table if not exists progress_recovery_incidents (
  id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  learner_id uuid not null references learners(id),
  learner_session_id uuid not null references learner_sessions(id),
  release_id uuid,
  category text not null check (category in
    ('stale','device_mismatch','schema_migration_required','integrity_blocked','incomplete_receipt')),
  base_progress_version integer,
  base_state_hash text,
  current_progress_version integer,
  current_state_hash text,
  status text not null default 'open' check (status in ('open','resolved')),
  attempt_count integer not null default 1,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  resolved_at timestamptz
);
create unique index if not exists ux_pri_active on progress_recovery_incidents(learner_session_id, category)
  where status = 'open';
alter table progress_recovery_incidents enable row level security;
alter table progress_recovery_incidents force row level security;

insert into platform_service_principals(
  id, service_key, key_ref, status, valid_from, valid_until, version
) values
  ('a1000000-0000-4000-8000-000000000007', 'progress-recovery-reconciler',
   'progress-recovery-reconciler-v1', 'active', now(), 'infinity', 1)
on conflict (service_key) do nothing;


-- ============================================================
-- Source: supabase/migrations/0048_bi004_subscription_cancellation.sql
-- ============================================================
-- BI-004 / V49: cancel at paid-period end, preserve paid access, and permit
-- provider-confirmed auto-renewal resumption before the same period ends.

alter table subscriptions
  add column if not exists provider_mandate_status text not null default 'unknown'
    check(provider_mandate_status in ('unknown','valid','invalid','pending_setup')),
  add column if not exists cancellation_requested_at timestamptz,
  add column if not exists cancellation_effective_at timestamptz,
  add column if not exists cancellation_reversed_at timestamptz,
  add column if not exists cancellation_reason_code text
    check(cancellation_reason_code is null or cancellation_reason_code='self_service'),
  add column if not exists cancellation_version integer not null default 1 check(cancellation_version>0);

update subscriptions set provider_mandate_status='valid'
where provider_mandate_ref is not null and provider_mandate_status='unknown';

update subscriptions set
  cancellation_requested_at=coalesce(cancellation_requested_at,updated_at),
  cancellation_effective_at=coalesce(cancellation_effective_at,current_period_end),
  cancellation_reason_code=coalesce(cancellation_reason_code,'self_service')
where cancel_at_period_end=true;

create index if not exists idx_subscriptions_cancellation_effective
  on subscriptions(cancellation_effective_at,id) where cancel_at_period_end=true;

create table recurring_agreement_setup_sessions (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references profiles(id),
  subscription_id uuid not null references subscriptions(id),
  provider text not null,
  provider_environment text not null check(provider_environment in ('test','production')),
  provider_session_ref text not null unique,
  provider_handoff_url text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('pending','confirmed','failed','expired')),
  expires_at timestamptz not null,
  result_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(parent_id,subscription_id,idempotency_key)
);
create index idx_recurring_agreement_setup_expiry
  on recurring_agreement_setup_sessions(status,expires_at);

create table billing_cancellation_notifications (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  cancellation_version integer not null,
  notification_type text not null
    check(notification_type in ('scheduled','setup_required','reversed','ended')),
  channel text not null check(channel in ('email','in_product')),
  recipient_email text,
  status text not null check(status in ('pending','sending','sent','retry_pending','cancelled')),
  attempt_count integer not null default 0,
  sent_at timestamptz,
  last_error_code text,
  safe_context_json jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(subscription_id,cancellation_version,notification_type,channel)
);
create index idx_billing_cancellation_notifications_status
  on billing_cancellation_notifications(status,created_at,id);

alter table recurring_agreement_setup_sessions enable row level security;
alter table billing_cancellation_notifications enable row level security;
alter table recurring_agreement_setup_sessions force row level security;
alter table billing_cancellation_notifications force row level security;

-- No browser policies. Parent operations are scoped through server-side
-- purchasing-parent services; learning applications receive no billing scope.


-- ============================================================
-- Source: supabase/migrations/0049_en003_lifecycle_transitions.sql
-- ============================================================
-- EN-003 / minimal BI-005: one versioned entitlement-transition domain
-- consuming verified billing/identity/app-registry/security lifecycle
-- events. Cancellation (BI-004) and grace (BI-003) keep their existing
-- lazy-lapse mechanism entirely unchanged — expireCancellationState/
-- expireGraceSubscriptionState gain one added call each into this ledger
-- so every transition, old and new, is immutable and auditable (rules 8,
-- 68). This ledger is the sole writer of the terminal states BI-005
-- introduces: inactive_refunded, suspended_financial, suspended_security
-- (already present, unused, in learner_app_effective_entitlements.state's
-- CHECK constraint since migration 0032).

create table entitlement_lifecycle_events (
  id uuid primary key default gen_random_uuid(),
  source text not null check(source in
    ('billing_cancellation','billing_grace','billing_refund','billing_chargeback',
     'billing_dispute','billing_reassignment','platform_security','reconciliation')),
  event_id text not null,
  event_type text not null,
  source_version integer not null,
  effective_at timestamptz not null,
  subscription_id uuid references subscriptions(id),
  paid_cycle_id text,
  refund_case_id uuid,
  dispute_id uuid,
  reassignment_case_id uuid references subscription_reassignment_cases(id),
  learner_id uuid not null references learners(id),
  -- The set of apps this event affects. Not a strict FK array (an app set
  -- snapshot, same reasoning as entitlement_cycles.app_ids_json) — the
  -- affected (learner,app,environment) rows are re-resolved from
  -- authoritative source tables at apply time, this is only the recorded
  -- input snapshot for audit/idempotency hashing.
  app_ids_json text not null,
  -- null = platform-level event (security revocation, reassignment audit)
  -- applying across every environment for this learner+app, not scoped to
  -- one provider environment.
  environment text,
  reason_category text not null,
  policy_effect text check(policy_effect is null or policy_effect in ('terminate_now','no_change')),
  fraud_or_security_risk integer not null default 0,
  payload_hash text not null,
  status text not null default 'pending' check(status in ('pending','applied','quarantined','rejected')),
  quarantine_reason text,
  conflicting_event_id uuid references entitlement_lifecycle_events(id),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source, event_id)
);
create index idx_entitlement_lifecycle_events_status on entitlement_lifecycle_events(status, effective_at);
create index idx_entitlement_lifecycle_events_learner on entitlement_lifecycle_events(learner_id, created_at);
create index idx_entitlement_lifecycle_events_subscription on entitlement_lifecycle_events(subscription_id, source_version);

-- Append-only per rule 8/68 ("financial and entitlement history remain
-- immutable and auditable") — mirrors BI-001's
-- reject_subscription_assignment_audit_mutation trigger on
-- subscription_assignment_audit.
create table entitlement_state_transitions (
  id uuid primary key default gen_random_uuid(),
  effective_entitlement_id uuid not null references learner_app_effective_entitlements(id),
  lifecycle_event_id uuid not null references entitlement_lifecycle_events(id),
  previous_state text not null,
  new_state text not null,
  effective_at timestamptz not null,
  session_effect text not null check(session_effect in
    ('preserve_to_hard_expiry','cancel_starting','immediate_revoke','none')),
  reason_category text not null,
  transition_version integer not null,
  result text not null check(result in ('applied','duplicate','superseded','quarantined')),
  created_at timestamptz not null default now(),
  unique(effective_entitlement_id, lifecycle_event_id)
);
create index idx_entitlement_state_transitions_entitlement
  on entitlement_state_transitions(effective_entitlement_id, created_at);

create or replace function reject_entitlement_state_transition_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'entitlement state transition history is immutable';
end;
$$;
create trigger entitlement_state_transitions_no_update_delete
before update or delete on entitlement_state_transitions
for each row execute function reject_entitlement_state_transition_mutation();

-- Idempotency receipts, mirroring EN-001's entitlement_application_receipts.
create table entitlement_transition_receipts (
  lifecycle_event_id uuid primary key references entitlement_lifecycle_events(id),
  request_hash text not null,
  idempotency_status text not null check(idempotency_status in ('processing','completed','failed')),
  result_json jsonb,
  error_code text,
  attempt_count integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table learner_app_effective_entitlements
  add column if not exists scheduled_transition_at timestamptz,
  add column if not exists scheduled_transition_type text,
  add column if not exists lifecycle_version integer not null default 0,
  add column if not exists last_lifecycle_event_id uuid references entitlement_lifecycle_events(id),
  add column if not exists revoked_before timestamptz;

-- Minimal BI-005: admin-driven refund case + provider-confirmation, modeled
-- on subscription_reassignment_cases. No dispute-resolution workflow, no
-- new payment-gateway integration — reuses BI-001's provider-adapter shape.
create table refund_cases (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  refund_type text not null check(refund_type in ('full','partial')),
  amount integer,
  entitlement_effect text check(entitlement_effect is null or entitlement_effect in ('terminate_now','no_change')),
  reason_category text not null,
  status text not null default 'pending_provider_confirmation'
    check(status in ('pending_provider_confirmation','confirmed','reversed','rejected')),
  provider_refund_ref text,
  refund_confirmed_at timestamptz,
  version integer not null default 1 check(version>0),
  administrator_id uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- rule 36: entitlement_effect is required (and meaningful) only for a
  -- partial refund; a full refund's effect is implicitly terminate_now.
  check((refund_type='partial')=(entitlement_effect is not null))
);
create index idx_refund_cases_subscription on refund_cases(subscription_id, status);

-- Minimal BI-005: signed chargeback/dispute webhook receipts, mirroring
-- deployment_webhook_receipts' shape (AR-002 session 2).
create table financial_dispute_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null check(event_type in ('chargeback_confirmed','chargeback_reversed','dispute_opened')),
  subscription_id uuid not null references subscriptions(id),
  fraud_or_security_risk integer not null default 0,
  occurred_at timestamptz not null,
  payload_hash text not null,
  status text not null default 'received' check(status in ('received','processed','rejected')),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(provider, provider_event_id)
);
create index idx_financial_dispute_events_subscription on financial_dispute_events(subscription_id, created_at);

-- process-due-transitions / reconcile-lifecycle bounded-sweep job ledger,
-- same shape as BI-002's billing_job_runs, scoped to this domain rather
-- than widening that table's job_type CHECK constraint.
create table entitlement_lifecycle_job_runs (
  principal_id uuid not null,
  job_type text not null check(job_type in ('sweep','reconcile')),
  run_idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('running','completed','failed')),
  result_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(principal_id,job_type,run_idempotency_key)
);

alter table entitlement_lifecycle_events enable row level security;
alter table entitlement_state_transitions enable row level security;
alter table entitlement_transition_receipts enable row level security;
alter table refund_cases enable row level security;
alter table financial_dispute_events enable row level security;
alter table entitlement_lifecycle_job_runs enable row level security;
alter table entitlement_lifecycle_events force row level security;
alter table entitlement_state_transitions force row level security;
alter table entitlement_transition_receipts force row level security;
alter table refund_cases force row level security;
alter table financial_dispute_events force row level security;
alter table entitlement_lifecycle_job_runs force row level security;

-- No browser policies — these are entirely service-role-written and read;
-- parents/admins see only the safe views the API layer derives from them.

insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
values
  (gen_random_uuid(),'entitlement-lifecycle-service','kms://babysteps/entitlement-lifecycle/v1','',
   'active',now(),now()+interval '365 days',1),
  (gen_random_uuid(),'entitlement-reconciliation-service','kms://babysteps/entitlement-reconciliation/v1','',
   'active',now(),now()+interval '365 days',1)
on conflict(service_key) do nothing;


-- ============================================================
-- Source: supabase/migrations/0050_en004_integrity_reconciliation.sql
-- ============================================================
-- EN-004: automatic repair from verified source truth, conflict quarantine
-- and cross-domain integrity monitoring. Every repair calls through to the
-- same EN-001 (applyPaidCycle), EN-002 (recomputeEffectiveEntitlement),
-- EN-003 (applyLifecycleEvent) or SC-002
-- (ensureEntitlementPeriodStandardAllocation) domain functions normal event
-- processing already uses — nothing here inserts a ready entitlement,
-- changes a credit count or sets an effective allowed flag directly.

-- One row per source record compared against its expected target, whether
-- the result was healthy/no-op, an applied repair, a deferred transient
-- failure or an opened incident (rules 8-9, 43).
create table entitlement_reconciliation_receipts (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check(source_type in
    ('paid_cycle','entitlement_period','effective_entitlement','lifecycle_event','credit_batch')),
  source_id text not null,
  source_version integer,
  source_hash text,
  expected_target_hash text,
  action text not null check(action in ('healthy','repair','defer','incident')),
  target_type text,
  target_id text,
  target_version integer,
  result text not null check(result in ('applied','no_op','failed')),
  attempt_count integer not null default 1,
  principal_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_type, source_id, source_version, target_type)
);
create index idx_entitlement_reconciliation_receipts_source
  on entitlement_reconciliation_receipts(source_type, source_id);

-- Rule 59 dedup at the whole-page-run grain, same shape as
-- progress_integrity_sweep_runs — a retried sweep call with the same
-- runIdempotencyKey+cursor returns the cached page result instead of
-- reprocessing and double-counting (rules 6, 55).
create table entitlement_integrity_sweep_runs (
  run_idempotency_key text not null,
  cursor text not null default '',
  environment text not null,
  source_domains_json text not null default '[]',
  window_from timestamptz,
  window_to timestamptz,
  principal_id uuid not null,
  processed integer not null,
  healthy_count integer not null default 0,
  repaired_count integer not null default 0,
  deferred_count integer not null default 0,
  incidents_opened_count integer not null default 0,
  errors_count integer not null default 0,
  next_cursor text,
  created_at timestamptz not null default now(),
  primary key(run_idempotency_key, cursor)
);

-- Rules 22, 31, 36, 38, 45: a narrowly-scoped operations incident queue for
-- genuine conflicts reconciliation must not silently resolve on its own —
-- mismatched identities, a ready target with no verified source, or a
-- used/mismatched batch. Safe technical identifiers and a mismatch category
-- only; no sensitive provider payload, payment instrument or progress data.
create table entitlement_integrity_incidents (
  id uuid primary key default gen_random_uuid(),
  environment text not null,
  category text not null check(category in
    ('MISSING_ENTITLEMENT','INCOMPLETE_ENTITLEMENT','PRODUCT_SNAPSHOT_MISMATCH','LEARNER_MISMATCH',
     'PERIOD_MISMATCH','SOURCE_HASH_MISMATCH','APP_SET_MISMATCH','ENTITLEMENT_WITHOUT_VERIFIED_SOURCE',
     'MISSING_EFFECTIVE_ENTITLEMENT','MISSING_LIFECYCLE_EVENT','MISSING_ALLOCATION_BATCH',
     'EXTRA_BATCH_UNKNOWN_SOURCE','BATCH_ATTRIBUTE_MISMATCH')),
  source_type text not null,
  source_id text not null,
  target_type text,
  target_id text,
  expected_hash text,
  actual_hash text,
  severity text not null check(severity in ('low','medium','high','critical')),
  status text not null default 'open' check(status in
    ('open','investigating','resolved_repaired','resolved_false_positive','routed_refund_case')),
  remediation_workflow text not null default 'none'
    check(remediation_workflow in ('none','refund_case','manual_source_correction')),
  remediation_reference text,
  assigned_operator_id uuid references auth.users(id),
  attempt_count integer not null default 0,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
-- Rule 22: exactly one active incident per source record under review.
create unique index ux_eii_active on entitlement_integrity_incidents(source_type, source_id)
  where status in ('open','investigating');

create table entitlement_integrity_incident_actions (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references entitlement_integrity_incidents(id),
  action text not null check(action in ('retry','resolve_false_positive','open_refund_case')),
  actor_admin_id uuid not null references auth.users(id),
  reauthenticated_at timestamptz not null,
  expected_version integer not null,
  idempotency_key text not null,
  reason_category text,
  evidence_refs text not null default '[]',
  result text not null check(result in ('applied','rejected','no_op')),
  result_code text,
  prior_incident_status text,
  new_incident_status text,
  created_at timestamptz not null default now(),
  unique(incident_id,idempotency_key)
);

-- Rules 41-42, 51-52: 'repair_in_progress' blocks new sessions while a
-- verified-but-incomplete source is being reconciled; 'quarantined' blocks
-- them while a genuine conflict is under incident review.
alter table learner_app_effective_entitlements
  add column if not exists integrity_state text not null default 'healthy'
    check(integrity_state in ('healthy','repair_in_progress','quarantined')),
  add column if not exists last_reconciled_source_version integer,
  add column if not exists last_reconciled_at timestamptz;

-- Rules 36-38: a batch belonging to a suppressed/unknown source is frozen
-- from new funding rather than deleted (counters/history preserved).
alter table learner_app_standard_credit_batches
  add column if not exists funding_disabled_at timestamptz,
  add column if not exists funding_disabled_reason text,
  add column if not exists reconciliation_receipt_id uuid references entitlement_reconciliation_receipts(id);

alter table entitlement_reconciliation_receipts enable row level security;
alter table entitlement_integrity_sweep_runs enable row level security;
alter table entitlement_integrity_incidents enable row level security;
alter table entitlement_integrity_incident_actions enable row level security;
alter table entitlement_reconciliation_receipts force row level security;
alter table entitlement_integrity_sweep_runs force row level security;
alter table entitlement_integrity_incidents force row level security;
alter table entitlement_integrity_incident_actions force row level security;

-- No browser policies — these are entirely service-role-written and read;
-- parents/admins see only the safe views the API layer derives from them.

insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
values
  (gen_random_uuid(),'entitlement-integrity-monitor-service','kms://babysteps/entitlement-integrity-monitor/v1','',
   'active',now(),now()+interval '365 days',1)
on conflict(service_key) do nothing;


-- ============================================================
-- Source: supabase/migrations/0051_ul002_safe_session_exit.sql
-- ============================================================
-- UL-002: checkpointed intentional app exit with Resume later or Finish now.
alter table learner_sessions drop constraint if exists learner_sessions_status_check;
alter table learner_sessions add constraint learner_sessions_status_check check (status in
  ('starting','active','disconnected','resumable','completed','interrupted','expired','revoked_by_admin','cancelled_before_launch'));

alter table learner_sessions add column if not exists intentional_exit_state text not null default 'none';
alter table learner_sessions add column if not exists intentional_exit_reason text;
alter table learner_sessions add column if not exists last_exit_acknowledged_progress_version integer;
alter table learner_sessions add column if not exists resumable_marked_at timestamptz;
alter table learner_sessions add column if not exists exit_transition_version integer not null default 0;
alter table learner_sessions drop constraint if exists learner_sessions_intentional_exit_state_check;
alter table learner_sessions add constraint learner_sessions_intentional_exit_state_check check (intentional_exit_state in
  ('none','resumable_requested','resumable','finish_requested','finalized'));
alter table learner_sessions drop constraint if exists learner_sessions_intentional_exit_reason_check;
alter table learner_sessions add constraint learner_sessions_intentional_exit_reason_check check
  (intentional_exit_reason in ('intentional_resume_later','intentional_finish') or intentional_exit_reason is null);

drop index if exists idx_learner_sessions_one_reserved;
create unique index idx_learner_sessions_one_reserved on learner_sessions(learner_id)
  where status in ('starting','active','disconnected','resumable');

create table session_exit_transition_receipts (
  id uuid primary key default gen_random_uuid(),
  learner_session_id uuid not null references learner_sessions(id),
  app_id uuid not null references app_registry(id),
  device_session_id uuid not null,
  release_id uuid,
  app_principal_id uuid not null references app_service_principals(id) on delete restrict,
  action text not null check (action in ('resume_later','finish_now')),
  expected_session_version integer not null,
  prior_session_version integer not null,
  new_session_version integer not null,
  acknowledged_progress_version integer not null,
  idempotency_key uuid not null,
  request_hash text not null,
  result_status text not null,
  response_json jsonb not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz not null,
  unique(learner_session_id, action, idempotency_key)
);
create index idx_session_exit_receipts_session_status_time
  on session_exit_transition_receipts(learner_session_id, action, result_status, created_at);

alter table session_exit_transition_receipts enable row level security;
alter table session_exit_transition_receipts force row level security;
-- Server session/app authorization services only; no browser table policy.


-- ============================================================
-- Source: supabase/migrations/0052_ul003_event_driven_launcher_refresh.sql
-- ============================================================
-- UL-003: event-driven conditional launcher freshness metadata only.
-- Authoritative launcher membership, cards and actions remain in EN/SC/
-- session/PR/app domains and are never persisted here.
create table launcher_freshness_metadata (
  learner_id uuid not null references learners(id),
  environment text not null,
  context_generation integer not null default 0,
  launcher_version text,
  source_version_hash text,
  invalidation_version integer not null default 0,
  invalidated_at timestamptz,
  invalidation_reason text,
  source_type text,
  source_version text,
  source_event_id text,
  app_id uuid references app_registry(id) on delete restrict,
  composed_at timestamptz,
  next_recheck_at timestamptz,
  cache_max_age_seconds integer not null default 60 check(cache_max_age_seconds between 1 and 300),
  last_successful_refresh_at timestamptz,
  last_failed_refresh_at timestamptz,
  last_refresh_result text,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(learner_id,environment)
);
create index idx_launcher_freshness_invalidated
  on launcher_freshness_metadata(environment,invalidated_at,learner_id);
create index idx_launcher_freshness_boundary
  on launcher_freshness_metadata(environment,next_recheck_at,learner_id);

create table learner_launcher_freshness_receipts (
  principal_id uuid not null references platform_service_principals(id),
  action text not null check(action in ('invalidate','reconcile')),
  idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  response_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(principal_id,action,idempotency_key)
);
create index idx_launcher_freshness_receipts_time
  on learner_launcher_freshness_receipts(action,created_at);

alter table launcher_freshness_metadata enable row level security;
alter table launcher_freshness_metadata force row level security;
alter table learner_launcher_freshness_receipts enable row level security;
alter table learner_launcher_freshness_receipts force row level security;
-- Service-role only; no browser PostgREST policy.

insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
values
  (gen_random_uuid(),'learner-launcher-domain-outbox','kms://babysteps/launcher-domain-outbox/v1','',
   'active',now(),now()+interval '365 days',1),
  (gen_random_uuid(),'learner-launcher-reconciliation','kms://babysteps/launcher-reconciliation/v1','',
   'active',now(),now()+interval '365 days',1)
on conflict(service_key) do nothing;


-- ============================================================
-- Source: supabase/migrations/0053_ul004_app_availability.sql
-- ============================================================
-- UL-004: manual/event-driven operational availability and planned maintenance.
create extension if not exists btree_gist;
create table app_launch_availability (
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null check(environment in ('development','staging','production')),
  operational_state text not null default 'available'
    check(operational_state in ('available','maintenance','temporarily_unavailable','restoring','security_blocked')),
  availability_version bigint not null default 1,
  reason_category text,
  safe_learner_message text check(safe_learner_message is null or char_length(safe_learner_message)<=160),
  expected_return_at timestamptz,
  source_reference text,
  updated_by text not null default 'system',
  updated_by_type text not null default 'system'
    check(updated_by_type in ('system','administrator','security','deployment')),
  updated_at timestamptz not null default now(),
  primary key(app_id,environment)
);
create index idx_app_launch_availability_state
  on app_launch_availability(environment,operational_state,app_id);

create table app_maintenance_windows (
  id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null check(environment in ('development','staging','production')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'scheduled' check(status in ('scheduled','cancelled','completed')),
  reason_category text not null,
  safe_learner_message text check(safe_learner_message is null or char_length(safe_learner_message)<=160),
  window_version bigint not null default 1,
  created_by uuid not null references auth.users(id),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(ends_at>starts_at)
);
create index idx_app_maintenance_windows_lookup
  on app_maintenance_windows(app_id,environment,status,starts_at,ends_at);
alter table app_maintenance_windows add constraint app_maintenance_windows_no_overlap
  exclude using gist (app_id with =, environment with =, tstzrange(starts_at,ends_at,'[)') with &&)
  where (status='scheduled');

create table app_availability_mutation_receipts (
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  action text not null check(action in ('schedule','update','cancel','transition')),
  window_id uuid,
  target_state text,
  availability_version_from bigint not null,
  availability_version_to bigint,
  request_hash text not null,
  idempotency_key text not null,
  status text not null check(status in ('processing','completed')),
  response_json jsonb,
  actor_id uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(app_id,environment,idempotency_key)
);
create index idx_app_availability_receipts_time
  on app_availability_mutation_receipts(app_id,environment,action,created_at);

create table app_availability_events (
  id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  availability_version bigint not null,
  event_type text not null,
  created_at timestamptz not null default now(),
  unique(app_id,environment,availability_version)
);

insert into app_launch_availability(app_id,environment,updated_by,updated_by_type)
select id,'production','migration','system' from app_registry where registry_status='active'
on conflict(app_id,environment) do nothing;

create or replace function initialize_app_launch_availability() returns trigger language plpgsql as $$
begin
  if new.registry_status='active' then
    insert into app_launch_availability(app_id,environment,updated_by,updated_by_type)
    values(new.id,'production','app-registry','system') on conflict(app_id,environment) do nothing;
  end if;
  return new;
end $$;
create trigger trg_initialize_app_launch_availability
after insert or update of registry_status on app_registry
for each row execute function initialize_app_launch_availability();

alter table app_launch_availability enable row level security;
alter table app_launch_availability force row level security;
alter table app_maintenance_windows enable row level security;
alter table app_maintenance_windows force row level security;
alter table app_availability_mutation_receipts enable row level security;
alter table app_availability_mutation_receipts force row level security;
alter table app_availability_events enable row level security;
alter table app_availability_events force row level security;
-- Server-role only; no browser PostgREST policies.

insert into platform_service_principals(id,service_key,key_ref,public_key,status,valid_from,valid_until,version)
values(gen_random_uuid(),'app-availability-reader','kms://babysteps/app-availability-reader/v1','',
  'active',now(),now()+interval '365 days',1)
on conflict(service_key) do nothing;


-- ============================================================
-- Source: supabase/migrations/0054_eg001_achievements.sql
-- ============================================================
-- EG-001: trusted, immutable app-owned achievements and safe aggregation.
create table learner_achievements (
  id uuid primary key,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null check(environment in ('development','staging','production')),
  app_achievement_key text not null,
  achievement_instance_key text not null,
  achievement_contract_version text not null,
  app_achievement_model_version text not null,
  title text not null check(char_length(title) between 1 and 100),
  short_description text check(short_description is null or char_length(short_description)<=240),
  badge_asset_key text,
  category text not null check(category in
    ('milestone','mastery','level','efficiency','challenge','consistency','other')),
  earned_at timestamptz not null,
  source_progress_version bigint,
  source_completion_id text,
  source_session_id uuid references learner_sessions(id) on delete restrict,
  source_release_id uuid not null references app_releases(id) on delete restrict,
  app_key_snapshot text not null,
  app_name_snapshot text not null,
  app_icon_asset_key_snapshot text,
  record_version bigint not null default 1 check(record_version>0),
  state_hash text not null,
  acknowledged_at timestamptz not null,
  revoked_at timestamptz,
  revocation_reason_code text check(revocation_reason_code is null or revocation_reason_code in
    ('app_error','duplicate_emission','invalid_source')),
  revoked_by_principal_id uuid references app_service_principals(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(learner_id,app_id,achievement_instance_key)
);
create index idx_learner_achievements_feed
  on learner_achievements(learner_id,earned_at desc,id desc);
create index idx_learner_achievements_app
  on learner_achievements(app_id,earned_at desc,id desc);

create or replace function reject_achievement_earned_field_update() returns trigger language plpgsql as $$
begin
  if new.learner_id is distinct from old.learner_id
    or new.app_id is distinct from old.app_id
    or new.environment is distinct from old.environment
    or new.app_achievement_key is distinct from old.app_achievement_key
    or new.achievement_instance_key is distinct from old.achievement_instance_key
    or new.achievement_contract_version is distinct from old.achievement_contract_version
    or new.app_achievement_model_version is distinct from old.app_achievement_model_version
    or new.title is distinct from old.title
    or new.short_description is distinct from old.short_description
    or new.badge_asset_key is distinct from old.badge_asset_key
    or new.category is distinct from old.category
    or new.earned_at is distinct from old.earned_at
    or new.source_progress_version is distinct from old.source_progress_version
    or new.source_completion_id is distinct from old.source_completion_id
    or new.source_session_id is distinct from old.source_session_id
    or new.source_release_id is distinct from old.source_release_id
    or new.app_key_snapshot is distinct from old.app_key_snapshot
    or new.app_name_snapshot is distinct from old.app_name_snapshot
    or new.app_icon_asset_key_snapshot is distinct from old.app_icon_asset_key_snapshot
    or new.state_hash is distinct from old.state_hash
    or new.acknowledged_at is distinct from old.acknowledged_at then
    raise exception 'achievement earned fields are immutable';
  end if;
  return new;
end $$;
create trigger trg_learner_achievements_immutable
before update on learner_achievements
for each row execute function reject_achievement_earned_field_update();

create table achievement_mutation_receipts (
  id uuid primary key,
  app_id uuid not null references app_registry(id) on delete restrict,
  achievement_id uuid not null references learner_achievements(id) on delete restrict,
  action text not null check(action in ('create','revoke')),
  idempotency_key text not null,
  request_hash text not null,
  response_json jsonb not null,
  created_at timestamptz not null default now(),
  unique(app_id,action,idempotency_key)
);
create index idx_achievement_receipts_achievement
  on achievement_mutation_receipts(achievement_id,action,created_at);

create table app_release_achievement_contracts (
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null references app_releases(id) on delete restrict,
  achievement_contract_version text not null,
  app_achievement_model_version text not null,
  allowed_badge_asset_keys_json jsonb not null default '[]'::jsonb,
  validation_report_json jsonb,
  status text not null default 'pending' check(status in ('pending','approved','blocked')),
  validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(app_id,release_id)
);
create index idx_release_achievement_contract_status
  on app_release_achievement_contracts(app_id,status,release_id);

create table achievement_journey_projection_outbox (
  id uuid primary key,
  achievement_id uuid not null references learner_achievements(id) on delete restrict,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  action text not null check(action in ('upsert','remove')),
  source_state_hash text not null,
  status text not null default 'pending' check(status in ('pending','processed','failed')),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(achievement_id,action,source_state_hash)
);
create index idx_achievement_journey_outbox_status
  on achievement_journey_projection_outbox(status,created_at,id);

alter table learner_achievements enable row level security;
alter table learner_achievements force row level security;
alter table achievement_mutation_receipts enable row level security;
alter table achievement_mutation_receipts force row level security;
alter table app_release_achievement_contracts enable row level security;
alter table app_release_achievement_contracts force row level security;
alter table achievement_journey_projection_outbox enable row level security;
alter table achievement_journey_projection_outbox force row level security;
-- Server-role only: no browser PostgREST policies.


-- ============================================================
-- Source: supabase/migrations/0055_eg002_consistency.sql
-- ============================================================
-- EG-002: per-app weekly consistency derived from the SC-002 funded-use
-- cadence. All tables are backend-only under forced RLS.
create table learner_app_consistency (
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  current_streak_weeks integer not null default 0 check(current_streak_weeks>=0),
  longest_streak_weeks integer not null default 0 check(longest_streak_weeks>=0),
  current_week_key text not null,
  current_week_progress integer not null default 0 check(current_week_progress between 0 and 2),
  current_week_start_at timestamptz not null,
  current_week_end_at timestamptz not null,
  latest_completed_week_key text,
  last_computed_usage_version integer not null default 0,
  state_version integer not null default 1,
  state_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(learner_id,app_id,environment)
);
create index idx_learner_app_consistency_current
  on learner_app_consistency(learner_id,environment,current_week_key,app_id);

create table learner_app_consistency_weeks (
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  environment text not null,
  weekly_key text not null,
  week_timezone text not null,
  weekly_start_at timestamptz not null,
  weekly_end_at timestamptz not null,
  cadence_target integer not null default 2 check(cadence_target=2),
  qualifying_standard_sessions integer not null default 0 check(qualifying_standard_sessions between 0 and 2),
  status text not null default 'open' check(status in
    ('open','cadence_complete','incomplete_reset','neutral_partial','platform_unavailable_neutral','out_of_scope')),
  entitlement_opening_state text not null check(entitlement_opening_state in
    ('eligible','approved_grace','partial_start','out_of_scope')),
  entitlement_opening_reference uuid,
  availability_neutral_evidence text,
  cadence_completed_by_session_id uuid references learner_sessions(id) on delete restrict,
  completed_at timestamptz,
  finalized_at timestamptz,
  result_version integer not null default 1,
  result_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(learner_id,app_id,environment,weekly_key)
);
create index idx_consistency_weeks_history
  on learner_app_consistency_weeks(learner_id,weekly_start_at desc,app_id,weekly_key);
create index idx_consistency_weeks_finalize
  on learner_app_consistency_weeks(environment,status,weekly_end_at,learner_id,app_id);

create table consistency_mutation_receipts (
  id uuid primary key,
  learner_id uuid references learners(id) on delete restrict,
  app_id uuid references app_registry(id) on delete restrict,
  environment text not null,
  weekly_key text,
  action text not null check(action in ('standard_session_committed','finalize_week','reconcile')),
  source_session_id uuid references learner_sessions(id) on delete restrict,
  source_usage_version integer,
  event_id text not null,
  run_idempotency_key text,
  cursor text not null default '',
  request_hash text not null,
  status text not null default 'pending' check(status in ('pending','completed','failed')),
  result_json jsonb,
  principal_id text not null,
  attempt_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique(action,event_id)
);
create index idx_consistency_receipts_pending
  on consistency_mutation_receipts(status,action,created_at,id);
create index idx_consistency_receipts_scope
  on consistency_mutation_receipts(learner_id,app_id,weekly_key,action,created_at);

alter table learner_app_consistency enable row level security;
alter table learner_app_consistency force row level security;
alter table learner_app_consistency_weeks enable row level security;
alter table learner_app_consistency_weeks force row level security;
alter table consistency_mutation_receipts enable row level security;
alter table consistency_mutation_receipts force row level security;
-- Server-role only: no browser PostgREST policies.


-- ============================================================
-- Source: supabase/migrations/0056_eg004_progress_motivation.sql
-- ============================================================
-- EG-004 extends the existing PR-003 summary row. Motivation is app-owned
-- presentation data, not a platform-derived progress model or separate table.
alter table learner_app_progress
  add column if not exists progress_summary_version integer not null default 0;
alter table learner_app_progress
  add column if not exists progress_summary_state_hash text;

alter table progress_mutation_requests drop constraint if exists progress_mutation_requests_operation_check;
alter table progress_mutation_requests add constraint progress_mutation_requests_operation_check
  check(operation in ('checkpoint','lesson_complete','summary_write'));

comment on column learner_app_progress.progress_summary_version is
  'EG-004 exact acknowledgement version for the nested PR-003 progress summary.';
comment on column learner_app_progress.progress_summary_state_hash is
  'EG-004 canonical hash of the exact app-owned summary representation and acknowledgement metadata.';


-- ============================================================
-- Source: supabase/migrations/0057_eg005_learner_journey.sql
-- ============================================================
-- EG-005: per-app learner journey with whole-learner inactivity retention.
create table learner_journey_retention_state (
  learner_id uuid primary key references learners(id) on delete restrict,
  state text not null check(state in ('active','inactive_retention','purged')),
  inactive_since timestamptz,
  journey_delete_after timestamptz,
  retention_generation bigint not null default 1 check(retention_generation>0),
  purged_at timestamptz,
  purged_through_at timestamptz,
  state_version bigint not null default 1 check(state_version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_journey_retention_due
  on learner_journey_retention_state(state,journey_delete_after,learner_id);

create table learner_app_journey_events (
  journey_event_id uuid primary key,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  retention_generation bigint not null check(retention_generation>0),
  event_type text not null check(event_type in ('lesson_completed','achievement_earned','milestone_reached')),
  event_at timestamptz not null,
  source_domain text not null check(source_domain in ('lesson_completion','achievement','app_milestone')),
  source_id text not null,
  title_snapshot text not null check(char_length(title_snapshot) between 1 and 100),
  short_description_snapshot text check(short_description_snapshot is null or char_length(short_description_snapshot)<=240),
  icon_asset_key text,
  source_status text not null default 'active' check(source_status='active'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(learner_id,app_id,source_domain,source_id)
);
create index idx_learner_app_journey_page
  on learner_app_journey_events(learner_id,app_id,retention_generation,event_at desc,journey_event_id desc);

create table journey_mutation_receipts (
  id uuid primary key,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  retention_generation bigint not null check(retention_generation>0),
  source_domain text not null check(source_domain in ('lesson_completion','achievement','app_milestone')),
  source_id text not null,
  action text not null check(action in ('upsert','remove')),
  idempotency_key text not null,
  request_hash text not null,
  result_status text not null check(result_status in ('created','replayed','removed','ignored_purged')),
  created_at timestamptz not null default now(),
  completed_at timestamptz not null,
  unique(learner_id,app_id,retention_generation,source_domain,action,idempotency_key)
);
create index idx_journey_receipts_learner_generation
  on journey_mutation_receipts(learner_id,retention_generation,created_at,id);

create table lesson_journey_projection_outbox (
  id uuid primary key,
  completion_id text not null,
  learner_id uuid not null references learners(id) on delete restrict,
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null,
  lesson_key text not null,
  completed_at timestamptz not null,
  title_snapshot text not null,
  short_description_snapshot text,
  icon_asset_key text,
  source_state_hash text not null,
  status text not null default 'pending' check(status in ('pending','processed','failed')),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique(learner_id,app_id,completion_id,source_state_hash)
);
create index idx_lesson_journey_outbox_status
  on lesson_journey_projection_outbox(status,created_at,id);

create table app_release_journey_contracts (
  app_id uuid not null references app_registry(id) on delete restrict,
  release_id uuid not null references app_releases(id) on delete restrict,
  journey_contract_version text not null,
  lesson_display_metadata boolean not null,
  milestone_display_metadata boolean not null,
  allowed_icon_asset_keys_json jsonb not null default '[]'::jsonb,
  validation_report_json jsonb,
  status text not null default 'pending' check(status in ('pending','approved','blocked')),
  validated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(app_id,release_id)
);
create index idx_release_journey_contract_status
  on app_release_journey_contracts(app_id,status,release_id);

create table journey_retention_job_runs (
  principal_id uuid not null references platform_service_principals(id) on delete restrict,
  run_idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  result_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(principal_id,run_idempotency_key)
);

alter table learner_journey_retention_state enable row level security;
alter table learner_journey_retention_state force row level security;
alter table learner_app_journey_events enable row level security;
alter table learner_app_journey_events force row level security;
alter table journey_mutation_receipts enable row level security;
alter table journey_mutation_receipts force row level security;
alter table lesson_journey_projection_outbox enable row level security;
alter table lesson_journey_projection_outbox force row level security;
alter table app_release_journey_contracts enable row level security;
alter table app_release_journey_contracts force row level security;
alter table journey_retention_job_runs enable row level security;
alter table journey_retention_job_runs force row level security;
-- Server-role only: no browser PostgREST policies.


-- ============================================================
-- Source: supabase/migrations/0058_eg006_learning_reminders.sql
-- ============================================================
-- EG-006 parent-only consolidated learning reminders. Server-role only: no
-- browser PostgREST policy and no learner contact storage.
create table parent_notification_preferences (
  parent_id uuid primary key references profiles(id) on delete cascade,
  learning_reminder_email_enabled boolean not null default true,
  version bigint not null default 1 check(version>0),
  last_idempotency_key text,
  last_request_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table learning_reminder_batches (
  id uuid primary key,
  parent_id uuid not null references profiles(id) on delete cascade,
  reminder_stage text not null check(reminder_stage in ('mid_window','final_window')),
  scheduler_run_id text not null,
  status text not null default 'evaluating'
    check(status in ('evaluating','ready','suppressed','sending','sent','failed')),
  item_count integer not null default 0 check(item_count>=0),
  template_version text not null default 'eg006-v1',
  expected_parent_identity_version text,
  idempotency_key text not null unique,
  batch_version bigint not null default 1 check(batch_version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);
create index idx_learning_reminder_batches_parent_stage
  on learning_reminder_batches(parent_id,reminder_stage,status,created_at,id);

create table learning_reminder_items (
  id uuid primary key,
  batch_id uuid not null references learning_reminder_batches(id) on delete cascade,
  parent_id uuid not null references profiles(id) on delete cascade,
  learner_id uuid not null references learners(id) on delete cascade,
  app_id uuid not null references app_registry(id) on delete restrict,
  weekly_key text not null,
  reminder_stage text not null check(reminder_stage in ('mid_window','final_window')),
  observed_weekly_progress integer not null check(observed_weekly_progress in (0,1)),
  remaining_normal_sessions integer not null check(remaining_normal_sessions in (1,2)),
  eligibility_version bigint not null,
  eligibility_digest text not null,
  availability_note text,
  status text not null default 'candidate' check(status in ('candidate','included','suppressed')),
  suppressed_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(parent_id,learner_id,app_id,weekly_key,reminder_stage)
);
create index idx_learning_reminder_items_batch
  on learning_reminder_items(batch_id,status,learner_id,app_id);
create index idx_learning_reminder_items_scope
  on learning_reminder_items(parent_id,weekly_key,reminder_stage,learner_id,app_id);

create table learning_reminder_deliveries (
  id uuid primary key,
  batch_id uuid not null unique references learning_reminder_batches(id) on delete cascade,
  provider_message_id text,
  provider_status text not null default 'pending'
    check(provider_status in ('pending','accepted','delivered','uncertain','retry_pending','failed')),
  destination_identity_version text not null,
  destination_email_hash text not null,
  attempt_count integer not null default 0 check(attempt_count between 0 and 3),
  provider_idempotency_key text not null unique,
  api_idempotency_key text not null,
  request_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  last_attempt_at timestamptz,
  unique(batch_id,api_idempotency_key)
);
create index idx_learning_reminder_deliveries_status
  on learning_reminder_deliveries(provider_status,updated_at,batch_id);

create table learning_reminder_job_runs (
  principal_id uuid not null references platform_service_principals(id) on delete restrict,
  operation text not null check(operation in ('evaluate','reconcile')),
  run_idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  result_json jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(principal_id,operation,run_idempotency_key)
);

alter table parent_notification_preferences enable row level security;
alter table parent_notification_preferences force row level security;
alter table learning_reminder_batches enable row level security;
alter table learning_reminder_batches force row level security;
alter table learning_reminder_items enable row level security;
alter table learning_reminder_items force row level security;
alter table learning_reminder_deliveries enable row level security;
alter table learning_reminder_deliveries force row level security;
alter table learning_reminder_job_runs enable row level security;
alter table learning_reminder_job_runs force row level security;


-- ============================================================
-- Source: supabase/migrations/0059_nt001_transactional_notifications.sql
-- ============================================================
-- NT-001: reliable, source-owned transactional parent-email delivery.
-- Server-role only: no browser PostgREST policy. Source domains
-- (BI-002/003/004/005, IA-003) write intents inside their own commit
-- transaction; NT-001 owns everything from here onward (recipient
-- resolution, template rendering, provider send, retry/reconciliation).
create table transactional_notification_intents (
  notification_id uuid primary key,
  parent_id uuid not null references profiles(id) on delete cascade,
  notification_type text not null,
  source_domain text not null,
  source_event_key text not null,
  source_version integer not null,
  template_version text not null,
  safe_variables jsonb not null,
  semantic_hash text not null,
  state text not null default 'pending'
    check(state in ('pending','claimed','sent','blocked_recipient','failed','suppressed_by_policy')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  next_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(notification_type,source_domain,source_event_key,parent_id,template_version)
);
create index idx_transactional_notification_intents_claim
  on transactional_notification_intents(state,next_attempt_at,created_at);
create index idx_transactional_notification_intents_source
  on transactional_notification_intents(source_domain,source_event_key);

-- One active delivery row per notification per channel (rule 58; V1 has
-- exactly one channel, email). provider_idempotency_key is the stable key
-- handed to the email provider so retries never double-send (rule 57).
create table transactional_notification_deliveries (
  id uuid primary key,
  notification_id uuid not null references transactional_notification_intents(notification_id) on delete cascade,
  channel text not null default 'email' check(channel='email'),
  provider_message_id text,
  provider_idempotency_key text not null unique,
  state text not null default 'pending'
    check(state in ('pending','sending','accepted','delivered_when_known','temporary_failed','permanent_failed','blocked_recipient','suppressed_by_policy')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  last_error_code text,
  accepted_at timestamptz,
  delivered_at timestamptz,
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(notification_id,channel)
);
create index idx_transactional_notification_deliveries_state
  on transactional_notification_deliveries(state,updated_at);

-- Replay guard for API-NT-003 provider webhooks, same shape as
-- deployment_webhook_receipts/financial_dispute_events.
create table notification_provider_webhook_receipts (
  id uuid primary key,
  provider text not null,
  provider_event_id text not null,
  received_at timestamptz not null default now(),
  unique(provider, provider_event_id)
);

alter table transactional_notification_intents enable row level security;
alter table transactional_notification_intents force row level security;
alter table transactional_notification_deliveries enable row level security;
alter table transactional_notification_deliveries force row level security;
alter table notification_provider_webhook_receipts enable row level security;
alter table notification_provider_webhook_receipts force row level security;


-- ============================================================
-- Source: supabase/migrations/0060_nt002_communication_history_index.sql
-- ============================================================
-- NT-002: lightweight 13-month parent communication history, composed
-- directly from NT-001's own intents/deliveries tables (no new authoritative
-- table — rules 69-70). The only schema change this requirement needs is an
-- index to keep the parent-scoped, retention-windowed, newest-first keyset
-- read bounded (rule 72, NFR: "Parent+created_at index supports cursor
-- pagination").
create index idx_transactional_notification_intents_parent_history
  on transactional_notification_intents(parent_id, created_at desc, notification_id desc);


-- ============================================================
-- Source: supabase/migrations/0061_ad001_staff_identity.sql
-- ============================================================
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


-- ============================================================
-- Source: supabase/migrations/0062_nt001g01_idempotency_key.sql
-- ============================================================
-- NT1-G01: API-NT-001 frozen wire contract requires an explicit
-- idempotencyKey. Nullable/non-unique-by-default so existing in-process
-- callers (BI-002/003/004/005, IA-003) keep relying on the pre-existing
-- natural-key unique constraint as their identity; the partial unique index
-- enforces exact-once only for requests that actually supply one (the
-- API-NT-001 route).
alter table transactional_notification_intents add column if not exists idempotency_key text;

create unique index if not exists idx_transactional_notification_intents_idempotency_key
  on transactional_notification_intents(idempotency_key) where idempotency_key is not null;


-- ============================================================
-- Source: supabase/migrations/0063_nt1g03_delivery_run_contract.sql
-- ============================================================
-- NT1-G03: API-NT-002's frozen runIdempotencyKey — one row per attempted
-- delivery-run call. 'running' guards against a concurrent/overlapping
-- replay (409); 'completed' makes a replay of the same key return the exact
-- same aggregate result without reprocessing any notification.
create table if not exists notification_delivery_runs (
  run_idempotency_key text primary key,
  state text not null default 'running' check(state in ('running','completed')),
  result_json text,
  created_at text not null,
  updated_at text not null
);
alter table notification_delivery_runs enable row level security;
alter table notification_delivery_runs force row level security;


-- ============================================================
-- Source: supabase/migrations/0064_nt1g04_reconcile_contract.sql
-- ============================================================
-- NT1-G04: API-NT-004's own frozen runIdempotencyKey, kept in a table
-- separate from notification_delivery_runs so a caller reusing the same key
-- string for a delivery-run and a reconcile call can never collide.
create table if not exists notification_reconcile_runs (
  run_idempotency_key text primary key,
  state text not null default 'running' check(state in ('running','completed')),
  result_json text,
  created_at text not null,
  updated_at text not null
);
alter table notification_reconcile_runs enable row level security;
alter table notification_reconcile_runs force row level security;


-- ============================================================
-- Source: supabase/migrations/0065_nt1g07_recipient_destination_evidence.sql
-- ============================================================
-- NT1-G07: privacy-safe recipient/destination evidence for audit and
-- reconciliation. recipient_identity_version is the exact verified-at
-- timestamp that authorized the attempt; destination_hash is a one-way
-- SHA-256 of the normalized address — never the raw email itself, and never
-- a second authoritative parent email (that stays users.email).
alter table transactional_notification_deliveries add column if not exists recipient_identity_version text;
alter table transactional_notification_deliveries add column if not exists destination_hash text;


-- ============================================================
-- Source: supabase/migrations/0066_nt2g01_structured_learner_reference.sql
-- ============================================================
-- NT2-G01: a structured, approved learner reference for source events that
-- legitimately have one — immune to a later learner rename, unlike the
-- display-name-only safe_variables.learnerName legacy rows carry.
-- Deliberately unconstrained text, not an FK to learners(id) — same
-- "actor/reference columns stay unconstrained" precedent AD-001 established.
alter table transactional_notification_intents add column if not exists learner_id text;


-- ============================================================
-- Source: supabase/migrations/0067_ad002_support_cases.sql
-- ============================================================
-- AD-002: case-first support workflow. AD-002 owns none of the underlying
-- customer data (rule 34) — parent/learner/billing/progress/notification
-- fields are composed live from their owning domains at read time; this
-- table only ever stores the case's own identity, binding, workflow state
-- and optional exact references.
create table if not exists support_cases (
  id text primary key,
  category text not null check(category in
    ('account_access','learner_access','billing_question','subscription_assignment','payment_refund',
     'app_access','progress_display','technical_issue','notification_delivery','other')),
  status text not null default 'open'
    check(status in ('open','in_progress','waiting_parent','escalated','resolved','closed')),
  priority text not null default 'normal' check(priority in ('low','normal','high','urgent')),
  parent_id uuid not null references auth.users(id),
  learner_id text,
  app_id text,
  subscription_id text,
  invoice_id text,
  source_ref text,
  created_from_receipt_id text not null,
  assigned_staff_account_id uuid references staff_accounts(id),
  escalation_role text check(escalation_role in
    ('billing_administrator','operations_administrator','platform_administrator') or escalation_role is null),
  version integer not null default 1,
  reopened_count integer not null default 0,
  created_by_staff_account_id uuid not null references staff_accounts(id),
  created_at text not null,
  updated_at text not null,
  closed_at text
);
create index if not exists idx_support_cases_status on support_cases(status, updated_at);
create index if not exists idx_support_cases_assigned on support_cases(assigned_staff_account_id, status);
create index if not exists idx_support_cases_parent on support_cases(parent_id, created_at desc);
alter table support_cases enable row level security;
alter table support_cases force row level security;

create table if not exists support_case_notes (
  id text primary key,
  case_id text not null references support_cases(id) on delete cascade,
  staff_account_id uuid not null references staff_accounts(id),
  note_text text not null,
  idempotency_key text not null,
  created_at text not null,
  unique(case_id, staff_account_id, idempotency_key)
);
create index if not exists idx_support_case_notes_case on support_case_notes(case_id, created_at);
alter table support_case_notes enable row level security;
alter table support_case_notes force row level security;

create table if not exists support_case_activity (
  id text primary key,
  case_id text not null references support_cases(id) on delete cascade,
  actor_staff_account_id uuid not null references staff_accounts(id),
  canonical_action text not null,
  underlying_role text,
  resource_safe_id text,
  result text not null,
  request_id text,
  created_at text not null
);
create index if not exists idx_support_case_activity_case on support_case_activity(case_id, created_at);
alter table support_case_activity enable row level security;
alter table support_case_activity force row level security;

create table if not exists support_lookup_receipts (
  id text primary key,
  staff_account_id uuid not null references staff_accounts(id),
  identifier_type text not null check(identifier_type in ('email','subscription_ref','invoice_ref','case_id')),
  identifier_hash text not null,
  result_class text not null check(result_class in ('matched','no_match','duplicate_match')),
  resolved_parent_id uuid references auth.users(id),
  resolved_learner_id text,
  resolved_app_id text,
  resolved_subscription_id text,
  resolved_invoice_id text,
  reason text not null,
  consumed_at text,
  created_at text not null,
  expires_at text not null
);
create index if not exists idx_support_lookup_receipts_staff on support_lookup_receipts(staff_account_id, created_at);
alter table support_lookup_receipts enable row level security;
alter table support_lookup_receipts force row level security;

create table if not exists support_case_mutation_requests (
  actor_staff_account_id uuid not null references staff_accounts(id),
  idempotency_key text not null,
  case_id text not null,
  operation text not null,
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  response_json text,
  created_at text not null,
  completed_at text,
  primary key (actor_staff_account_id, case_id, idempotency_key)
);
alter table support_case_mutation_requests enable row level security;
alter table support_case_mutation_requests force row level security;


-- ============================================================
-- Source: supabase/migrations/0068_ad004_operation_changes.sql
-- ============================================================
-- AD-004: immutable human-operations change/audit spine. Never a second
-- AR-001/AR-002/UL-004/AU-004 state machine — scope/type/reason are frozen
-- at creation; only workflow fields (status/assignment/schedule) version.
create table if not exists platform_operation_changes (
  id text primary key,
  change_type text not null check(change_type in
    ('app_registry_change','release_promotion','manual_rollback','planned_maintenance',
     'emergency_availability_change','machine_principal_change','machine_credential_change')),
  status text not null default 'planned'
    check(status in ('planned','ready','executing','succeeded','failed','cancelled')),
  environment text not null,
  app_id text,
  primary_resource_type text,
  primary_resource_id text,
  reason text not null,
  scheduled_for text,
  linked_support_case_id text references support_cases(id),
  assigned_staff_account_id uuid references staff_accounts(id),
  source_reference text,
  version integer not null default 1,
  created_by_staff_account_id uuid not null references staff_accounts(id),
  created_at text not null,
  updated_at text not null,
  terminal_at text,
  retention_due_at text
);
create index if not exists idx_platform_operation_changes_status on platform_operation_changes(status, updated_at);
create index if not exists idx_platform_operation_changes_app on platform_operation_changes(app_id, environment);
alter table platform_operation_changes enable row level security;
alter table platform_operation_changes force row level security;

create table if not exists platform_operation_activity (
  id text primary key,
  operation_change_id text not null references platform_operation_changes(id) on delete cascade,
  staff_account_id uuid not null references staff_accounts(id),
  canonical_action text not null,
  underlying_role text,
  resource_safe_id text,
  result text not null,
  request_id text,
  created_at text not null
);
create index if not exists idx_platform_operation_activity_change on platform_operation_activity(operation_change_id, created_at);
alter table platform_operation_activity enable row level security;
alter table platform_operation_activity force row level security;


-- ============================================================
-- Source: supabase/migrations/0069_ad005_platform_governance.sql
-- ============================================================
-- AD-005: platform governance — staff passkey recovery (normal + sole-
-- Platform-Administrator break-glass), recovery-code rotation, governance-
-- gated IA-003 restoration and a privileged-audit read model composed live
-- over existing append-only activity tables. Never a second staff/audit/
-- restoration engine.
create table if not exists staff_recovery_sessions (
  id text primary key,
  target_staff_id uuid not null references staff_accounts(id) on delete cascade,
  issued_by_staff_id uuid references staff_accounts(id),
  method text not null check(method in ('normal','break_glass')),
  purpose text not null default 'staff_passkey_recovery' check(purpose='staff_passkey_recovery'),
  expires_at text not null,
  consumed_at text,
  created_at text not null
);
create index if not exists idx_staff_recovery_sessions_target
  on staff_recovery_sessions(target_staff_id, consumed_at, expires_at);
alter table staff_recovery_sessions enable row level security;
alter table staff_recovery_sessions force row level security;

create table if not exists platform_recovery_codes (
  id text primary key,
  generation integer not null,
  verifier_hash text not null,
  status text not null default 'active' check(status in ('active','used','revoked')),
  created_by_staff_id uuid references staff_accounts(id),
  created_at text not null,
  used_at text,
  used_by_staff_id uuid references staff_accounts(id),
  revoked_at text
);
create index if not exists idx_platform_recovery_codes_status on platform_recovery_codes(status);
alter table platform_recovery_codes enable row level security;
alter table platform_recovery_codes force row level security;

create table if not exists platform_governance_mutation_requests (
  actor_staff_account_id uuid not null references staff_accounts(id),
  idempotency_key text not null,
  canonical_action text not null,
  target_reference text,
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  response_json text,
  created_at text not null default (now()::text),
  completed_at text,
  primary key (actor_staff_account_id, idempotency_key)
);
alter table platform_governance_mutation_requests enable row level security;
alter table platform_governance_mutation_requests force row level security;

-- AD-005 rule 75: optimistic-concurrency token for governance-gated
-- restoration only.
alter table profiles add column if not exists version integer not null default 1;


-- ============================================================
-- Source: supabase/migrations/0070_pc004_data_erasure_receipts.sql
-- ============================================================
-- PC-004: minimal, append-only deletion evidence for the existing
-- one-year post-entitlement learner retention timer
-- (learner_journey_retention_state, migration 00xx). No second retention
-- timer/state table.
create table if not exists data_erasure_receipts (
  id text primary key,
  learner_id text not null references learners(id),
  retention_generation integer not null,
  erased_at text not null,
  processor_status text not null default 'none_configured'
    check(processor_status in ('none_configured','pending','completed','failed')),
  processor_attempt_count integer not null default 0,
  replayed_at text,
  created_at text not null default (now()::text)
);
create index if not exists idx_data_erasure_receipts_learner
  on data_erasure_receipts(learner_id,created_at desc);
alter table data_erasure_receipts enable row level security;
alter table data_erasure_receipts force row level security;


-- ============================================================
-- Source: supabase/migrations/0071_an002_operational_monitoring.sql
-- ============================================================
-- AN-002: minimal operational-monitoring projection. Observational only,
-- never authoritative — never touches any source-domain job-run table.
create table if not exists monitoring_job_snapshots (
  id text primary key,
  job_key text not null,
  source_run_key text not null,
  status text not null check(status in ('completed','failed','running')),
  run_at text not null,
  duration_ms integer,
  counts_json text not null default '{}',
  correlation_id text,
  created_at text not null default (now()::text),
  unique(job_key,source_run_key)
);
create index if not exists idx_monitoring_job_snapshots_job
  on monitoring_job_snapshots(job_key,run_at desc);
alter table monitoring_job_snapshots enable row level security;
alter table monitoring_job_snapshots force row level security;

create table if not exists monitoring_job_monthly_aggregates (
  job_key text not null,
  month_key text not null,
  run_count integer not null default 0,
  failed_count integer not null default 0,
  created_at text not null default (now()::text),
  updated_at text not null default (now()::text),
  primary key(job_key,month_key)
);
alter table monitoring_job_monthly_aggregates enable row level security;
alter table monitoring_job_monthly_aggregates force row level security;


-- ============================================================
-- Source: supabase/migrations/0072_br002_disaster_recovery_test_records.sql
-- ============================================================
-- BR-002: production-side compliance evidence ledger for the ~6-monthly
-- disaster-recovery drill. Never a live restore orchestrator — the drill
-- itself runs against a disposable temp project this app never connects
-- to; this table only records backup chosen/results/teardown.
create table if not exists disaster_recovery_test_records (
  id text primary key,
  initiated_by_staff_account_id uuid not null references staff_accounts(id),
  backup_reference text not null,
  temp_project_reference text not null,
  started_at text not null,
  outbound_processing_suppressed integer not null default 0 check(outbound_processing_suppressed in (0,1)),
  deletion_replay_confirmed integer not null default 0 check(deletion_replay_confirmed in (0,1)),
  deletion_replay_notes text,
  billing_reconciliation_confirmed integer not null default 0 check(billing_reconciliation_confirmed in (0,1)),
  billing_reconciliation_notes text,
  derivable_state_rebuild_confirmed integer not null default 0 check(derivable_state_rebuild_confirmed in (0,1)),
  derivable_state_rebuild_notes text,
  critical_flows_validated integer not null default 0 check(critical_flows_validated in (0,1)),
  critical_flows_notes text,
  completed_at text,
  teardown_confirmed_at text,
  updated_at text not null default (now()::text)
);
create index if not exists idx_disaster_recovery_test_records_started
  on disaster_recovery_test_records(started_at desc);
alter table disaster_recovery_test_records enable row level security;
alter table disaster_recovery_test_records force row level security;

-- 0073 IA-002 production path: shared rate limiting and restated owner isolation.
drop policy if exists "profiles are readable by owner" on profiles;
create policy "profiles are readable by owner"
  on profiles for select using (auth.uid() = id);

drop policy if exists "consent records are readable by owner" on consent_records;
create policy "consent records are readable by owner"
  on consent_records for select using (auth.uid() = parent_user_id);

alter table profiles force row level security;
alter table consent_records force row level security;

create table if not exists distributed_rate_limits (
  limiter_key text primary key,
  request_count bigint not null,
  window_started_at bigint not null,
  window_ends_at bigint not null
);
alter table distributed_rate_limits enable row level security;
alter table distributed_rate_limits force row level security;
