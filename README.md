# Baby Steps Platform

Central identity/entitlement app for `babysteps.in`, per
[REQ-08](./REQ-08-baby-steps-platform-auth.md). Next.js 14 (App Router) +
TypeScript + Tailwind.

**Current runtime mode: local SQLite + built-in session auth**, not
Supabase — see "Local dev mode vs. production" below.

## What's implemented

- Marketing landing page with a live product catalog section
  (`src/lib/products.ts`), linking to each product app's **local dev port**
  in development or its production subdomain otherwise
- Tricolor design system (`tailwind.config.ts`, `src/app/globals.css`) — see
  "Theme" below
- **IA-001 — email/password parent registration and login**: signup, login,
  logout, password reset, and required-email-verification gating before
  `/account` (or any protected route) is reachable. Dev-mode: the
  verification/reset link is shown on-page instead of emailed, since
  there's no email provider locally. See "Auth architecture (IA-001)" below
- **Admin dashboard** (`/admin`, REQ-08 §8): date-range + granularity picker,
  revenue/active-subscriber/growth stat tiles and breakdowns by product,
  manual "grant access" action, and an audit-log view — gated on a per-user
  `is_admin` flag
- SQLite schema (`src/lib/db/schema.sql`) and SQL migrations
  (`supabase/migrations/`) implementing REQ-08 §3 (profiles, products,
  subscriptions, payments, entitlement logic), §7 (audit log), and §8
  (reporting views) — kept in parallel, see below

## Local dev mode vs. production

REQ-08 specifies a single centralized **Supabase** project for auth and
entitlements. Setting that up isn't needed to develop against day to day, so
this app currently runs against a **local SQLite file** and a **built-in
JWT session** (`src/lib/auth/`, `src/lib/db/`) instead:

- `src/lib/db/*` — SQLite queries, same column names/status enums as the
  Postgres schema in `supabase/migrations/`, so porting later is a dialect
  change, not a redesign
- `src/lib/auth/session.ts` — signs a local JWT (`jose`, HS256) with the
  same `entitlements` claim shape as REQ-08 §4.1, stored in an httpOnly
  cookie. No refresh flow (unlike the real 1-hour Supabase JWT + silent
  refresh) — it's just longer-lived for dev convenience
- The `src/lib/supabase/*` client helpers and `supabase/migrations/*.sql`
  are untouched and dormant — that's the production path to switch back to

On first run, a local admin account is seeded (`ADMIN_EMAIL` /
`ADMIN_PASSWORD` in `.env.local`, printed to the console) and the SQLite
file appears at `./data/babysteps.db` (gitignored). The seeded admin is
marked email-verified at seed time (`src/lib/db/client.ts`) so it isn't
gated by IA-001's verification requirement — that's a self-serve-signup
concept, not something an out-of-band-provisioned admin needs.

## Auth architecture (IA-001)

Email/password parent registration and login (requirement IA-001) is
built behind an `AuthAdapter` interface (`src/lib/auth/auth-adapter.ts`)
so the identity provider can be swapped without touching callers — per
IA-001's own Codex build notes. `src/lib/auth/sqlite-auth-adapter.ts` is
the only implementation today; a `supabase-auth-adapter.ts` implementing
the same interface is the intended swap once a Supabase project is
provisioned (see "Applying the production migrations" below — migration
`0008` already carries the matching Postgres schema and idempotent
trigger).

Key pieces:

- `src/lib/auth/validation.ts` — shared email/password policy (12+ chars,
  upper/lower/digit), used client-side (`minLength` on new-password
  fields) and server-side (`validateSignup`)
- `src/lib/auth/sqlite-auth-adapter.ts` — signup (creates the auth user +
  parent profile atomically, one row each — AC2), login, email
  verification tokens, password reset tokens; non-enumerating by design
  (unknown email and wrong password return the same `null`)
- `src/lib/auth/parent-profile.ts` + `src/lib/db/parent-profile-store.ts`
  — `ensureParentProfile()` is the idempotent recovery path (AC5): insert
  only if missing, safe to call on every request
- `src/lib/auth/guards.ts` — `requireVerifiedParent()` does a **live**
  (not session-cached) email-verified + account-status check on every
  protected request, so a mid-session suspension or a same-session
  verification both take effect immediately, not just on next login
- `POST /v1/onboarding/ensure-parent-profile` — the recovery endpoint from
  IA-001's server contract: session-derived user ID only, rejects
  `EMAIL_NOT_VERIFIED`, never reactivates a suspended/deleted profile
- `/auth/confirm` — the local-dev counterpart of Supabase's own
  confirmation link handler; `/auth/callback` stays reserved for
  OAuth/PKCE code exchange once real Supabase is wired in
