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
