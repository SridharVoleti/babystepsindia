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
