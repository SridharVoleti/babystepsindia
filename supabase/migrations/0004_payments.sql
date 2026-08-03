-- REQ-08 §3.4 — one row per actual charge. Reporting is built from this
-- table, never from `subscriptions`.

create table payments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id),
  amount_inr integer not null,
  razorpay_payment_id text unique not null,
  paid_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index idx_payments_paid_at on payments(paid_at);
create index idx_payments_subscription on payments(subscription_id);

alter table payments enable row level security;

create policy "payments are readable by owner"
  on payments for select
  using (
    exists (
      select 1 from subscriptions s
      where s.id = payments.subscription_id
        and s.user_id = auth.uid()
    )
  );

-- Written only by the (service-role) webhook handler.
