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
  email_verified_at text,
  created_at text not null default (datetime('now'))
);

-- REQ-08 §3.1 / IA-001 & IA-002 data model impact
create table if not exists profiles (
  id text primary key references users(id) on delete cascade,
  profile_type text not null default 'parent'
    check (profile_type = 'parent'),
  display_name text,
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
  -- GAP-008: one-way sha256 hash only — the raw token is never persisted,
  -- only ever returned once to the caller that just issued it.
  token_hash text unique not null,
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

-- AU-002: one authoritative, device-bound nested learner mode per parent session.
-- Activation is performed only after IA-004 passkey verification; browser claims
-- never write this table directly.
create table if not exists learner_mode_unlock_receipts (
  id text primary key,
  parent_user_id text not null references profiles(id) on delete cascade,
  parent_session_id text not null,
  device_session_id text not null,
  learner_id text not null references learners(id),
  credential_id text not null,
  verified_at text not null,
  expires_at text not null,
  consumed_at text
);
create index if not exists idx_learner_mode_unlock_receipt_expiry
  on learner_mode_unlock_receipts(expires_at,consumed_at);

create table if not exists learner_unlock_contexts (
  parent_session_id text not null,
  device_session_id text not null,
  parent_user_id text not null references profiles(id) on delete cascade,
  learner_id text not null references learners(id),
  credential_id text not null,
  status text not null check(status in ('active','revoked','expired')),
  expires_at text not null,
  version integer not null default 1,
  created_at text not null,
  updated_at text not null,
  revoked_at text,
  revocation_reason text,
  primary key(parent_session_id,device_session_id)
);
create index if not exists idx_learner_unlock_context_credential
  on learner_unlock_contexts(credential_id,status);

-- IA-004: a learner's registered WebAuthn passkey credentials. public_key
-- is the COSE-encoded credential public key (base64); sign_count is the
-- authenticator's own signature counter, used to detect cloned
-- authenticators on the next assertion.
create table if not exists learner_passkey_credentials (
  id text primary key,
  learner_id text not null references learners(id),
  owner_parent_id text not null references profiles(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  sign_count integer not null default 0,
  transports_json text not null default '[]',
  device_type text not null,
  backed_up integer not null default 0,
  label text not null,
  status text not null check(status in ('active','revoked')),
  created_at text not null,
  last_used_at text,
  revoked_at text,
  revocation_reason text
);
create index if not exists idx_learner_passkey_credentials_learner
  on learner_passkey_credentials(learner_id,status);

-- GAP-072: a 5-minute single-use WebAuthn challenge, stored only as a hash
-- (challenge_hash) — never the raw value — so a leaked row alone can't be
-- replayed. One row per registration or authentication ceremony attempt.
create table if not exists webauthn_challenges (
  id text primary key,
  purpose text not null check(purpose in ('registration','authentication')),
  parent_user_id text not null references profiles(id) on delete cascade,
  parent_session_id text not null,
  device_session_id text not null,
  learner_id text not null references learners(id),
  challenge_hash text not null,
  expires_at text not null,
  consumed_at text
);
create index if not exists idx_webauthn_challenges_expiry
  on webauthn_challenges(expires_at,consumed_at);

create table if not exists authorization_actions (
  action_key text primary key,
  required_mode text not null check(required_mode in ('parent_management','learner_mode','app_service','administrator','support','service')),
  resource_type text not null,
  sensitive integer not null default 0,
  version integer not null default 1,
  active integer not null default 1
);

-- AU-001: reviewed policy definitions are stored as immutable, digest-addressed
-- bundles. Activation is deliberately modeled separately so publishing a
-- version never mutates its reviewed contents.
create table if not exists authorization_policy_bundles (
  id text primary key,
  version text not null unique,
  digest text not null unique check(length(digest) = 64),
  source_commit_sha text not null check(length(source_commit_sha) = 40),
  policy_json text not null,
  created_at text not null
);

create trigger if not exists authorization_policy_bundles_no_update
before update on authorization_policy_bundles
begin
  select raise(abort, 'authorization policy bundles are immutable');
end;

create trigger if not exists authorization_policy_bundles_no_delete
before delete on authorization_policy_bundles
begin
  select raise(abort, 'authorization policy bundles are immutable');
end;

-- Singleton pointer: the primary-key check makes multiple active versions
-- structurally impossible. Switching it and writing history share one
-- transaction in the policy service.
create table if not exists authorization_policy_active (
  singleton_key text primary key check(singleton_key = 'active'),
  bundle_id text not null unique references authorization_policy_bundles(id),
  activated_by text not null,
  activated_at text not null
);

create trigger if not exists authorization_policy_active_no_delete
before delete on authorization_policy_active
begin
  select raise(abort, 'active authorization policy cannot be deleted');
end;

create table if not exists authorization_policy_activation_history (
  id text primary key,
  bundle_id text not null references authorization_policy_bundles(id),
  previous_bundle_id text references authorization_policy_bundles(id),
  digest text not null check(length(digest) = 64),
  source_commit_sha text not null check(length(source_commit_sha) = 40),
  activated_by text not null,
  activated_at text not null
);

create trigger if not exists authorization_policy_activation_history_no_update
before update on authorization_policy_activation_history
begin
  select raise(abort, 'authorization policy activation history is immutable');
end;

-- AU-001 managed platform-service identities are deliberately separate from
-- LA-002 learning-app principals and browser sessions.
-- AU-004: identity is an Ed25519 managed key pair, not a shared secret —
-- public_key holds the SPKI PEM verification key; key_ref is now just a
-- human-readable rotation label, not a lookup into an env-var secret map.
create table if not exists platform_service_principals (
  id text primary key,
  service_key text not null unique,
  key_ref text not null,
  public_key text not null default '',
  status text not null check(status in ('active','revoked')),
  valid_from text not null,
  valid_until text not null,
  version integer not null default 1
);

create table if not exists platform_service_assertion_replays (
  principal_id text not null references platform_service_principals(id),
  jti text not null,
  expires_at text not null,
  primary key(principal_id,jti)
);

create trigger if not exists authorization_policy_activation_history_no_delete
before delete on authorization_policy_activation_history
begin
  select raise(abort, 'authorization policy activation history is immutable');
end;

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
  product_type text not null default 'individual_app'
    check (product_type in ('individual_app','bundle')),
  version integer not null default 1 check (version > 0),
  status text not null default 'active'
    check (status in ('active','coming_soon','archived')),
  created_at text not null default (datetime('now'))
);

-- BI-002: immutable price versions. Amounts are stored in minor currency
-- units (paise for INR); checkout and renewal bind to one exact row/version.
create table if not exists product_prices (
  id text primary key,
  product_id text not null references products(id),
  currency text not null check(length(currency)=3 and currency=upper(currency)),
  billing_interval text not null check(billing_interval in ('month','year')),
  interval_count integer not null default 1 check(interval_count>0),
  unit_amount integer not null check(unit_amount>=0),
  pricing_rule_version text not null,
  supports_non_renewing integer not null default 1 check(supports_non_renewing in (0,1)),
  status text not null default 'active' check(status in ('active','retired')),
  effective_from text not null,
  effective_to text,
  version integer not null check(version>0),
  created_at text not null default (datetime('now')),
  unique(product_id,currency,billing_interval,interval_count,version)
);
create index if not exists idx_product_prices_catalog
  on product_prices(product_id,status,currency,version);

-- REQ-08 §3.3
create table if not exists subscriptions (
  id text primary key,
  -- Legacy alias retained while REQ-08 callers migrate. BI-001 treats
  -- purchaser_parent_id as authoritative and always writes both values
  -- identically.
  user_id text not null references users(id) on delete cascade,
  type text not null check (type in ('bundle','single')),
  product_id text not null references products(id),
  purchaser_parent_id text not null references profiles(id),
  assigned_learner_id text not null references learners(id),
  product_version integer not null default 1 check (product_version > 0),
  status text not null default 'active'
    check (status in ('pending_payment','active','cancelling','cancelled','expired','past_due',
      'refunded','charged_back','disputed','suspended_fraud')),
  cancel_at_period_end integer not null default 0,
  auto_renew_enabled integer not null default 0 check(auto_renew_enabled in (0,1)),
  provider text not null default 'legacy',
  provider_environment text not null default 'test' check(provider_environment in ('test','production')),
  provider_account_id text,
  razorpay_subscription_id text unique not null,
  provider_customer_ref text,
  provider_payment_method_ref text,
  provider_mandate_ref text,
  provider_mandate_status text not null default 'unknown'
    check(provider_mandate_status in ('unknown','valid','invalid','pending_setup')),
  provider_subscription_ref text,
  billing_price_id text references product_prices(id),
  billing_price_version integer,
  payment_state text not null default 'paid'
    check(payment_state in ('pending','paid','renewal_failed','past_due_grace','inactive_nonpayment',
      'failed','overlap_resolution_required')),
  grace_started_at text,
  grace_ends_at text,
  renewal_failure_at text,
  last_recovery_attempt_at text,
  recovery_version integer not null default 1 check(recovery_version > 0),
  nonpayment_ended_at text,
  provider_retry_stop_state text check(provider_retry_stop_state in ('pending','confirmed','unsupported','failed')),
  started_at text not null default (datetime('now')),
  current_period_start text not null default (datetime('now')),
  current_period_end text not null,
  next_renewal_at text,
  billing_anchor_at text,
  original_anchor_day integer check(original_anchor_day between 1 and 31),
  original_anchor_time text,
  pending_reassignment_learner_id text references learners(id),
  pending_reassignment_effective_at text,
  assignment_version integer not null default 1 check (assignment_version > 0),
  cancellation_requested_at text,
  cancellation_effective_at text,
  cancellation_reversed_at text,
  cancellation_reason_code text check(cancellation_reason_code is null or cancellation_reason_code='self_service'),
  cancellation_version integer not null default 1 check(cancellation_version > 0),
  version integer not null default 1 check (version > 0),
  cancelled_at text,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  check (user_id = purchaser_parent_id),
  check (cancel_at_period_end=0 or cancellation_effective_at is not null),
  check ((pending_reassignment_learner_id is null) = (pending_reassignment_effective_at is null)),
  check (pending_reassignment_learner_id is null or pending_reassignment_learner_id <> assigned_learner_id)
);

create index if not exists idx_subscriptions_user on subscriptions(user_id);
create index if not exists idx_subscriptions_purchaser on subscriptions(purchaser_parent_id, status, id);
create index if not exists idx_subscriptions_learner on subscriptions(assigned_learner_id, status, id);
create index if not exists idx_subscriptions_product on subscriptions(product_id);
create index if not exists idx_subscriptions_status on subscriptions(status);
create index if not exists idx_subscriptions_next_renewal
  on subscriptions(next_renewal_at,id)
  where auto_renew_enabled=1 and cancel_at_period_end=0;
create index if not exists idx_subscriptions_grace_expiry
  on subscriptions(grace_ends_at,id)
  where payment_state='past_due_grace';
create index if not exists idx_subscriptions_cancellation_effective
  on subscriptions(cancellation_effective_at,id)
  where cancel_at_period_end=1;
create index if not exists idx_subscriptions_pending_reassignment
  on subscriptions(pending_reassignment_effective_at)
  where pending_reassignment_learner_id is not null;

create trigger if not exists subscriptions_purchaser_immutable
before update of purchaser_parent_id,user_id on subscriptions
when new.purchaser_parent_id <> old.purchaser_parent_id or new.user_id <> old.user_id
begin
  select raise(abort, 'subscription purchaser is immutable');
end;

-- BI-001 API-BI-001: immutable, exact-once parent/learner/product checkout
-- context. Provider-hosted handoff data is deliberately opaque and safe;
-- no payment instrument is stored.
create table if not exists checkout_intents (
  id text primary key,
  purchaser_parent_id text not null references profiles(id),
  assigned_learner_id text not null references learners(id),
  product_id text not null references products(id),
  product_version integer not null check (product_version > 0),
  price_id text references product_prices(id),
  price_version integer,
  amount integer,
  currency text,
  billing_interval text,
  interval_count integer,
  auto_renew_enabled integer check(auto_renew_enabled in (0,1)),
  consent_disclosure_version text,
  consented_at text,
  provider text not null,
  provider_environment text,
  provider_account_id text,
  provider_checkout_ref text not null unique,
  provider_payment_ref text,
  provider_mandate_ref text,
  provider_handoff_json text not null,
  overlap_source_hash text,
  status text not null default 'pending_provider'
    check (status in ('pending_provider','payment_failed','activated','expired')),
  idempotency_key text not null,
  request_hash text not null,
  expires_at text not null,
  subscription_id text references subscriptions(id),
  created_at text not null,
  updated_at text not null,
  unique(purchaser_parent_id,idempotency_key)
);
create index if not exists idx_checkout_intents_status_expiry on checkout_intents(status,expires_at);

create table if not exists checkout_activation_receipts (
  provider text not null,
  provider_event_id text not null,
  request_hash text not null,
  checkout_intent_id text not null references checkout_intents(id),
  subscription_id text references subscriptions(id),
  result_code text not null,
  response_json text,
  created_at text not null,
  primary key(provider,provider_event_id)
);

create trigger if not exists checkout_intents_context_immutable
before update of purchaser_parent_id,assigned_learner_id,product_id,product_version,
  price_id,price_version,amount,currency,billing_interval,interval_count,auto_renew_enabled,
  consent_disclosure_version,consented_at,provider,provider_environment,provider_account_id,
  provider_checkout_ref,idempotency_key,
  request_hash,overlap_source_hash on checkout_intents
begin
  select raise(abort, 'checkout context is immutable');
end;

-- BI-002 provider truth and exact paid-period ledger. Full provider payloads
-- and payment credentials are intentionally absent.
create table if not exists billing_periods (
  id text primary key,
  subscription_id text not null references subscriptions(id),
  period_start text not null,
  period_end text not null,
  provider_payment_ref text not null,
  amount integer not null check(amount>=0),
  currency text not null,
  price_id text not null references product_prices(id),
  price_version integer not null,
  status text not null check(status in ('paid','failed','refunded','disputed')),
  source_provider_event_id text not null,
  created_at text not null,
  unique(subscription_id,period_start,period_end),
  unique(provider_payment_ref)
);
create index if not exists idx_billing_periods_subscription
  on billing_periods(subscription_id,period_start,status);

create table if not exists payment_provider_events (
  provider text not null,
  environment text not null check(environment in ('test','production')),
  account_id text not null,
  provider_event_id text not null,
  event_type text not null,
  payload_hash text not null,
  checkout_intent_id text references checkout_intents(id),
  subscription_id text references subscriptions(id),
  provider_checkout_ref text,
  provider_payment_ref text,
  status text not null check(status in ('received','processed','duplicate','ignored','rejected','deferred')),
  result_code text,
  result_json text,
  error_code text,
  received_at text not null,
  processed_at text,
  primary key(provider,environment,account_id,provider_event_id)
);
create index if not exists idx_payment_provider_events_status
  on payment_provider_events(status,received_at);

create table if not exists billing_mutation_requests (
  actor_id text not null,
  subscription_id text not null references subscriptions(id),
  idempotency_key text not null,
  operation text not null,
  request_hash text not null,
  result_json text,
  status text not null check(status in ('processing','completed','failed')),
  created_at text not null,
  completed_at text,
  expires_at text not null,
  primary key(actor_id,subscription_id,idempotency_key)
);
create index if not exists idx_billing_mutation_requests_expiry
  on billing_mutation_requests(expires_at,status);

-- BI-004 provider-hosted recurring-agreement setup. The browser can only
-- follow the opaque handoff URL; provider confirmation is processed through
-- the signed billing event boundary.
create table if not exists recurring_agreement_setup_sessions (
  id text primary key,
  parent_id text not null references profiles(id),
  subscription_id text not null references subscriptions(id),
  provider text not null,
  provider_environment text not null check(provider_environment in ('test','production')),
  provider_session_ref text not null unique,
  provider_handoff_url text not null,
  idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('pending','confirmed','failed','expired')),
  expires_at text not null,
  result_json text not null,
  created_at text not null,
  updated_at text not null,
  unique(parent_id,subscription_id,idempotency_key)
);
create index if not exists idx_recurring_agreement_setup_expiry
  on recurring_agreement_setup_sessions(status,expires_at);

