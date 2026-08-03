# REQ-08: Baby Steps Platform Authentication & Entitlement System

**Status:** Draft — pending freeze
**Supersedes:** Original REQ-08 (ChessQuest-only auth)
**Owner:** Sri
**Depends on:** None (foundational — gates all product-app entitlement checks)

---

## 1. Objective

Build a centralized identity and entitlement system, hosted in a single Baby Steps Supabase project, that every product app (ChessQuest, Magical Math, Speed Reading, RAAS, Mind Reading, and future products) trusts for authentication and subscription access — without any product app storing its own copy of subscription state.

**Success criteria (SMART):**
- A user can sign up once on `babysteps.in` and be authenticated on any `*.babysteps.in` product subdomain without re-logging in.
- A user's subscription status, checked from any product app, always reflects the single source of truth in Baby Steps within a bounded staleness window (JWT TTL).
- Adding a new product to the platform requires zero code changes to Baby Steps — only a data insert plus a documented one-time config checklist.
- Revenue and subscriber-count reporting, sliced by product and by day/month/quarter/year, is answerable with a single query against centralized data.

---

## 2. Architecture Overview

**Centralized (Baby Steps Supabase project):**
- Identity (`auth.users`, `profiles`)
- Entitlements (`subscriptions`, `payments`)
- Product registry (`products`)
- Admin reporting dashboard

**Decentralized (each product's own Vercel + Supabase project):**
- Product-specific content and user activity data (chess games, math sessions, lesson progress, RAAS viewing history)
- A local `is_free` flag on individual content records for the free-preview gate
- No subscription/entitlement table of any kind, cached or otherwise

**Trust mechanism:** Each product app verifies JWTs signed by Baby Steps. Entitlement is carried as a claim inside the JWT, not fetched via a live API call on every request.

```
                         ┌─────────────────────────┐
                         │   babysteps.in           │
                         │   (Baby Steps app)       │
                         │                           │
                         │  Supabase project:        │
                         │  - auth.users             │
                         │  - profiles               │
                         │  - products               │
                         │  - subscriptions          │
                         │  - payments               │
                         │  - /admin dashboard       │
                         └───────────┬───────────────┘
                                     │ issues JWT
                                     │ (claims: sub, entitlements[])
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                      ▼
   chess.babysteps.in     math.babysteps.in       raas.babysteps.in
   (own Vercel+Supabase)  (own Vercel+Supabase)   (own Vercel+Supabase)
   - verifies JWT          - verifies JWT           - verifies JWT
   - own content data      - own content data       - own content data
   - is_free flag only     - is_free flag only      - is_free flag only
```

---

## 3. Schema — Baby Steps Project

### 3.1 `profiles`

One row per user. No parent/child modeling — single account shared by the whole family if needed.

```sql
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  date_of_birth date,
  class_level text,              -- optional, read by products like Magical Math
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### 3.2 `products`

The product registry. New products are rows, not code.

```sql
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
```

### 3.3 `subscriptions`

Multi-entitlement model. A user may hold multiple rows (several single-product subs) or one bundle row.

```sql
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
```

**Status semantics:**
- `active` — full access, will renew
- `cancelling` — full access until `current_period_end`, will not renew (`cancel_at_period_end = true`)
- `cancelled` — access ended, `current_period_end` has passed
- `expired` — renewal payment failed permanently
- `past_due` — renewal payment failed, in Razorpay retry window; access held during grace period

### 3.4 `payments`

One row per actual charge. Reporting is built from this table, never from `subscriptions`.

```sql
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
```

### 3.5 Entitlement check function

Single shared function; every access decision — including the JWT claims generator — calls this.

```sql
create or replace function fn_has_product_access(p_user_id uuid, p_product_slug text)
returns boolean as $$
  select exists (
    select 1
    from subscriptions s
    join products p on p.slug = p_product_slug
    where s.user_id = p_user_id
      and s.status in ('active','cancelling','past_due')
      and (
        s.type = 'bundle'
        or s.product_id = p.id
      )
      and s.current_period_end > now()
  );
$$ language sql stable security definer;
```

---

## 4. JWT Claims & Cross-Project Verification

### 4.1 Claims structure

On login/session refresh, Baby Steps issues a JWT with entitlements embedded:

```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "entitlements": {
    "bundle": false,
    "products": ["chess", "magical-math"]
  },
  "exp": 1234567890
}
```

- If `entitlements.bundle` is `true`, access to all products is implied regardless of the `products` array.
- Claims are computed at token-issue time via `fn_has_product_access`-equivalent logic (aggregate query, not per-product calls).

### 4.2 TTL and refresh

- JWT expiry: 1 hour (Supabase default access-token lifetime)
- Refresh token flow re-issues the JWT with recomputed entitlements on each refresh
- **Known tradeoff:** a subscription cancellation or expiry may take up to 1 hour to propagate to product apps. Acceptable for a subscription product; flagged explicitly so it's a conscious choice, not an oversight.

### 4.3 Cross-project verification setup (per product app)

This is the one part of onboarding a new product that is genuine configuration, not a data insert:

1. Each product's Supabase project is configured to verify JWTs using Baby Steps' JWT secret (Supabase supports external JWT verification via project settings → Auth → JWT Secret).
2. Product app's RLS policies reference `auth.jwt() -> 'entitlements'` instead of querying a local subscriptions table.
3. Product app middleware reads the shared session cookie (domain `.babysteps.in`) and forwards it to Supabase client calls.

---

## 5. Free-Preview Gating (Per Product, Local)

Not a time-based trial. A small number of lessons/missions are flagged free at the content level, in each product's own database:

```sql
alter table lessons add column is_free boolean not null default false;
```

Access resolution in every product app:

```
canAccess(lesson) = lesson.is_free
                     OR jwt.entitlements.bundle == true
                     OR product_slug in jwt.entitlements.products
