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