create table if not exists billing_cancellation_notifications (
  id text primary key,
  subscription_id text not null references subscriptions(id),
  cancellation_version integer not null,
  notification_type text not null
    check(notification_type in ('scheduled','setup_required','reversed','ended')),
  channel text not null check(channel in ('email','in_product')),
  recipient_email text,
  status text not null check(status in ('pending','sending','sent','retry_pending','cancelled')),
  attempt_count integer not null default 0,
  sent_at text,
  last_error_code text,
  safe_context_json text not null,
  created_at text not null,
  updated_at text not null,
  unique(subscription_id,cancellation_version,notification_type,channel)
);
create index if not exists idx_billing_cancellation_notifications_status
  on billing_cancellation_notifications(status,created_at,id);

create table if not exists subscription_renewal_reminders (
  id text primary key,
  subscription_id text not null references subscriptions(id),
  renewal_cycle_at text not null,
  reminder_due_at text not null,
  expected_amount integer not null,
  currency text not null,
  price_id text not null references product_prices(id),
  price_version integer not null,
  channel text not null default 'email' check(channel in ('email','in_product')),
  status text not null default 'pending'
    check(status in ('pending','sending','sent','retry_pending','cancelled','skipped')),
  attempt_count integer not null default 0,
  sent_at text,
  last_error_code text,
  created_at text not null,
  updated_at text not null,
  unique(subscription_id,renewal_cycle_at)
);
create index if not exists idx_subscription_renewal_reminders_due
  on subscription_renewal_reminders(status,reminder_due_at,id);

create table if not exists billing_job_runs (
  principal_id text not null,
  job_type text not null check(job_type in ('reconcile','renewal_reminder')),
  run_idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('running','completed','failed')),
  result_json text,
  created_at text not null,
  completed_at text,
  primary key(principal_id,job_type,run_idempotency_key)
);

-- BI-003: one safe, provider-bound record per renewal attempt. Provider
-- payloads and payment credentials are never retained.
create table if not exists renewal_payment_attempts (
  id text primary key,
  subscription_id text not null references subscriptions(id),
  provider text not null,
  environment text not null check(environment in ('test','production')),
  account_id text not null,
  provider_invoice_ref text,
  provider_payment_ref text not null,
  provider_attempt_ref text,
  attempt_number integer not null default 1 check(attempt_number > 0),
  status text not null check(status in ('failed','settled','late_exception')),
  amount integer not null check(amount >= 0),
  currency text not null,
  price_id text not null references product_prices(id),
  price_version integer not null,
  attempted_at text not null,
  settled_at text,
  failure_code text,
  provider_event_id text not null,
  created_at text not null,
  updated_at text not null,
  unique(provider,environment,account_id,provider_payment_ref),
  unique(provider,environment,account_id,provider_attempt_ref)
);
create index if not exists idx_renewal_payment_attempts_subscription
  on renewal_payment_attempts(subscription_id,status,attempted_at);

create table if not exists payment_method_update_sessions (
  id text primary key,
  parent_id text not null references profiles(id),
  subscription_id text not null references subscriptions(id),
  provider text not null,
  environment text not null check(environment in ('test','production')),
  provider_session_ref text not null unique,
  provider_handoff_url text not null,
  status text not null check(status in ('created','completed','expired','failed')),
  idempotency_key text not null,
  request_hash text not null,
  expires_at text not null,
  result_json text not null,
  created_at text not null,
  updated_at text not null,
  unique(parent_id,subscription_id,idempotency_key)
);
create index if not exists idx_payment_method_update_sessions_expiry
  on payment_method_update_sessions(status,expires_at);

create table if not exists billing_recovery_notifications (
  id text primary key,
  subscription_id text not null references subscriptions(id),
  notification_type text not null check(notification_type in ('initial_failure','routine_recovery','recovered','expired')),
  channel text not null check(channel in ('email','in_product')),
  window_key text not null,
  status text not null check(status in ('pending','sending','sent','retry_pending','cancelled')),
  attempt_count integer not null default 0,
  sent_at text,
  last_error_code text,
  safe_context_json text not null,
  created_at text not null,
  updated_at text not null,
  unique(subscription_id,notification_type,channel,window_key)
);
create index if not exists idx_billing_recovery_notifications_status
  on billing_recovery_notifications(status,created_at,id);

create table if not exists billing_grace_job_runs (
  principal_id text not null,
  run_idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('running','completed','failed')),
  result_json text,
  created_at text not null,
  completed_at text,
  primary key(principal_id,run_idempotency_key)
);

create table if not exists subscription_reassignment_cases (
  id text primary key,
  purchaser_parent_id text not null references profiles(id),
  subscription_id text not null references subscriptions(id),
  source_learner_id text not null references learners(id),
  target_learner_id text not null references learners(id),
  reason_code text not null,
  notes text,
  status text not null default 'open'
    check (status in ('open','scheduled','executed','rejected','closed','expired')),
  requested_effective_mode text check (requested_effective_mode in ('immediate_if_unused','next_period')),
  effective_at text,
  administrator_id text,
  resolution_code text,
  version integer not null default 1 check (version > 0),
  idempotency_key text not null,
  request_hash text not null,
  requested_at text not null,
  reviewed_at text,
  executed_at text,
  updated_at text not null,
  unique(purchaser_parent_id,idempotency_key),
  check (source_learner_id <> target_learner_id)
);
create index if not exists idx_reassignment_cases_subscription
  on subscription_reassignment_cases(subscription_id,status);
create index if not exists idx_reassignment_cases_admin
  on subscription_reassignment_cases(administrator_id,status);

create table if not exists subscription_reassignment_requests (
  administrator_id text not null,
  idempotency_key text not null,
  case_id text not null references subscription_reassignment_cases(id),
  subscription_id text not null references subscriptions(id),
  request_hash text not null,
  response_json text,
  status text not null check (status in ('processing','completed')),
  created_at text not null,
  completed_at text,
  primary key(administrator_id,idempotency_key)
);

create table if not exists subscription_assignment_audit (
  id text primary key,
  subscription_id text not null references subscriptions(id),
  case_id text references subscription_reassignment_cases(id),
  event_type text not null check (event_type in
    ('subscription_activated','reassignment_case_created','reassignment_scheduled','reassignment_executed')),
  actor_type text not null check (actor_type in ('parent','administrator','billing_service')),
  actor_id text not null,
  purchaser_parent_id text not null,
  source_learner_id text,
  target_learner_id text,
  product_id text not null,
  effective_at text,
  result_code text not null,
  created_at text not null
);
create index if not exists idx_subscription_assignment_audit_subscription
  on subscription_assignment_audit(subscription_id,created_at);

create trigger if not exists subscription_assignment_audit_no_update
before update on subscription_assignment_audit
begin
  select raise(abort, 'subscription assignment audit is immutable');
end;

create trigger if not exists subscription_assignment_audit_no_delete
before delete on subscription_assignment_audit
begin
  select raise(abort, 'subscription assignment audit is immutable');
end;

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

-- BI-001 immutable product-version expansion. Individual products have
-- exactly one row; bundles have one row per included app. Application
-- validation enforces the cardinality because SQLite cannot express a
-- cross-row count check.
create table if not exists product_version_apps (
  product_id text not null references products(id),
  product_version integer not null check (product_version > 0),
  app_id text not null references app_registry(id) on delete restrict,
  created_at text not null default (datetime('now')),
  primary key(product_id,product_version,app_id)
);
create index if not exists idx_product_version_apps_app
  on product_version_apps(app_id,product_id,product_version);

