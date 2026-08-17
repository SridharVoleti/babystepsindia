# PC-001 development handoff

Last updated: 2026-08-17 (Asia/Kolkata)

Status: IMPLEMENTATION COMPLETE / VALIDATED — PC-001 ONLY

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

## Implemented

### Personal Data Catalog and fail-closed policy

Added `src/lib/privacy-governance/catalog.ts` and `src/lib/privacy-governance/policy.ts`.

The catalog is version controlled (`pc-001-v1`) and declares, per data element, its subject, owning requirement, purpose, classification, authoritative store, allowed consumers/surfaces, app/log/telemetry/analytics rules, retention authority and sharing authority.

Policy enforcement now provides:

- default denial for unknown data elements or uses;
- purpose-specific and consumer-specific least privilege;
- rejection of incomplete/contradictory catalog entries;
- prohibition of learner email/phone/contact data;
- prohibition of advertising, advertising profiles, session replay, learner surveillance and behavioral tracking;
- default denial for device permissions unless a future frozen requirement explicitly catalogs one;
- one-authoritative-store validation for raw personal-data elements;
- explicit raw-to-derived authorization rather than treating derivation services as ordinary raw-data consumers.

### Learner DOB boundary

`learner.date_of_birth` remains authoritative only in `learners.date_of_birth` and is directly consumable only by the learner-profile authority.

Two explicit platform-internal derivations are authorized:

- raw DOB -> `learner.age_derived` for `app_launch_service`;
- raw DOB -> `learner.analytics_age_band` for `analytics_service`.

The existing launch implementation continues to send only `age_years`, `age_months` and `age_as_of_date`; repository guards fail if raw DOB is added to the bootstrap assertion.

Permanent AN-001 aggregates continue to contain age band only, with no learner ID, parent ID or raw DOB.

### BI-004 notification minimization

Removed raw parent-email persistence from the BI-004 cancellation notification writer.

Added `src/lib/billing/notification-recipient.ts`. The billing notification service resolves the current authoritative `users.email` only at the actual delivery boundary, after PC-001 purpose/consumer authorization.

Added Supabase migration `0051_pc001_privacy_minimization.sql`, which physically drops `billing_cancellation_notifications.recipient_email`.

The local SQLite test harness still contains BI-004's historical nullable compatibility column in its bootstrap schema. PC-001 application code cannot populate it; the BI-004 acceptance test proves the queued value stays null, the safe context contains no email, and changing `users.email` after queueing causes delivery resolution to use the new authoritative address. This preserves the privacy invariant without changing unrelated local-database bootstrap mechanics.

The queue's subscription reference is classified as pseudonymous/personal linkage rather than incorrectly labeled non-personal.

### Security inventory and CI enforcement

The new notification-recipient database reader is classified as `platform_service` in the deny-by-default repository scope registry.

Added `tests/pc-001.acceptance.test.ts` and `tests/pc-001.repository-guard.test.ts` covering the frozen PC-001 invariants and known implementation boundaries.

Added `.github/workflows/pc001-privacy.yml`, which runs dependency installation, TypeScript compilation and the full Vitest regression suite on the PC-001 branch, pull requests and master.

The repository's separate legacy `npm run test:architecture` command is intentionally not part of the PC-001 workflow because it currently fails on unchanged `master`: `architecture/app-platform-boundary-allowlist.json` references `apps/ChessMaster/...` paths while the repository has no tracked `apps/` directory. PC-001 did not modify those Consumer App boundary files. PC-001's own architecture/data-boundary guards and `rls-repository-scope-coverage.test.ts` are part of the passing full Vitest suite.

## Validation record

GitHub Actions PC-001 privacy gate run `32000605103` on code head `01fa0aa2bbc855bdde43f55cdca8d2e0a12c016d` passed:

- `npm ci` — PASS
- `npm run typecheck` — PASS
- `npm test` — PASS

Earlier gate runs correctly caught and drove fixes for:

- a TypeScript catalog-derivation typing error;
- the old BI-004 test that expected duplicate raw email persistence;
- the missing RLS/repository-scope classification for the new delivery-time reader.

## Completion gate

- [x] PC-001 acceptance tests pass.
- [x] Full existing Vitest regression suite remains green.
- [x] TypeScript compilation is clean.
- [x] Raw learner DOB remains restricted to its authoritative profile store and approved platform-internal derivations.
- [x] Learning apps receive approved derived age only.
- [x] Permanent analytics remains age-band/anonymous only.
- [x] Cancellation notifications do not persist duplicate raw parent email.
- [x] Unknown/unregistered personal-data uses fail closed.
- [x] Prohibited tracking/advertising/session-replay purposes cannot be authorized.
- [x] Device permissions are deny-by-default.
- [x] The Personal Data Catalog is version controlled and validates successfully.
- [x] New database access is explicitly classified under the existing deny-by-default boundary inventory.
- [x] No PC-002, PC-003, PC-004 or PC-005 behavior has been implemented in this branch.

PC-001 is complete. The next privacy requirement, when explicitly started, is PC-002 — Consent Management.
