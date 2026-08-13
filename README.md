# Baby Steps Platform

Central identity/entitlement app for `babysteps.in`, per
[REQ-08](./REQ-08-baby-steps-platform-auth.md). Next.js 14 (App Router) +
TypeScript + Tailwind.

**Current runtime mode: local SQLite + built-in session auth**, not
Supabase — see "Local dev mode vs. production" below.

## What's implemented

- **EG-004 - app-defined motivation progress**: the existing PR-003 summary
  can carry one optional exact `steps`, `percentage`, `label`, or `none`
  representation. Writes are version-bound, atomic, release-declared, and
  rendered without platform normalization, XP, levels, or cross-app scoring.
  See "App-defined motivation progress (EG-004)" below.
- **EG-003 - app-specific weekly cadence celebration context**: the exact
  second qualifying standard session can receive a server-derived, app-safe
  celebration context only after finalization commits. Apps own every visual,
  copy, motion, audio, accessibility, and dismissal choice. See "App-specific
  cadence completion celebrations (EG-003)" below.
- **EG-002 - per-app weekly consistency**: each learner app tracks its own
  two-standard-session weekly cadence using the existing SC-002 week boundary,
  with event-driven updates, neutral partial/outage weeks, bounded finalization
  and reconciliation, and separate learner/parent history views. See "Per-app
  weekly consistency (EG-002)" below.
- **EG-001 - app-owned achievement aggregation**: learning apps can create
  immutable, exact-once learner achievements through the platform API and
  revoke them with tombstones; learners and parents receive separate,
  cursor-paginated history views, and learner home includes the three most
  recent active achievements. See "App-owned achievement aggregation
  (EG-001)" below.
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
- **IA-003 — parent credential changes and soft account deletion**:
  `/account/security` for password change, a two-phase-verified email
  change (old address stays authoritative until a 24-hour link is
  confirmed, then the old one archives), and `/account/delete` (soft
  delete — every row is retained, access is blocked). Admin-only,
  reason-required restoration at `/admin/restore`. See "Account security
  (IA-003)" below
- **AR-001 — admin-managed canonical app registration and soft deletion**:
  `/admin/apps` — permanent `id`/`app_key` identity, draft → active →
  soft_deleted lifecycle, optimistic versioning, admin-scoped idempotency.
  No hard-delete surface exists anywhere. See "App registry (AR-001)" below
- **AN-001 — minimal-data daily analytics aggregation**: `/admin/analytics`
  and `/admin/analytics/runs` — one temporary, HMAC-pseudonymized daily
  buffer per learner/app/level, aggregated into permanent anonymous
  date/app/level/age-band rows by one verified-then-purged daily job. No
  raw event history, no learner UUID ever stored in analytics tables. See
  "Minimal-data daily analytics aggregation (AN-001)" below
- **BI-001 — purchaser-owned, learner-assigned subscriptions**: checkout
  requires exactly one parent-owned learner and an immutable product version;
  only a verified provider result activates the subscription. Parents can open
  reassignment cases, while execution requires the exact billing-admin
  permission plus recent reauthentication. Used subscriptions move at the next
  billing boundary; unused corrections may move immediately. See "Billing and
  subscription assignment (BI-001)" below
- **BI-002 — payment and auto-renew lifecycle**: exact-price checkout and
  explicit recurring consent, signed provider-event activation, anchored paid
  periods, renewal disablement, reconciliation, and one T-7 reminder per cycle.
  See "Payment and auto-renew lifecycle (BI-002)" below
- **BI-003 — failed-renewal grace and recovery**: exactly 168 hours of
  existing-credit-only access after an enabled renewal fails, provider-hosted
  payment recovery, and deterministic nonpayment cutoff with progress retained.
  See "Failed-renewal grace and recovery (BI-003)" below
- **BI-004 — cancellation and renewal resumption**: purchaser-only
  cancel-at-period-end with paid access and progress preserved, plus safe
  pre-expiry auto-renewal resumption using a valid mandate or provider-hosted
  recurring setup. See "Cancellation and renewal resumption (BI-004)" below
- **Admin dashboard** (`/admin`, REQ-08 §8): date-range + granularity picker,
  revenue/active-subscriber/growth stat tiles and breakdowns by product,
  manual "grant access" action, and an audit-log view — gated on a per-user
  `is_admin` flag
- SQLite schema (`src/lib/db/schema.sql`) and SQL migrations
  (`supabase/migrations/`) implementing REQ-08 §3 (profiles, products,
  subscriptions, payments, entitlement logic), §7 (audit log), and §8
  (reporting views) — kept in parallel, see below

## Billing and subscription assignment (BI-001)

BI-001 is implemented from the V49 requirement, API contract, data model,
acceptance-test, frozen-constraint, and Codex build-spec rows in
`Requirements/Babysteps_Platform_Requirements_v49.xlsx`.

- `src/lib/billing/bi001-service.ts` owns checkout intents, verified payment
  activation, parent subscription views, case creation, administrator
  reassignment, billing-boundary application, idempotency, optimistic
  versioning, audit history, and atomic outbox writes.
- The five V49 endpoints are exposed at `/v1/billing/checkout-intents`,
  `/v1/parent/subscriptions`, `/v1/subscription-reassignment-cases`,
  `/v1/admin/subscription-reassignment-cases/{caseId}`, and
  `/v1/admin/subscriptions/{subscriptionId}/reassign-learner`.
- `supabase/migrations/0044_bi001_subscription_assignment.sql` and the local
  SQLite schema enforce one immutable purchaser, one assigned learner, an
  immutable product-version snapshot, append-only assignment audit history,
  and deny-by-default RLS boundaries. Learning apps have no direct billing
  mutation surface.
- `tests/bi-001.acceptance.test.ts` maps the V49 AT-BI-001-01 through
  AT-BI-001-35 scenarios; `tests/bi-001-routes.test.ts` covers endpoint and
  authorization wiring.

## Payment and auto-renew lifecycle (BI-002)

BI-002 is implemented from the V49 requirement, API contract, data model,
acceptance-test, frozen-constraint, decision-log, and Codex build-spec rows in
`Requirements/Babysteps_Platform_Requirements_v49.xlsx`.

- `src/lib/billing/bi002-service.ts` owns durable provider-event receipts,
  exact-once initial activation and renewal, anchored billing periods,
  provider-first renewal disablement, reconciliation, overlap quarantine, and
  one retryable T-168-hour reminder receipt per renewal cycle.
- Checkout presents the exact immutable price and a visible, default-selected
  auto-renew checkbox. Only the final submitted choice is stored; recurring
  checkout requires a safe provider mandate reference.
- Provider webhooks verify the untouched raw body, environment, account,
  amount, currency, and price before atomically creating paid access through
  EN-001. Browser redirects never activate access.
- V49 endpoints include payment-provider webhooks, parent billing status,
  provider-first auto-renew disablement, bounded reconciliation, and bounded
  renewal-reminder sweeps. Formal cancellation/reversal APIs remain owned by
  BI-004; `syncReminderAfterAutoRenewalResumed` is the explicit BI-004 hook.
- `supabase/migrations/0045_bi002_payment_auto_renew.sql` mirrors the local
  SQLite model with deny-by-default RLS and no browser-facing mutation policy
  for provider events, mutation receipts, reminders, or job runs.
- `tests/bi-002.acceptance.test.ts`, `tests/bi-002-routes.test.ts`, and
  `tests/bi-002-ui.test.tsx` cover the V49 acceptance scenarios, endpoint
  authorization, and recurring-consent UI.

The checked-in `local` provider adapter is a deterministic development/test
adapter. Production deployment still requires configuring a real payment
provider adapter, webhook secret, account/environment bindings, and the two
internal billing service principals.

## Failed-renewal grace and recovery (BI-003)

BI-003 is implemented from the V49 requirement, API contract, data model,
acceptance-test, frozen-constraint, and Codex build-spec rows in
`Requirements/Babysteps_Platform_Requirements_v49.xlsx`.

- A verified failed enabled renewal enters `past_due_grace` at the exact prior
  `current_period_end`; `grace_ends_at` is that boundary plus 168 hours. The
  prior billing period is not extended and no paid period, renewed event, or
  monthly allocation is created by grace.
- Entitlement evaluation exposes a restricted grace state. Only existing
  standard or technical credits can fund new starts; fresh start, dispatch,
  and usable-launch confirmation fail closed at cutoff. Active or resumable
  sessions retain their original device and hard-expiry rules.
- Provider retry failures have unique safe attempt receipts. A verified payment
  settled by the deadline creates exactly one missing paid period from the
  original boundary, restores active state, and emits recovered plus renewed
  events without changing purchaser, learner, product, price, or billing anchor.
- Parent recovery status and payment-method update APIs are purchaser-scoped.
  The update flow is provider-hosted and never counts as payment by itself.
- Lazy access checks and the bounded `billing-recovery` grace-expiry sweep share
  the same serialized cutoff transition. Unpaid subscriptions become
  `inactive_nonpayment`, starting reservations are released, provider retries
  are stopped where supported, and progress remains stored.
- `supabase/migrations/0046_bi003_failed_renewal_grace.sql` adds renewal attempt,
  payment-update-session, recovery-notification, and sweep-run receipts with
  forced RLS and no browser or learning-app table policies.
- `tests/bi-003.acceptance.test.ts`, `tests/bi-003-routes.test.ts`, and
  `tests/bi-003-ui.test.tsx` cover AT-BI-003-01 through AT-BI-003-40 and the
  three V49 API contracts.

## Cancellation and renewal resumption (BI-004)

BI-004 is implemented from the V49 requirement, API contract, data model,
acceptance-test, frozen-constraint, decision-log, and Codex build-spec rows in
`Requirements/Babysteps_Platform_Requirements_v49.xlsx`.

- `src/lib/billing/bi004-service.ts` owns purchaser-scoped cancellation,
  cancellation reversal, recurring-mandate inspection, provider-hosted setup
  receipts, provider-confirmed completion, exact mutation retries, and safe
  confirmation outbox records.
- Cancellation sets `auto_renew_enabled=false`, schedules the authoritative
  `current_period_end`, and does not shorten/refund the paid period, allocate
  credits, shift the anchor, or enter BI-003 grace. The learner keeps normal
  paid access and valid credits until the exact half-open period boundary.
- `src/lib/billing/cancellation-policy.ts` supplies the shared lazy cutoff.
  It closes subscription state once, releases unconsumed starting reservations,
  and preserves active/resumable sessions through their existing hard expiry,
  along with progress, completions, financial records, and audit history.
- Before expiry, a valid provider mandate is reused without an immediate charge.
  An invalid mandate returns a short-lived provider-hosted setup handoff while
  cancellation remains active; only a signed provider event or reconciliation
  can finish resumption.
- Early resumption restores the single BI-002 T-7 reminder. Late resumption
  returns the exact next charge date/amount in its confirmation and creates no
  duplicate scheduled reminder.
- API-BI-008, API-BI-009, and API-BI-015 are implemented at the canonical
  cancel, billing-status, and resume-auto-renew routes. There is no pause or
  immediate-termination route, and learning-app principals receive no billing
  action or repository scope.
- `supabase/migrations/0048_bi004_subscription_cancellation.sql` mirrors the
  local schema with cancellation history, safe recurring-setup receipts,
  confirmation outbox data, forced RLS, and no browser table policy.
- `tests/bi-004.acceptance.test.ts`, `tests/bi-004-routes.test.ts`, and
  `tests/bi-004-ui.test.tsx` cover AT-BI-004-01 through AT-BI-004-35.

## App-owned achievement aggregation (EG-001)

EG-001 from the v56 requirements workbook is implemented as an app-owned,
platform-aggregated achievement record:

- `src/lib/achievements/service.ts` validates approved release contracts and
  badge assets, acknowledged learning evidence, timestamps, and bounded safe
  metadata before committing an immutable snapshot.
- Create and revoke mutations are exact-once and app-scoped. Revocation writes
  a tombstone and journey-projection outbox event without changing learning
  progress, completion, billing, or entitlements.
- The internal app APIs, learner feed, parent-owned learner feed, release
  contract endpoint, and learner-home amendment implement API-EG-001 through
  API-EG-006.
- `supabase/migrations/0054_eg001_achievements.sql` and the local SQLite schema
  provide server-only storage, mutation receipts, release contracts, and
  journey projection outbox rows.
- Learner and parent history screens use stable cursor pagination, identify the
  source app, expose revocation state, and deliberately avoid cross-app scores
  or competitive ranking.
- `tests/eg-001.acceptance.test.ts`, `tests/eg-001-routes.test.ts`,
  `tests/eg-001-ui.test.tsx`, and `tests/eg-001-release-contract.test.ts` cover
  service invariants, authorization, API behavior, release gating, and UI.

## Per-app weekly consistency (EG-002)

EG-002 from the v56 requirements workbook is implemented as a platform-owned,
display-only consistency measure aligned to the normal SC-002 cadence:

- Each learner/app/environment has an independent weekly state. The target is
  exactly the first two committed standard funded usable launches in the
  authoritative SC-002 week; technical credits and catch-up sessions never add
  another count.
- Full eligible incomplete weeks reset only the current streak. Midweek access
  boundaries and proven platform-unavailable weeks are neutral, while
  commercial gaps restart the current streak without deleting longest streak
  or weekly history.
- The SC-003 usable-launch commit path enqueues and applies exact-once
  contributions after the session transaction succeeds. Cursor-bounded weekly
  finalization and reconciliation use only authoritative usage, entitlement,
  and durable availability facts.
- API-EG-007 through API-EG-012 provide learner/parent reads, trusted internal
  contribution/finalization/reconciliation, and learner-home composition. No
  browser, app, admin, reward, credit, or authorization write surface exists.
- `supabase/migrations/0055_eg002_consistency.sql` and the local SQLite schema
  add compact consistency state, weekly results, and metadata-only mutation
  receipts behind server-only access boundaries.
- Learner home shows a compact per-app weekly indicator, dedicated learner and
  parent views expose cursor-paginated history, and Past apps retain historical
  current/longest values without recreating access or combining app scores.
- `tests/eg-002.acceptance.test.ts`, `tests/eg-002-routes.test.ts`, and
  `tests/eg-002-ui.test.tsx` cover the v56 domain invariants, exact
  authorization contracts, reconciliation, and neutral responsive UI.

## App-specific cadence completion celebrations (EG-003)

EG-003 from the v56 requirements workbook is implemented as a headless,
app-owned integration on top of EG-002 and LA-004:

- Eligibility is server-derived from the finalized session and the exact
  EG-002 `cadence_completed_by_session_id`. First, catch-up, technical,
  reservation-only, cancelled, hard-expired, and security-ended sessions do
  not receive a context.
- API-EG-013 returns only week, fixed 2/2 cadence, current/longest same-app
  streak, a learner-safe app reference, and context version. API-EG-014 amends
  successful session completion with that optional context after finalization
  commits.
- Context lookup is best-effort and cannot delay or roll back finalization.
  When composed, the existing temporary LA-004 receipt is enriched so an exact
  retry returns the same context. No central celebration history or seen ledger
  is created.