-- Admin-scoped idempotency for every registry mutation (create/edit/
-- activate/soft-delete/restore share one table, distinguished by
-- `operation`) — same replay-safe shape as LP-001's
-- learner_creation_requests, but keyed by admin rather than parent and
-- generalized across operation types instead of one table per verb.
create table if not exists app_registry_mutation_requests (
  admin_user_id text not null,
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

-- AD-001: a structurally separate human staff identity. Shares the same
-- `users` credential row (email/password_hash) a parent would, but never
-- gets a `profiles` row — see the two mutual-exclusion triggers below
-- (business rules 2-6, 121).
create table if not exists staff_accounts (
  id text primary key,
  auth_user_id text not null unique references users(id) on delete cascade,
  normalized_email text not null unique,
  display_name text,
  status text not null check(status in ('invited','active','suspended','revoked')),
  -- Bumped on every status/role change so a live session's cached
  -- authorization can fail closed within 5 seconds (business rule 38)
  -- without a server-side session store — same pattern as
  -- learner_unlock_contexts.version (PD-004 modeGeneration).
  authorization_generation integer not null default 1,
  invited_by_staff_id text references staff_accounts(id),
  invitation_expires_at text,
  activated_at text,
  suspended_at text,
  revoked_at text,
  version integer not null default 1,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now'))
);

-- One auth identity can never be both a parent and staff (business rules
-- 4-5, 121-123). Enforced both directions so insert order never matters.
create trigger if not exists trg_staff_accounts_no_parent_conflict
before insert on staff_accounts
begin
  select case when exists(select 1 from profiles where id = new.auth_user_id)
    then raise(abort, 'STAFF_AUTH_USER_ALREADY_PARENT') end;
end;

create trigger if not exists trg_profiles_no_staff_conflict
before insert on profiles
begin
  select case when exists(select 1 from staff_accounts where auth_user_id = new.id)
    then raise(abort, 'PARENT_AUTH_USER_ALREADY_STAFF') end;
end;

-- Static V1 role keys (business rule 32); role -> capability mapping is
-- version-controlled code (src/lib/staff-identity/roles.ts), not DB-editable.
create table if not exists staff_role_assignments (
  id text primary key,
  staff_account_id text not null references staff_accounts(id) on delete cascade,
  role_key text not null check(role_key in
    ('support_agent','billing_administrator','operations_administrator','platform_administrator')),
  role_version integer not null default 1,
  assigned_by_staff_id text references staff_accounts(id),
  assigned_at text not null,
  removed_at text
);
-- One active assignment per (staff, role) — business rule 33.
create unique index if not exists idx_staff_role_assignments_active
  on staff_role_assignments(staff_account_id, role_key) where removed_at is null;
create index if not exists idx_staff_role_assignments_staff
  on staff_role_assignments(staff_account_id);

-- Mirrors learner_passkey_credentials (IA-004) exactly, scoped to staff
-- instead of learners — no private key/biometric/PIN ever stored.
create table if not exists staff_passkey_credentials (
  id text primary key,
  staff_account_id text not null references staff_accounts(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  sign_count integer not null default 0,
  transports_json text not null default '[]',
  device_type text not null,
  backed_up integer not null default 0,
  label text not null,
  status text not null check(status in ('active','revoked')),
  created_at text not null,
  last_used_at text,
  revoked_at text,
  revocation_reason text
);
create index if not exists idx_staff_passkey_credentials_staff
  on staff_passkey_credentials(staff_account_id,status);

-- Mirrors webauthn_challenges (GAP-072): stored only as a hash, single-use,
-- 5-minute expiry. purpose='reauth' covers the <=10-minute sensitive-action
-- two-factor reauthentication (business rules 60-69), not just login/MFA.
create table if not exists staff_auth_challenges (
  id text primary key,
  purpose text not null check(purpose in ('login','register','reauth')),
  staff_account_id text not null references staff_accounts(id) on delete cascade,
  challenge_hash text not null,
  expires_at text not null,
  consumed_at text
);
create index if not exists idx_staff_auth_challenges_expiry
  on staff_auth_challenges(expires_at,consumed_at);

-- Ephemeral record that a staff session completed a fresh two-factor
-- (password + passkey) reauthentication within the last 10 minutes
-- (business rule 61). No assertion/password stored, only a factors summary.
create table if not exists staff_reauth_receipts (
  id text primary key,
  staff_session_id text not null,
  staff_account_id text not null references staff_accounts(id) on delete cascade,
  reauth_at text not null,
  valid_until text not null,
  factors_json text not null default '{}'
);
create index if not exists idx_staff_reauth_receipts_session
  on staff_reauth_receipts(staff_session_id,valid_until);

-- Immutable minimal staff audit trail (business rules 80-84). Append-only
-- by convention (no UPDATE/DELETE call site anywhere in this domain);
-- Postgres mirror additionally forces RLS with no update/delete grants.
create table if not exists staff_audit_log (
  id text primary key,
  actor_staff_account_id text references staff_accounts(id),
  target_staff_account_id text references staff_accounts(id),
  canonical_action text not null,
  resource_type text,
  resource_safe_id text,
  reason text,
  result text not null,
  request_id text,
  policy_version integer,
  role_version integer,
  created_at text not null default (datetime('now'))
);
create index if not exists idx_staff_audit_log_actor
  on staff_audit_log(actor_staff_account_id,created_at);

-- Idempotency receipt for staff status/role mutations (API-AD-007/008),
-- same request_hash + idempotency_key composite-key pattern already used
-- by BI-001's subscription_reassignment_requests: a replayed key with an
-- identical payload returns the cached response; a reused key with a
-- different payload is rejected (business rule 65).
create table if not exists staff_mutation_requests (
  actor_staff_account_id text not null references staff_accounts(id),
  idempotency_key text not null,
  canonical_action text not null,
  target_staff_account_id text not null references staff_accounts(id),
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  response_json text,
  created_at text not null default (datetime('now')),
  completed_at text,
  primary key (actor_staff_account_id, idempotency_key)
);

-- LP-004: one learner choice per authenticated parent session.
create table if not exists learner_selection_contexts (
  parent_session_id text primary key,
  parent_user_id text not null references profiles(id),
  selected_learner_id text not null references learners(id),
  selected_at text not null,
  expires_at text not null
);

create index if not exists idx_learner_selection_contexts_expiry
  on learner_selection_contexts(expires_at);

create table if not exists learner_app_week_usage (
  learner_id text not null references learners(id),
  app_id text not null,
  week_key text not null,
  week_timezone text not null,
  normal_sessions_started integer not null default 0 check (normal_sessions_started between 0 and 2),
  -- SC-002: increments only at SC-003 usable launch, not at session start.
  standard_sessions_funded integer not null default 0 check (standard_sessions_funded between 0 and 3),
  version integer not null default 1,
  updated_at text not null,
  primary key (learner_id, app_id, week_key)
);

-- SC-002: one compact batch row per learner/app/allocation-month instead of
-- eight individual credit rows. available = granted - reserved - consumed.
-- EN-001: the same compact-batch shape also backs one independent 8-credit
-- batch per allocation-bearing entitlement app-period (entitlement_period_id
-- populated, allocation_month/timezone left null) instead of a calendar
-- month. SQLite's unique(learner_id,app_id,allocation_month) still works
-- with entitlement-period rows since it permits multiple NULLs.
create table if not exists learner_app_standard_credit_batches (
  id text primary key,
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  allocation_month text,
  timezone text,
  entitlement_period_id text references learner_app_entitlement_periods(id),
  granted_count integer not null default 8 check (granted_count = 8),
  reserved_count integer not null default 0 check (reserved_count >= 0),
  consumed_count integer not null default 0 check (consumed_count >= 0),
  effective_at text not null,
  expires_at text not null,
  version integer not null default 1,
  -- EN-004 rules 36-38: a batch belonging to a suppressed/unknown source is
  -- frozen from new funding by reconciliation rather than deleted (counters/
  -- history preserved); reconciliation_receipt_id links back to whichever
  -- receipt made that determination.
  funding_disabled_at text,
  funding_disabled_reason text,
  reconciliation_receipt_id text references entitlement_reconciliation_receipts(id),
  created_at text not null,
  updated_at text not null,
  unique(learner_id, app_id, allocation_month),
  unique(entitlement_period_id),
  check (reserved_count + consumed_count <= granted_count),
  check ((allocation_month is not null) <> (entitlement_period_id is not null))
);
create index if not exists idx_standard_credit_batches_lookup
  on learner_app_standard_credit_batches(learner_id, app_id, expires_at);

create table if not exists learner_sessions (
  id text primary key,
  learner_id text not null references learners(id),
  app_id text not null,
  parent_user_id text not null references profiles(id),
  parent_session_id text,
  device_session_id text not null,
  week_key text not null,
  week_timezone text not null,
  weekly_slot_number integer check (weekly_slot_number in (1,2)),
  replacement_credit_id text,
  source text not null check (source in ('normal','replacement','technical_credit','standard_monthly')),
  -- SC-002: which standard-credit batch funded this session, and its 1..3
  -- ordinal within the learner/app/week (3 only via catch-up pacing).
  standard_credit_batch_id text references learner_app_standard_credit_batches(id),
  weekly_session_ordinal integer check (weekly_session_ordinal between 1 and 3),
  status text not null check (status in ('starting','active','disconnected','resumable','completed','interrupted','expired','revoked_by_admin','cancelled_before_launch')),
  -- SC-003: the reserve-then-activate lifecycle. A session is created
  -- 'starting'/reserved and becomes 'active'/consumed only once the app
  -- backend confirms usable launch; an unconfirmed reservation expires
  -- exactly 300 seconds after reserved_at.
  funding_state text not null default 'reserved' check (funding_state in ('reserved','consumed','released','expired')),
  reserved_at text,
  reservation_expires_at text,
  schedule_authorization_id text not null,
  started_at text not null,
  disconnected_at text,
  resume_deadline text,
  cumulative_disconnected_seconds integer not null default 0 check (cumulative_disconnected_seconds between 0 and 900),
  connected_elapsed_seconds integer not null default 0 check (connected_elapsed_seconds >= 0),
  verified_active_seconds integer not null default 0 check (verified_active_seconds >= 0),
  -- SC-001: browser-local session runtime replaces recurring heartbeats. The
  -- platform records only the usable-launch moment and a hard server expiry;
  -- everything in between is client-reported and capped, never polled.
  usable_launch_established_at text,
  active_segment_started_at text,
  hard_expires_at text,
  maximum_connected_seconds integer not null default 2700,
  final_reported_connected_seconds integer,
  final_accepted_connected_seconds integer,
  resume_token_hash text not null,
  ended_at text,
  end_reason text,
  version integer not null default 1,
  created_at text not null,
  updated_at text not null,
  deployment_id text,
  release_id text,
  deployment_environment text,
  deployment_origin text,
  launch_path text,
  session_expires_at text,
  current_level_key text,
  current_lesson_key text,
  context_started_verified_seconds integer not null default 0,
  interruption_episode_count integer not null default 0,
  final_progress_version integer,
  finalization_started_at text,
  session_credit_id text,
  -- EN-002: the effective-entitlement binding fresh-evaluated and persisted
  -- at Start (business rule 21); resume/revocation checks against this
  -- binding, not a re-derived one, are a follow-up (not built this pass).
  effective_entitlement_id text references learner_app_effective_entitlements(id),
  effective_entitlement_version_at_start integer,
  allocation_source_entitlement_period_id text references learner_app_entitlement_periods(id),
  -- PR-002: set only by the recovery write path (never by ordinary
  -- checkpoints) — a session-scoped marker distinct from
  -- learner_app_progress's own general-purpose current row.
  last_acknowledged_progress_version integer,
  last_acknowledged_progress_hash text,
  recovery_closed_at text,
  recovery_closed_reason text check (recovery_closed_reason in
    ('finalized','secure_exit','hard_expired','security_revoked','irrecoverable') or recovery_closed_reason is null),
  -- UL-002: metadata-only intentional exit state. Funding, device binding,
  -- connected-time bounds and hard expiry remain on the existing session.
  intentional_exit_state text not null default 'none' check (intentional_exit_state in
    ('none','resumable_requested','resumable','finish_requested','finalized')),
  intentional_exit_reason text check (intentional_exit_reason in
    ('intentional_resume_later','intentional_finish') or intentional_exit_reason is null),
  last_exit_acknowledged_progress_version integer,
  resumable_marked_at text,
  exit_transition_version integer not null default 0,
  check (connected_elapsed_seconds <= maximum_connected_seconds),
  check ((source = 'normal' and weekly_slot_number is not null and replacement_credit_id is null and session_credit_id is null and standard_credit_batch_id is null)
    or (source = 'replacement' and weekly_slot_number is null and replacement_credit_id is not null and session_credit_id is null and standard_credit_batch_id is null)
    or (source = 'technical_credit' and weekly_slot_number is null and replacement_credit_id is null and session_credit_id is not null and standard_credit_batch_id is null)
    or (source = 'standard_monthly' and weekly_slot_number is null and replacement_credit_id is null and session_credit_id is null and standard_credit_batch_id is not null and weekly_session_ordinal is not null))
);

-- UL-002: exact-once, metadata-only receipts for intentional exit outcomes.
-- No raw progress payload or browser state is stored here.
create table if not exists session_exit_transition_receipts (
  id text primary key,
  learner_session_id text not null references learner_sessions(id),
  app_id text not null references app_registry(id),
  device_session_id text not null,
  release_id text,
  app_principal_id text not null references app_service_principals(id),
  action text not null check (action in ('resume_later','finish_now')),
  expected_session_version integer not null,
  prior_session_version integer not null,
  new_session_version integer not null,
  acknowledged_progress_version integer not null,
  idempotency_key text not null,
  request_hash text not null,
  result_status text not null,
  response_json text not null,
  created_at text not null,
  completed_at text not null,
  unique(learner_session_id, action, idempotency_key)
);
create index if not exists idx_session_exit_receipts_session_status_time
  on session_exit_transition_receipts(learner_session_id, action, result_status, created_at);

-- UL-003: disposable, metadata-only launcher freshness state. The launcher
-- payload remains composed from EN/SC/session/PR/app sources and is never
-- stored here or used to authorize Start/Resume.
create table if not exists launcher_freshness_metadata (
  learner_id text not null references learners(id),
  environment text not null,
  context_generation integer not null default 0,
  launcher_version text,
  source_version_hash text,
  invalidation_version integer not null default 0,
  invalidated_at text,
  invalidation_reason text,
  source_type text,
  source_version text,
  source_event_id text,
  app_id text references app_registry(id) on delete restrict,
  composed_at text,
  next_recheck_at text,
  cache_max_age_seconds integer not null default 60 check(cache_max_age_seconds between 1 and 300),
  last_successful_refresh_at text,
  last_failed_refresh_at text,
  last_refresh_result text,
  version integer not null default 1,
  created_at text not null,
  updated_at text not null,
  primary key(learner_id,environment)
);
create index if not exists idx_launcher_freshness_invalidated
  on launcher_freshness_metadata(environment,invalidated_at,learner_id);
create index if not exists idx_launcher_freshness_boundary
  on launcher_freshness_metadata(environment,next_recheck_at,learner_id);

-- Exact retry receipts for API-UL-009/API-UL-010. Only request hashes and
-- safe aggregate results are retained; there is no launcher card payload.
create table if not exists learner_launcher_freshness_receipts (
  principal_id text not null references platform_service_principals(id),
  action text not null check(action in ('invalidate','reconcile')),
  idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  response_json text,
  created_at text not null,
  completed_at text,
  primary key(principal_id,action,idempotency_key)
);
create index if not exists idx_launcher_freshness_receipts_time
  on learner_launcher_freshness_receipts(action,created_at);

-- LA-001: one mutable, temporary launch attempt per LP-004 session.
create table if not exists learner_session_launch_state (
  learner_session_id text primary key references learner_sessions(id),
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null,
  deployment_id text not null,
  release_id text not null,
  device_session_id text not null,
  launch_attempt_id text not null unique,
  attempt_version integer not null,
  code_hash text,
  code_expires_at text,
  status text not null check (status in ('prepared','exchanged','revoked','expired')),
  exchanged_principal_id text,
  created_at text not null,
  updated_at text not null,
  exchanged_at text
);

-- Trusted AR-002 publication/window projection used by LA-001. Browser
-- requests never write or override these values.
create table if not exists app_deployment_launch_controls (
  deployment_id text primary key,
  app_id text not null references app_registry(id) on delete restrict,
  release_id text not null,
  environment text not null,
  immutable_origin text not null,
  launch_path text not null,
  api_contract_version text not null default '1.0',
  compatibility_status text not null check (compatibility_status in ('passed','failed','pending')),
  drain_starts_at text,
  deployment_window_ends_at text,
  status text not null check (status in ('published','draining','deploying','retired')),
  version integer not null default 1,
  updated_at text not null
);

create table if not exists deployment_mutation_requests (
  admin_user_id text not null,
  idempotency_key text not null,
  operation text not null check (operation in ('schedule','reschedule','cancel','promote','rollback')),
  deployment_id text not null,
  request_hash text not null,
  status text not null check (status in ('processing','completed')),
  response_json text,
  created_at text not null,
  completed_at text,
  primary key(admin_user_id,idempotency_key)
);

create table if not exists deployment_authorization_audit (
  id text primary key,
  admin_user_id text not null,
  app_id text not null,
  deployment_id text not null,
  release_id text not null,
  operation text not null,
  policy_version text not null,
  policy_digest text not null,
  version_from integer not null,
  version_to integer not null,
  created_at text not null
);

-- AR-002 business rule 6: minimal admin-curated list of domains a
-- provider-confirmed production origin is allowed to resolve under. Same
-- "small stand-in registry" shape as approved_app_icons (AR-001) /
-- approved_avatars (LP-001) for a precondition the spec assumes exists.
create table if not exists approved_domains (
  id text primary key,
  domain_suffix text not null unique,
  status text not null default 'active' check (status in ('active','retired')),
  created_at text not null default (datetime('now'))
);

-- AR-002: verified provider (Vercel) project binding, one per app+environment.
-- Admins select from provider-discovered projects only; no free-text URL/ID.
create table if not exists app_deployment_bindings (
  id text primary key,
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null check (environment in ('development','staging','production')),
  provider text not null,
  provider_team_id text not null,
  provider_project_id text not null,
  expected_repository text not null,
  approved_domain_id text,
  binding_status text not null default 'unverified' check (binding_status in ('unverified','verified','disabled')),
  deployment_enabled integer not null default 1,
  verified_at text,
  version integer not null default 1,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  unique(app_id, environment),
  unique(provider, provider_team_id, provider_project_id, environment)
);

-- AR-002: immutable release. Created only by an authenticated CI principal
-- from an approved repository commit (business rule 11); build-once, same
-- artifact_digest promoted through staging and production (rule 14).
create table if not exists app_releases (
  id text primary key,
  app_id text not null references app_registry(id) on delete restrict,
  source_repository text not null,
  source_commit_sha text not null,
  dependency_lock_hash text not null,
  build_input_hash text not null,
  artifact_digest text not null,
  provider_artifact_id text,
  manifest_json text not null,
  gate_results_json text not null,
  -- AR-002 session 2, business rules 46-49: which learner_app_progress
  -- schema_version values this release's code can still read/migrate
  -- (expand/migrate/contract) — CI's own attestation, checked against
  -- currently represented versions before staging can verify.
  readable_schema_versions_json text not null default '[]',
  status text not null default 'created'
    check (status in ('created','gate_failed','staging_deploying','staging_failed','verified','promoted')),
  created_by_ci_principal text not null,
  version integer not null default 1,
  created_at text not null default (datetime('now')),
  verified_at text,
  failed_at text,
  unique(app_id, source_commit_sha, artifact_digest)
);

create index if not exists idx_app_releases_app on app_releases(app_id, status);

-- AR-002: one row per environment deployment of a release (staging or
-- production). validation_summary_json is compact pass/fail codes only,
-- never full logs (business rule 40).
create table if not exists app_deployments (
  id text primary key,
  app_id text not null references app_registry(id) on delete restrict,
  release_id text not null references app_releases(id) on delete restrict,
  binding_id text not null references app_deployment_bindings(id) on delete restrict,
  environment text not null,
  provider_deployment_id text not null unique,
  verified_origin text not null,
  status text not null check (status in ('deploying','validating','published','superseded','failed','rolled_back')),
  validation_summary_json text not null default '{}',
  investigation_hold integer not null default 0,
  started_at text not null default (datetime('now')),
  validated_at text,
  published_at text,
  superseded_at text,
  ended_at text
);

create index if not exists idx_app_deployments_app_env on app_deployments(app_id, environment, status);

-- AR-002: atomic current/previous-healthy publication pointer per
-- app+environment (business rule 28, 31). This is the source of truth that
-- production promotion/rollback updates; app_deployment_launch_controls is
-- kept as a derived projection so LA-001/LP-004's existing read path
-- (resolveTrustedDeployment) is unaffected.
create table if not exists app_environment_publications (
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null,
  current_published_deployment_id text references app_deployments(id),
  previous_healthy_deployment_id text references app_deployments(id),
  version integer not null default 1,
  published_at text,
  primary key(app_id, environment)
);

-- AR-002: actor+app-scoped idempotency for binding/release/staging/
-- production operations (business rule 43) — same request-hash/receipt
-- shape as deployment_mutation_requests and entitlement_application_receipts.
create table if not exists deployment_operation_requests (
  actor_principal_id text not null,
  app_id text not null,
  idempotency_key text not null,
  operation text not null
    check (operation in ('bind','verify_binding','create_release','deploy_staging','approve_production',
      'schedule_window','reschedule_window','cancel_window','rollback')),
  request_hash text not null,
  release_id text,
  deployment_id text,
  result_id text,
  status text not null check (status in ('processing','completed')),
  safe_response_json text,
  created_at text not null default (datetime('now')),
  completed_at text,
  primary key(actor_principal_id, idempotency_key)
);

-- AR-002: short-retention provider webhook idempotency ledger (business
-- rule 37, 40). Populated by the webhook ingestion route (deferred to a
-- follow-up session); table created now so the retention/idempotency shape
-- is fixed ahead of that work.
create table if not exists deployment_webhook_receipts (
  id text primary key,
  provider text not null,
  provider_event_id text not null,
  received_at text not null default (datetime('now')),
  processed_at text,
  status text not null default 'received' check (status in ('received','processed','rejected')),
  unique(provider, provider_event_id)
);

-- AR-002: compact backward-compatibility report per release (business
-- rules 46-49). Table created now; the read/migrate/write test runner that
-- populates it is deferred to a follow-up session (see README).
create table if not exists app_release_compatibility_reports (
  release_id text primary key references app_releases(id) on delete restrict,
  platform_contract_version text not null,
  represented_progress_schema_versions_json text not null default '[]',
  status text not null default 'skipped' check (status in ('passed','failed','skipped')),
  generated_at text not null default (datetime('now'))
);

-- AR-002 session 2: one pre-scheduled app-specific production slot per
-- window (business rules 50-60). drain_starts_at is always starts_at minus
-- 60 minutes (rule 51), stored rather than computed so the existing
-- app_deployment_launch_controls projection can be upserted from it
-- unchanged. The partial unique index below is SQLite's stand-in for the
-- spec's "exclusion rule preventing overlapping non-final windows per app"
-- (no real exclusion-constraint support here) — only one non-final window
-- per app at a time; a schedule/reschedule attempt while one is already
-- non-final is rejected by the service layer's own transaction check
-- first, this index is the last-resort DB-level guarantee.
create table if not exists app_deployment_windows (
  id text primary key,
  app_id text not null references app_registry(id) on delete restrict,
  release_id text not null references app_releases(id) on delete restrict,
  starts_at text not null,
  ends_at text not null,
  drain_starts_at text not null,
  status text not null default 'scheduled'
    check (status in ('scheduled','draining','executing','completed','cancelled','failed','extended_safe_block')),
  failure_code text,
  created_by_admin_id text not null,
  version integer not null default 1,
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  completed_at text
);

create unique index if not exists idx_app_deployment_windows_one_nonfinal_per_app
  on app_deployment_windows(app_id)
  where status in ('scheduled','draining','executing','extended_safe_block');

-- AR-002 session 2: restart-safe state for the ten-minute/one-check-per-
-- minute post-publish release-safety observation (business rules 32-33).
-- One row per production deployment publish; the sweep reads status
-- rather than holding anything in memory, so a restart mid-window resumes
-- correctly (NFR: "release-safety observation is restart safe").
create table if not exists app_deployment_safety_observations (
  deployment_id text primary key references app_deployments(id) on delete restrict,
  app_id text not null references app_registry(id) on delete restrict,
  started_at text not null default (datetime('now')),
  checks_run integer not null default 0,
  consecutive_critical_failures integer not null default 0,
  identity_failure integer not null default 0,
  status text not null default 'observing' check (status in ('observing','passed','rollback_triggered')),
  last_checked_at text
);

-- AU-004: client_id's identity proof is an Ed25519 key pair (public_key,
-- SPKI PEM) held per principal row — the private key never touches the
-- platform, only the app backend that was issued it out-of-band. key_ref
-- stays as a human rotation label (paired with version) for the unique
-- constraint below, not a secret-store lookup key.
create table if not exists app_service_principals (
  id text primary key,
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null,
  deployment_id text not null,
  client_id text not null unique,
  key_ref text not null,
  public_key text not null default '',
  status text not null check (status in ('active','revoked')),
  valid_from text not null,
  valid_until text not null,
  version integer not null default 1,
  unique(app_id, environment, deployment_id, key_ref)
);

create table if not exists app_client_assertion_replays (
  principal_id text not null references app_service_principals(id),
  jti text not null,
  expires_at text not null,
  primary key(principal_id, jti)
);

create table if not exists app_launch_exchange_receipts (
  principal_id text not null references app_service_principals(id),
  idempotency_key text not null,
  request_hash text not null,
  launch_attempt_id text not null,
  response_json text not null,
  expires_at text not null,
  created_at text not null,
  primary key(principal_id, idempotency_key)
);

-- LA-002: one compact, temporary API authorization grant per LP-004 session.
create table if not exists app_session_grants (
  id text primary key,
  learner_session_id text not null unique references learner_sessions(id),
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null,
  deployment_id text not null,
  release_id text not null,
  app_principal_id text not null references app_service_principals(id),
  scopes_json text not null,
  api_contract_version text not null,
  grant_version integer not null default 1,
  -- SC-003 amendment (GAP-048/089): a grant starts 'provisional' — scoped
  -- only to session.usable_launch — and is atomically upgraded to 'active'
  -- with the full scope set only once confirmUsableLaunch succeeds.
  status text not null check (status in ('provisional','active','revoked','expired')),
  expires_at text not null,
  revocation_reason text,
  revoked_at text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_app_session_grants_deployment_active
  on app_session_grants(app_id,deployment_id,status);

create table if not exists app_session_grant_requests (
  principal_id text not null references app_service_principals(id),
  grant_id text not null references app_session_grants(id),
  idempotency_key text not null,
  request_hash text not null,
  response_json text not null,
  expires_at text not null,
  created_at text not null,
  primary key(principal_id,grant_id,idempotency_key)
);

create unique index if not exists idx_learner_sessions_one_reserved
  on learner_sessions(learner_id)
  where status in ('starting','active','disconnected','resumable');
create unique index if not exists idx_learner_sessions_normal_slot
  on learner_sessions(learner_id, app_id, week_key, weekly_slot_number)
  where source = 'normal';
create unique index if not exists idx_learner_sessions_credit
  on learner_sessions(replacement_credit_id)
  where replacement_credit_id is not null;

create table if not exists session_start_requests (
  actor_session_id text not null,
  learner_id text not null references learners(id),
  idempotency_key text not null,
  request_hash text not null,
  session_id text references learner_sessions(id),
  status text not null check (status in ('processing','completed','failed')),
  safe_response_json text,
  created_at text not null,
  completed_at text,
  primary key (actor_session_id, learner_id, idempotency_key)
);

create table if not exists session_replacement_credits (
  id text primary key,
  original_session_id text not null unique references learner_sessions(id),
  learner_id text not null references learners(id),
  app_id text not null,
  granted_by_admin_id text not null,
  reason_code text not null,
  evidence_summary text not null,
  granted_at text not null,
  valid_from text not null,
  expires_at text not null,
  status text not null check (status in ('available','consumed','expired','revoked')),
  consumed_session_id text unique references learner_sessions(id),
  consumed_at text
);

-- LA-004: short completion retry state and self-service technical credits.
create table if not exists session_finalization_requests (
  learner_session_id text not null references learner_sessions(id),
  app_principal_id text not null references app_service_principals(id),
  idempotency_key text not null,
  request_hash text not null,
  response_json text not null,
  expires_at text not null,
  created_at text not null,
  primary key(learner_session_id,app_principal_id,idempotency_key)
);

-- SC-003: idempotency receipts for the usable-launch confirmation that
-- atomically converts a starting/reserved session into active/consumed.
create table if not exists usable_launch_requests (
  learner_session_id text not null references learner_sessions(id),
  app_principal_id text not null references app_service_principals(id),
  idempotency_key text not null,
  request_hash text not null,
  response_json text not null,
  expires_at text not null,
  created_at text not null,
  primary key(learner_session_id,app_principal_id,idempotency_key)
);

create table if not exists learner_session_credits (
  id text primary key,
  source_learner_session_id text not null references learner_sessions(id),
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  credit_type text not null check(credit_type='technical_replacement'),
  status text not null check(status in ('available','reserved','consumed','expired','revoked')),
  confirmed_by_actor_type text not null check(confirmed_by_actor_type in ('learner','parent')),
  confirmed_by_actor_id text not null,
  confirmation_reason_code text not null check(confirmation_reason_code='technical_issue'),
  granted_at text not null,
  expires_at text not null,
  reserved_session_id text unique,
  reserved_at text,
  consumed_at text,
  revoked_at text,
  version integer not null default 1,
  created_at text not null,
  updated_at text not null,
  unique(source_learner_session_id,credit_type)
);

create table if not exists technical_credit_claim_requests (
  actor_id text not null,
  source_learner_session_id text not null references learner_sessions(id),
  idempotency_key text not null,
  request_hash text not null,
  response_json text not null,
  expires_at text not null,
  created_at text not null,
  primary key(actor_id,source_learner_session_id,idempotency_key)
);

-- AN-001: temporary pseudonymous source data. learner_daily_key is an
-- HMAC over (learner_id, activity_date) with a dedicated analytics
-- secret (business rule 6) — never the raw learner UUID. Deleted in full
-- once its date's run completes (business rule 25); nothing here is
-- meant to outlive that.
create table if not exists app_analytics_levels (
  app_id text not null references app_registry(id) on delete restrict,
  level_key text not null,
  status text not null default 'active' check (status in ('active','inactive')),
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  primary key (app_id, level_key),
  check (length(trim(level_key)) > 0 and level_key <> 'unassigned')
);

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
  current_state_json text,
  current_lesson_engaged_seconds integer not null default 0 check (current_lesson_engaged_seconds >= 0),
  current_level_engaged_seconds integer not null default 0 check (current_level_engaged_seconds >= 0),
  progress_version integer not null default 1,
  last_session_id text,
  last_checkpoint_sequence integer not null default 0,
  state_hash text,
  -- PR-003: the standard app-owned progress summary contract — current
  -- level, an efficiency star rating, an optional milestone label and the
  -- app's declared "what's next" destination — kept separate from the
  -- opaque app_state/current_state_json blob so it has a stable shape
  -- independent of any one app's own schema version.
  progress_summary_json text,
  -- PR-004: visibility/version tracking for the summary above, and the
  -- last per-learner migration receipt this row is linked to (rules 15,
  -- 17-19, 71).
  progress_summary_visibility_status text not null default 'current'
    check (progress_summary_visibility_status in ('current','stale','unavailable')),
  progress_summary_based_on_version integer,
  -- EG-004: independent summary acknowledgement metadata. Motivation
  -- remains inside the PR-003 summary JSON; it is not a second progress
  -- table or authority.
  progress_summary_version integer not null default 0,
  progress_summary_state_hash text,
  last_migration_receipt_id text references learner_progress_migration_receipts(id),
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
  completion_outcome_code text not null default 'completed',
  progress_version_after_completion integer,
  primary key (learner_id, app_id, lesson_key)
);

-- EG-001: immutable app-owned educational achievements. The platform
-- validates and aggregates these snapshots but never derives thresholds,
-- points, XP, rank, rarity, rewards, or cross-app achievement value.
create table if not exists learner_achievements (
  id text primary key,
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null check(environment in ('development','staging','production')),
  app_achievement_key text not null,
  achievement_instance_key text not null,
  achievement_contract_version text not null,
  app_achievement_model_version text not null,
  title text not null check(length(title) between 1 and 100),
  short_description text check(short_description is null or length(short_description)<=240),
  badge_asset_key text,
  category text not null check(category in
    ('milestone','mastery','level','efficiency','challenge','consistency','other')),
  earned_at text not null,
  source_progress_version integer,
  source_completion_id text,
  source_session_id text references learner_sessions(id),
  source_release_id text not null references app_releases(id) on delete restrict,
  app_key_snapshot text not null,
  app_name_snapshot text not null,
  app_icon_asset_key_snapshot text,
  record_version integer not null default 1 check(record_version>0),
  state_hash text not null,
  acknowledged_at text not null,
  revoked_at text,
  revocation_reason_code text check(revocation_reason_code is null or revocation_reason_code in
    ('app_error','duplicate_emission','invalid_source')),
  revoked_by_principal_id text references app_service_principals(id),
  created_at text not null,
  unique(learner_id,app_id,achievement_instance_key)
);
create index if not exists idx_learner_achievements_feed
  on learner_achievements(learner_id,earned_at desc,id desc);
create index if not exists idx_learner_achievements_app
  on learner_achievements(app_id,earned_at desc,id desc);

create trigger if not exists learner_achievements_earned_fields_immutable
before update on learner_achievements
when new.learner_id is not old.learner_id or new.app_id is not old.app_id
  or new.environment is not old.environment or new.app_achievement_key is not old.app_achievement_key
  or new.achievement_instance_key is not old.achievement_instance_key
  or new.achievement_contract_version is not old.achievement_contract_version
  or new.app_achievement_model_version is not old.app_achievement_model_version
  or new.title is not old.title or new.short_description is not old.short_description
  or new.badge_asset_key is not old.badge_asset_key or new.category is not old.category
  or new.earned_at is not old.earned_at or new.source_progress_version is not old.source_progress_version
  or new.source_completion_id is not old.source_completion_id or new.source_session_id is not old.source_session_id
  or new.source_release_id is not old.source_release_id or new.app_key_snapshot is not old.app_key_snapshot
  or new.app_name_snapshot is not old.app_name_snapshot
  or new.app_icon_asset_key_snapshot is not old.app_icon_asset_key_snapshot
  or new.state_hash is not old.state_hash or new.acknowledged_at is not old.acknowledged_at
begin
  select raise(abort,'achievement earned fields are immutable');
end;

create table if not exists achievement_mutation_receipts (
  id text primary key,
  app_id text not null references app_registry(id) on delete restrict,
  achievement_id text not null references learner_achievements(id),
  action text not null check(action in ('create','revoke')),
  idempotency_key text not null,
  request_hash text not null,
  response_json text not null,
  created_at text not null,
  unique(app_id,action,idempotency_key)
);
create index if not exists idx_achievement_receipts_achievement
  on achievement_mutation_receipts(achievement_id,action,created_at);

create table if not exists app_release_achievement_contracts (
  app_id text not null references app_registry(id) on delete restrict,
  release_id text not null references app_releases(id) on delete restrict,
  achievement_contract_version text not null,
  app_achievement_model_version text not null,
  allowed_badge_asset_keys_json text not null default '[]',
  validation_report_json text,
  status text not null default 'pending' check(status in ('pending','approved','blocked')),
  validated_at text,
  created_at text not null,
  updated_at text not null,
  primary key(app_id,release_id)
);
create index if not exists idx_release_achievement_contract_status
  on app_release_achievement_contracts(app_id,status,release_id);

-- EG-005 consumes this reliable, non-blocking instruction outbox later.
-- Failure to project a journey event never rolls back EG-001 authority.
create table if not exists achievement_journey_projection_outbox (
  id text primary key,
  achievement_id text not null references learner_achievements(id),
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  action text not null check(action in ('upsert','remove')),
  source_state_hash text not null,
  status text not null default 'pending' check(status in ('pending','processed','failed')),
  created_at text not null,
  processed_at text,
  unique(achievement_id,action,source_state_hash)
);
create index if not exists idx_achievement_journey_outbox_status
  on achievement_journey_projection_outbox(status,created_at,id);

-- EG-005: the learner-facing journey is a safe, read-optimized projection.
-- Authoritative lesson, achievement and progress records remain in their
-- source domains and are never exposed through these rows.
create table if not exists learner_journey_retention_state (
  learner_id text primary key references learners(id),
  state text not null check(state in ('active','inactive_retention','purged')),
  inactive_since text,
  journey_delete_after text,
  retention_generation integer not null default 1 check(retention_generation>0),
  purged_at text,
  purged_through_at text,
  state_version integer not null default 1 check(state_version>0),
  created_at text not null,
  updated_at text not null
);
create index if not exists idx_journey_retention_due
  on learner_journey_retention_state(state,journey_delete_after,learner_id);

create table if not exists learner_app_journey_events (
  journey_event_id text primary key,
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  retention_generation integer not null check(retention_generation>0),
  event_type text not null check(event_type in ('lesson_completed','achievement_earned','milestone_reached')),
  event_at text not null,
  source_domain text not null check(source_domain in ('lesson_completion','achievement','app_milestone')),
  source_id text not null,
  title_snapshot text not null check(length(title_snapshot) between 1 and 100),
  short_description_snapshot text check(short_description_snapshot is null or length(short_description_snapshot)<=240),
  icon_asset_key text,
  source_status text not null default 'active' check(source_status='active'),
  created_at text not null,
  updated_at text not null,
  unique(learner_id,app_id,source_domain,source_id)
);
create index if not exists idx_learner_app_journey_page
  on learner_app_journey_events(learner_id,app_id,retention_generation,event_at desc,journey_event_id desc);

create table if not exists journey_mutation_receipts (
  id text primary key,
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  retention_generation integer not null check(retention_generation>0),
  source_domain text not null check(source_domain in ('lesson_completion','achievement','app_milestone')),
  source_id text not null,
  action text not null check(action in ('upsert','remove')),
  idempotency_key text not null,
  request_hash text not null,
  result_status text not null check(result_status in ('created','replayed','removed','ignored_purged')),
  created_at text not null,
  completed_at text not null,
  unique(learner_id,app_id,retention_generation,source_domain,action,idempotency_key)
);
create index if not exists idx_journey_receipts_learner_generation
  on journey_mutation_receipts(learner_id,retention_generation,created_at,id);

create table if not exists lesson_journey_projection_outbox (
  id text primary key,
  completion_id text not null,
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  release_id text not null,
  lesson_key text not null,
  completed_at text not null,
  title_snapshot text not null,
  short_description_snapshot text,
  icon_asset_key text,
  source_state_hash text not null,
  status text not null default 'pending' check(status in ('pending','processed','failed')),
  created_at text not null,
  processed_at text,
  unique(learner_id,app_id,completion_id,source_state_hash)
);
create index if not exists idx_lesson_journey_outbox_status
  on lesson_journey_projection_outbox(status,created_at,id);

create table if not exists app_release_journey_contracts (
  app_id text not null references app_registry(id) on delete restrict,
  release_id text not null references app_releases(id) on delete restrict,
  journey_contract_version text not null,
  lesson_display_metadata integer not null check(lesson_display_metadata in (0,1)),
  milestone_display_metadata integer not null check(milestone_display_metadata in (0,1)),
  allowed_icon_asset_keys_json text not null default '[]',
  validation_report_json text,
  status text not null default 'pending' check(status in ('pending','approved','blocked')),
  validated_at text,
  created_at text not null,
  updated_at text not null,
  primary key(app_id,release_id)
);
create index if not exists idx_release_journey_contract_status
  on app_release_journey_contracts(app_id,status,release_id);

create table if not exists journey_retention_job_runs (
  principal_id text not null,
  run_idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  result_json text,
  created_at text not null,
  completed_at text,
  primary key(principal_id,run_idempotency_key)
);

-- LA-003 release-owned progress schema and short mutation retry receipts.
create table if not exists app_progress_schemas (
  app_id text not null references app_registry(id) on delete restrict,
  release_id text not null,
  schema_version integer not null,
  schema_json text not null,
  schema_digest text not null,
  status text not null check (status in ('active','retired')),
  created_at text not null,
  primary key(app_id,release_id,schema_version)
);

-- PR-001: a deterministic, declarative (rename/default/drop — no arbitrary
-- code) transform between two adjacent schema_versions of the same app.
-- migrateProgressState walks these one step at a time in either direction,
-- so both a forward and a rollback row are needed for a version bump to be
-- considered safe (see assertReleaseSchemaCompatibility).
create table if not exists app_progress_schema_migrations (
  id text primary key,
  app_id text not null references app_registry(id) on delete restrict,
  from_schema_version integer not null,
  to_schema_version integer not null,
  transform_json text not null,
  registered_at text not null,
  unique(app_id,from_schema_version,to_schema_version)
);

create table if not exists progress_mutation_requests (
  app_principal_id text not null references app_service_principals(id),
  grant_id text not null references app_session_grants(id),
  learner_session_id text not null references learner_sessions(id),
  idempotency_key text not null,
  operation text not null check(operation in ('checkpoint','lesson_complete','summary_write')),
  request_hash text not null,
  response_json text not null,
  expires_at text not null,
  created_at text not null,
  primary key(app_principal_id,grant_id,learner_session_id,idempotency_key)
);

-- PR-004: fail-closed progress-integrity validation, safely readable
-- continuation and controlled operations incidents. Recovery receipts
-- (PR-002) do not exist in this codebase yet — rule 16 (recovery metadata
-- agreement) is structurally unreachable and is not modeled here.

-- PR-001's own per-learner migration receipt (rules 12, 14, 15) — the
-- existing app_progress_schema_migrations table is only an app-wide
-- transform registry, not an event log of what actually happened to a
-- given learner's row.
create table if not exists learner_progress_migration_receipts (
  id text primary key,
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  release_id text not null,
  from_schema_version integer not null,
  to_schema_version integer not null,
  progress_version integer not null,
  state_hash_after text not null,
  migrated_at text not null,
  unique(learner_id,app_id,release_id,to_schema_version)
);

create table if not exists progress_integrity_incidents (
  id text primary key,
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null check (environment in ('staging','production')),
  learner_id text not null references learners(id),
  classification text not null check (classification in
    ('read_only_safe','blocked_repairable_metadata','blocked_conflict','unreadable_corrupt')),
  severity text not null check (severity in ('low','medium','high','critical')),
  status text not null default 'open' check (status in
    ('open','investigating','resolved_repaired','resolved_false_positive',
     'resolved_legacy_policy','routed_disaster_recovery')),
  issue_codes text not null default '[]',
  expected_state_hash text,
  actual_state_hash text,
  expected_progress_version integer,
  actual_progress_version integer,
  expected_schema_version integer,
  actual_schema_version integer,
  source_receipt_type text check (source_receipt_type in ('migration') or source_receipt_type is null),
  source_receipt_id text,
  release_id text,
  workflow_route text not null default 'none' check (workflow_route in ('none','release_rollback','disaster_recovery')),
  attempt_count integer not null default 0,
  version integer not null default 1,
  created_at text not null,
  updated_at text not null,
  resolved_at text
);
-- rules 59, 67: exactly one active incident per learner+app.
create unique index if not exists ux_pii_active on progress_integrity_incidents(learner_id,app_id)
  where status in ('open','investigating');

create table if not exists learner_app_progress_integrity (
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null default 'production' check (environment in ('staging','production')),
  integrity_state text not null default 'healthy' check (integrity_state in
    ('healthy','read_only_safe','blocked_repairable_metadata','blocked_conflict','unreadable_corrupt')),
  integrity_version integer not null default 0,
  canonical_state_hash text,
  validated_progress_version integer,
  validated_schema_version integer,
  last_migration_receipt_id text references learner_progress_migration_receipts(id),
  issue_codes text not null default '[]',
  mutation_blocked integer not null default 0,
  read_safe integer not null default 1,
  legacy_policy_acknowledged integer not null default 0,
  last_validated_at text,
  last_validated_source text check (last_validated_source in ('inline_read','inline_write','launch','reconcile') or last_validated_source is null),
  active_incident_id text references progress_integrity_incidents(id),
  created_at text not null default (datetime('now')),
  updated_at text not null default (datetime('now')),
  primary key (learner_id,app_id)
);

-- Append-only audit/idempotency log for every inline/launch/reconcile
-- validation (rules 6, 60-61: no raw state, ever).
create table if not exists progress_integrity_validation_receipts (
  id text primary key,
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
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
  created_at text not null
);
create unique index if not exists ux_pivr_idem on progress_integrity_validation_receipts(requester_principal_id,idempotency_key)
  where idempotency_key is not null;

create table if not exists progress_integrity_incident_actions (
  id text primary key,
  incident_id text not null references progress_integrity_incidents(id),
  action text not null check (action in
    ('revalidate','retry_safe_metadata_repair','link_matching_receipt',
     'resolve_legacy_policy','open_disaster_recovery_case','resolve_false_positive')),
  actor_admin_id text not null,
  reauthenticated_at text not null,
  expected_version integer not null,
  idempotency_key text not null,
  reason_category text,
  evidence_refs text not null default '[]',
  result text not null check (result in ('applied','rejected','no_op')),
  result_code text,
  prior_integrity_state text,
  new_integrity_state text,
  prior_incident_status text,
  new_incident_status text,
  created_at text not null,
  unique(incident_id,idempotency_key)
);

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
  created_at text not null,
  primary key (run_idempotency_key, cursor)
);

