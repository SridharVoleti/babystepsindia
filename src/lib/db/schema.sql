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
  activated_by text not null references users(id),
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
  activated_by text not null references users(id),
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
  status text not null check (status in ('starting','active','disconnected','completed','interrupted','expired','revoked_by_admin','cancelled_before_launch')),
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
  check (connected_elapsed_seconds <= maximum_connected_seconds),
  check ((source = 'normal' and weekly_slot_number is not null and replacement_credit_id is null and session_credit_id is null and standard_credit_batch_id is null)
    or (source = 'replacement' and weekly_slot_number is null and replacement_credit_id is not null and session_credit_id is null and standard_credit_batch_id is null)
    or (source = 'technical_credit' and weekly_slot_number is null and replacement_credit_id is null and session_credit_id is not null and standard_credit_batch_id is null)
    or (source = 'standard_monthly' and weekly_slot_number is null and replacement_credit_id is null and session_credit_id is null and standard_credit_batch_id is not null and weekly_session_ordinal is not null))
);

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
  admin_user_id text not null references users(id),
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
  admin_user_id text not null references users(id),
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
  created_by_admin_id text not null references users(id),
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
  where status in ('starting','active','disconnected');
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
  granted_by_admin_id text not null references users(id),
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

create table if not exists progress_mutation_requests (
  app_principal_id text not null references app_service_principals(id),
  grant_id text not null references app_session_grants(id),
  learner_session_id text not null references learner_sessions(id),
  idempotency_key text not null,
  operation text not null check(operation in ('checkpoint','lesson_complete')),
  request_hash text not null,
  response_json text not null,
  expires_at text not null,
  created_at text not null,
  primary key(app_principal_id,grant_id,learner_session_id,idempotency_key)
);

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
