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

-- LP-001: platform-managed avatar registry. Learners may reference only an
-- active row; the application also checks active=1 so retired choices remain
-- referentially intact without being selectable for new profiles.
create table if not exists approved_avatars (
  id text primary key,
  label text not null,
  active integer not null default 1,
  created_at text not null default (datetime('now'))
);

-- LP-001 permanent learner identity. Age is deliberately absent: every read
-- derives it from date_of_birth and an explicit calendar as-of date.
create table if not exists learners (
  id text primary key,
  owner_parent_id text not null references profiles(id),
  display_name text not null,
  normalized_display_name text not null,
  date_of_birth text not null,
  avatar_id text references approved_avatars(id),
  version integer not null default 1,
  locale text not null,
  timezone text not null,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  unique (owner_parent_id, normalized_display_name)
);

create index if not exists idx_learners_owner on learners(owner_parent_id);

create table if not exists learner_creation_requests (
  parent_user_id text not null references profiles(id),
  idempotency_key text not null,
  request_hash text not null,
  learner_id text references learners(id),
  status text not null check (status in ('processing','completed','failed')),
  created_at text not null default (datetime('now')),
  completed_at text,
  primary key (parent_user_id, idempotency_key)
);

create index if not exists idx_learner_creation_requests_status
  on learner_creation_requests(status, created_at);

-- LP-002 parent+learner-scoped exact-once profile correction requests.
create table if not exists learner_profile_update_requests (
  parent_user_id text not null references profiles(id),
  learner_id text not null references learners(id),
  idempotency_key text not null,
  request_hash text not null,
  expected_version integer not null,
  result_version integer,
  status text not null check (status in ('processing','completed','failed')),
  response_json text,
  created_at text not null default (datetime('now')),
  completed_at text,
  primary key (parent_user_id, learner_id, idempotency_key)
);

create index if not exists idx_learner_profile_update_requests_status
  on learner_profile_update_requests(status, created_at);

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

-- AR-001: canonical app identity. RESTRICT (the default) on every FK to
-- app_registry(id) — no ON DELETE CASCADE anywhere, and there is
-- deliberately no delete statement/route/SQL function for this table at
-- all. Soft deletion (registry_status='soft_deleted') is the only
-- removal mechanism; id/app_key/display_name are kept forever so
-- historical references stay interpretable (business rule 25).
create table if not exists app_registry (
  id text primary key,
  app_key text not null unique,
  display_name text not null,
  short_description text,
  icon_asset_key text,
  category text,
  owning_team text,
  internal_notes text,
  registry_status text not null default 'draft'
    check (registry_status in ('draft','active','soft_deleted')),
  version integer not null default 1,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  activated_at text,
  soft_deleted_at text,
  soft_delete_reason_code text
);

create index if not exists idx_app_registry_status on app_registry(registry_status);

-- Admin-scoped idempotency for every registry mutation (create/edit/
-- activate/soft-delete/restore share one table, distinguished by
-- `operation`) — same replay-safe shape as LP-001's
-- learner_creation_requests, but keyed by admin rather than parent and
-- generalized across operation types instead of one table per verb.
create table if not exists app_registry_mutation_requests (
  admin_user_id text not null references users(id),
  idempotency_key text not null,
  operation text not null
    check (operation in ('create','edit','activate','soft_delete','restore')),
  app_id text,
  request_hash text not null,
  result_app_id text,
  result_version integer,
  status text not null check (status in ('processing','completed','failed')),
  safe_response_json text,
  created_at text not null default (datetime('now')),
  completed_at text,
  primary key (admin_user_id, idempotency_key)
);

create index if not exists idx_app_registry_mutation_requests_status
  on app_registry_mutation_requests(status, created_at);

-- Minimal local stand-in for the "approved platform asset registry"
-- AR-001 assumes exists (business rule 8) — same shape as LP-001's
-- approved_avatars for the same reason: a small, admin-curated,
-- soft-retirable list an activation check can reference by key.
create table if not exists approved_app_icons (
  id text primary key,
  label text not null,
  active integer not null default 1,
  created_at text not null default (datetime('now'))
);

