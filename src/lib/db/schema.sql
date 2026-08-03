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

-- REQ-08 §3.1 / IA-001 data model impact
create table if not exists profiles (
  id text primary key references users(id) on delete cascade,
  profile_type text not null default 'parent'
    check (profile_type = 'parent'),
  display_name text,
  date_of_birth text,
  class_level text,
  account_status text not null default 'active'
    check (account_status in ('active','suspended','deleted')),
  onboarding_status text not null default 'profile_pending'
    check (onboarding_status in ('profile_pending','learner_pending','complete')),
  locale text not null default 'en-IN',
  timezone text not null default 'Asia/Kolkata',
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

-- IA-001 security note: "Record privacy and terms acceptance separately
-- with policy version and timestamp" — kept independent of auth.users /
-- Auth metadata so it remains the authoritative consent record.
create table if not exists consent_acceptances (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  policy_type text not null check (policy_type in ('terms','privacy')),
  policy_version text not null,
  accepted_at text not null default (datetime('now'))
);

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