```

No `trialing` subscription status exists — this keeps `subscriptions.status` free of time-based trial complexity.

---

## 6. Razorpay Integration

### 6.1 Webhook handler (single endpoint, in Baby Steps app)

Handles events for both bundle and single-product plans:
- `subscription.activated` → insert/update `subscriptions` row, `status = 'active'`
- `subscription.charged` → insert `payments` row
- `subscription.cancelled` → `status = 'cancelling'`, `cancel_at_period_end = true` (access continues until period end); a scheduled job flips to `cancelled` once `current_period_end` passes
- `subscription.halted` (payment failure exhausted retries) → `status = 'expired'`
- `payment.failed` on renewal → `status = 'past_due'`, grace period begins

Webhook handler must be idempotent (keyed on `razorpay_payment_id` / `razorpay_subscription_id`) since Razorpay retries on non-2xx responses.

### 6.2 Prorated upgrades (single → bundle)

Razorpay does not fully automate cross-plan proration. Flow:
1. Calculate unused-time credit on the current single-product subscription
2. Cancel the old Razorpay subscription
3. Create a new bundle subscription with the credit applied as a discount on the first charge
4. Update `subscriptions`: expire the old row, insert the new bundle row

This is application logic, not a Razorpay webhook side-effect — build as an explicit "upgrade" action, not inferred from webhook events.

---

## 7. Manual Override & Audit (Support Safety Net)

Since there is no local double-verification in product apps, the safety net for "webhook silently failed" lives here instead:

```sql
create table subscription_audit_log (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references subscriptions(id),
  changed_by text not null,        -- 'webhook' | 'admin:<email>' | 'system:cron'
  change_type text not null,       -- 'created' | 'status_change' | 'manual_override'
  old_status text,
  new_status text,
  note text,
  created_at timestamptz not null default now()
);
```

Admin dashboard includes a manual "grant access" action (creates a `subscriptions` row with `razorpay_subscription_id = 'manual-<uuid>'`) for cases where payment succeeded but the webhook failed.

---

## 8. Admin Reporting Dashboard

Route: `babysteps.in/admin`

**Views needed (materialized or plain SQL views, refreshed as needed):**

```sql
create view v_daily_revenue_by_product as
select
  date_trunc('day', p.paid_at) as day,
  coalesce(pr.slug, 'bundle') as product_slug,
  sum(p.amount_inr) as revenue_inr,
  count(*) as payment_count
from payments p
join subscriptions s on s.id = p.subscription_id
left join products pr on pr.id = s.product_id
group by 1, 2;
```

Equivalent views (or a single parameterized query) for week/month/quarter/year rollups via `date_trunc`.

```sql
create view v_active_subscribers_by_product as
select
  coalesce(pr.slug, 'bundle') as product_slug,
  count(*) as active_subscribers
from subscriptions s
left join products pr on pr.id = s.product_id
where s.status in ('active','cancelling')
group by 1;
```

**Dashboard features:**
- Date-range picker (day / week / month / quarter / year granularity)
- Revenue and subscriber count, filterable by product
- Growth-rate view (new subscriptions per period per product) to distinguish fast-moving products from slow ones
- Manual entitlement grant action + audit log view

---

## 9. New Product Onboarding Checklist

Target: this is the *only* work required to add a new product to the platform.

1. Insert row into `products` (slug, name, subdomain, Razorpay plan ID, price)
2. Create new Razorpay plan for the product (single-product tier)
3. Provision new Vercel project + new Supabase project for the product app
4. Configure the new Supabase project to verify JWTs using Baby Steps' JWT secret
5. Point product app middleware at the shared `.babysteps.in` session cookie
6. Add DNS + Vercel domain config for `<slug>.babysteps.in`
7. Confirm `babysteps.in` marketing/catalog page picks up the new product automatically (reads from `products` table — no code change expected)

Steps 3–6 are genuine one-time setup and should eventually be scripted (CLI or template repo) rather than done by hand each time.

---

## 10. Open Decisions Before Freeze

- [ ] Grace period duration for `past_due` status before flipping to `expired` (Razorpay default retry schedule vs. custom)
- [ ] Whether bundle subscribers count toward *each* product's "active subscriber" number in reporting, or are shown as a separate bundle count
- [ ] GST-compliant invoice generation — deferred to backlog, not blocking REQ-08
- [ ] Coupon/discount code support — deferred to backlog, not blocking REQ-08

---

## 11. Explicitly Out of Scope (Backlog)

- Trial periods (resolved: free-preview lessons replace time-based trials — see §5)
- Parent/child account separation (resolved: single shared account — see §3.1)
- Local per-product entitlement caching (resolved: JWT claims only, no local copy — see §4)
- GST invoicing
- Coupon/referral codes
- Cross-product achievement/progress signals feeding into the Mind Reading program