-- PR-002: original-browser pre-expiry recovery of pending meaningful
-- progress. Append-only, metadata-only per rule 45 — no raw
-- pendingState/current_state is ever persisted here.
create table if not exists progress_recovery_receipts (
  id text primary key,
  learner_session_id text not null references learner_sessions(id),
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  device_session_id text not null,
  recovery_capsule_id text not null,
  recovery_sequence integer not null,
  base_progress_version integer not null,
  base_state_hash text not null,
  new_progress_version integer,
  new_state_hash text,
  release_id text,
  deployment_id text,
  request_hash text not null,
  idempotency_key text not null,
  result text not null check (result in ('recovered','stale','rejected')),
  result_code text,
  created_at text not null,
  unique(learner_session_id,idempotency_key)
);
create index if not exists idx_prr_session_sequence on progress_recovery_receipts(learner_session_id,recovery_sequence);

-- Discrete per-attempt problem log (not a persistent per-learner-app state
-- machine like progress_integrity_incidents) — dedup is scoped to
-- (session, category).
create table if not exists progress_recovery_incidents (
  id text primary key,
  app_id text not null references app_registry(id) on delete restrict,
  learner_id text not null references learners(id),
  learner_session_id text not null references learner_sessions(id),
  release_id text,
  category text not null check (category in
    ('stale','device_mismatch','schema_migration_required','integrity_blocked','incomplete_receipt')),
  base_progress_version integer,
  base_state_hash text,
  current_progress_version integer,
  current_state_hash text,
  status text not null default 'open' check (status in ('open','resolved')),
  attempt_count integer not null default 1,
  created_at text not null,
  updated_at text not null,
  resolved_at text
);
create unique index if not exists ux_pri_active on progress_recovery_incidents(learner_session_id,category)
  where status='open';

