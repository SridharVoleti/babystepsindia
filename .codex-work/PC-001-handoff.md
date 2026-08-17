# PC-001 development handoff

Last updated: 2026-08-17 (Asia/Kolkata)

Status: IMPLEMENTATION STARTED — PC-001 ONLY

Base: `master` at `1472f925bcc28504ad1a0780e37bdc5157e73e52`
Branch: `feature/pc-001-privacy-minimization`

## Frozen requirement

PC-001 — Privacy by Design & Data Minimization

Babysteps must collect, transmit, store, expose, log, analyze, and permit access to only the minimum personal data necessary for an explicitly approved purpose.

Frozen rules:

1. Purpose before collection. No speculative personal-data collection.
2. One authoritative copy of raw personal data wherever practical; consumers use references or derived values rather than duplicate raw values.
3. Prefer derived or pseudonymous data over raw personal data whenever the approved purpose can be met without the raw value.
4. Learner contact data is prohibited.
5. Learner raw date of birth is restricted to the authoritative learner profile. Learning apps must not receive raw DOB.
6. Learning apps may receive only the approved derived age values needed for the learning experience.
7. Analytics may use age bands only; permanent analytics must not contain raw learner identifiers or raw DOB.
8. Logs, telemetry, alerts, and operational records must not contain raw learner personal data unless an approved frozen requirement and Personal Data Catalog entry explicitly permit it.
9. Advertising identifiers, advertising profiles, session replay, learner surveillance, and behavioral tracking are prohibited.
10. Device permissions are denied by default. A permission may be requested only when an approved frozen requirement explicitly requires it and the permission is registered in the Personal Data Catalog.
11. New personal-data fields, API exposure, telemetry, logging, integrations, or administrator capabilities fail closed unless both an approved/frozen requirement and a Personal Data Catalog entry authorize the use.
12. Minimum permissions / least privilege applies to every consumer and administrative access path.

## Personal Data Catalog contract

Every registered personal-data element must declare:

- data element
- subject
- owning requirement
- approved purpose
- classification
- authoritative store
- allowed consumers
- learning-app exposure
- logging / telemetry / analytics permission
- retention authority
- sharing authority

Unknown or incomplete catalog entries are denied by default.

## Existing implementation that PC-001 must preserve

The current repository already contains privacy-aligned behavior that PC-001 must formalize rather than duplicate:

- `src/lib/app-launch/service.ts` derives age from `learners.date_of_birth` and places only derived age (`age_years`, `age_months`, `age_as_of_date`) in the app bootstrap assertion; raw DOB is not sent to the app.
- `supabase/migrations/0015_an001_analytics.sql` stores temporary pseudonymous learner daily keys and age bands, and permanent analytics contains no learner/parent identifier.
- Learning-app launch contracts are already narrow/exact-object contracts and reject destination overrides.

## Known PC-001 remediation targets

1. `billing_cancellation_notifications.recipient_email` currently stores a raw recipient email in a notification queue. PC-001 must remove unnecessary duplicate raw-email persistence and resolve the recipient from the authoritative parent identity at send time, or store only a non-reversible/opaque reference when needed for idempotency/evidence.
2. Notification delivery evidence must be classified as personal/pseudonymous whenever it can identify or link back to a parent recipient; it must not be marked as "no personal data" merely because the raw email is absent.
3. Existing logs/events/JSON metadata must be reviewed so learner raw DOB, learner contact information, free-form personal payloads, and provider raw payloads cannot be introduced without catalog authorization.

## Explicitly out of scope

Do not implement PC-002 consent lifecycle, PC-003 child-interaction controls, PC-004 retention/deletion lifecycle, or PC-005 third-party processor/sharing governance in this branch except where an existing PC-001 data-minimization defect must be corrected without introducing those domains.

## TDD implementation sequence

### RED — acceptance tests first

Add `tests/pc-001.acceptance.test.ts` covering at minimum:

- unknown personal-data element/use is denied
- catalog entry missing any mandatory authority/purpose field is rejected
- learner contact-data registration is rejected
- learner raw DOB is authority-only; app/log/analytics exposure is denied
- derived learner age is permitted for the approved app-bootstrap purpose only
- analytics permits age band, not raw DOB or raw learner ID in permanent aggregates
- unregistered logging/telemetry use is denied
- device permission is denied when not explicitly cataloged
- advertising/session-replay/behavioral-tracking purposes are always denied
- app exposure is least-privilege and purpose-specific
- admin access is denied unless explicitly authorized in the catalog
- raw duplicate parent email cannot be registered as a second authoritative store
- notification-recipient evidence is treated as personal/pseudonymous rather than non-personal

Add targeted regression tests around the cancellation notification flow proving raw recipient email is not persisted in `billing_cancellation_notifications`.

### GREEN — minimum implementation

Create a focused privacy-governance module, for example `src/lib/privacy-governance/`, with:

- typed catalog model
- immutable/version-controlled catalog data
- catalog validator
- fail-closed authorization function for data use/exposure
- purpose and consumer enums/identifiers that do not accept arbitrary free-form values
- explicit prohibited-purpose gate for ads/session replay/behavioral surveillance
- helper for device-permission authorization (default deny)

The catalog is the authority for PC-001 policy, not a second copy of application data.

### Data minimization remediation

Add a forward migration after `0050` that removes `billing_cancellation_notifications.recipient_email` after the application path has been changed to resolve the parent email from the authoritative identity at send time.

Do not copy the parent email into another queue/table as a substitute.

Update the local SQLite schema to remain migration-equivalent.

### CI / architecture enforcement

Add a PC-001 privacy gate to CI that fails when:

- the Personal Data Catalog is invalid/incomplete
- a prohibited purpose is registered
- a learner-contact data category is introduced
- known raw DOB/app/log/analytics invariants regress
- notification queue schemas reintroduce raw recipient email

The gate must be deterministic and must not require production secrets or network access.

## Completion gate

PC-001 is not complete until all of the following are true:

- all new PC-001 acceptance tests pass
- the full existing test suite remains green
- `tsc --noEmit` is clean
- raw learner DOB stays restricted to the learner profile authority
- learning apps receive derived age only
- permanent analytics remains age-band/pseudonymous only
- cancellation notifications no longer persist duplicate raw recipient email
- unknown/unregistered personal-data uses fail closed
- prohibited tracking/advertising/session-replay purposes cannot be authorized
- device permissions are deny-by-default
- the Personal Data Catalog is version-controlled and validates successfully
- no PC-002..PC-005 behavior has been pulled into this change

Only after this gate is satisfied should implementation move to PC-002.