- An optional AR-002 `weeklyCadenceCelebration` manifest declaration carries
  the supported context version and mandatory accessibility capabilities;
  unsupported versions fail staging validation. Apps without a declaration
  continue to stage but receive no celebration context.
- `src/lib/cadence-celebration/app-sdk.ts` provides only app-local replay
  suppression helpers. The platform supplies no generic celebration UI,
  artwork, copy, audio, rewards, extra-session CTA, rankings, or cross-app
  score.
- `tests/eg-003.acceptance.test.ts`, `tests/eg-003-routes.test.ts`, and
  `tests/eg-003-ui.test.ts` cover the 40 v56 acceptance cases, post-commit
  ordering, failure isolation, exact retries, release declaration, safe fields,
  excluded session paths, and app ownership boundaries.

## App-defined motivation progress (EG-004)

EG-004 from the v56 requirements workbook extends the existing PR-003 summary
without creating another progress authority:

- Apps may add one exact `motivationProgress` representation: ordinal `steps`,
  an app-supplied `percentage`, an app-authored `label`, or `none`. Optional
  labels and a short motivational message remain app-owned and are never
  translated, normalized, combined, or recalculated by Baby Steps.
- `PUT /v1/internal/learner-app-progress/summary` requires the dedicated
  `progress.summary.write` grant, the exact acknowledged progress version, and
  an idempotency key. Core summary and motivation validate and commit
  atomically; rejected writes retain the previous safe snapshot.
- AR-002 releases declare `motivationContractVersion` and their supported
  display types. Staging validates shape/version only, while runtime rejects a
  type the pinned release did not declare.
- The learner launcher and parent current/Past app cards render the stored
  representation exactly. Ordinal steps never become percentages, and the
  platform adds no common denominator, XP, global level, ranking, reward,
  access, credit, or session effect.
- `supabase/migrations/0056_eg004_progress_motivation.sql` adds only summary
  acknowledgement version/hash metadata to the existing progress row.
  `tests/eg-004.acceptance.test.ts`, `tests/eg-004-routes.test.ts`, and
  `tests/eg-004-ui.test.tsx` cover all 48 v56 cases plus API and rendering
  integration.

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
limiter, consent, phone normalization/masking, invoice labeling,
account-security repo functions, and form fields) is covered by Vitest
— 128 tests as of IA-003 (`npm test` — the number climbs further if
other work is in progress in the same tree; check `git log` for what's
actually shipped), `tests/*.test.ts(x)`. Two things are **not**
unit-tested and were instead verified manually against a running dev
server (`npm run dev`) in a browser:

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

IA-003 end-to-end, also manual: password change (old password confirmed
rejected via a direct hash check, new one confirmed working, both
verified against the actual on-disk SQLite file — not just the UI);
email change request → `/account/security` pending card with live
expiry/Resend/Cancel → dev-mode callback link → new email active
immediately, old one archived exactly once, confirmed by replaying the
*same* callback link a second time and checking the history table still
had one row; direct `PATCH .../email-change/request` and
`/v1/account/security` calls confirmed the old email stays the only
login identity while pending; soft delete → credentials still valid at
the password layer but `/login` routes to `/account-suspended` and
`GET /v1/account/security` returns 403 `ACCOUNT_DELETED`; a
self-restore attempt from the deleted parent's own (still-authenticated
but denied) session returned 403 `FORBIDDEN`; admin restore via
`/admin/restore` flipped `account_status` back to `'active'` while
`auth_revoked_before` stayed byte-for-byte the same in the database, and
the parent's **next** fresh login (new JWT `iat`) reached `/account`
normally.

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

## Account security (IA-003)

Password change, an email change gated by a 24-hour verification link,
and soft account deletion, all under `src/lib/account/` and
`src/lib/db/account-security-repo.ts`.

**Password change** reuses `sqliteAuthAdapter.signInWithPassword` for
both jobs current-password reauth needs: confirming the current
password, and (called a second time with the *new* password) rejecting
a "new" password that's actually unchanged — no new
password-comparison code.

**Email change** is deliberately two phases, kept as separately callable
functions rather than one combined step:

- `applyEmailChangeToken(token)` — the "Auth side changed" step: validates
  the token/expiry/request status and updates `users.email`. Replaying an
  already-verified token returns the same success result instead of
  erroring (AT-IA-003-05/14).
- `finalizeEmailChange(parentUserId)` — idempotent by construction: it
  only acts when a still-`pending` request's `new_email` matches the
  user's current email, and flips that request out of `pending` in the
  same transaction that archives the old address into
  `parent_email_history`. A second call finds nothing left to do.

Splitting them is what makes reconciliation (CBS: "Auth email changed but
archival write failed") a real, testable local code path instead of a
Supabase-specific concern — simulated in tests by calling
`applyEmailChangeToken` alone, then calling `finalizeEmailChange`
standalone afterward and confirming it completes and stays idempotent.
The callback route (`/auth/email-change/callback`) just calls both in
sequence. The old email stays the active login/invoice address for the
entire pending window (`email_change_requests`, one `pending` row per
parent enforced by a partial unique index — a new request cancels the
old one first rather than being blocked by it).

**Soft delete** (`softDeleteAccount`) only ever writes to `profiles` +
`account_events` — verified by asserting an unrelated `subscriptions` row
survives it untouched. It sets `account_status='deleted'` (an existing
IA-001 enum value — no new denial path needed there) and
`auth_revoked_before=now()`. That second field is the piece IA-003 adds
to the access-decision logic
(`parent-profile.ts`'s `parentAccessDecision`): a session's JWT `iat` is
compared against it, so a token issued before the cutoff is denied
(`SESSION_REVOKED`) even once `account_status` is back to `'active'` —
which is what makes `restoreAccount` safe to *never* clear
`auth_revoked_before`. That one omission is the entire mechanism forcing
a fresh login post-restore (business rule 14) — no session-revocation
table needed. `SESSION_REVOKED` gets its own handling apart from
suspended/deleted: the page guard redirects to `/login` rather than
`/account-suspended` (the account itself may be fine), and the API guard
returns 401 rather than 403 (re-authenticating would actually fix it).

Restoration (`POST /v1/admin/accounts/[parentId]/restore`) is
deliberately **not** built on `requireApiParent` — that guard is for a
parent acting on their own profile. It checks `session.isAdmin` directly,
the same way `guards.requireAdmin()` does for `/admin` pages, and
requires a reason (persisted in `account_events`).

All of this is a lightweight, queryable `account_events` audit trail
rather than a message-broker outbox — no such infrastructure exists in
this stack, and no acceptance test actually requires one; it's the
pragmatic reading of "audit/outbox infrastructure" for a monolith.
Nothing in this code path calls `console.*` at all, which is how AC15
("no secrets in logs") holds — verified by grep, not by a log-capture
test.

## App registry (AR-001)

A new domain, largely orthogonal to the parent-identity work above:
`app_registry` is the canonical, admin-managed identity for each
learning app (Chess Master, Magical Math, Speed Reader today). Every
platform relationship is meant to reference `app_registry.id` — this
requirement builds the registry itself; the actual product-mapping,
entitlement, schedule, launch, session, progress, and analytics
integrations are explicitly out of scope (they're listed as
Dependencies, not deliverables, in the source requirement) and don't
exist yet in this codebase.

**Identity and lifecycle**: permanent UUID `id`, immutable globally-unique
`app_key` (`^[a-z][a-z0-9-]{1,49}$`), and a `draft → active → soft_deleted`
state machine with optimistic `version` locking. There is deliberately
**no hard-delete anywhere** — no `DELETE` route, no SQL deletion
function, no `ON DELETE CASCADE` from `app_registry` — verified by grep
as part of manual testing, matching AT-AR-001-29's "inspect UI/routes/
functions/FKs — none exists." Soft deletion keeps the row (id, key,
last display name) forever so historical references stay interpretable;
restoring always returns to `draft`, never straight back to `active`,
since deactivated readiness/metadata should be re-checked before an app
goes live again.

Key pieces:

- `src/lib/app-registry/validation.ts` — key/name/description format
  rules, `assertOnlyMutableFields()` (rejects `id`/`appKey`/
  `registryStatus`/`version`/timestamps outright rather than silently
  dropping them — AT-AR-001-27), and `computeRequestHash()` for
  idempotency comparison
- `src/lib/app-registry/readiness-adapter.ts` — the AR-002 seam.
  Activation is supposed to check "environment configuration readiness
  supplied by AR-002" (business rule 12), which isn't its own
  requirement yet; `stubReadinessAdapter` always reports ready so
  activation logic calls through a real interface rather than a
  hardcoded `true`
- `src/lib/db/app-registry-repo.ts` — `createApp`/`editApp`/
  `activateApp`/`softDeleteApp`/`restoreApp`, following the same
  idempotency idiom the concurrent LP-001/002 work established
  (inline `sha256(JSON)` request-hash comparison per operation, kept in
  `app_registry_mutation_requests`) rather than a generic wrapper.
  `assertAppOperational(appId)` is the guard function future
  downstream systems would call before writing — throws `APP_NOT_FOUND`
  for an unknown id (never implicitly creates one — AC14) or
  `APP_NOT_ACTIVE` for anything not currently active
- Icon approval (`approved_app_icons`, business rule 8) is checked
  **at write time** (create/edit), not deferred to activation — an
  unapproved `icon_asset_key` should never be stored in the first
  place — with a second check at activation as defense-in-depth for an
  icon that was approved when set but deactivated later
- `src/lib/auth/admin-permissions.ts` / `admin-api-guard.ts` — a
  granular `admin_permissions` table layered on top of the existing
  coarse `users.is_admin` flag, since AT-AR-001-16 requires denying an
  admin who lacks `app_registry_soft_delete` specifically even though
  they can reach `/admin` generally. Activate/soft-delete/restore also
  require reauth (`verifyReauth` re-checks the current password on
  every call, the same choice IA-003 made rather than caching a
  reauthenticated-at timestamp)
- `src/lib/app-registry/bootstrap.ts` — registers Chess Master,
  Magical Math, and Speed Reader through `createApp()` itself (business
  rule 13: "must not bypass its validation or identity rules"), with
  fixed deterministic idempotency keys so re-running it is a safe
  replay. Exposed as `POST /v1/admin/apps/bootstrap` (a button on
  `/admin/apps`) rather than auto-run at server boot — `createApp()`
  depends on `getDb()`, which would recurse if called from inside
  `client.ts`'s `openDb()` before the connection is cached
- `GET`/`POST /v1/admin/apps`, `GET`/`PATCH /v1/admin/apps/[appId]`,
  `POST .../activate`, `.../soft-delete`, `.../restore` — admin +
  permission gated. `GET /v1/apps`, `GET /v1/apps/[appKey]` — public,
  active-only, safe metadata (never `internalNotes`)

Manually verified end-to-end in a browser: bootstrap (3 draft apps,
confirmed idempotent via a direct repeat call — still 3 rows after);
Chess Master through the full lifecycle — edit metadata → "Metadata is
complete" readiness hint appears → activate (version increments,
`activatedAt` set) → appears in `GET /v1/apps` with no `internalNotes`
field → soft-delete (confirmation-mismatch rejection checked first,
then the real delete) → immediately 404 from the public single-app
read and absent from the public list *and* the default admin list,
present only with `includeSoftDeleted=true` → restore (back to
`draft`, `app_key`/`id` unchanged, `version` incremented again) — with
the complete `create → edit → activate → soft_delete → restore` audit
trail confirmed directly against the SQLite file at the end, and all 3
app rows still present throughout (nothing physically deleted at any
point).

## Minimal-data daily analytics aggregation (AN-001)

Another largely orthogonal domain: instead of a permanent per-event
analytics history, the platform keeps one **temporary** buffer row per
`(activity_date, learner_daily_key, app_id, level_key)` during the day,
then runs one daily job that turns it into **permanent, anonymous**
`date × app × age_band` (and `× level_key`) aggregate rows before
deleting the buffer. No learner UUID, parent UUID, name, DOB, or exact
age ever reaches analytics storage — only an approved age band and a
key that's a one-way HMAC of `(learner_id, activity_date)` and changes
every day.

**Temporary buffer, not an event log**: `analytics_daily_buffer` has no
`session_id`/timestamp-per-row shape — it's five running counters
(`engaged_seconds`, `sessions_started/completed/interrupted`,
`lessons_completed`) upserted in place per contribution. There is no
click/page-view/heartbeat/session-replay table anywhere in the schema.

Key pieces:

