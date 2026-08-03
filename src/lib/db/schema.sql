-- Local SQLite stand-in for the Supabase schema in
-- supabase/migrations/*.sql (REQ-08 §3, §7). Column names and status enums
-- match exactly so porting back to Postgres later is a dialect change, not
-- a redesign. Differences are dialect-only: text ids (uuid via
-- crypto.randomUUID() in app code) instead of gen_random_uuid(), integer
-- 0/1 instead of boolean, text timestamps instead of timestamptz.

create table if not exists users (
  id text primary key,
  email text unique not null,
  password_hash text not null,
  is_admin integer not null default 0,
  email_verified_at text,
  created_at text not null default (datetime('now'))
);

-- REQ-08 §3.1 / IA-001 & IA-002 data model impact
create table if not exists profiles (
  id text primary key references users(id) on delete cascade,
  profile_type text not null default 'parent'
    check (profile_type = 'parent'),
  display_name text,
  date_of_birth text,
  class_level text,
  -- IA-002: format-validated only, not SMS-verified — no phone_verified_at.
  -- Nullable because the profile exists before onboarding; application
  -- rules (not a DB constraint) require it once onboarding_status is
  -- learner_pending or complete. Deliberately not unique (business rule 6).
  phone_e164 text,
  phone_country_code text,
  account_status text not null default 'active'
    check (account_status in ('active','suspended','deleted')),
  onboarding_status text not null default 'profile_pending'
    check (onboarding_status in ('profile_pending','learner_pending','complete')),
  locale text not null default 'en-IN',
  timezone text not null default 'Asia/Kolkata',
  -- IA-003 soft delete (business rule 11): set together, never a physical
  -- delete. auth_revoked_before is the authoritative "sessions issued at
  -- or before this instant are invalid" gate — checked against the
  -- session JWT's iat even after account_status is later restored to
  -- 'active', which is what forces a fresh login post-restore instead of
  -- resurrecting the old session (business rule 14).
  deleted_at text,
  deleted_by_user_id text,
  auth_revoked_before text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

-- Local-only: Supabase mode uses a real email provider for this flow.
create table if not exists password_reset_tokens (
  token text primary key,
  user_id text not null references users(id) on delete cascade,
  expires_at text not null,
  created_at text not null default (datetime('now'))
);

-- Local-only: Supabase mode issues and verifies these via Supabase Auth
-- (IA-001 business rule 3). One unconsumed token per user is enforced in
-- application code, not a unique constraint, so a resend can replace it.
create table if not exists email_verification_tokens (
  token text primary key,
  user_id text not null references users(id) on delete cascade,
  expires_at text not null,
  created_at text not null default (datetime('now'))
);

-- IA-001/IA-002: "Record privacy and terms acceptance separately with
-- policy version and timestamp" — kept independent of auth.users / Auth
-- metadata so it remains the authoritative consent record. The unique
-- constraint is what makes repeated signup/onboarding submissions
-- idempotent (IA-002 AC13/business rule 14) instead of relying on
-- application code alone to avoid duplicates.
create table if not exists consent_records (
  id text primary key,
  parent_user_id text not null references profiles(id) on delete cascade,
  consent_type text not null check (consent_type in ('terms_of_service','privacy_policy')),
  policy_version text not null,
  granted integer not null default 1,
  granted_at text not null default (datetime('now')),
  revoked_at text,
  unique (parent_user_id, consent_type, policy_version)
);

-- IA-003: mirrors Supabase's own email_change flow so the product can show
-- pending state/expiry/resend/cancel — Supabase itself doesn't expose that
-- as queryable state. `token` is local-only (Supabase mode: the callback
-- carries Supabase's own email_change token instead). Only one row may be
-- 'pending' per parent (partial unique index below) — a new request
-- cancels the previous one first rather than being blocked by it.
create table if not exists email_change_requests (
  id text primary key,
  parent_user_id text not null references profiles(id) on delete cascade,
  old_email text not null,
  new_email text not null,
  token text unique not null,
  status text not null default 'pending'
    check (status in ('pending','verified','expired','cancelled')),
  requested_at text not null default (datetime('now')),
  expires_at text not null,
  verified_at text,
  cancelled_at text
);

create unique index if not exists idx_email_change_requests_one_pending
  on email_change_requests(parent_user_id)
  where status = 'pending';

-- Append-only (business rule: "Archive records ... are append-only").
create table if not exists parent_email_history (
  id text primary key,
  parent_user_id text not null references profiles(id) on delete cascade,
  email text not null,
  archived_at text not null default (datetime('now')),
  reason text not null default 'email_changed'
);

-- Lightweight, queryable stand-in for "audit/outbox infrastructure" — no
-- message broker exists in this codebase, so this is an append-only audit
-- trail rather than a pub/sub outbox. Never stores passwords or tokens
-- (IA-003 AC15) — metadata is a small JSON blob of non-sensitive context.
create table if not exists account_events (
  id text primary key,
  parent_user_id text not null references profiles(id) on delete cascade,
  event_type text not null,
  metadata text,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_account_events_parent on account_events(parent_user_id);

-- REQ-08 §3.2
create table if not exists products (
  id text primary key,
  slug text unique not null,
  name text not null,
  subdomain text not null,
  razorpay_plan_id text not null,
  price_inr integer not null,
  status text not null default 'active'
    check (status in ('active','coming_soon','archived')),
  created_at text not null default (datetime('now'))
);

-- REQ-08 §3.3
create table if not exists subscriptions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  type text not null check (type in ('bundle','single')),
  product_id text references products(id),
  status text not null default 'active'
    check (status in ('active','cancelling','cancelled','expired','past_due')),
  cancel_at_period_end integer not null default 0,
  razorpay_subscription_id text unique not null,
  started_at text not null default (datetime('now')),
  current_period_end text not null,
  cancelled_at text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  check (type = 'bundle' or product_id is not null)
);

create index if not exists idx_subscriptions_user on subscriptions(user_id);
create index if not exists idx_subscriptions_product on subscriptions(product_id);
create index if not exists idx_subscriptions_status on subscriptions(status);

-- REQ-08 §3.4
create table if not exists payments (
  id text primary key,
  subscription_id text not null references subscriptions(id),
  amount_inr integer not null,
  razorpay_payment_id text unique not null,
  paid_at text not null,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_payments_paid_at on payments(paid_at);
create index if not exists idx_payments_subscription on payments(subscription_id);

-- REQ-08 §7
create table if not exists subscription_audit_log (
  id text primary key,
  subscription_id text references subscriptions(id),
  changed_by text not null,
  change_type text not null,
  old_status text,
  new_status text,
  note text,
  created_at text not null default (datetime('now'))
);