-- EN-001: one row per applied paid-cycle event. app_ids_json is the
-- immutable purchased-app snapshot carried by the event itself (no bundle
-- catalog exists in this codebase yet to re-derive it from); product_id/
-- product_version stay merely descriptive/auditable per business rule 33.
create table if not exists entitlement_cycles (
  id text primary key,
  paid_cycle_id text not null unique,
  subscription_id text not null,
  purchaser_parent_id text not null references profiles(id),
  assigned_learner_id text not null references learners(id),
  product_id text not null,
  product_version integer not null,
  app_ids_json text not null,
  period_start text not null,
  period_end text not null,
  billing_anchor text not null,
  status text not null check(status in ('creating','ready','failed')),
  source_event_id text not null,
  source_event_version integer not null,
  source_event_hash text not null,
  created_at text not null,
  ready_at text,
  version integer not null default 1
);
create index if not exists idx_entitlement_cycles_learner on entitlement_cycles(assigned_learner_id);

-- EN-002: one materialized effective-access decision per learner/app/
-- environment, kept in sync at write time (business rule 42/43) whenever
-- EN-001 creates a period. evaluateAccessFresh() still re-checks the two
-- genuinely time-dependent facts (access_until vs. now, app_registry
-- status) live on every call rather than trusting this row unconditionally.
create table if not exists learner_app_effective_entitlements (
  id text primary key,
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null,
  state text not null check(state in
    ('active','approved_grace','inactive','inactive_refunded','suspended_financial','suspended_security','overlap_resolution')),
  allocation_source_entitlement_period_id text,
  access_until text,
  effective_version integer not null default 1,
  source_set_hash text not null,
  -- EN-003: written only by entitlement-lifecycle's applyLifecycleEvent,
  -- never by recomputeEffectiveEntitlement — a separate counter from
  -- effective_version, whose hash-bump semantics are untouched.
  scheduled_transition_at text,
  scheduled_transition_type text,
  lifecycle_version integer not null default 0,
  last_lifecycle_event_id text,
  revoked_before text,
  -- EN-004 rules 41-42, 51-52: 'repair_in_progress' blocks new sessions
  -- while a verified-but-incomplete source is being reconciled;
  -- 'quarantined' blocks them while a genuine conflict is under incident
  -- review. Neither is written by recomputeEffectiveEntitlement/
  -- applyLifecycleEvent above — only entitlement-integrity's repair/incident
  -- functions set or clear these two.
  integrity_state text not null default 'healthy'
    check(integrity_state in ('healthy','repair_in_progress','quarantined')),
  last_reconciled_source_version integer,
  last_reconciled_at text,
  created_at text not null,
  updated_at text not null,
  unique(learner_id, app_id, environment)
);