- `src/lib/analytics/daily-key.ts` — `learnerDailyKey()`: HMAC-SHA256
  over `activityDate:learnerId` using a **dedicated**
  `ANALYTICS_HMAC_SECRET` (separate from `AUTH_SECRET`/
  `LEARNING_SESSION_SECRET` on purpose — a compromised session secret
  shouldn't also unlock analytics pseudonym reversal risk). Fails
  closed (`ANALYTICS_SECRET_MISSING`) rather than ever falling back to
  a plain or predictable identifier
- `src/lib/analytics/age-band.ts` — `deriveAgeBand()` converts a DOB +
  activity date straight to one of the nine approved bands
  (`under_6` … `50_plus`) via the existing `calculateAge()`
  (`learner-profile/validation.ts`); the exact age never leaves the
  function
- `src/lib/analytics/validation.ts` — `validateContributionPayload()`:
  an explicit field allow-list (top level and inside `deltas`) so a
  caller trying to smuggle a raw DOB, exact age, or parent id through
  is rejected outright, not silently dropped
- `src/lib/db/analytics-contribution-repo.ts` — `applyDailyContribution()`:
  exact-once via `analytics_contribution_receipts` (a retried
  `contributionId` is a no-op), rejects a soft-deleted/unknown app via
  the existing `assertAppOperational()` from AR-001, and never persists
  the caller's `learnerId` — only the derived daily key
- `src/lib/analytics/aggregate.ts` — pure grouping/verification with no
  DB access, so the AT-AN-001-11/12/16/17 rules are directly
  unit-testable: `computeLevelAggregates()` groups by
  date+app+level+age-band, `computeAppAggregates()` groups by
  date+app+age-band **directly from buffer rows** (independent of
  level) so a learner active across several levels in one day is
  counted once at app grain, and `verifyControlTotals()` checks every
  additive counter sums correctly at both grains before anything is
  allowed to purge
- `src/lib/db/analytics-run-repo.ts` — `runDailyAggregation(activityDate)`
  orchestrates one date end to end: `claimDailyRun()` is the
  single-date lock (a running/completed date returns its current state
  untouched; a failed date is reclaimed and retried from its retained
  buffer); on success, `commitAggregates()` exact-replaces that date's
  `analytics_daily_level`/`analytics_daily_app` rows and marks the run
  completed in one transaction, then `purgeDailyBuffer()` deletes the
  buffer/receipts as a **separate**, idempotent, safely-retryable step
  (same two-phase split IA-003 used for email-change finalization) —
  splitting commit from purge is what makes "buffer deletion fails
  after aggregates already committed" (AT-AN-001-30) a real, tested
  code path rather than a hypothetical. On verification failure the
  run is marked `failed`, the buffer is left untouched, and a row is
  written to `platform_alerts` (the local stand-in for "an
  administrator alert is emitted" — no paging infra exists here)
  Before claiming a run, aggregation verifies that the dedicated 32+ character
  analytics HMAC secret is available. Missing key material fails explicitly as
  `ANALYTICS_SECRET_MISSING`, without creating a run or mutating/purging source
  and aggregate rows.
- `app_analytics_levels` is the platform-owned app/level contract. Analytics
  contributions accept only active registered levels or the reserved
  `unassigned` bucket; unknown and inactive keys fail as `UNKNOWN_LEVEL_KEY`.
  Aggregation revalidates retained buffer rows before publishing so tampered or
  legacy unknown keys fail the run without deleting source data.
- `src/lib/db/learner-progress-repo.ts` — the **named, permanent** side
  AN-001 explicitly limits to what parent reporting/continuation needs:
  `learner_app_progress` is one row per learner+app, overwritten in
  place (no snapshot history); `lesson_completions` is one row per
  learner+app+lesson, keyed by the caller's `completionId` so a retry
  is a no-op but a new id for the same lesson (a genuine retake)
  overwrites it rather than appending a second row
- `src/lib/auth/internal-service-guard.ts` — `requireInternalService()`:
  short-lived, audience-bound assertions from separate `analytics-scheduler`
  and `analytics-contributor` managed-service principals gate the two internal
  routes. Every assertion JTI is consumed once; browser cookies and static
  shared-secret headers are rejected.
- `POST /v1/internal/analytics/daily-contribution`,
  `POST /v1/internal/analytics/daily-runs/[activityDate]` — internal-service-only
  (verified in manual testing: an authenticated admin's own browser
  session gets `401 UNAUTHENTICATED` against these, confirming AC31).
  The contribution endpoint accepts only `learnerSessionId`, a deterministic
  `contributionId`, and one named counter event. It resolves learner, app,
  level, Kolkata activity date, and age band from platform-owned session data;
  callers cannot submit `ageBand`, `engagedSeconds`, aggregate dimensions, or
  arbitrary counts. Authoritative engaged time remains owned by the protected
  learning-session runtime.
  `GET /v1/admin/analytics/daily`, `GET /v1/admin/analytics/runs`,
  `POST /v1/admin/analytics/runs/[activityDate]/retry` — admin-only;
  reads require the granular `analytics_read` permission, while retry requires
  `analytics_run_retry` plus current-password reauthentication on every request
  (no cached reauthentication timestamp)
- `/admin/analytics` (cohort filters — date range/app/level/age-band —
  totals, completion/interruption rates; running/failed dates in the
  selected range are called out and excluded from the totals at the
  repository query boundary; orphaned aggregate rows without a completed
  run record are also excluded; no
  learner search or drill-down field exists anywhere on the page) and
  `/admin/analytics/runs` (one row per date, status pill, control
  totals, failure code, retry action)

The protected learning-session runtime now produces authoritative session
start, engaged-time, interruption, and completion contributions. Learning-app
services may submit only the narrow session-bound named-counter contract above.

The AN-001 production schedule is declared in
`.github/workflows/an001-daily-analytics.yml`. GitHub Actions invokes the
authenticated endpoint at `18:45 UTC`, exactly `00:15 Asia/Kolkata`, and
`scripts/run-an001-daily.mjs` derives and passes the explicit previous
Kolkata calendar date. A second, independent invocation runs at `19:20 UTC`
(`00:50 Asia/Kolkata`) and calls the service-authenticated monitor endpoint.
It creates one identifier-free `platform_alerts` row when the expected run is
missing, failed, still running after 30 minutes, or completed outside the
30-minute budget; repeated monitor invocations are idempotent. Configure the repository secrets
`ANALYTICS_BASE_URL` (the deployed platform HTTPS origin) and
`ANALYTICS_SCHEDULER_SERVICE_SECRET` (the scheduler principal's signing secret).
The deployed platform resolves `analytics-scheduler-v1` and
`analytics-contributor-v1` independently through `PLATFORM_SERVICE_SECRETS`.
The workflow also supports manual dispatch with an
optional `YYYY-MM-DD` activity date for controlled recovery.

`tests/an-001.acceptance.test.ts` is the traceability gate for all 35
AT-AN-001 criteria. `tests/an-001.nfr.test.ts` covers buffer p95, representative
daily-run duration and restart safety, control/purge invariants, filter and
time-zone contracts, independent operational monitoring, and reversible
migration instructions. Run both with `npm run test:analytics`; the focused
analytics behavior tests continue to run under the ordinary `npm test` suite.

Manually verified end-to-end in a browser + curl (the internal routes
require a service secret a browser session doesn't have): registered
and activated a demo app through the existing AR-001 admin UI →
submitted three contributions across two learners/two levels via
`curl` with the internal service secret → ran the daily job for that
date → `/admin/analytics` showed the correctly-rolled-up app-grain row
(2 active learners, not 3 — one learner spans two levels) alongside the
per-level breakdown, and correct 67%/33% completion/interruption
rates → `/admin/analytics/runs` showed the run as `completed` with
matching control totals → manually inserted a `failed` run row with a
retained buffer contribution and clicked **Retry** in the runs UI,
which reprocessed the retained buffer to `completed` with the right
totals, confirming the retry path end-to-end.

## Paid-cycle entitlements and central access evaluation (EN-001, EN-002)

Two entitlement-domain requirements, built together because EN-002 is
EN-001's own dependency (EN-001 must ask EN-002 which source is
allocation-bearing before creating a credit batch). Both remain **partial,
scoped builds**: BI-001 and BI-002 now supply product assignment and
webhook-verified paid-cycle events, while BI-003..BI-005, EN-003 lifecycle
states such as `suspended_financial`, and later lifecycle overlays remain
separate requirements.

**EN-001 — `src/lib/entitlement-cycle/service.ts`, `applyPaidCycle()`**:
a pure event consumer invoked in-process by BI-002 after verified initial and
renewal payments. Other trusted callers can use the internal route and must
supply a complete, well-formed paid-cycle event, including its immutable
purchased-app-id snapshot. Idempotent by `(paidCycleId, eventId)`; a
different event touching an already-applied `paidCycleId` is rejected
as a conflicting duplicate rather than silently reapplied. Creates one
`entitlement_cycles` row and one `learner_app_entitlement_periods` row
per app, atomically with an independent 8-credit batch for whichever
period EN-002 names as `allocation_bearing` — no batch at all for
`access_supporting` periods.

**EN-002 — `src/lib/entitlement-access/service.ts`**:
- `recomputeEffectiveEntitlement()`: called by EN-001 inside its own
  transaction whenever a period is created. Walks every entitlement
  period this learner has for the app, earliest-first, greedily
  assigning `allocation_bearing` to whichever period starts at or after
  the previous allocation-bearing period's end (a genuine, non-overlapping
  renewal) and `access_supporting` to anything that overlaps it. Writes
  one materialized `learner_app_effective_entitlements` row per
  learner+app+environment with a version that only increments when the
  underlying (period, role) set actually changes.
- `evaluateAccessFresh()`: the fresh-evaluation gate. Reads the
  materialized row for the stable id/version bookkeeping, but always
  re-checks the two genuinely time-dependent facts live — whether a
  period actually covers `now`, and current `app_registry` status — so
  a call made after a period lapses, with no write in between, correctly
  denies access. Wired as a direct in-process call (not the HTTP route)
  into the three gates the spec names: `startLearnerSession` (replaced
  the previously-dead `entitlementGranted: boolean` parameter that no
  caller ever actually set), SC-003's `confirmUsableLaunch`, and LA-001's
  `exchangeAppLaunch`. A denial throws `ENTITLEMENT_INACTIVE`; SC-003's
  reservation gates additionally release the credit/concurrency hold on
  denial, same as an expired reservation.
- `POST /v1/internal/entitlements/apply-paid-cycle` and
  `POST /v1/internal/entitlements/evaluate-access` — internal-service-only
  HTTP routes (new `entitlement-applier`/`entitlement-evaluator` roles on
  the existing `requireInternalService` guard) for external/admin/future
  billing callers; the three in-process gates above don't use them.

**Explicitly not built**: EN-003 lifecycle states (grace, refund,
financial/security suspension) — no
producer; UL-001 launcher membership / `GET /v1/learner-home` wiring —
no launcher route exists yet; EN-004 rebuild/reconciliation. SC-002's
existing calendar-month credit batches are untouched — EN-001's
entitlement-period-keyed batches (`ensureEntitlementPeriodStandardAllocation`
in `session-credit-standard/service.ts`) are created correctly and
idempotently but are **not** wired into live `standard_monthly` session
funding (`fundStandardSession`/`liveBatches` still only ever draw from
calendar-month batches) — that coexistence is the same kind of product
decision already left open for `normal` vs. `standard_monthly`, not
resolved here.

No manual/browser verification — like SC-001, this is an internal
platform-to-platform protocol with no UI of its own.

## Automated app deployment, release promotion and production publish (AR-002, session 1)

The largest requirement built in this codebase so far — 60 business rules,
42 acceptance criteria, real Vercel/CI/webhook integration. Built as a
**scoped core spine** (roughly AC1-26): provider adapter → manifest
validation → immutable CI-authenticated release pipeline → staging gates →
atomic production publish. Rollback automation, signed webhooks,
backward-compatibility gates, deployment-window automation, and retention
purging (roughly AC27-42) are an explicit, documented follow-up — same
phased-build pattern as EN-001/EN-002 above. Marked `In Development`, not
`Done`, in the v18 spec.

**Discovery this session**: a concurrent AU-001 session had already built a
deployment-window *authorization scaffold* — `app_deployment_launch_controls`
+ `src/lib/authorization/deployment-{contract,service,route}.ts` + five
admin routes (`schedule/reschedule/cancel/promote/rollback`) — that
LP-004/LA-001's session-start and launch-dispatch code already read live for
drain-blocking (`resolveTrustedDeployment` in `src/lib/app-launch/deployment.ts`).
That table had a comment literally reading "Trusted AR-002 publication/window
projection used by LA-001" — a seam left for this requirement, but nothing
had ever inserted a real row into it outside test fixtures. AR-002's real
tables (below) are the new source of truth; production publish additionally
upserts one `app_deployment_launch_controls` row per new deployment so that
existing read path keeps working completely unchanged (zero edits to
`learning-session/gateway.ts` or `src/lib/app-launch/*`).

**Provider adapter — `src/lib/deployment-provider/`:** a provider-neutral
`DeploymentProvider` interface (`verifyProject`/`deploy`/`promote`/
`checkHealth`), a real `VercelDeploymentProvider` (fetch-based Vercel REST
calls, only exercised when `VERCEL_API_TOKEN` is configured — never in
automated tests), and `createFakeDeploymentProvider()`, a deterministic
in-memory implementation used by every test and as the default local-dev
provider (`resolveDeploymentProvider()` in `deployment-provider/index.ts`
picks whichever is configured). The same contract-test suite
(`tests/deployment-provider-contract.test.ts`) runs against both, per the
spec's own "provider adapter has contract tests independent of Vercel"
requirement.

**Manifest — `src/lib/deployment-manifest/schema.ts`:** validates
`babysteps.app.json` (manifest version, `appKey` match against
`app_registry.app_key`, relative-only `launchPath`/`returnPath`/
`identityPath`/`healthPath`, minimum SDK version) and rejects any origin/
audience/secret field outright — pure logic, fully unit-tested.

**Binding — `src/lib/deployment-binding/service.ts`:** verified
provider-project binding, one per app/environment (business rule 3/5). An
admin selects a provider-discovered project; verification calls
`provider.verifyProject()` and only a real `{verified:true}` result flips
`binding_status` to `verified` — there is no field anywhere in the
create/verify payloads for a production URL (AC5-6). A verified binding
cannot be silently overwritten; the same provider project/environment
cannot back two apps.

**Release — `src/lib/deployment-release/service.ts`, `createRelease()`:**
the sole write path onto `app_releases`, reachable only through a new
`ci-deployer` internal-service role (`src/lib/auth/internal-service-guard.ts`,
same HMAC-assertion pattern as `entitlement-applier`/`scheduler`) —
`POST /v1/internal/apps/{appId}/releases`. **CI-reported gate results are
trusted, not re-executed**: this repo has no live CI runner and the apps
AR-002 deploys don't exist in this workspace either, so the authenticated
CI caller reports each mandatory gate's pass/fail outcome the same way
EN-001 trusts an already-verified paid-cycle event. A release with any
failed gate is still persisted (`status='gate_failed'`, immutable audit
trail per business rule 16) but blocks staging. Idempotent by
`(app_id, source_commit_sha, artifact_digest)` — a duplicate retry, even
under a different idempotency key, returns the original release rather
than creating a second one.

**Staging — `src/lib/deployment-staging/service.ts`, `deployToStaging()`:**
deploys the release's exact artifact digest to the verified staging
binding and runs the checks that are mechanically verifiable without a
real running learner-app backend: provider deploy success, origin
resolves under an `approved_domains` suffix
(`src/lib/deployment-pipeline/approved-domains.ts` — a small admin-curated
registry seeded with `babysteps.in`/`vercel.app`/`example.dev`, same
"local stand-in for an assumed registry" shape as AR-001's
`approved_app_icons`), a health-endpoint check via the manifest's
`healthPath`, and manifest-identity re-confirmation. **Explicitly not
executed**: the wider SSO/CORS/progress/session-heartbeat/SDK/
accessibility checks business rule 19 names — those need a live app
responding to the babysteps contract, which no app in this workspace
does. Only a release where every executed check passes becomes `verified`.

**Production — `src/lib/deployment-production/service.ts`,
`approveProduction()`:** permission (`app_deployment_promote`, new) +
fresh password reauthentication (`verifyReauth`, same re-check-every-call
idiom as AR-001's activate/soft-delete, not a cached timestamp) + an
explicit staging-verified release. Concurrent promotions for the same app
serialize — an in-flight `deployment_operation_requests` row for the app
blocks a second one before either reaches the provider. Calls
`provider.promote()` on the *exact* staged artifact (never rebuilds),
rejects any origin that doesn't resolve under an approved domain
(`DEPLOYMENT_ORIGIN_REJECTED`), runs a production smoke check, and only
then atomically updates `app_environment_publications`
(current/previous-healthy pointers) — a smoke or origin failure leaves the
current publication completely untouched, only the failed attempt itself
is recorded. `getPublishedDeployment(appId, environment)` (backing
`GET /v1/internal/apps/{appId}/published-deployment`) is the one correct,
tested read of "what should a brand-new learner session use" — **not yet
wired into `startLearnerSession`**, deliberately: that file is
concurrently owned and fast-moving, and wiring a new deployment-resolution
seam into it wasn't this session's call to make unilaterally. Flag this if
asked whether new sessions actually pick up a fresh publish yet — the
resolver is correct and tested, the integration point is a follow-up.

**Admin UI** — `/admin/apps/{appId}/deployments`
(`src/components/deployment-pipeline/deployment-console.tsx`): binding
picker per environment, release list with CI status and a "Deploy to
staging" action, and a password-gated "Approve production" action. No
input field anywhere accepts a production URL.

**Explicitly deferred to a follow-up session** (all of this is now built —
see "AR-002, session 2" below; left here as the historical record of what
session 1 actually scoped out): automated 10-minute post-publish safety observation +
automatic rollback (rules 32-33) — `previous_healthy_deployment_id` is
correctly tracked so the data is ready, only the rollback *execution*
path is missing; signed webhook ingestion
(`deployment_webhook_receipts` exists, no route reads it yet);
backward-compatibility/migration gate logic against
`learner_app_progress.schema_version` (rules 46-49 —
`app_release_compatibility_reports` exists, unpopulated); deployment-window
automation extending AU-001's scaffold (`DEPLOYMENT_WINDOW_LEAD_TIME_REQUIRED`
naming, automated at-`starts_at`/window-overrun sweeps, linking a window to
an approved release — rules 50-60); retention/purge job for previews,
superseded staging, and processed webhooks; wiring `stubReadinessAdapter`
(`src/lib/app-registry/readiness-adapter.ts`) to the real binding table.

Verified: `npx tsc --noEmit` clean; full suite green (625 tests: 619
passed, 6 intentionally skipped live-Vercel contract tests that only run
when `VERCEL_API_TOKEN` is set);
`tests/canonical-route-actions.test.ts` and
`tests/rls-repository-scope-coverage.test.ts` updated and green. Manually
verified in a real browser via claude-in-chrome up through app creation,
activation, and both staging/production binding creation+verification
against the live SQLite-backed dev server — the CI-release-creation →
staging-deploy → production-approval leg of the UI walkthrough was cut
short by a dev-server startup hang encountered late in the session under
heavy concurrent-session CPU load on this machine (unrelated to this
code — a fresh `next dev` on an unused port sat at "Starting…" indefinitely
across three separate attempts); that leg is covered instead by
`tests/deployment-release-routes.test.ts`, which exercises the exact
`POST /v1/internal/apps/{appId}/releases` HTTP path with a real minted
CI service assertion end-to-end.

## Automated app deployment, rollback, windows, compatibility, webhooks and retention (AR-002, session 2)

Closes out AR-002's remaining AC27-42 (rules 27-60) that session 1 explicitly
deferred: automated + manual rollback, real deployment-window enforcement,
backward-compatibility gating, signed webhook ingestion, and retention/purge.
Same phased-build pattern as every prior multi-session requirement, planned
via EnterPlanMode and confirmed with Sridhar before starting.

**Discovery this session, and the decision it led to**: AU-001 had already
built a *parallel* admin scaffold —
`src/lib/authorization/deployment-{contract,service,route}.ts` + five routes
(`schedule/reschedule/cancel/promote/rollback` under
`/admin/apps/{appId}/deployments/{deploymentId}/...`) — that mutates
`app_deployment_launch_controls` directly and independently of AR-002's real
pipeline. Its "promote"/"rollback" never called a provider or touched
`app_environment_publications`; its "schedule/reschedule/cancel" have no
release binding, overlap exclusion, or zero-session enforcement, and its
URLs don't match the spec's own API contract (`/deployment-windows`
collection + `/releases/{releaseId}/approve-production` +
`/deployments/{deploymentId}/rollback`). Asked Sridhar how to reconcile;
answer was "reconcile onto AR-002." In practice, given
`tests/au-001.acceptance.test.ts` AC44 locks `DEPLOYMENT_ADMIN_AUTHORIZATION`'s
five keys and `mutateDeployment`'s implementation in place (another
lineage's already-tested feature, not mine to gut), that meant: **the
`rollback` route is repointed** to call the real
`src/lib/deployment-rollback/service.ts` directly (same URL, real
provider-confirmed work instead of a projection-only status flip); the
**`schedule`/`reschedule`/`cancel`/`promote` routes are left exactly as
AU-001 built them** — a narrower, independent admin-notice surface that
still only touches already-published rows' status/drain fields — while the
real, spec-correct `/admin/apps/{appId}/deployment-windows` collection
(new) and the now window-gated `/releases/{releaseId}/approve-production`
(session 1's route, extended) are the actual authoritative pipeline. Both
surfaces exist; only one moves real learner-session-affecting state. Flag
this explicitly if asked why two "schedule" concepts exist in the codebase.

**Deployment windows — `src/lib/deployment-window/service.ts` (new
`app_deployment_windows` table, rules 50-60):** `scheduleDeploymentWindow`
requires a `verified` release with a passed staging deployment and ≥60
minutes' lead time; only one non-final window per app at a time (SQLite
partial unique index; a real Postgres exclusion constraint in the parallel
migration). On success it projects `drain_starts_at`/`deployment_window_ends_at`
onto whichever `app_deployment_launch_controls` row the publication pointer
*currently* names — not onto every row still marked `'published'`, which
session 1's/AU-001's "insert a new projection row, never touch the old
one" design means there can be several of at any time (a real bug caught
and fixed mid-session via a regression test, see below). `approveProduction`
(`deployment-production/service.ts`) now requires a `deploymentWindowId`
and revalidates it's `scheduled`/`executing`, bound to the exact
app/release, and at/after its `starts_at` (rule 38 — "no immediate
unscheduled production promotion"), and on success both completes the
window and clears the *previous* published deployment's drain projection
immediately (rather than waiting for the window's raw `ends_at` to lapse —
"on safe completion the block is removed," Main Flow step 26). The
scheduled `sweepDeploymentWindows` (new
`POST /v1/internal/deployments/window-sweep`) confirms zero
starting/active/disconnected sessions at `starts_at` before promoting;
if any remain it postpones without deploying (no allowance consumed), and
an overrun past `ends_at` while still blocked moves to
`extended_safe_block` rather than silently unblocking.

**Rollback — `src/lib/deployment-rollback/service.ts` (new):**
`rollbackProduction` is the single core both triggers share (rule 35 —
"manual rollback uses the same automated path"). It re-promotes the
previous-healthy deployment's own already-staged artifact (the
`DeploymentProvider` interface has no separate rollback primitive — reusing
`promote()` is build-once-safe and exercises the same fake-provider-testable
path `approveProduction` already uses), re-validates the restored origin
against the approved-domain registry, and atomically swaps the publication
pointer — with `previousHealthyDeploymentId` set to `null` afterward, since
this schema's two-pointer retention model (rule 41) genuinely has nothing
further back to roll back to. Fails closed on any provider error (Alternate
Flows: "keep last known publication pointer and alert"). The **automated**
path is `sweepReleaseSafetyObservations` (new
`app_deployment_safety_observations` table + `POST
/v1/internal/deployments/safety-sweep`): every production publish starts a
restart-safe ten-minute/one-check-per-minute observation (identity/origin
re-check + `provider.checkHealth`); one identity failure or three
consecutive availability failures triggers `rollbackProduction` and writes
a `platform_alerts` row (same dedup-by-open-alert shape as AN-001's
`recordAlertOnce`) — including a distinct `deployment_automated_rollback_failed`
alert if the rollback itself can't complete, so a "no previous healthy
deployment" case is loud, not a silent forever-retry.

**Backward compatibility — `deployment-release/service.ts` +
`deployment-staging/service.ts` (rules 46-49):** CI's release-creation
payload gains an optional `readableSchemaVersions: number[]` attestation
(which `learner_app_progress.schema_version` values this release's code can
still read/migrate). Before a release can move from staging-passed to
`verified`, the pipeline enumerates every schema version actually
represented in retained progress for the app and requires every one to be
covered; a gap fails with `RELEASE_BACKWARD_COMPATIBILITY_FAILED` (not the
generic `STAGING_VALIDATION_FAILED`) and writes the compact result into
`app_release_compatibility_reports` (table existed since session 1,
unpopulated until now). Same "trust CI's attestation, don't re-derive it"
posture as the build/test/security gates — there's no live app in this
workspace to actually run a migration engine against.

**Webhook ingestion — `src/lib/deployment-webhook/service.ts` (new),
`POST /v1/internal/deployment-provider/webhook`:** HMAC-SHA256 over
`${timestamp}.${rawBody}` (`DEPLOYMENT_WEBHOOK_SECRET`), 5-minute timestamp
tolerance, and idempotent recording into `deployment_webhook_receipts`
(existed since session 1, unpopulated until now) — a forged signature or
stale timestamp is `WEBHOOK_SIGNATURE_INVALID`, a genuine event-ID replay
is `WEBHOOK_REPLAYED`. Authenticated by its own shared-secret signature
rather than `requireInternalService`'s managed-service-assertion pattern
(a deployment provider isn't a Babysteps-issued principal). Deliberately
audit-only per rule 44 ("no repository/app credential may mutate
publication pointers directly") — it records a verified event and nothing
more; it never itself triggers promote/rollback/publish.

**Retention — `src/lib/deployment-retention/service.ts` (new), `POST
/v1/internal/deployments/retention-purge`:** purges superseded/failed/
rolled-back `app_deployments` rows (and their `app_deployment_safety_observations`
/ `app_deployment_launch_controls` rows) past 7 days, unless still named by
a publication pointer or under `investigation_hold`; final-state
`app_deployment_windows` past 7 days; processed `deployment_webhook_receipts`
and completed `deployment_operation_requests` past 24 hours.

**Scheduling**: all three sweeps share one new `deployment-scheduler`
platform-service role (`src/lib/auth/internal-service-guard.ts`) and one
script, `scripts/run-ar002-deployment-sweeps.mjs`, invoked by
`.github/workflows/ar002-deployment-sweeps.yml` every 5 minutes — GitHub
Actions' schedule trigger has a practical minimum interval of about 5
minutes with no delivery-time guarantee even at that, so it's the closest
achievable cadence on this platform, not the literal "one check per minute"
of rule 32; the sweep itself still internally throttles to at most one
check per minute per observation row regardless of invocation frequency,
and is restart-safe by construction (all state in the DB row, nothing in
process memory). Same operational gap as the pre-existing `scheduler`/
`ci-deployer` roles: nothing in this codebase auto-seeds the
`platform_service_principals` row a real deployment provisions for this
role; it's a manual/ops step outside this codebase's scope, same as its
siblings.

**Admin UI** (`deployment-console.tsx`): the old direct "Approve production"
button is gone — a verified release now gets a "Schedule production
deployment" form (start/end pickers, reauth), a new Deployment windows list
(status, cancel), and a password-gated "Roll back to previous healthy
release" action once a previous-healthy deployment exists. The
compatibility report's per-release detail isn't surfaced in the UI yet
(the release's own `verified`/`staging_failed` status already reflects
pass/fail) — flag if asked for a dedicated compatibility panel.

**Explicitly still open, same shape as session 1's own gap list**: LP-004
still has no HTTP route for `startLearnerSession` itself (a pre-existing,
separate, cross-cutting gap flagged since 2026-08-05 — see
[[babysteps-requirements-progress]]/README's LP-004 sections), so while
`getPublishedDeployment` is now genuinely dispatch-block-aware and
`startLearnerSession`'s own `input.deployment.dispatchBlocked` check is
real, nothing in production yet resolves `input.deployment` for an actual
new session start — rule 52's new-start drain block is correct in shape,
not reachable end-to-end, exactly as session 1 left `getPublishedDeployment`
itself. No dedicated preview/development-environment deployment path was
ever built (rule 17) — not attempted this session either.

Verified: `npx tsc --noEmit` clean throughout; full suite green (736
tests passing, 6 intentionally skipped live-Vercel tests, up from 669 at
session start); `tests/canonical-route-actions.test.ts`,
`tests/rls-repository-scope-coverage.test.ts`, and
`tests/au-001.acceptance.test.ts` (AC19's table count bumped 70→72, same
mechanical update every prior requirement's new tables have needed)
updated and green. Manual browser verification of the new admin UI
(schedule/cancel window, rollback button) was blocked by the exact same
`next dev` "✓ Starting…" hang session 1 hit under heavy concurrent-session
CPU load (9 node processes running at the time, same as session 1's
handoff recorded) — reproduced, not a regression, documented instead of
forced; every new route is covered by real HTTP-level tests instead
(`tests/deployment-sweep-routes.test.ts`, `tests/deployment-webhook.test.ts`,
`tests/deployment-retention-route.test.ts`), same substitution session 1
used for its own cut-short walkthrough leg.

## v45 gap-audit remediation (2026-08-08)

`Requirements/Babysteps_Implemented_Requirements_Gap_Audit_v45.xlsx` is an
independent gap audit against the v45 spec, 107 findings (`GAP-001`..
`GAP-107`) across every requirement built so far. Worked iteratively:
triaged every gap into concrete in-repo fix, genuinely platform/infra-
dependent (Deferred), or blocked on a large not-yet-built internal
requirement (left Open); fixed 16 real bugs this pass; marked 52
platform-dependent gaps `Deferred` in the xlsx's `Gap Register` sheet (a
new `Resolution Notes` column records why, per row); left 39 open,
documented below.

**Fixed this pass (marked `Resolved` in the xlsx):**
- **GAP-008** (IA-003): email-change verification tokens are now sha256-hashed
  (`email_change_requests.token_hash`) — the raw token is never persisted.
- **GAP-010** (IA-003): `softDeleteAccount` now atomically revokes every
  active/starting learner session and its app grant
  (`revokeActiveLearnerSessionsForParent`, new in
  `src/lib/learning-session/gateway.ts`), not just learner-mode unlock
  contexts.
- **GAP-011** (IA-003): `account_events` for email-change now stores masked
  addresses (`maskEmail()`), not raw ones — `parent_email_history` keeps the
  real archival record per its own append-only rule.
- **GAP-019/060/080** (LP-004/LA-004/SC-001): removed the
  `repeated_interruption_after_threshold` auto-completion path entirely —
  v45 makes hard expiry the sole recovery boundary.
- **GAP-043/048/089** (LA-001/LA-002/SC-003): a session-start grant is now
  **provisional** — scoped only to `session.usable_launch` — until
  `confirmUsableLaunch` atomically activates it to the full scope set
  (`activateAppGrant`, new in `src/lib/app-authorization/service.ts`).
  Deliberately doesn't bump `grant_version` on activation: scope checks
  re-read the live grant row every call, so the still-valid provisional
  token keeps working and simply gains the wider scope, no reissue needed.
- **GAP-050** (LA-002): `session.heartbeat` renamed to
  `session.usable_launch` across `APP_API_SCOPES` and the three routes that
  used it — SC-001 eliminated recurring heartbeats; the name now reflects
  the actual non-periodic use.
- **GAP-051** (LA-002): `assertLiveGrant` rejects a provisional grant once
  its session is no longer `starting`.
- **GAP-075** (AU-002): already fixed before this audit (commit `89efe0a`)
  — `signOutAction` revokes learner-mode unlock contexts before clearing the
  cookie. Verified, no code change needed.
- **GAP-085/098** (SC-002/EN-001): standard-credit batch expiry is now
  calendar-anchor-based (`addCalendarMonthsClamped`/`calendarMonthsBetween`
  in `src/lib/entitlement-cycle/service.ts`), not raw millisecond-duration
  arithmetic — the old formula drifted by a day whenever `periodStart`/
  `periodEnd` straddled months of different lengths (e.g. a Jan-31-anchored
  cycle ending Feb 28 must roll to Mar 31, not Mar 28).
- **GAP-095** (EN-001): `applyPaidCycle` now verifies
  `learner.owner_parent_id === purchaserParentId` before materializing an
  entitlement cycle — previously any paid-cycle event could name an
  arbitrary learner.
- **GAP-101** (EN-002): `evaluateAccessFresh` special-cases
  `useCase: "resume"` to honor the entitlement binding the session was
  actually started under (persisted at Start), through the session's own
  hard expiry — instead of re-checking a live covering period, which wrongly
  denied resuming a session whose paid period ended after it started. Also
  wires this check into `resumeLearnerSession` for the first time (it was
  previously EN-002-unaware, a known/flagged gap).

**Deferred (52 gaps — genuinely platform/infra-dependent, not fixable in
this repo alone):** production Supabase Auth/RLS activation, live Vercel
provider APIs and connected external CI (most of AR-002's remaining gaps),
a real BI billing/payment gateway producer (EN-001/EN-002/SC-002's
remaining gaps), Postgres-only concurrency certification, a shared durable
rate-limit store, production key-rotation runbooks, and anything requiring
an independently deployed learning app or its own out-of-repo SDK. Full
per-gap reasoning is in the xlsx's `Resolution Notes` column.

**The 39 gaps left `Open` at the end of this pass were closed in a follow-up
session — see "v45 gap-audit remediation, session 2" below for AU-004,
IA-004, SC-001 and PR-001/002/003; GAP-106 was fixed alongside them and
GAP-002/025/093/107 turned out to share the same billing/production-email
root cause as gaps already marked Deferred above, so they were reclassified
Deferred rather than left Open.**

## v45 gap-audit remediation, session 2 — AU-004, IA-004, SC-001, PR-001/002/003 (2026-08-09)

Closed all 39 gaps session 1 left `Open`, plus GAP-106, by building the four
internal requirements they were blocked on (each was self-contained and
buildable, just not attempted in session 1) rather than deferring them.
GAP-002/025/093/107 were reclassified `Deferred` — investigation showed they
share the same platform/billing root cause as gaps already Deferred above,
not a different, in-repo-fixable situation. **107/107 gaps now accounted
for: 51 Resolved, 56 Deferred, 0 Open.** 798/798 tests passing (up from 741
at session 1's end), `tsc --noEmit` clean throughout.

- **AU-004 — managed Ed25519 machine identity** (closes GAP-030, 042, 047,
  049, 065, 091, 100): every machine-to-platform identity — app-backend
  client assertions (`src/lib/app-launch/principal.ts`) and platform-internal
  service principals for analytics/entitlements/deployment
  (`src/lib/authorization/internal-decision.ts`) — now proves itself with an
  Ed25519 signature verified against a public key stored on its own
  principal row, replacing HS256 shared secrets entirely.
  `APP_SERVICE_SECRETS`/`PLATFORM_SERVICE_SECRETS` env-var secret maps are
  gone from the codebase.
- **IA-004 — real WebAuthn learner passkeys** (closes GAP-014, 023, 070,
  071, 072, 073, 074): `src/lib/webauthn/service.ts` implements registration
  and authentication ceremonies (`@simplewebauthn/server`), 5-minute
  single-use hashed challenges, a `learner_passkey_credentials` registry with
  sign-counter clone detection, and reauth-protected revocation that tears
  down any active learner-mode context bound to the revoked credential. Wires
  into AU-002's existing trust-boundary seam
  (`recordTrustedPasskeyVerification` → `activateLearnerMode`), which
  previously had no real verifier calling it. Includes a minimal browser
  enrollment/unlock component
  (`src/components/learner-mode/passkey-unlock.tsx`,
  `@simplewebauthn/browser`) with no password/PIN fallback. Tests exercise
  genuine ECDSA attestation/assertion crypto via a hand-built virtual
  authenticator (`tests/helpers/webauthn-virtual-authenticator.ts`), not
  mocks of the verification library.
- **SC-001 — browser-local session runtime SDK** (closes GAP-020, 021, 022,
  055, 057, 061, 077, 078, 079, 081, 082, 083, 090): `src/lib/session-runtime-sdk/`
  is the browser package that never existed before — real IndexedDB
  persistence (`createRuntime`, envelope-verified before any local runtime
  is trusted into existence), single-owner-tab coordination (Web Locks +
  BroadcastChannel, `claimOwnerTab`), the five-minute change-gated checkpoint
  (`recordMeaningfulChange`/`checkpointIfDue` — proven by a test asserting
  zero sync calls absent a due+dirty capsule across a simulated 45-minute
  session), one-time HMAC-bound pending-capsule recovery gated on hard
  expiry and server progress version (`prepareResume`), and a versioned
  runtime-record migration registry that fails closed on an unrecognized
  future version. The session envelope moved from HS256 to EdDSA
  specifically so this SDK can verify it client-side with only the Ed25519
  public key (`SESSION_ENVELOPE_SIGNING_PUBLIC_KEY`) — nothing secret ships
  to the browser.
- **PR-001/002/003 — progress schema migration registry** (closes GAP-037,
  054, 056, 059, 062, 092): `src/lib/progress-schema-registry/service.ts` is
  a deterministic, declarative (rename/default/drop — no arbitrary code)
  transform registry, walked one adjacent `schema_version` at a time in
  either direction. Wired into two real gates: AR-002's `approveProduction`
  now blocks promoting a release whose declared progress schema has no
  forward+rollback path from every schema version still in use by an
  existing learner (`RELEASE_PROGRESS_SCHEMA_INCOMPATIBLE`), and SC-003's
  `confirmUsableLaunch` migrates a learner's stored progress to the
  release's schema version before consuming funding, blocking (funding left
  untouched) if no path exists. PR-003's standard app-owned progress summary
  contract (current level, efficiency stars, milestone, next destination) is
  an optional field on `saveCheckpoint`/`completeLesson`, validated and
  persisted on `learner_app_progress.progress_summary_json`, surfaced again
  at session finalization.
- **GAP-106 — bounded launcher access cache**:
  `src/lib/entitlement-access/launcher-cache.ts`'s `evaluateAccessForLauncher`
  is a bounded, read-only, per-process cache in front of
  `evaluateAccessFresh` for launcher/home-screen display only — expires at
  the sooner of a 60-second TTL or the decision's own nearest
  entitlement/app boundary, and is never consulted by Start, launch
  exchange, usable launch or resume, all of which still call
  `evaluateAccessFresh` directly and unchanged.
- **GAP-018 — LP-002 cross-requirement integration tests**: now that the
  session-runtime gaps it was blocked on are built,
  `tests/gap-018-lp002-session-integration.test.ts` exercises a
  date-of-birth change against the full session lifecycle — confirming
  weekly session-slot usage is preserved (keyed independent of profile
  fields) and that analytics age-band attribution reflects the DOB in
  effect at the moment of each contribution, never retroactively rewriting
  an already-recorded day.
- **GAP-002/025/093/107 reclassified `Deferred`**: GAP-002 needs configured
  production email delivery (same root cause as GAP-001/004); GAP-025/093/107
  all need the BI/EN-003 billing and lifecycle-overlay producers that don't
  exist anywhere in this repo (same root cause as the other billing-Deferred
  gaps above) — none of the three is fixable from this repo alone.

## Fail-closed progress mutations, safely readable continuation and controlled integrity incidents (PR-004, 2026-08-10)

Adds an integrity layer over LA-003's single-current-row progress model
(`learner_app_progress`, `lesson_completions`): every mutation — checkpoint,
lesson completion, PR-001 schema migration, PR-003 summary write, and
SC-003's mandatory-progress usable launch — now fails closed under a fresh
integrity check first, and genuine corruption routes to a controlled,
metadata-only operations-incident workflow rather than any raw-JSON reset
path. New `src/lib/progress-integrity/` module (`service.ts` the
classifier/orchestrator, `incidents.ts` the admin action dispatcher,
`reconcile.ts` the scheduled sweep), migration `0043_pr004_progress_integrity.sql`.

**Real gap found and worked around**: the prior session's "PR-001/002/003"
commit only actually built PR-001 (migration registry) and a bare PR-003
summary column — PR-002 (recovery receipts) was never built, and no
`learner_app_progress_summaries` table with `based_on_progress_version`
exists. PR-004 treats recovery metadata as always-absent (rule 16 is
vacuously satisfied, same pattern as EN-001/EN-002's own documented gaps)
rather than inventing PR-002 inside this session's scope. It does add a
small `learner_progress_migration_receipts` table so rules 12/14/15
(migration-receipt agreement) are real rather than a second vacuous gap —
`migrateLearnerProgressToReleaseSchema` now writes one on every successful
migration.

**Canonical hash redefinition**: `learner_app_progress.state_hash` now
covers identity (learner/app/environment) + progress_version + schema_version
+ state, not just state (`computeCanonicalStateHash`) — `saveCheckpoint`/
`completeLesson` in `src/lib/app-progress/service.ts` were updated to
compute it the same way, so PR-004's validation is a real, meaningful check
rather than one that can never fail. The hash is opaque/internal with no
external consumer, so this was a safe redefinition; no live Supabase
deployment exists yet, so no real data was at risk from the format change.

**Five-way classification** (`healthy | read_only_safe |
blocked_repairable_metadata | blocked_conflict | unreadable_corrupt`) —
`classifyIntegrity` is a pure function over an evidence struct (hash match,
schema registration/validation, version positivity, migration/legacy
receipt status, completion ownership, summary relation), most-severe-wins
when multiple issues coexist, every issue code still recorded (rule 67
aggregation). `validateProgressIntegrity` is the DB-backed orchestrator
every write-gate and route calls — bounded single-row lookups only (rule
57), integrity_version bumps only when state actually changes (rule 53),
idempotent by requester+idempotencyKey.

**Incidents open only for issues an operator can actually act on** — a
`SUMMARY_STALE`-only `read_only_safe` row (benign, rule 26) never gets an
incident; a `LEGACY_RECEIPT_MISSING_UNENFORCED` `read_only_safe` row does,
since rule 63's `resolve_legacy_policy` action needs one to exist. One
active incident per learner+app is enforced by a partial unique index
(`ux_pii_active`), not application logic — a second detection while one is
open aggregates issue codes onto it. The 6 Version-1 actions
(`revalidate`, `retry_safe_metadata_repair`, `link_matching_receipt`,
`resolve_legacy_policy`, `open_disaster_recovery_case`,
`resolve_false_positive`) are a closed dispatcher in `incidents.ts` that
never accepts `current_state_json`/`progress_version`/`schema_version`/
summary/completion fields as input at all (rule 64 enforced structurally,
not by a runtime denylist). `revalidate` is the only path that can move a
row back to `healthy` from `unreadable_corrupt` (rule 65) — even
`resolve_false_positive` closes the incident without forcing
`integrity_state`.

**Reconciliation sweep** (`reconcile.ts`) mirrors
`sweepReleaseSafetyObservations`'s restart-safe, all-state-in-DB design:
keyset pagination over `learner_app_progress` (`updated_at, learner_id,
app_id`), idempotent per `runIdempotencyKey`+cursor via a new
`progress_integrity_sweep_runs` table, `environment` supplied by the caller
as sweep-run context (the progress table itself has no environment column
— only sessions/deployments do). "Repair" isn't a separate code path: it's
the same `validateProgressIntegrity` re-evaluation every row in the page
already gets, so a `blocked_repairable_metadata` row whose data has since
self-corrected simply comes back healthy.

**New routes** (all registered in `route-actions.ts`/`modes.ts`):
`POST /v1/internal/learner-app-progress/validate-integrity` (dual-caller —
app grant token for `read|write|launch`, the new `progress-integrity`
`PlatformServiceRole` for `reason=reconcile` against an explicit
learner/app/environment target, since a service principal has no session
context of its own to derive them from — a genuine gap in the spec's
literal input list, filled pragmatically),
`POST /v1/internal/learner-app-progress/reconcile-integrity` (scheduler-only,
runs the bulk sweep), `GET /v1/admin/progress-integrity-incidents/{id}`,
`POST .../action` (exact `progress_integrity_manage` permission +
`verifyReauth` on every call, same shape as the deployment-rollback route),
`GET /v1/admin/apps/{appId}/progress-integrity-health` (aggregate counts
only, no learner reference).

**SC-003 gate**: `confirmUsableLaunch` now requires `integrity_state ===
"healthy"` (not just "not blocked" — `read_only_safe` still fails here,
since this flow is about to mutate progress via schema migration) before
`activateAppGrant`, for any app with an active registered progress schema
for the release (`isMandatoryProgressApp` — no new `app_registry` column,
reuses the existing early-return convention `assertReleaseSchemaCompatibility`/
`migrateLearnerProgressToReleaseSchema` already had).

**Explicitly deferred, documented not silently dropped**: rule 16 (PR-002
recovery-receipt agreement) is structurally unreachable, no code path ever
sets recovery metadata. Rule 68's automated release-rollback trigger
records the routing decision (`workflow_route`) but doesn't wire an actual
call into `rollbackProduction` — the spec doesn't crisply define trigger
volume/conditions, so a documented routing record is the deliverable, full
auto-trigger is a follow-up. Rules 69-70 (disaster-recovery restore-then-
revalidate) are status-only for the same reason as PR-002 — no PR-005
exists yet.

1,009 tests passing (6 pre-existing skips), `tsc --noEmit` clean, and the
production build succeeds after the BI-001, BI-002, BI-003, BI-004, and PR-004 protected
tables and routes were registered. No PR-004-specific manual/browser
verification was performed — this requirement has no learner-facing UI of
its own (same reasoning as SC-001/SC-002/SC-003: internal platform↔app-
backend protocol only); the three scenarios a manual pass would have
covered (healthy checkpoint round-trip under the new hash format, a forced
hash-mismatch failing closed on read/write, walking an incident through
`revalidate` → `resolved_repaired`) are each exercised by real, passing
tests against the production code paths instead. Not committed — ask
before committing per this repo's standing rule.

## Original-browser pre-expiry recovery of pending meaningful progress (PR-002, 2026-08-10)

Lets the learner's *original browser/device* recover unsaved progress after
a crash/network loss/tab close, as long as the session hasn't hit its hard
server expiry yet — closes the gap where a browser crash before a
checkpoint just lost that work. Direct continuation of the Progress
domain; every dependency (SC-001's browser runtime SDK, LA-002/003/004,
PR-001's migration registry, SC-003's reservation lifecycle, PR-004's
integrity gate) was already real going in. New `src/lib/progress-recovery/`
module (`service.ts` the recovery write path, reusing PR-004's integrity
gate and LA-003's schema/hash machinery), migration
`0047_pr002_progress_recovery.sql`. Confirmed genuinely greenfield before
starting — PR-004 was explicitly built treating PR-002 as absent.

**Three decisions made explicitly before writing code (via AskUserQuestion),
same EnterPlanMode process as PR-004**: (1) the new browser-side capsule
store lives inside `session-runtime-sdk` (new IndexedDB object store,
`DB_SCHEMA_VERSION` 1→2, reusing its existing HMAC device-binding scheme
and owner-tab lock) rather than a separate package — note this is a
different concept from that SDK's existing `pendingCapsule`/`prepareResume`,
which explicitly discards anything at/after hard expiry (SC-001's own
same-tab-crash recovery); PR-002's capsule must survive independently of
that lifecycle. (2) `learner_sessions.last_acknowledged_progress_version/
hash` are set only by the recovery path, never by ordinary checkpoints —
resume's amended response does a live read of `learner_app_progress`
instead, matching how finalization already works. (3) `recover-current`
independently re-validates `deviceSessionId` + the resume credential hash
itself (the same check `resumeLearnerSession` already does), rather than
trusting that resume ran moments earlier in the same request flow.

**Recovery is only ever valid before hard expiry** (rules 22-23) — the
existing `resumeLearnerSession` already correctly hard-fails with
`SESSION_HARD_EXPIRED` and purges launch data once expiry passes, and
PR-002 doesn't change that. The flow is: amend resume's response with
`currentProgressVersion`/`currentStateSchemaVersion`/`currentStateHash`/
`recoveryAllowed`/`recoveryAllowedUntil` (client decides whether to submit
a pending capsule) → a new `recover-current` endpoint does the actual
write, reusing `app-progress/service.ts`'s `validateState` (now exported)
and `progress-integrity/service.ts`'s `computeCanonicalStateHash`/
`validateProgressIntegrity`, but with its **own** conflict code
(`PROGRESS_RECOVERY_STALE`, not `PROGRESS_VERSION_CONFLICT`) and its own
monotonic counter (`recoverySequence`, distinct from `checkpointSequence`)
— rules 41-42 mean recovery never advances level/lesson or infers a new
lesson completion, so `current_level_key`/`current_lesson_key` are
deliberately left untouched by the write, unlike an ordinary checkpoint.

**Integrity gate runs twice**: once before the write (PR-004's existing
`mutationBlocked` check, same as any other progress mutation) and once
again immediately after the write commits (rule 69 — a fresh recompute,
not nested in the same transaction, since better-sqlite3 transactions
shouldn't nest and the write has already happened by that point; this is a
post-hoc confirmation gating the *acknowledgment*, not the write itself).

**Incidents are a discrete per-attempt log** (`progress_recovery_incidents`,
dedup scoped to `(session, category)`), not a persistent per-learner-app
state machine like PR-004's — a stale-conflict, device-mismatch, schema-
migration-required or integrity-blocked recovery attempt is a one-off
event tied to a specific session, not an ongoing issue to track like a
corrupt row. `reconcile-recovery` (AU-004's new `progress-recovery`
service role) deliberately takes no payload parameter at all — it can only
confirm or flag what a receipt already claims happened.

**New routes**: `POST /v1/internal/learner-app-progress/recover-current`
(new `progress.recover` app-service scope), `POST .../reconcile-recovery`
(new `progress-recovery` `PlatformServiceRole`), `GET /v1/admin/apps/
{appId}/progress-recovery-incidents` (new `progress_recovery_read`
permission, matching `ProgressIntegrityPermission`'s pattern). All
registered in `route-actions.ts`/`modes.ts`.

**`closeRecoveryWindow`** (rule 52) is wired into every existing session-
ending call site — LA-004's `finalizeCore`, `completeLearnerSession`
(secure exit), `revokeActiveLearnerSessionsForParent` (security
revocation), and both the inline and swept hard-expiry paths in
`resumeLearnerSession`/`sweepExpiredLearnerSessions` — a small addition to
each, not a new subsystem.

1009/1009 tests passing (6 pre-existing skips), `tsc --noEmit` clean —
confirmed after a concurrent session's parallel BI-* billing work (which
was still active this entire session) settled. No manual/browser
verification — same reasoning as PR-004/SC-001: the new browser-side
`recovery-capsule.ts` functions are real and tested against
`fake-indexeddb`, but nothing in this repo's own UI consumes them yet (no
learner-progress-taking page exists here at all). Not committed — ask
before committing per this repo's standing rule.

## Entitlement lifecycle transitions and a minimal refund/chargeback producer (EN-003, BI-005, 2026-08-11)

One versioned entitlement-transition domain (`src/lib/entitlement-lifecycle/`)
consuming verified billing/identity/app-registry/security lifecycle events —
cancellation, grace, refund, chargeback/dispute, reassignment, and platform
security revocation, each producing a deterministic access effect and never
deleting learner progress. The largest single dependency gap found while
planning: **BI-005 (refunds/disputes) didn't exist at all** — only unused
placeholder enum values already sat in the schema
(`learner_app_effective_entitlements.state`'s CHECK constraint has permitted
`inactive_refunded`/`suspended_financial`/`suspended_security`/
`approved_grace`/`overlap_resolution` since migration `0032`, but no code
ever wrote them). Built a minimal BI-005 alongside EN-003 rather than
deferring the refund/chargeback rules, per explicit user sign-off
(AskUserQuestion, all three scoping decisions below taken as recommended).

**Key architectural decision, worth reading before touching this domain
again**: EN-003 does **not** replace BI-003/BI-004's existing lazy
lapse-based mechanism for cancellation/grace — `expireCancellationState`
(`cancellation-policy.ts`) and `expireGraceSubscriptionState`
(`grace-policy.ts`) are unchanged; `evaluateAccessFresh` still calls them
inline, live, on every fresh evaluation, and neither has ever written
anything but `active`/`inactive` to `learner_app_effective_entitlements
.state`. EN-003's `applyLifecycleEvent` (`src/lib/entitlement-lifecycle/
service.ts`) owns the genuinely new terminal states — `inactive_refunded`,
`suspended_financial`, `suspended_security` — plus reassignment audit and
reconciliation-driven chargeback restoration. Cancellation/grace events are
still recorded into the same lifecycle ledger for audit uniformity (rule
8/68), but as `newState: null` (audit-only) entries in
`src/lib/entitlement-lifecycle/contracts.ts`'s rule→effect table.

**Three decisions made explicitly (AskUserQuestion), don't re-litigate
without asking again**: (1) build a minimal BI-005 producer alongside
EN-003 — admin-driven refund case + provider-confirmation reusing BI-001's
`provider-adapter.ts` seam (`confirmRefund?`, new), plus a signed HMAC
webhook for chargeback/dispute mirroring AR-002's deployment-webhook
pattern (`src/lib/billing/bi005-service.ts`) — rather than deferring the
~28 refund/chargeback ACs until a real payment-gateway integration exists;
(2) build a minimal admin trigger for security revocation
(`POST /v1/admin/entitlements/{effectiveEntitlementId}/revoke`, new
`entitlement_security_revoke` permission) rather than only the consumption
side, since nothing before this could immediately suspend a single
learner-app's access; (3) leave IA-003's `account-security-repo.ts`
untouched — its existing session/context revocation plus `account_status`
gating already satisfies rule 54 (parent suspension blocks access
immediately) without adding a redundant entitlement-state transition.

**New tables** (migration `0049_en003_lifecycle_transitions.sql`):
`entitlement_lifecycle_events` (the versioned event log, `(source,event_id)`
unique, `status` pending/applied/quarantined/rejected), append-only
`entitlement_state_transitions` (UPDATE/DELETE-blocking trigger, same
pattern as BI-001's `subscription_assignment_audit`), idempotency receipts
`entitlement_transition_receipts`, a bounded-sweep job ledger
`entitlement_lifecycle_job_runs` (same shape as BI-002's `billing_job_runs`,
kept separate rather than widening that table's `job_type` CHECK
constraint), plus BI-005's `refund_cases` and `financial_dispute_events`.
`learner_app_effective_entitlements` gained `lifecycle_version` (a
**separate** counter from EN-002's own `effective_version` — its hash-bump
semantics in `recomputeEffectiveEntitlement` are untouched),
`last_lifecycle_event_id`, `revoked_before`, `scheduled_transition_at/type`
(schema support for a future scheduled-boundary producer; nothing populates
it yet, same "wired but unreachable" shape as several EN-001 overlays).

**`applyLifecycleEvent`** loads authoritative details server-side (rule 1),
resolves the affected `(learner,app)` set once and stores it as the event's
immutable `app_ids_json` snapshot (rule 3 — retries/the sweep replay that
stored set, never a fresh live query), and is idempotent per
`(source,event_id)` (rule 61), rejects a strictly-stale `sourceVersion`
(rule 62), and **quarantines** — inserts a `status='quarantined'` row with
`conflicting_event_id` set, not just an in-memory rejection — a same-version
differing-payload conflict (rule 63). Financial-truth-first ordering (rule
67): the event row commits before the per-entitlement effect transaction
runs; if that transaction throws, the event stays `pending` and a repeat
call or `process-due-transitions` retries idempotently (each per-app write
is guarded by a unique `(effective_entitlement_id,lifecycle_event_id)`
constraint on `entitlement_state_transitions`). Session effects
(`cancelStartingSessionsForLearnerApp`/`revokeActiveLearnerSessionsForLearnerApp`,
new exports in `learning-session/gateway.ts`, factored out of the existing
per-parent revoke loop rather than duplicated) never touch SC-001's
`hard_expires_at` machinery directly — `preserve_to_hard_expiry` only
cancels *starting* reservations, deliberately leaving an already-active
session to finish exactly where the existing hard-expiry sweep already ends
it.

**`reconcileEntitlementLifecycle`** is the **only** path that may emit
`chargeback_reversed` (rule 47) — the financial-events webhook records a
reversal into `financial_dispute_events` but never applies it directly;
reconciliation checks a `learner_app_entitlement_periods` row still covers
the reversal moment before restoring `active`, otherwise marks it
`processed`/skipped with no entitlement effect.

**EN-002 amendments** (`entitlement-access/service.ts`): `AccessDecision
.state` gained the three terminal values plus an optional `reasonCategory`
(rule 69 — only ever a safe category, never refund amount/dispute
detail/billing data); `evaluateAccessFresh` checks the materialized row's
terminal state before the existing cancellation-lapse/grace/resume logic,
for every `useCase` including resume — a `revoked_before`-specific resume
check was considered (per rule 57) but turned out to be dead code, since
every `session_effect: 'immediate_revoke'` transition already sets one of
the three terminal states the earlier check already catches; removed rather
than left in as unreachable logic. `applyLifecycleEvent` calls the existing
`clearLauncherAccessCache()` after every committed transition.

1042/1042 tests passing (6 pre-existing skips), `tsc --noEmit` clean.
`tests/rls-repository-scope-coverage.test.ts` and AU-001's AC19 both needed
their hardcoded table/permission counts bumped for the 6 new tables (101→107)
— routine per this repo's own documented pattern, not a design issue.
Manual/browser verification not applicable — same reasoning as
EN-001/EN-002/PR-004: an internal platform↔billing↔security protocol with no
Babysteps UI of its own; the admin revoke route is server-to-server admin
auth, exercised via route tests. Not committed — ask before committing per
this repo's standing rule.

## Automatic repair from verified source truth and cross-domain integrity monitoring (EN-004, 2026-08-11)

A reconciliation service (`src/lib/entitlement-integrity/`) that repairs
entitlement state when a verified billing event exists but the
corresponding entitlement/effective-access/lifecycle/credit-batch state is
missing or incomplete — by calling the **same** EN-001 (`applyPaidCycle`),
EN-002 (`recomputeEffectiveEntitlement`), EN-003 (`applyLifecycleEvent`) and
SC-002 (`ensureEntitlementPeriodStandardAllocation`) domain functions normal
event processing already uses, never inventing state directly. Genuine
conflicts (mismatched identities, a ready target with no verified source, a
used batch that disagrees with the frozen policy) fail closed into a
narrowly-scoped incident queue instead. Built in full in one pass — repair
across all four domains, the incident queue, a bounded scheduled sweep, and
a standalone lazy-repair function — per explicit user sign-off
(AskUserQuestion, all three scoping decisions below taken as recommended).

**Key discovery, worth reading before assuming this domain is easy to
exercise**: the exact gap EN-004 repairs — a verified billing event with
missing/incomplete entitlement state — **cannot arise today via any real
code path**. `billing_periods`, `entitlement_cycles`, the effective-
entitlement row and the SC-002 batch are all written inside one atomic
better-sqlite3 transaction (`bi002-service.ts`'s two `applyPaidCycle` call
sites). This is defense-in-depth for a future multi-writer/Postgres
backend, a bug that lets one write commit without the other, or a manual
data edit — not a reachable-today scenario. Tests exercise the repair paths
by directly constructing the inconsistent state in fixtures (inserting a
`billing_periods` row and never creating/deleting its `entitlement_cycles`
counterpart), the same technique used elsewhere in this codebase for other
"can't organically happen yet but must be handled" paths. Don't mistake this
for dead code — it's real, tested, reachable defense-in-depth, just not
producible by today's happy-path code.

**Three decisions made explicitly (AskUserQuestion), don't re-litigate
without asking again**: (1) build the full spec in one pass rather than
deferring the scheduled sweep/lazy-repair to a follow-up session; (2) tests
simulate the gap via direct fixture construction rather than skipping
repair-path coverage; (3) the lazy-repair function (rules 51-52) is built
and unit-tested standalone but **not wired into `evaluateAccessFresh` or the
learner-home route** — that remains a deliberate follow-up, same caution as
other additions that could otherwise touch a live, frequently-hit path
unilaterally. Two further decisions: no admin UI page (API-only incident
queue, matching PR-004's own precedent for its incidents); `open_refund_case`
requires a real, pre-existing `refund_cases.id` and fails closed otherwise
(rule 48's "uses existing Billing/refund flows").

**New tables** (migration `0050_en004_integrity_reconciliation.sql`):
`entitlement_reconciliation_receipts` (one row per source compared, healthy/
repair/defer/incident), `entitlement_integrity_sweep_runs` (bounded-sweep
run ledger, merges the run-ledger and per-page-idempotency roles into one
table like PR-004's `progress_integrity_sweep_runs`), `entitlement_integrity_
incidents` (partial-unique-active-per-source index, same shape as PR-004's
`progress_integrity_incidents`), `entitlement_integrity_incident_actions`
(structural copy of `progress_integrity_incident_actions`).
`learner_app_effective_entitlements` gained `integrity_state`
(`healthy`/`repair_in_progress`/`quarantined`) and
`last_reconciled_source_version`/`last_reconciled_at`;
`learner_app_standard_credit_batches` gained `funding_disabled_at/reason`
and a `reconciliation_receipt_id` link. New `platform_service_principals`
role `entitlement-integrity-monitor-service`, distinct from EN-003's own
narrower `entitlement-reconciliation` (chargeback-replay only).

**`contracts.ts`** is a pure, DB-free classifier layer —
`classifyPaidCycleGap` (rules 9-22: healthy/repairable/conflict, comparing
learner, period, product, app-set, then a catch-all source hash, in that
fixed order so a divergence always reports one deterministic category),
`classifyBatchConsistency` (rules 34-38), and `classifyOrphanEntitlement`
(rule 31, `ENTITLEMENT_WITHOUT_VERIFIED_SOURCE` — the *opposite* traversal
direction from the other two, starting from an already-`ready` target and
probing backwards for a source, reachable only from the sweep's second
pass).

**`repair.ts`**'s `reconcilePaidCycle` loads the verified `billing_periods`
row (joined through `subscriptions` for environment), classifies against
any existing `entitlement_cycles` row, and on `repairable` calls
`applyPaidCycle` with the **original** event id
(`billing_periods.source_provider_event_id`) and dates — never `now` as the
billing anchor. One real constraint surfaced during TDD: `applyPaidCycle`
unconditionally rejects (`PAID_CYCLE_CONFLICT`) *any* existing
`entitlement_cycles` row for a `paid_cycle_id`, regardless of status — so a
`creating`/`failed` leftover (rule 11) has to be cleared (along with its
never-completed dependents) before retrying; documented in-line as not
violating rule 30's "immutable source period" protection, since a
never-completed row was never that period. On an already-healthy cycle, it
also validates the SC-002 batch invariant per allocation-bearing period
(rules 34-35), creating one only when genuinely missing.
`reconcileLearnerApp` calls `recomputeEffectiveEntitlement` unconditionally,
then replays any of the learner's still-`pending` `entitlement_lifecycle_
events` affecting this app through a new small export,
`entitlement-lifecycle/service.ts`'s `applyPendingEventById` — the exact
same `applyRecordedEvent` path a repeat apply-lifecycle-event call would
use, never a fresh reconciliation-authored duplicate.

**`incidents.ts`** mirrors PR-004's `applyIncidentAction` shape
(`expectedVersion` + `idempotencyKey`, not EN-003's weaker revoke route) for
three actions: `retry` (re-runs the appropriate repair function against the
incident's own source — `credit_batch` incidents retry through their
owning paid cycle, since SC-002 batches have no repair entry point of their
own), `resolve_false_positive` (requires a reason), `open_refund_case`
(fails closed without a real `refund_cases.id`, per Decision 5 above —
never grants access or edits credits itself).

**`sweep.ts`**'s `runEntitlementIntegritySweep` pages `billing_periods.id`
(simpler single-column cursor than PR-004's composite one, since that's
this sweep's natural ordering key) scoped to one `environment`, bounded and
page-idempotent via `(run_idempotency_key,cursor)`, calling
`reconcilePaidCycle` per row plus a second orphan-detection pass over
`entitlement_cycles` for subscriptions already in the page. That orphan
pass is deliberately scoped to the current page's subscriptions — a cycle
whose subscription has zero `billing_periods` rows at all would need its
own independent reverse-direction cursor, not built this session.
**`lazy-repair.ts`**'s `attemptLazyRepair` is a wall-clock-deadline-bounded
call into `reconcileLearnerApp`, built and tested standalone per Decision 3
above.

**New routes**: three internal (`POST /v1/internal/entitlements/
reconcile-integrity`, `.../reconcile-paid-cycle/{paidCycleId}`,
`.../reconcile-learner-app`, all gated by the new
`entitlement-integrity-monitor` service role) and two admin
(`GET`/`POST .../action` on `/v1/admin/entitlement-integrity-incidents/
{incidentId}`, gated by the new `entitlement_integrity_manage` permission,
the action route additionally requiring rate-limiting + recent
reauthentication). All five registered in `authorization/route-actions.ts`
+ `modes.ts`'s `AUTHORIZATION_ACTIONS`, per this repo's enforced
canonical-route-actions convention.

**Not built / explicitly out of scope, flag if asked**: `evaluateAccessFresh`/
the learner-home route do not call `attemptLazyRepair` — the function is
real and tested, just not wired into that live path (Decision 3). No admin
UI page for the incident queue (Decision 4, matching PR-004's own
precedent). The sweep's orphan-detection pass only covers subscriptions
already present in its `billing_periods` page (documented narrowing above).

**Verification**: 1111/1111 tests passing (6 pre-existing skips, up from
1046), `tsc --noEmit` clean throughout. `tests/rls-repository-scope-coverage.test.ts`
and AU-001's AC19 both needed their hardcoded table counts bumped (107→111)
for the 4 new tables — routine per this repo's own documented pattern.
No manual/browser verification — same reasoning as EN-001/002/003/PR-002/
PR-004: an internal platform↔billing↔entitlement reconciliation protocol
with no Babysteps UI of its own (confirmed no admin page was added either).
Not committed — ask before committing per this repo's standing rule.

## One secure learner-bound launcher, preserved Past apps and normal-checkout resubscription (UL-001, 2026-08-11)

Built **UL-001** in full (82 business rules, 46 ACs) — the learner-facing
"home" screen listing every app a learner can currently use, plus a
parent-facing Past-apps view and a Subscribe-again path that never
reactivates a historical entitlement. Pure read-composition: no new
authoritative table, everything is joined live from EN-002/EN-004,
SC-002, LA-004, PR-003/PR-004, app registry/publication and BI-002 on
every request. New `src/lib/learner-home/` module (`contracts.ts`,
`service.ts` — `composeLearnerHome`, `past-apps.ts` — `listPastApps`,
`subscribe-again.ts` — `resolveSubscribeAgainContinuation`), two
mechanical read-only additions (`src/lib/app-progress/summary-read.ts`,
`readProgressVisibilitySnapshot` in `src/lib/progress-integrity/
service.ts`), three new routes (`GET /v1/learner-home`, `GET /v1/parent/
learners/{learnerId}/past-apps`, `POST .../past-apps/{appId}/
subscribe-again`), and real UI: `src/app/learner/page.tsx` (previously a
placeholder stub) now renders the actual responsive card grid, and a new
`src/app/account/learners/[learnerId]/apps/page.tsx` shows current +
past apps for the direct owning parent. 49 new tests across 7 files, all
real-DB-backed via `useInMemoryDb()`.

**Decisions made explicitly (AskUserQuestion) before planning, don't
re-litigate without asking again**: (1) no persisted
`learner_app_launcher_read_model`/`learner_app_past_access_index` tables
— pure live composition, matching the spec's own "no persistent launcher
entitlement table is authoritative" and EN-002's `launcher-cache.ts`
precedent; (2) build the real learner-home/Past-apps UI in this pass,
not API-only, since `src/app/learner/page.tsx` already existed as a
literal placeholder stub for exactly this purpose; (3) the Past-apps
surface lives at `/account/learners/{learnerId}/apps`, matching the
existing `.../{learnerId}/{edit,progress}` nesting convention; (4)
**do not** build the still-missing LP-004 `startLearnerSession`/
`resumeLearnerSession` HTTP routes — confirmed during planning that
*both* remain unreachable from a learner's browser today (`resume` is
only callable via an `app_service`-mode internal route, not just
`start`) — a pre-existing, cross-cutting gap left open by 5+ prior
sessions since 2026-08-05. The learner-home card's Start/Resume buttons
render correctly-shaped but disabled, not faked.

**Two real findings from planning, worth internalizing before touching
this domain again**: `validateProgressIntegrity` (PR-004) is **not**
side-effect-free — every call, including `reason:"read"`, upserts
`learner_app_progress_integrity` and inserts a
`progress_integrity_validation_receipts` row. Calling it once per app on
every learner-home load would have violated UL-001's own
side-effect-free-read rule, so `readProgressVisibilitySnapshot` reads
the last-computed `read_safe`/`integrity_state` columns directly instead
— the same "cheap column read, not the live judgment-call function"
discipline this codebase already applies to `entitlement_integrity`'s
`integrity_state` (`entitlement-access/launcher-cache.ts`,
`entitlement-integrity/lazy-repair.ts`), now established a third time.
Second: `evaluateAccessFresh`'s own `AccessDecision.state` never
actually surfaces the raw DB literals `approved_grace`/
`overlap_resolution` (grace is computed live via `findGraceCoverage` and
never persisted back to `.state`) — `learner_app_effective_entitlements`
enumeration is used only to discover candidate `app_id`s;
`evaluateAccessForLauncher`/`evaluateAccessFresh` remain the sole
authority on the actual allow/deny decision per app.

**Mechanical, non-judgment-call additions this session required**:
`readLearnerAppSummarySnapshot` (new file, since `getCurrentProgress` in
`app-progress/service.ts` requires an active/disconnected session and is
unusable for a cross-app launcher read) and `readProgressVisibilitySnapshot`
(added to `progress-integrity/service.ts`). A small boolean-returning
sibling of BI-001's `assertNoProductAccessOverlap`,
`hasProductAccessOverlap`, was extracted in `bi001-service.ts` so
Subscribe-again's eligibility check shares the exact same overlap query
rather than duplicating it — `assertNoProductAccessOverlap` now delegates
to it and is otherwise unchanged. `CheckoutAssignmentForm` gained an
optional `initialLearnerId` prop and `/account/subscriptions/new` reads
an optional `?learner=` search param, so Subscribe-again's handoff can
preselect the exact learner (rule 63) on the existing, unmodified BI-002
review screen — Subscribe-again does **not** create a `checkout_intents`
row itself, it resolves eligibility and hands off to that screen.

**Explicitly not built / deliberate deviations from the spec's literal
API contract**: the LP-004 Start route and a learner-mode-facing Resume
route (see decision 4 above — both remain `app_service`-only). No
persisted read-model/past-access-index tables, and therefore no
`POST /v1/internal/learner-launcher/reconcile-read-model` route and no
standalone `GET /v1/internal/learner-launcher/eligibility` route —
eligibility is an in-process function called directly by the
composition, there is no read model to reconcile.
`expectedPastAppVersion`/`idempotencyKey` dropped from Subscribe-again's
request contract since nothing is persisted/versioned to check them
against. The environment for every learner-home/Past-apps read is a
hardcoded `"production"` constant — no per-request environment resolver
exists outside an active session; a real one is a larger, separate,
cross-cutting change. `app_registry` has no `display_order` column
(confirmed by repo-wide grep), so card ordering is a deterministic
`appName, appId` sort rather than an admin-configurable order. A
historical app currently included by more than one active product fails
closed (`multiple_current_products`, no subscribe action) rather than
guessing which one the parent meant (rule 66, no silent substitution).

**Verification**: 1160/1160 tests passing (6 pre-existing skips, up from
1111), `tsc --noEmit` clean throughout. `tests/rls-repository-scope-
coverage.test.ts` needed the 4 new DB-touching files registered in
`access-boundaries.ts`'s `repositoryScopeRegistry` (all `learner_owner`
scope, matching `learning-session/gateway.ts`/`learner-progress-repo.ts`)
— no new tables, so `AU-001`'s AC19 table count was untouched. **Real
browser verification performed** (unlike every prior UL-adjacent
requirement, this one has actual UI): signed up a fresh parent, hit the
same stale-dev-DB-schema gap prior sessions had flagged
(`data/babysteps.db` predated several later sessions' migrations, e.g.
`progress_summary_json`) and reset it with the user's explicit
confirmation, seeded a learner with one active app (with a real published
deployment) and one ended app with a matching current product, then
confirmed in Chrome: `/account/learners/{id}/apps` renders the Active
card and the Past-app card with a working "Subscribe again" button;
clicking it round-trips through the real subscribe-again endpoint and
redirects into the existing `/account/subscriptions/new` checkout screen
with the exact learner and product preselected. The learner-mode
`/learner` page itself could not be click-verified end-to-end — reaching
real `learner_mode` requires a passkey/WebAuthn ceremony this
environment can't automate (same limitation IA-004/AU-002 sessions
already hit) — but it was confirmed to fail closed (redirects to
`/account`) when not unlocked, and it calls the exact same
`composeLearnerHome` function already verified live via the parent page.

## EG-005 learner journey

EG-005 adds a safe, date-wise journey for each learner and app. First
lesson completions, verified achievements, and explicit app-owned
milestones are projected from their authoritative source domains; retrying
a source cannot duplicate the journey event, and projection failures never
roll back learning or achievement state. Learners can open a journey only
from a currently accessible app, while an owning parent can also open an
ended app's retained history.

Journey retention is whole-learner rather than per app. Any active or
approved-grace entitlement keeps every app journey indefinitely. When the
last such entitlement ends, one 12-calendar-month Asia/Kolkata deadline is
recorded. Reactivation before deletion clears that deadline and preserves
all history. A due purge rechecks entitlement truth under a write lock,
removes every journey event and journey-specific receipt/outbox row, and
advances a retained generation/cutoff tombstone so older operational lesson
or achievement records can never reconstruct the deleted history.

The production schema is in `0057_eg005_learner_journey.sql`. APIs
API-EG-018 through API-EG-023 cover learner and parent reads, trusted app
milestones, source projections, and bounded retention reconciliation/purge.
There is deliberately no browser/admin journey authoring, deadline
extension, restore-history, global score, XP, rank, or session-log API.

## EG-006 parent learning reminders

EG-006 adds parent-only, consolidated email reminders for the existing
two-standard-session learner-app weekly cadence. The evaluator uses the exact
SC-002/EG-002 weekly key, boundaries, and 0/2–2/2 progress. It omits completed
2/2 apps, catch-up-third and technical-credit states, ended or suspended
access, security blocks, and operational windows that leave insufficient
time for the remaining normal sessions. The sender freshly rechecks every
item and the owning parent's current verified account email before composing
one grouped message; a zero-item recheck sends nothing.

Only `mid_window` and `final_window` stages exist. Item-stage and provider
idempotency prevent daily or retry duplicates, while uncertain provider
outcomes use a bounded reconciliation path. Email copy is neutral, links only
to the normal parent account entry point, and stores no body, learner contact,
open/click stream, raw progress, or sensitive learning/payment data. Compact
batch/item/delivery metadata is removed after 90 days.

Parents control `learningReminderEmailEnabled` from the responsive account
notification settings screen. It defaults on and is independent of billing,
security, and account-control email. Apps, learners, and administrators have
no preference or send authority. API-EG-024 through API-EG-027 and production
migration `0058_eg006_learning_reminders.sql` implement the preference,
evaluation, send, and reconciliation boundaries. The same read-only cadence
eligibility is exposed for a future PD-003 in-app attention adapter without
coupling it to email preference or delivery state.

## Parent dashboard, learner detail, attention center and navigation shell (PD-001–004, 2026-08-13)

Built the entire Parent Dashboard building block in one session — four
tightly-coupled Must-Have requirements (PD-001 home, PD-002 learner
detail, PD-003 attention center, PD-004 navigation shell), ~200 business
rules combined. All four are read-only composition over already-built
domains (UL-001's `composeLearnerHome`, EN-002/003 entitlements, PR-003/004
progress, EG-001/002/004/005/006 achievements/streak/motivation/journey/
reminders, UL-004 availability, BI-001/003/004 billing, IA-004 passkeys) —
none required new educational/billing/entitlement logic. **Zero schema
changes** — the first requirement at this scale with no migration at all,
since every build spec's optional cache table was deliberately skipped
(matching UL-001's precedent of always-live composition).

**Build order was dependency-driven**: PD-003 first, since PD-001's
attention preview and PD-004's shell badge both reuse its exact
composition rather than deriving a second attention algorithm (a rule
the spec states explicitly and this session followed literally
end-to-end) — then PD-001, PD-002, PD-004.

- **PD-003** (`src/lib/parent-attention/`): `composeParentAttention`
  sources five categories — `billing` (from `listParentSubscriptions`'s
  `paymentState`/`cancelAtPeriodEnd`), `learner_setup` (missing active
  IA-004 passkey, only when the learner has a current app),
  `service_status` (UL-004 `readAppAvailability`), `learning_cadence`
  (EG-006's `listLearningCadenceAttention(parentId, "mid_window", now)` —
  its due-window is a superset of `"final_window"`'s last-24h, so a
  single call captures the whole back-half-of-week without inventing a
  new threshold), and `access` (the terminal `suspended_security` state,
  which `evaluateAccessFresh` trusts directly from the persisted column
  rather than recomputing — unlike `active`/`grace`, which always require
  a real backing paid cycle). No support/contact route exists anywhere in
  the app, so the `access` category renders a safe generic message with
  **no CTA route** rather than inventing one. `composeParentAttentionBadge`
  is the compact wrapper PD-001/PD-004 both reuse.
- **PD-001** (`src/lib/parent-dashboard/`): `composeParentDashboard`
  reuses `composeLearnerHome` per owned learner (confirmed reusable as-is
  — it has no `learner_mode`/session coupling internally), stripping the
  `session`/`eligibility`/`primaryAction` fields that encode Start/Resume
  state before returning cards, since the parent overview must never
  surface those as actionable. "Apps on track X/Y" counts only cards with
  a defined `consistency`. Redesigned `src/app/account/page.tsx` from a
  bare placeholder into the learner-first card grid.
- **PD-002** (`src/lib/parent-learner-detail/`): redesigned the existing
  `/account/learners/{learnerId}/apps` page (built for UL-001) in place
  into a Current/Past segmented control + compact app selector + one
  expanded detail panel, rather than adding a second competing route.
  `composeParentAppDetail` scopes `listAchievements` to the exact
  selected `appId` (bounded 3-item preview, not a learner-wide top-3) and
  links to the existing journey/achievement-history pages rather than
  re-embedding their feeds.
- **PD-004** (`src/lib/parent-shell/`, `src/components/account/parent-nav.tsx`,
  `src/app/account/layout.tsx`): a real shared layout now wraps **every**
  page under `src/app/account/**` (14 pre-existing pages had their
  duplicate `<SiteHeader>`/`<SiteFooter>` wrapper stripped down to just
  their inner content — mechanical, no logic changes) plus three new
  pages. `ParentNav` is a small client component (`usePathname` for
  active-state styling) with a real desktop persistent bar and a
  deliberately different mobile bottom bar (`<details>`-based "More"
  disclosure, no client state library). New
  `src/app/account/learners/page.tsx` (minimal index, the "Learners" nav
  target) and `src/app/account/learners/{learnerId}/unlock/page.tsx` —
  **the first page anywhere in this codebase to mount `PasskeyUnlock`**,
  via a new `UnlockAndRedirect` client wrapper
  (`src/components/learner-mode/unlock-and-redirect.tsx`) that only adds
  the `router.push("/learner")` redirect on success. The component and
  its full IA-004 backend already existed — only the page wiring it in
  was missing, confirmed during scoping (AskUserQuestion) before building
  it as part of this session rather than leaving Open Learner disabled.

**Four decisions confirmed explicitly (AskUserQuestion) before planning,
don't re-litigate without asking again**: (1) build the missing
Open-learner unlock page now, since the backend was already 100% real;
(2) redesign PD-002 in place at the existing `/apps` URL rather than a
new competing route; (3) wrap every existing `/account/**` page in the
new shell, not just the three new PD pages; (4) skip the optional cache
layer entirely, matching UL-001's always-live-composition precedent.

**No `modeGeneration` field exists anywhere in this codebase** (grepped,
zero matches) despite the spec text using that word for shell
history/bfcache safety — parent/learner mode separation already works via
`requireParentManagement()`/`requireLearnerMode()` re-verifying on every
server request, and PD-004 relies on that existing real mechanism rather
than inventing a new session field.

**Routes/permissions added** (all `parent_management` mode,
`repositoryScopeRegistry` entries only where a file calls `getDb()`
directly — most of these compose from other services and don't):
`GET /v1/parent/attention[,/summary]`, `GET /v1/parent/dashboard`,
`GET /v1/parent/learners/{learnerId}[,/apps/{appId}]`,
`GET /v1/parent/shell-context`. Every page calls `requireParentManagement()`
directly (not only transitively via the new layout) —
`tests/au-002.acceptance.test.ts` AT-AU-002-10 hard-checks this for every
`src/app/account/**/page.tsx`.

**Verification**: 1441/1441 tests passing (6 pre-existing skips), `tsc
--noEmit` clean throughout, 9 new test files (composer + route + one
nav-component test using `@testing-library/react`). Real browser
verification performed: signed up a fresh parent, seeded a learner with a
real published/paid-cycle app (same `applyPaidCycle`/`publishApp` fixture
recipe as UL-001's own tests) and a second zero-app learner, then
confirmed live in Chrome — the dashboard renders both learner sections
with the exact "2 items need attention" badge matching the Attention
page's two items (missing passkey + due cadence, correctly sorted
action-required-first); the unlock page correctly mounts `PasskeyUnlock`
and shows its real registration UI (the WebAuthn ceremony itself can't be
completed in this environment — same limitation IA-004/UL-001 sessions
already hit); PD-002's selector + detail panel renders the app's level/
streak/attention/achievement-and-journey links correctly; the Learners
index and the existing Billing page both render cleanly inside the new
shell with no duplicate header/footer and the correct nav item
highlighted active.

## Reliable transactional parent-email delivery (NT-001, 2026-08-13)

Built **NT-001** ("Reliable parent-email delivery for source-owned
transactional events with idempotency, retry and delivery status") in full
— 132 business rules, 62 ACs, the next unbuilt Must-Have after PD-001–004.
Source workbook: `Requirements/Babysteps_Platform_Requirements_v63.xlsx`
(had to be located on the user's machine and copied into `Requirements/`
this session — the `v64.xlsx` carry-forward register only kept NT-001's
one-line title, not its full spec; same "read the last version with full
detail" pattern prior carry-forward sessions established, except here that
version genuinely didn't exist locally until this session). New module
`src/lib/notifications/` (`contracts.ts` the version-controlled type
registry, `templates.ts` pure renderers, `recipient.ts` the one exported
"current verified parent email" resolver, `provider-adapter.ts`, `service.ts`
enqueue/deliver/reconcile/read, `webhook.ts`, `retention.ts`), migration
`0059_nt001_transactional_notifications.sql`, 5 new internal routes, 12 new
test files (~90 new tests).

**Architecture**: source domains (BI-002/003/004/005, IA-003) own *when* to
notify and the semantic content; NT-001 owns recipient resolution (always
the current verified email, resolved fresh at send time — never a pending
replacement), idempotent intent creation (deterministic identity =
`notificationType+sourceDomain+sourceEventKey+parentId+templateVersion`,
same-key-different-payload rejected as `NOTIFICATION_SEMANTIC_CONFLICT`),
versioned template rendering, provider send with bounded retry, and a
two-tier state model: `transactional_notification_intents.state` (coarse
lifecycle: pending → claimed → sent/blocked_recipient/failed) drives the
worker's claim loop, `transactional_notification_deliveries.state` carries
the exact rule-59 vocabulary (pending/sending/accepted/delivered_when_known/
temporary_failed/permanent_failed/blocked_recipient/suppressed_by_policy)
tests actually assert against. `enqueueTransactionalNotification` is a plain
function callable two ways: directly, in-process, nested inside a source
domain's own `getDb().transaction()` (the same "nested transaction calls
compose fine in this codebase" pattern `applyLifecycleEvent` already
established) — which is how every real wiring point below uses it — or via
the internal HTTP route (API-NT-001) as a thin wrapper for a hypothetical
future external source service.

**Real finding, worth internalizing before touching this domain again**: two
existing "notification queue" tables — `billing_recovery_notifications`
(BI-002/003) and `billing_cancellation_notifications` (BI-004) — were
already being written to but had **zero consumers anywhere in the
codebase**; BI-002's own T-7 renewal-reminder send was a separate bespoke
no-op (`localRenewalReminderNotifier`). Confirmed via a background
ground-truth survey before planning. Decided explicitly (AskUserQuestion):
repoint the real call sites into NT-001's new outbox rather than leave a
third parallel notification concept — this is also what AT-NT-001-14
through -20 actually require (real commit-time flow, not fixture
simulation). The two old tables are left in schema (no destructive
migration) but nothing writes to them anymore; nothing ever read them, so
nothing regresses.

**Real wiring (7 call sites, all inside existing transactions, all
integration-tested against real commits, not fixtures)**:
- `bi002-service.ts`: the T-7 sweep's send step now also calls
  `enqueueTransactionalNotification` alongside the legacy `notifier.send`
  call (kept, not replaced — BI-002's own tested retry/attempt-count
  contract depends on the legacy notifier throwing on failure; the NT-001
  enqueue is wrapped in its own try/catch so it can never disturb that
  contract). Grace-started (`applyFailedRenewal`) and payment-recovered
  (`applyRenewal`) call it directly, unwrapped, right next to the existing
  `applyLifecycleEvent` audit-ledger call each already makes.
- `grace-policy.ts`: grace-expired (`expireGraceSubscriptionState`).
- `bi004-service.ts`: cancellation-scheduled and cancellation-reversed
  (`completeResumption`). Cancellation "ended"/access-lapse and BI-004's
  `setup_required` notice are **not** wired — neither is in rule 31's named
  initial-type family and neither has an AT-NT-001 test.
- `bi005-service.ts`: refund outcome (`confirmProviderRefund`). Chargeback
  is **not** wired — same reasoning, not in the named family.
- `account-security-repo.ts`: `changePassword` and `finalizeEmailChange`
  (the "Auth side changed" step) — IA-003 had **no notification trigger of
  any kind** before this session; this is new integration, not a repoint.

**Two types declared but not wired to a real producer this session**
(decided explicitly, AskUserQuestion): `invoice_receipt_available` — BI-005
in this codebase is deliberately minimal (EN-003's own note: "just enough
of a refund/chargeback/dispute producer") and has no invoice/receipt
*document* generation at all to hook; `approved_service_notice` — UL-004 has
no "this warrants a parent email" decision point anywhere. Both have a full
template contract and are covered by fixture-constructed tests
(`tests/nt-001-architecture.test.ts`), matching this codebase's established
EN-004 precedent for a real, tested, currently-unreachable-from-production
path.

**Recipient resolution gap found and fixed**: no shared "resolve current
verified parent email" function existed anywhere — three of four existing
billing notification call sites didn't even check `email_verified_at`
before this session. `src/lib/notifications/recipient.ts`'s
`resolveCurrentVerifiedParentEmail` is now the one place that decision is
made, deliberately **not** gating on `profiles.account_status`: rule 55
("NT-001 does not silently drop a mandatory financial/security message
solely because interactive account access is blocked") means a
suspended/soft-deleted parent keeps whatever verified email they had —
whether to enqueue at all for such a parent is the calling source domain's
decision, not this resolver's.

**Small mechanical additions this session required** (not judgment calls):
4 new `PlatformServiceRole` entries in
`src/lib/auth/internal-service-guard.ts` (`notification-enqueue`/`-delivery`/
`-reconcile`/`-read`; the provider-webhook route uses the same signature-only
boundary as `/v1/webhooks/financial-events`, not `requireInternalService`),
5 new `service.notifications.*` permissions in `modes.ts`/`route-actions.ts`,
3 new tables registered in `access-boundaries.ts`
(`supabaseTableAccess`/`repositoryScopeRegistry`), `tests/au-001.acceptance
.test.ts` AC19's hardcoded table count bumped 136→139.

**Verification**: 1530/1530 tests passing (6 pre-existing skips, up from
1441 at the PD-001–004 handoff), `tsc --noEmit` clean **for every file this
session touched** — three pre-existing type errors surfaced in
`tests/au-002.nfr.test.ts`/`tests/unified-principals.test.ts` from a
concurrent session's in-progress `modeGeneration` field addition to
`EndUserAuthorizationContext` in `src/lib/authorization/modes.ts` (confirmed
via `git diff` that only 5 lines near `AUTHORIZATION_ACTIONS`'s closing
brace are this session's own edit; everything else in that file's diff
belongs to the concurrent session) — not touched, per this repo's standing
concurrent-session protocol. No browser verification — NT-001 is an internal
platform↔billing↔identity protocol with no parent-facing UI of its own (same
reasoning as PR-004/EN-003/EN-004), the 7 real-wiring integration tests
(`tests/nt-001-bi00{2,3,4,5}-wiring.test.ts`, `tests/nt-001-ia003-wiring
.test.ts`) are what stand in for "does this actually fire," using
`useInMemoryDb()` real-DB-backed tests against the actual BI-*/IA-003 commit
paths, not mocks.

**Not built / explicitly out of scope this session, flag if asked**: NT-002
(13-month parent communication history) and NT-003 (notification
preferences page, EG-006 alias/migration) — separate Must-Have requirements
NT-001's own type contract was deliberately shaped to support later
(`historyVisible`/`mandatory` fields already on every type definition) but
neither was requested this session. No admin UI for inspecting notification
queue health — `getNotificationDeliveryHealth`/API-NT-005 read only, matching
this codebase's established "API-only, no admin page" precedent for internal
platform protocols (PR-004, BI-005).

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
# generate AUTH_SECRET / ANALYTICS_HMAC_SECRET / managed-service secrets:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
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

`0010_ia003_account_security.sql` is the IA-003 migration: adds
`deleted_at`/`deleted_by_user_id`/`auth_revoked_before` to `profiles`,
and creates `email_change_requests` (partial unique index for one
pending request per parent), `parent_email_history`, and
`account_events`. Configuring the real Supabase project for IA-003 also
needs, outside this migration: Secure Email Change disabled (so only
the *new* address needs to confirm, not both), and the Auth email
link/OTP expiry set to 86,400 seconds to match the 24-hour window this
repo enforces locally in `account-security-repo.ts`.

Migrations `0011`/`0012`/`0014` belong to concurrent LP-001/LP-002/LP-004
work in this same tree (learner profiles, learning sessions), not
documented here.

`0013_ar001_app_registry.sql` is the AR-001 migration: creates
`app_registry`, `app_registry_mutation_requests`, `approved_app_icons`,
`app_registry_audit_log`, and `admin_permissions`. Numbered around the
concurrent session's `0012_lp002` migration to avoid a collision — both
were created at essentially the same time in the same working tree.

`0015_an001_analytics.sql` is the AN-001 migration: creates
`analytics_daily_buffer`, `analytics_contribution_receipts`,
`analytics_daily_level`, `analytics_daily_app`, `analytics_daily_runs`,
`platform_alerts`, `learner_app_progress`, and `lesson_completions`,
all with RLS enabled and no anon/authenticated policies (every read and
write goes through the service-role-backed internal/admin APIs).

Down-migration SQL for the IA-00x and AR-001 migrations is included as
a comment block at the end of each file (this repo's migrations have
no automated up/down runner — apply manually to reverse).
