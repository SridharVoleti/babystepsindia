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
