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
- **IA-002 — mandatory parent mobile number with optional display name**:
  `/onboarding` gates a verified parent behind a mandatory, format-validated
  (not SMS-verified) mobile number before `/account` is reachable, with
  optional display name and required Terms/Privacy acceptance. See "Parent
  profile onboarding (IA-002)" below
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
marked email-verified and `onboarding_status='complete'` at seed time
(`src/lib/db/client.ts`) so it isn't gated by IA-001's verification
requirement or IA-002's phone-onboarding requirement — those are
self-serve-signup concepts, not something an out-of-band-provisioned
admin needs.

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

All business logic (adapters, profile recovery, validation, rate
limiter, consent, phone normalization/masking, invoice labeling, and
form fields) is covered by Vitest — 78 tests, `tests/*.test.ts(x)`. Two
things are **not** unit-tested and were instead verified manually
against a running dev server (`npm run dev`) in a browser:

- Anything that calls `cookies()`/`redirect()` from `next/headers` /
  `next/navigation` (server actions, route handlers) — these throw
  outside Next's own request context, so `actions.ts` and every
  `route.ts` under `src/app/v1/`, `src/app/auth/confirm/` are
  deliberately thin wiring around the tested business logic above, not
  independently unit-tested
- `useFormState`/`useFormStatus` wiring (`SignupForm`, `LoginForm`, etc.)
  — the installed `react-dom@18.3.1` package doesn't export these at the
  top level outside Next's own bundler, so each form is split into a
  hook-free presentational component (`SignupFields`, `LoginFields` —
  unit-tested) and a thin wrapper (exercised manually). `ParentOnboardingForm`
  (IA-002) sidesteps this entirely — see below — and is fully unit-tested.

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

## Parent profile onboarding (IA-002)

After email verification, a parent with `onboarding_status='profile_pending'`
is routed to `/onboarding` instead of `/account` (or any other protected
route) — `guards.requireVerifiedParent()` checks this live on every
request, the same way it already checked verified-email/account-status
for IA-001. The onboarding screen itself uses the narrower
`requireOnboardingParent()` (same checks, no onboarding-status redirect,
to avoid a loop) and redirects forward to `/account` if it's revisited
after completion.

Key pieces:

- `src/lib/parent-profile/phone.ts` — `normalizePhone()` uses
  `libphonenumber-js`'s **full** (`/max`) metadata, not the default
  minimal build. The minimal build validates by length alone and treats
  numbers like `2015550123` as plausibly Indian (10 digits); full
  metadata validates against real per-country prefix ranges, which is
  what "don't rely on regex alone" actually requires in practice. Format
  validation only — no OTP, no `phone_verified_at` column, and phone is
  deliberately not unique (family members may share a number)
- `src/lib/parent-profile/invoice.ts` — `invoiceRecipientLabel()`:
  trimmed display name if present, otherwise the authenticated email
- `src/lib/parent-profile/mask.ts` — `maskPhone()` for logs/support views
  (keeps the leading `+` and last two digits)
- `src/lib/parent-profile/onboarding-validation.ts` — the shared
  server-side gate: mandatory phone, optional 1–100 char trimmed display
  name, and required *current-version* policy acceptance
  (`POLICY_VERSION_OUTDATED` if a client submits a stale version).
  Postal address/date-of-birth are simply never read from the payload —
  extra fields are ignored, not rejected
- `src/lib/db/consent.ts` — `consent_records` (replacing IA-001's
  `consent_acceptances`) has a `unique(parent_user_id, consent_type,
  policy_version)` constraint, so `recordConsent()` is a real upsert:
  repeated submissions can't create duplicate rows even without
  application-level bookkeeping
- `src/lib/db/parent-profile-repo.ts` — `completeParentOnboarding()`
  wraps the profile update and both consent writes in one
  `better-sqlite3` transaction, so a mid-write failure rolls back
  everything (tested by dropping `consent_records` mid-transaction and
  confirming the profile update didn't stick). Only ever advances
  `onboarding_status` from `profile_pending` to `learner_pending` — a
  later phone-number edit (e.g. from account settings, once that
  exists) never regresses it
- `GET`/`PATCH /v1/parent/profile` (`src/app/v1/parent/profile/route.ts`)
  — the authenticated email always comes from the session
  (`api-guard.ts`'s `requireApiParent()`), never from the request body,
  so it can't be changed through this endpoint regardless of what a
  client sends
- `src/components/onboarding/parent-onboarding-form.tsx` — deliberately
  avoids both `next/navigation`'s `useRouter` (needs Next's App Router
  context, unavailable under Vitest) and `useFormState`/`useFormStatus`
  (see above). Plain `useState` + `fetch` + a full `window.location`
  navigation to `/account` on success — which also has the side benefit
  of re-running the server-side onboarding guard fresh, rather than
  trusting a soft client-side transition. Fully unit-tested as a result,
  unlike the IA-001 forms.

The country/calling-code selector (`src/lib/parent-profile/countries.ts`)
is a curated ~8-country list, not the full ISO set — India first/default,
since that's the actual target market (`en-IN`/`Asia/Kolkata` defaults).

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
(`ON CONFLICT (id) DO NOTHING`), adds an `updated_at` trigger, and
originally created `consent_acceptances`.

`0009_ia002_parent_phone_consent.sql` is the IA-002 migration: adds
`phone_e164`/`phone_country_code` to `profiles`, and replaces
`consent_acceptances` with `consent_records` (adds the
`unique(parent_user_id, consent_type, policy_version)` constraint IA-002
requires for idempotent repeated onboarding submissions — see "Parent
profile onboarding (IA-002)" above). `consent_acceptances` was created in
0008 and never used outside this repo, so it's replaced outright rather
than carrying two consent tables forward.

Down-migration SQL for both is included as a comment block at the end of
each file (this repo's migrations have no automated up/down runner —
apply manually to reverse).