create table if not exists learner_app_effective_sources (
  effective_entitlement_id text not null references learner_app_effective_entitlements(id),
  entitlement_period_id text not null,
  role text not null check(role in ('allocation_bearing','access_supporting','overlap_suppressed')),
  valid_from text not null,
  valid_until text not null,
  primary key(effective_entitlement_id, entitlement_period_id)
);

-- EN-001: one per-app entitlement period per paid cycle (business rule 3, 34,
-- unique paid_cycle_id+app_id). effective_source_role/effective_entitlement_id
-- are populated by EN-002's selectEffectiveSourceRole before the SC-002-style
-- batch (standard_credit_batch_id) is created for allocation_bearing roles only.
create table if not exists learner_app_entitlement_periods (
  id text primary key,
  entitlement_cycle_id text not null references entitlement_cycles(id),
  subscription_id text not null,
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  product_version integer not null,
  period_start text not null,
  period_end text not null,
  status text not null default 'ready' check(status in ('ready')),
  effective_source_role text not null check(effective_source_role in
    ('allocation_bearing','access_supporting','overlap_suppressed')),
  effective_entitlement_id text references learner_app_effective_entitlements(id),
  standard_credit_batch_id text references learner_app_standard_credit_batches(id),
  created_at text not null,
  unique(entitlement_cycle_id, app_id)
);
create index if not exists idx_entitlement_periods_learner_app
  on learner_app_entitlement_periods(learner_id, app_id, period_start, period_end);