- `src/lib/auth/rate-limit.ts` — in-memory fixed-window limiter for
  signup/login/resend/reset (single-process only; swap for a shared store
  before running more than one instance)
- `src/lib/db/consent.ts` — records Terms/Privacy acceptance with a
  policy version and timestamp, independent of auth metadata

### Running the tests

```bash
npm test
```

All business logic (adapter, profile recovery, validation, rate limiter,
consent, and the signup/login form fields) is covered by Vitest — 35
tests, `tests/*.test.ts(x)`. Two things are **not** unit-tested and were
instead verified manually against a running dev server (`npm run dev`) in
a browser:

- Anything that calls `cookies()`/`redirect()` from `next/headers` /
  `next/navigation` (server actions, route handlers) — these throw
  outside Next's own request context, so `actions.ts` and the
  `/auth/confirm` and `/v1/onboarding/ensure-parent-profile` route
  handlers are deliberately thin wiring around the tested business logic
  above, not independently unit-tested
- `useFormState`/`useFormStatus` wiring (`SignupForm`, `LoginForm`, etc.)
  — the installed `react-dom@18.3.1` package doesn't export these at the
  top level outside Next's own bundler, so each form is split into a
  hook-free presentational component (`SignupFields`, `LoginFields` —
  unit-tested) and a thin wrapper (exercised manually)

Manually verified end-to-end: signup → dev-mode verification link →
`/auth/confirm` → `/account`; logout → login → wrong password (generic
error) → correct password; an unverified session redirected to
`/verify-email` and `POST /v1/onboarding/ensure-parent-profile` returning
403 `EMAIL_NOT_VERIFIED` for it; a profile suspended mid-session
redirecting to `/account-suspended` on the next request, with the
recovery endpoint confirmed *not* to reactivate it; password reset
end-to-end (old password rejected, new one works); and the seeded admin
account still logging in and reaching `/admin` (regression check for the
11-character `changeme123` password against the new 12-char policy — see
`PasswordField`'s `minLength` prop).

## Theme

Saffron (`saffron-*`), a modernized green (`green-*` — shifted from the
flag's yellow-olive `#138808` toward a fresher emerald `#10A374` so it reads
as a product accent rather than a literal flag swatch), and an Ashoka Chakra
navy (`chakra-*`) for text/dark surfaces. The three colors only appear
together in the `.tricolor-rule` accent bar (header/footer) — everywhere
else they're used individually (saffron = primary CTA, green = success/
secondary accent, navy = text and dark surfaces) so the site doesn't read as
a literal flag graphic.

## Running locally

```bash
npm install
cp .env.local.example .env.local
# generate AUTH_SECRET: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run dev
```

Or double-click **`dev.bat`** — it copies `.env.local.example` on first run
if `.env.local` is missing, opens `http://localhost:3000` in your browser,
and starts the dev server.

Log in with the seeded admin (default `admin@babysteps.in` /
`changeme123`, or whatever `.env.local` sets) to reach `/admin`.

### Other product apps' local ports

The product catalog links out to each product app's own dev server, per
[REQ-08 §2](./REQ-08-baby-steps-platform-auth.md) (each product is its own
Vercel+Supabase project). On localhost that's by port, not subdomain:

| Product | Slug | Local port |
|---|---|---|
| ChessQuest | `chess` | 3002 |
| Magical Math | `magical-math` | 8763 |
| Speed Reading | `speed-reading` | 3003 |

Note: cross-app session sharing (the shared `.babysteps.in` cookie domain
in REQ-08 §4.3) doesn't work across different `localhost` ports — different
ports are different origins. That only becomes testable once product apps
are deployed to real subdomains.

## Not yet built (see REQ-08 for spec)

- Razorpay webhook handler (§6)
- Custom access-token hook that embeds `entitlements` into the JWT — only
  relevant once ported to Supabase (§4.1)
- Cross-project JWT verification config on product apps (§4.3, §9)

## Applying the production (Supabase) migrations

Run the files in `supabase/migrations/` in order (`supabase db push` or the
SQL editor) against the Baby Steps Supabase project once it's provisioned,
and swap the auth/db code back onto `src/lib/supabase/*`.

`0008_ia001_parent_profile_status.sql` is the IA-001 migration: adds
`profile_type`/`account_status`/`onboarding_status`/`locale`/`timezone`
to `profiles`, makes the `auth.users` → `profiles` trigger idempotent
(`ON CONFLICT (id) DO NOTHING`), adds an `updated_at` trigger, and creates
`consent_acceptances`. Down-migration SQL is included as a comment block
at the end of the file (this repo's migrations have no automated
up/down runner — apply it manually to reverse).
