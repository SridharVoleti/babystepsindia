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