-- EN-001: idempotency receipts for apply-paid-cycle, mirroring the
-- session_finalization_requests/usable_launch_requests pattern.
create table if not exists entitlement_application_receipts (
  paid_cycle_id text not null,
  event_id text not null,
  request_hash text not null,
  result_json text not null,
  status text not null check(status in ('ready','failed','quarantined')),
  created_at text not null,
  primary key(paid_cycle_id, event_id)
);

-- EN-003 / minimal BI-005: one versioned entitlement-transition domain.
-- Cancellation (BI-004) and grace (BI-003) keep their existing lazy-lapse
-- mechanism unchanged; this ledger records every transition (old and new)
-- for audit, and is the sole writer of the terminal states already present
-- in learner_app_effective_entitlements.state's CHECK constraint above
-- (inactive_refunded, suspended_financial, suspended_security).
create table if not exists entitlement_lifecycle_events (
  id text primary key,
  source text not null check(source in
    ('billing_cancellation','billing_grace','billing_refund','billing_chargeback',
     'billing_dispute','billing_reassignment','platform_security','reconciliation')),
  event_id text not null,
  event_type text not null,
  source_version integer not null,
  effective_at text not null,
  subscription_id text,
  paid_cycle_id text,
  refund_case_id text,
  dispute_id text,
  reassignment_case_id text references subscription_reassignment_cases(id),
  learner_id text not null references learners(id),
  app_ids_json text not null,
  -- null = platform-level event (security revocation, reassignment audit)
  -- applying across every environment for this learner+app.
  environment text,
  reason_category text not null,
  policy_effect text check(policy_effect is null or policy_effect in ('terminate_now','no_change')),
  fraud_or_security_risk integer not null default 0,
  payload_hash text not null,
  status text not null default 'pending' check(status in ('pending','applied','quarantined','rejected')),
  quarantine_reason text,
  conflicting_event_id text references entitlement_lifecycle_events(id),
  received_at text not null,
  processed_at text,
  created_at text not null,
  updated_at text not null,
  unique(source, event_id)
);
create index if not exists idx_entitlement_lifecycle_events_status on entitlement_lifecycle_events(status, effective_at);
create index if not exists idx_entitlement_lifecycle_events_learner on entitlement_lifecycle_events(learner_id, created_at);
create index if not exists idx_entitlement_lifecycle_events_subscription on entitlement_lifecycle_events(subscription_id, source_version);

-- Append-only per rule 8/68, mirroring subscription_assignment_audit's
-- no-update/no-delete triggers above.
create table if not exists entitlement_state_transitions (
  id text primary key,
  effective_entitlement_id text not null references learner_app_effective_entitlements(id),
  lifecycle_event_id text not null references entitlement_lifecycle_events(id),
  previous_state text not null,
  new_state text not null,
  effective_at text not null,
  session_effect text not null check(session_effect in
    ('preserve_to_hard_expiry','cancel_starting','immediate_revoke','none')),
  reason_category text not null,
  transition_version integer not null,
  result text not null check(result in ('applied','duplicate','superseded','quarantined')),
  created_at text not null,
  unique(effective_entitlement_id, lifecycle_event_id)
);
create index if not exists idx_entitlement_state_transitions_entitlement
  on entitlement_state_transitions(effective_entitlement_id, created_at);

create trigger if not exists entitlement_state_transitions_no_update
before update on entitlement_state_transitions
begin
  select raise(abort, 'entitlement state transition history is immutable');
end;

create trigger if not exists entitlement_state_transitions_no_delete
before delete on entitlement_state_transitions
begin
  select raise(abort, 'entitlement state transition history is immutable');
end;

create table if not exists entitlement_transition_receipts (
  lifecycle_event_id text primary key references entitlement_lifecycle_events(id),
  request_hash text not null,
  idempotency_status text not null check(idempotency_status in ('processing','completed','failed')),
  result_json text,
  error_code text,
  attempt_count integer not null default 1,
  created_at text not null,
  updated_at text not null
);

-- Minimal BI-005: admin-driven refund case + provider-confirmation, modeled
-- on subscription_reassignment_cases above. No dispute-resolution workflow,
-- no new payment-gateway integration.
create table if not exists refund_cases (
  id text primary key,
  subscription_id text not null references subscriptions(id),
  refund_type text not null check(refund_type in ('full','partial')),
  amount integer,
  entitlement_effect text check(entitlement_effect is null or entitlement_effect in ('terminate_now','no_change')),
  reason_category text not null,
  status text not null default 'pending_provider_confirmation'
    check(status in ('pending_provider_confirmation','confirmed','reversed','rejected')),
  provider_refund_ref text,
  refund_confirmed_at text,
  version integer not null default 1 check(version>0),
  administrator_id text,
  created_at text not null,
  updated_at text not null,
  check((refund_type='partial')=(entitlement_effect is not null))
);
create index if not exists idx_refund_cases_subscription on refund_cases(subscription_id, status);

-- Minimal BI-005: signed chargeback/dispute webhook receipts, mirroring
-- deployment_webhook_receipts' shape.
create table if not exists financial_dispute_events (
  id text primary key,
  provider text not null,
  provider_event_id text not null,
  event_type text not null check(event_type in ('chargeback_confirmed','chargeback_reversed','dispute_opened')),
  subscription_id text not null references subscriptions(id),
  fraud_or_security_risk integer not null default 0,
  occurred_at text not null,
  payload_hash text not null,
  status text not null default 'received' check(status in ('received','processed','rejected')),
  created_at text not null,
  processed_at text,
  unique(provider, provider_event_id)
);
create index if not exists idx_financial_dispute_events_subscription on financial_dispute_events(subscription_id, created_at);

-- process-due-transitions / reconcile-lifecycle bounded-sweep job ledger,
-- same shape as billing_job_runs above, scoped to this domain rather than
-- widening that table's job_type CHECK constraint.
create table if not exists entitlement_lifecycle_job_runs (
  principal_id text not null,
  job_type text not null check(job_type in ('sweep','reconcile')),
  run_idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('running','completed','failed')),
  result_json text,
  created_at text not null,
  completed_at text,
  primary key(principal_id,job_type,run_idempotency_key)
);

-- EN-004: cross-domain integrity reconciliation. Repairs are never invented
-- directly here — every repair calls through to the same EN-001
-- (applyPaidCycle), EN-002 (recomputeEffectiveEntitlement), EN-003
-- (applyLifecycleEvent) or SC-002 (ensureEntitlementPeriodStandardAllocation)
-- domain functions normal event processing already uses. One row per source
-- record compared against its expected target, whether the result was
-- healthy/no-op, an applied repair, a deferred transient failure or an
-- opened incident (rule 8-9, 43).
create table if not exists entitlement_reconciliation_receipts (
  id text primary key,
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
  principal_id text not null,
  created_at text not null,
  updated_at text not null,
  unique(source_type, source_id, source_version, target_type)
);
create index if not exists idx_entitlement_reconciliation_receipts_source
  on entitlement_reconciliation_receipts(source_type, source_id);

-- Rule 59 dedup at the whole-page-run grain, same shape as
-- progress_integrity_sweep_runs — a retried sweep call with the same
-- runIdempotencyKey+cursor returns the cached page result instead of
-- reprocessing and double-counting (rule 6, 55).
create table if not exists entitlement_integrity_sweep_runs (
  run_idempotency_key text not null,
  cursor text not null default '',
  environment text not null,
  source_domains_json text not null default '[]',
  window_from text,
  window_to text,
  principal_id text not null,
  processed integer not null,
  healthy_count integer not null default 0,
  repaired_count integer not null default 0,
  deferred_count integer not null default 0,
  incidents_opened_count integer not null default 0,
  errors_count integer not null default 0,
  next_cursor text,
  created_at text not null,
  primary key(run_idempotency_key, cursor)
);

-- Rule 22, 31, 36, 38, 45: a narrowly-scoped operations incident queue for
-- genuine conflicts reconciliation must not silently resolve on its own —
-- mismatched identities, a ready target with no verified source, or a
-- used/mismatched batch. Safe technical identifiers and a mismatch category
-- only; no sensitive provider payload, payment instrument or progress data.
create table if not exists entitlement_integrity_incidents (
  id text primary key,
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
  assigned_operator_id text,
  attempt_count integer not null default 0,
  version integer not null default 1,
  created_at text not null,
  updated_at text not null,
  resolved_at text
);
-- Rule 22: exactly one active incident per source record under review.
create unique index if not exists ux_eii_active on entitlement_integrity_incidents(source_type, source_id)
  where status in ('open','investigating');

create table if not exists entitlement_integrity_incident_actions (
  id text primary key,
  incident_id text not null references entitlement_integrity_incidents(id),
  action text not null check(action in ('retry','resolve_false_positive','open_refund_case')),
  actor_admin_id text not null,
  reauthenticated_at text not null,
  expected_version integer not null,
  idempotency_key text not null,
  reason_category text,
  evidence_refs text not null default '[]',
  result text not null check(result in ('applied','rejected','no_op')),
  result_code text,
  prior_incident_status text,
  new_incident_status text,
  created_at text not null,
  unique(incident_id,idempotency_key)
);

-- EG-002: compact, per-app weekly consistency derived only from SC-002's
-- authoritative standard funded usable-launch count. It is display-only and
-- never participates in funding, access, progress, or achievement authority.
create table if not exists learner_app_consistency (
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null,
  current_streak_weeks integer not null default 0 check(current_streak_weeks>=0),
  longest_streak_weeks integer not null default 0 check(longest_streak_weeks>=0),
  current_week_key text not null,
  current_week_progress integer not null default 0 check(current_week_progress between 0 and 2),
  current_week_start_at text not null,
  current_week_end_at text not null,
  latest_completed_week_key text,
  last_computed_usage_version integer not null default 0,
  state_version integer not null default 1,
  state_hash text not null,
  created_at text not null,
  updated_at text not null,
  primary key(learner_id,app_id,environment)
);
create index if not exists idx_learner_app_consistency_current
  on learner_app_consistency(learner_id,environment,current_week_key,app_id);

