-- REQ-08 §3.2 — the product registry. New products are rows, not code.

create table products (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,             -- 'chess', 'magical-math', 'speed-reading'
  name text not null,
  subdomain text not null,               -- 'chess.babysteps.in'
  razorpay_plan_id text not null,        -- single-product plan
  price_inr integer not null,
  status text not null default 'active'  -- active | coming_soon | archived
    check (status in ('active','coming_soon','archived')),
  created_at timestamptz not null default now()
);

alter table products enable row level security;

create policy "products are publicly readable"
  on products for select
  using (true);