-- Minimal, queryable audit trail (business rule 32 / AC25/AC30): IDs,
-- key, operation, admin, reason code, version transition, timestamp
-- only — never a full metadata snapshot.
create table if not exists app_registry_audit_log (
  id text primary key,
  app_id text not null,
  app_key text not null,
  operation text not null,
  admin_user_id text not null,
  reason_code text,
  version_from integer,
  version_to integer,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_app_registry_audit_log_app on app_registry_audit_log(app_id);

-- Granular admin permissions (business rule 2 / AT-AR-001-16: an admin
-- without app_registry_soft_delete must still be denied even though
-- users.is_admin is true). is_admin stays the coarse "can reach /admin
-- at all" gate; this table is the fine-grained layer on top of it.
create table if not exists admin_permissions (
  user_id text not null references users(id) on delete cascade,
  permission text not null,
  granted_at text not null default (datetime('now')),
  primary key (user_id, permission)
);

-- AN-001: temporary pseudonymous source data. learner_daily_key is an
-- HMAC over (learner_id, activity_date) with a dedicated analytics
-- secret (business rule 6) — never the raw learner UUID. Deleted in full
-- once its date's run completes (business rule 25); nothing here is
-- meant to outlive that.
create table if not exists analytics_daily_buffer (
  activity_date text not null,
  learner_daily_key text not null,
  app_id text not null references app_registry(id) on delete restrict,
  level_key text not null,
  age_band text not null check (age_band in
    ('under_6','6_7','8_9','10_12','13_15','16_18','19_29','30_49','50_plus')),
  engaged_seconds integer not null default 0 check (engaged_seconds >= 0),
  sessions_started integer not null default 0 check (sessions_started >= 0),
  sessions_completed integer not null default 0 check (sessions_completed >= 0),
  sessions_interrupted integer not null default 0 check (sessions_interrupted >= 0),
  lessons_completed integer not null default 0 check (lessons_completed >= 0),
  updated_at text not null default (datetime('now')),
  primary key (activity_date, learner_daily_key, app_id, level_key)
);

create index if not exists idx_analytics_daily_buffer_date on analytics_daily_buffer(activity_date);

-- Exact-once contribution tracking (business rule 11) — the smallest
-- mechanism that lets a retried contribution be recognized and ignored
-- without double-counting into the buffer row above. Deleted together
-- with its date's buffer rows once the run completes (business rule 6).
create table if not exists analytics_contribution_receipts (
  contribution_id text primary key,
  activity_date text not null,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_analytics_contribution_receipts_date
  on analytics_contribution_receipts(activity_date);

-- Permanent, anonymous. No learner/parent identifier of any kind — grain
-- is date + app + level + age band only (business rule 5, 18).
create table if not exists analytics_daily_level (
  activity_date text not null,
  app_id text not null references app_registry(id) on delete restrict,
  level_key text not null,
  age_band text not null,
  active_learners integer not null default 0,
  sessions_started integer not null default 0,
  sessions_completed integer not null default 0,
  sessions_interrupted integer not null default 0,
  engaged_seconds integer not null default 0,
  lessons_completed integer not null default 0,
  generated_at text not null,
  run_version integer not null default 1,
  primary key (activity_date, app_id, level_key, age_band)
);

-- Same grain as analytics_daily_level but rolled up to app+age_band so a
-- learner active across several levels in one day is counted once
-- (business rule 19 / AT-AN-001-12), not once per level.
create table if not exists analytics_daily_app (
  activity_date text not null,
  app_id text not null references app_registry(id) on delete restrict,
  age_band text not null,
  active_learners integer not null default 0,
  sessions_started integer not null default 0,
  sessions_completed integer not null default 0,
  sessions_interrupted integer not null default 0,
  engaged_seconds integer not null default 0,
  lessons_completed integer not null default 0,
  generated_at text not null,
  run_version integer not null default 1,
  primary key (activity_date, app_id, age_band)
);

-- Run tracking/lock (business rules 16, 17, 26). Deliberately holds only
-- control totals and status — no learner information, ever.
create table if not exists analytics_daily_runs (
  activity_date text primary key,
  status text not null check (status in ('running','completed','failed')),
  run_version integer not null default 1,
  source_row_count integer not null default 0,
  source_engaged_seconds integer not null default 0,
  source_sessions_started integer not null default 0,
  source_sessions_completed integer not null default 0,
  source_sessions_interrupted integer not null default 0,
  source_lessons_completed integer not null default 0,
  started_at text not null,
  completed_at text,
  failure_code text
);

-- Minimal admin-alert stand-in for "an administrator alert is emitted"
-- (business rule 24) — no paging/notification infra exists locally, so
-- this is a queryable table an admin surface can read instead. Never
-- carries learner information.
create table if not exists platform_alerts (
  id text primary key,
  alert_type text not null,
  message text not null,
  metadata text,
  created_at text not null default (datetime('now')),
  resolved_at text
);

-- AN-001 business rule 29: current state only, one row per learner+app,
-- overwritten in place — deliberately not append-only/versioned history.
create table if not exists learner_app_progress (
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  current_level_key text,
  current_lesson_key text,
  current_engaged_seconds integer not null default 0 check (current_engaged_seconds >= 0),
  app_state text,
  schema_version integer not null default 1,
  updated_at text not null default (datetime('now')),
  primary key (learner_id, app_id)
);

-- AN-001 business rule 30: one row per learner/app/lesson. completion_id
-- is the caller's deterministic idempotency key so a retried submission
-- neither duplicates the row nor double-counts into the buffer.
create table if not exists lesson_completions (
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  lesson_key text not null,
  completion_id text not null unique,
  level_key text not null,
  completed_at text not null,
  engaged_seconds integer not null default 0 check (engaged_seconds >= 0),
  result text,
  primary key (learner_id, app_id, lesson_key)
);