create table if not exists learner_app_consistency_weeks (
  learner_id text not null references learners(id),
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null,
  weekly_key text not null,
  week_timezone text not null,
  weekly_start_at text not null,
  weekly_end_at text not null,
  cadence_target integer not null default 2 check(cadence_target=2),
  qualifying_standard_sessions integer not null default 0 check(qualifying_standard_sessions between 0 and 2),
  status text not null default 'open' check(status in
    ('open','cadence_complete','incomplete_reset','neutral_partial','platform_unavailable_neutral','out_of_scope')),
  entitlement_opening_state text not null check(entitlement_opening_state in
    ('eligible','approved_grace','partial_start','out_of_scope')),
  entitlement_opening_reference text,
  availability_neutral_evidence text,
  cadence_completed_by_session_id text references learner_sessions(id),
  completed_at text,
  finalized_at text,
  result_version integer not null default 1,
  result_hash text not null,
  created_at text not null,
  updated_at text not null,
  primary key(learner_id,app_id,environment,weekly_key)
);
create index if not exists idx_consistency_weeks_history
  on learner_app_consistency_weeks(learner_id,weekly_start_at desc,app_id,weekly_key);
create index if not exists idx_consistency_weeks_finalize
  on learner_app_consistency_weeks(environment,status,weekly_end_at,learner_id,app_id);

create table if not exists consistency_mutation_receipts (
  id text primary key,
  learner_id text,
  app_id text,
  environment text not null,
  weekly_key text,
  action text not null check(action in ('standard_session_committed','finalize_week','reconcile')),
  source_session_id text references learner_sessions(id),
  source_usage_version integer,
  event_id text not null,
  run_idempotency_key text,
  cursor text not null default '',
  request_hash text not null,
  status text not null default 'pending' check(status in ('pending','completed','failed')),
  result_json text,
  principal_id text not null,
  attempt_count integer not null default 0,
  created_at text not null,
  updated_at text not null,
  completed_at text,
  unique(action,event_id)
);
create index if not exists idx_consistency_receipts_pending
  on consistency_mutation_receipts(status,action,created_at,id);
create index if not exists idx_consistency_receipts_scope
  on consistency_mutation_receipts(learner_id,app_id,weekly_key,action,created_at);

-- UL-004: operational availability is independent of entitlement. Browser
-- reads are display-only; Start rechecks this authority before funding.
create table if not exists app_launch_availability (
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null check(environment in ('development','staging','production')),
  operational_state text not null default 'available'
    check(operational_state in ('available','maintenance','temporarily_unavailable','restoring','security_blocked')),
  availability_version integer not null default 1,
  reason_category text,
  safe_learner_message text,
  expected_return_at text,
  source_reference text,
  updated_by text not null default 'system',
  updated_by_type text not null default 'system' check(updated_by_type in ('system','administrator','security','deployment')),
  updated_at text not null default (datetime('now')),
  primary key(app_id,environment)
);
create index if not exists idx_app_launch_availability_state
  on app_launch_availability(environment,operational_state,app_id);

create table if not exists app_maintenance_windows (
  id text primary key,
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null check(environment in ('development','staging','production')),
  starts_at text not null,
  ends_at text not null,
  status text not null default 'scheduled' check(status in ('scheduled','cancelled','completed')),
  reason_category text not null,
  safe_learner_message text,
  window_version integer not null default 1,
  created_by text not null,
  updated_by text not null,
  created_at text not null,
  updated_at text not null,
  check(ends_at>starts_at)
);
create index if not exists idx_app_maintenance_windows_lookup
  on app_maintenance_windows(app_id,environment,status,starts_at,ends_at);

create table if not exists app_availability_mutation_receipts (
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null,
  action text not null check(action in ('schedule','update','cancel','transition')),
  window_id text,
  target_state text,
  availability_version_from integer not null,
  availability_version_to integer,
  request_hash text not null,
  idempotency_key text not null,
  status text not null check(status in ('processing','completed')),
  response_json text,
  actor_id text not null,
  created_at text not null,
  completed_at text,
  primary key(app_id,environment,idempotency_key)
);
create index if not exists idx_app_availability_receipts_time
  on app_availability_mutation_receipts(app_id,environment,action,created_at);

create table if not exists app_availability_events (
  id text primary key,
  app_id text not null references app_registry(id) on delete restrict,
  environment text not null,
  availability_version integer not null,
  event_type text not null,
  created_at text not null,
  unique(app_id,environment,availability_version)
);

-- Every newly activated app receives the authoritative production default.
-- Missing/corrupt rows still fail closed at Start.
create trigger if not exists trg_app_availability_insert_active
after insert on app_registry when new.registry_status='active'
begin
  insert or ignore into app_launch_availability(app_id,environment,updated_by,updated_by_type)
  values(new.id,'production','app-registry','system');
end;
create trigger if not exists trg_app_availability_activate
after update of registry_status on app_registry when new.registry_status='active'
begin
  insert or ignore into app_launch_availability(app_id,environment,updated_by,updated_by_type)
  values(new.id,'production','app-registry','system');
end;
insert or ignore into app_launch_availability(app_id,environment,updated_by,updated_by_type)
select id,'production','migration','system' from app_registry where registry_status='active';

-- EG-006: parent-only learning reminders are a short-lived operational
-- projection over authoritative EN/SC/EG/UL state. No learner contact or
-- permanent engagement-message history is stored.
create table if not exists parent_notification_preferences (
  parent_id text primary key references profiles(id) on delete cascade,
  learning_reminder_email_enabled integer not null default 1
    check(learning_reminder_email_enabled in (0,1)),
  version integer not null default 1 check(version>0),
  last_idempotency_key text,
  last_request_hash text,
  created_at text not null,
  updated_at text not null
);

create table if not exists learning_reminder_batches (
  id text primary key,
  parent_id text not null references profiles(id) on delete cascade,
  reminder_stage text not null check(reminder_stage in ('mid_window','final_window')),
  scheduler_run_id text not null,
  status text not null default 'evaluating'
    check(status in ('evaluating','ready','suppressed','sending','sent','failed')),
  item_count integer not null default 0 check(item_count>=0),
  template_version text not null default 'eg006-v1',
  expected_parent_identity_version text,
  idempotency_key text not null unique,
  batch_version integer not null default 1 check(batch_version>0),
  created_at text not null,
  updated_at text not null,
  sent_at text
);
create index if not exists idx_learning_reminder_batches_parent_stage
  on learning_reminder_batches(parent_id,reminder_stage,status,created_at,id);

create table if not exists learning_reminder_items (
  id text primary key,
  batch_id text not null references learning_reminder_batches(id) on delete cascade,
  parent_id text not null references profiles(id) on delete cascade,
  learner_id text not null references learners(id) on delete cascade,
  app_id text not null references app_registry(id) on delete restrict,
  weekly_key text not null,
  reminder_stage text not null check(reminder_stage in ('mid_window','final_window')),
  observed_weekly_progress integer not null check(observed_weekly_progress in (0,1)),
  remaining_normal_sessions integer not null check(remaining_normal_sessions in (1,2)),
  eligibility_version integer not null,
  eligibility_digest text not null,
  availability_note text,
  status text not null default 'candidate' check(status in ('candidate','included','suppressed')),
  suppressed_reason text,
  created_at text not null,
  updated_at text not null,
  unique(parent_id,learner_id,app_id,weekly_key,reminder_stage)
);
create index if not exists idx_learning_reminder_items_batch
  on learning_reminder_items(batch_id,status,learner_id,app_id);
create index if not exists idx_learning_reminder_items_scope
  on learning_reminder_items(parent_id,weekly_key,reminder_stage,learner_id,app_id);

create table if not exists learning_reminder_deliveries (
  id text primary key,
  batch_id text not null unique references learning_reminder_batches(id) on delete cascade,
  provider_message_id text,
  provider_status text not null default 'pending'
    check(provider_status in ('pending','accepted','delivered','uncertain','retry_pending','failed')),
  destination_identity_version text not null,
  destination_email_hash text not null,
  attempt_count integer not null default 0 check(attempt_count between 0 and 3),
  provider_idempotency_key text not null unique,
  api_idempotency_key text not null,
  request_hash text not null,
  created_at text not null,
  updated_at text not null,
  sent_at text,
  last_attempt_at text,
  unique(batch_id,api_idempotency_key)
);
create index if not exists idx_learning_reminder_deliveries_status
  on learning_reminder_deliveries(provider_status,updated_at,batch_id);

create table if not exists learning_reminder_job_runs (
  principal_id text not null,
  operation text not null check(operation in ('evaluate','reconcile')),
  run_idempotency_key text not null,
  request_hash text not null,
  status text not null check(status in ('processing','completed')),
  result_json text,
  created_at text not null,
  completed_at text,
  primary key(principal_id,operation,run_idempotency_key)
);

-- NT-001: reliable, source-owned transactional parent-email delivery.
-- Source domains (BI-002/003/004/005, IA-003) write intents inside their
-- own commit transaction; NT-001 owns everything from here onward
-- (recipient resolution, template rendering, provider send, retry/
-- reconciliation).
create table if not exists transactional_notification_intents (
  notification_id text primary key,
  parent_id text not null references profiles(id) on delete cascade,
  notification_type text not null,
  source_domain text not null,
  source_event_key text not null,
  source_version integer not null,
  template_version text not null,
  safe_variables text not null,
  semantic_hash text not null,
  idempotency_key text,
  state text not null default 'pending'
    check(state in ('pending','claimed','sent','blocked_recipient','failed','suppressed_by_policy')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  next_attempt_at text,
  created_at text not null,
  updated_at text not null,
  unique(notification_type,source_domain,source_event_key,parent_id,template_version)
);
create index if not exists idx_transactional_notification_intents_claim
  on transactional_notification_intents(state,next_attempt_at,created_at);
create index if not exists idx_transactional_notification_intents_source
  on transactional_notification_intents(source_domain,source_event_key);
-- API-NT-001 (NT1-G01): the frozen external wire contract's idempotencyKey
-- identity. Nullable/non-unique-by-default because BI-*/IA-003 call
-- enqueueTransactionalNotification() directly in-process without one, using
-- the pre-existing natural-key unique constraint above as their identity
-- (unchanged); the partial unique index below only enforces exact-once for
-- requests that actually supply an idempotencyKey (the API-NT-001 route).
create unique index if not exists idx_transactional_notification_intents_idempotency_key
  on transactional_notification_intents(idempotency_key) where idempotency_key is not null;

-- One active delivery row per notification per channel (rule 58; V1 has
-- exactly one channel, email). provider_idempotency_key is the stable key
-- handed to the email provider so retries never double-send (rule 57).
create table if not exists transactional_notification_deliveries (
  id text primary key,
  notification_id text not null references transactional_notification_intents(notification_id) on delete cascade,
  channel text not null default 'email' check(channel='email'),
  provider_message_id text,
  provider_idempotency_key text not null unique,
  state text not null default 'pending'
    check(state in ('pending','sending','accepted','delivered_when_known','temporary_failed','permanent_failed','blocked_recipient','suppressed_by_policy')),
  attempt_count integer not null default 0 check(attempt_count>=0),
  last_error_code text,
  accepted_at text,
  delivered_at text,
  last_attempt_at text,
  created_at text not null,
  updated_at text not null,
  unique(notification_id,channel)
);
create index if not exists idx_transactional_notification_deliveries_state
  on transactional_notification_deliveries(state,updated_at);
-- NT-002: parent-scoped, retention-windowed, newest-first keyset read.
create index if not exists idx_transactional_notification_intents_parent_history
  on transactional_notification_intents(parent_id, created_at desc, notification_id desc);

-- Replay guard for API-NT-003 provider webhooks, same shape as
-- deployment_webhook_receipts/financial_dispute_events.
create table if not exists notification_provider_webhook_receipts (
  id text primary key,
  provider text not null,
  provider_event_id text not null,
  received_at text not null,
  unique(provider, provider_event_id)
);
