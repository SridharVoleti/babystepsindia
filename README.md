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
allocation-bearing before creating a credit batch). Both are **partial,
scoped builds** — their full specs depend on the entire BI-001..BI-005
billing/checkout domain (product catalog, webhook-verified payment,
grace/cancellation lifecycle) and EN-003 (lifecycle states like
`suspended_financial`), none of which exist anywhere in this codebase.
Building "the rest" isn't deferred by oversight — it's genuinely
unbuildable without those first. See the two requirements' rows in the
v18 spec and the session handoff notes for the exact scope boundary.

**EN-001 — `src/lib/entitlement-cycle/service.ts`, `applyPaidCycle()`**:
a pure event consumer. No BI-002/BI-005 webhook producer exists yet, so
the caller (a future billing service, or a manual/test caller) supplies
a complete, well-formed paid-cycle event — including its own immutable
purchased-app-id snapshot, since there's no bundle catalog table to
re-derive one from either. Idempotent by `(paidCycleId, eventId)`; a
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

**Explicitly not built**: checkout overlap prevention (`check-product-overlap`,
`PRODUCT_ACCESS_OVERLAP`) — no checkout flow exists to call it; EN-003
lifecycle states (grace, refund, financial/security suspension) — no
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
