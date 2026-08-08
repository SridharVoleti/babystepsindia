# AN-001 development handoff

Last updated: 2026-08-07 (Asia/Kolkata)

## Completed in this session

### Daily scheduler (AT-AN-001-09)

- Added `.github/workflows/an001-daily-analytics.yml`.
- Scheduled for `18:45 UTC`, exactly `00:15 Asia/Kolkata`.
- Added `scripts/run-an001-daily.mjs` to derive and submit the explicit previous Kolkata calendar date.
- Added manual workflow dispatch with an optional `YYYY-MM-DD` recovery date.
- Added fail-closed checks for missing configuration and failed HTTP responses.
- Added workflow concurrency protection.
- Added `tests/analytics-scheduler.test.ts`.
- Documented required deployment configuration in `.env.local.example` and `README.md`.

Production activation still requires these GitHub repository secrets after the workflow reaches the default branch:

- `ANALYTICS_BASE_URL`: deployed platform HTTPS origin.
- `ANALYTICS_SCHEDULER_SERVICE_SECRET`: scheduler principal's 32+ character signing secret.
- The platform's `PLATFORM_SERVICE_SECRETS` must independently map
  `analytics-scheduler-v1` and `analytics-contributor-v1` to their matching secrets.

### Session-runtime analytics contributions

- Updated `src/lib/learning-session/gateway.ts`.
- A session contributes `sessions_started=1` only when usable launch is confirmed, not when its reservation is created.
- Confirmation retries use the deterministic contribution ID `session-started:{sessionId}` and cannot double-count.
- Active-to-disconnected transitions contribute:
  - The newly accepted engaged-time delta.
  - One interruption episode.
- Engaged time is capped by the session maximum and server-observed wall-clock time before contribution.
- Cumulative reports contribute only their delta; for example, a report of 100 after an accepted 60 contributes 40.
- Duplicate disconnect deliveries are no-ops.
- Runtime state and analytics contribution are committed in the same SQLite transaction.
- Activity date is derived in `Asia/Kolkata`.
- Age band is derived from restricted learner DOB; DOB and learner ID are not written to permanent analytics.
- Missing level is explicitly routed to the `unassigned` level key.
- Expanded `tests/learner-session-gateway.test.ts` coverage for launch retry, disconnect retry, resume, cumulative delta, and interruption counting.

### Normal-completion engaged-time propagation

- Extended the protected session-completion contract with required `reportedConnectedSeconds`.
- Finalization caps the cumulative report by the configured session maximum and server-observed elapsed wall time.
- Previously accepted disconnect time is the floor, so connected time cannot move backwards.
- Only the difference between the final accepted total and the prior accepted checkpoint is contributed to AN-001.
- The final engaged-time delta, `sessions_completed=1`, session finalization, and credential revocation share one transaction.
- Finalization retries return the original response and cannot double-count analytics.
- Added coverage for direct completion and completion after a prior 60-second checkpoint where a final report of 100 contributes only 40.

### Sweeper interruption propagation

- `sweepExpiredLearnerSessions()` now contributes one AN-001 interruption when an active session disappears and is finalized by the sweeper.
- The deterministic contribution ID `session-swept-interruption:{sessionId}` prevents retry inflation.
- The session interruption count, analytics contribution, terminal state, launch cleanup, and audit event share one transaction.
- A session already in `disconnected` state is not counted again when its recovery window expires because its active-to-disconnected transition already contributed the interruption.
- Added coverage for both abandoned-active and expired-disconnected paths plus repeated sweep idempotency.

### Asia/Kolkata midnight engaged-time splitting (AT-AN-001-14)

- Added `src/lib/analytics/kolkata-interval.ts` to split every accepted integer second at Kolkata calendar boundaries while preserving exact totals.
- Added temporary `learner_sessions.active_segment_started_at` state in the SQLite schema and Supabase migration `0028_an001_midnight_engaged_split.sql`.
- Usable-launch confirmation initializes the active segment; disconnect clears it; successful resume starts a new segment.
- Disconnect and normal-finalization engaged-time contributions now emit a deterministic contribution per affected activity date.
- Session completion/interruption counters remain on the server-observed event date and merge into the appropriate daily buffer grain.
- A disconnected session cannot accrue additional engaged time during finalization.
- Added exact-midnight, month/year rollover, total-preservation, zero-duration, and end-to-end finalization coverage.

### Atomic daily-run claiming (AT-AN-001-10)

- Replaced SQLite's read-then-insert/update claim with an `IMMEDIATE` transaction, conflict-safe insert, and conditional `status='failed'` reclaim.
- Exactly one failed-run claimant changes the row to `running` and increments `run_version`; later contenders observe the current running version without mutation.
- Added Supabase migration `0029_an001_atomic_daily_run_claim.sql` with the database-owned `claim_analytics_daily_run()` function.
- Postgres first creation uses `INSERT ... ON CONFLICT DO NOTHING`; failed-run reclamation uses `SELECT ... FOR UPDATE` before its conditional update.
- Function execution is revoked from public, anonymous, and authenticated roles and granted only to `service_role`.
- Added tests for duplicate first claims, exactly-one failed reclaim, version stability, and required Postgres locking/security semantics.
- When the analytics repository is moved from SQLite to Supabase, its claim operation must call this RPC rather than reproduce claim logic in application code.

### Scoped replay-protected analytics service identities

- Replaced `ANALYTICS_INTERNAL_SERVICE_SECRET` and `x-internal-service-secret` with 60-second managed-service assertions.
- Added distinct `analytics-scheduler` and `analytics-contributor` principals with independently rotatable key references.
- Scheduler assertions are bound to audience `babysteps:internal:analytics:run`; contributor assertions are bound to `babysteps:internal:analytics:contribute`.
- Each route enforces the exact expected service key and audience, so either identity is denied at the other's boundary.
- Assertion signature, issuer/subject, active principal window, issued/expiry times, and maximum lifetime are verified.
- Every `(principal_id, jti)` is consumed atomically in `platform_service_assertion_replays`; replay receives HTTP 409.
- Updated the GitHub scheduler to mint a fresh assertion for every invocation.
- Added Supabase migration `0030_an001_analytics_service_principals.sql` for the two principal records; no secret is stored in the database.

### Server-derived internal counter contributions

- Narrowed `POST /v1/internal/analytics/daily-contribution` to three fields: `learnerSessionId`, deterministic `contributionId`, and an enumerated one-count `eventType`.
- The repository resolves learner, app, current level, date of birth, and Kolkata activity date from the platform-owned learner session.
- Age band is derived server-side; the caller cannot submit age, DOB, learner/app identifiers, date, level, or aggregate dimensions.
- `engagedSeconds` is always zero at this boundary because authoritative engaged time remains owned by the learning-session runtime.
- Unknown fields, arbitrary counter values, and unknown event types fail closed.
- Added validation and repository tests proving the narrowed contract and derived aggregate row.

### Explicit aggregation secret precondition

- `runDailyAggregation()` now validates the dedicated analytics HMAC secret before claiming a daily run.
- Missing or shorter-than-32-character key material throws `ANALYTICS_SECRET_MISSING` explicitly.
- The scheduler HTTP route returns that stable error code with HTTP 500 instead of an opaque framework failure.
- Configuration failure leaves the daily run absent and preserves buffer, receipts, and aggregate rows unchanged.
- Added a repository test covering the complete no-mutation failure behavior.

### Completed-run publication filter for admin aggregates

- Both level and app aggregate read queries now inner-join the matching `analytics_daily_runs` row with `status='completed'`.
- Running, failed, and orphaned aggregate rows are excluded at the repository boundary for both the admin page and API.
- Run-status listings remain unfiltered so administrators can still diagnose incomplete dates.
- Added a repository test covering completed, running, failed, and missing-run states for both aggregate grains.

### Platform-owned analytics level registry

- Added `app_analytics_levels`, keyed by immutable app ID and level key, with active/inactive lifecycle state.
- Added Supabase migration `0033_an001_app_analytics_levels.sql` with forced RLS and service-role-only access.
- Contributions reject unknown and inactive levels with `UNKNOWN_LEVEL_KEY` before creating a daily key, receipt, or buffer row.
- The reserved platform bucket `unassigned` remains valid without an app registry row and cannot be registered as an ordinary app level.
- Daily aggregation revalidates every retained buffer level and fails while retaining source data if an invalid key bypassed the contribution boundary.
- Added TDD coverage for unknown, inactive, reserved fallback, and tampered-buffer paths.

### Strict analytics calendar-date validation

- Added one shared `isStrictCalendarDate()` validator for canonical, real Gregorian `YYYY-MM-DD` values.
- Replaced regex-only checks at the admin aggregate API, run-list API, retry API, internal scheduler API, admin aggregate page, admin run page, and contribution-validation boundaries.
- Impossible API filters now return HTTP 400 instead of being discarded and unintentionally broadening the query.
- Impossible page filters fail closed with an explicit validation message before any analytics read occurs.
- Added coverage for invalid leap days, impossible month/day combinations, canonical formatting, century leap-year rules, valid leap days, every analytics HTTP boundary, and both server-rendered filter pages.

### Granular analytics authorization and retry reauthentication

- Added a separate `analytics_read` permission and enforced it at both cohort-read APIs and both server-rendered analytics pages.
- Coarse administrators and administrators holding an unrelated permission receive HTTP 403 from analytics APIs and cannot load analytics pages.
- Kept `analytics_run_retry` as the distinct mutation permission; an analyst may hold read access without retry authority.
- Every retry now requires the administrator's current password in a strict JSON body and verifies it immediately through the existing stateless reauthentication path.
- Missing, wrong, or cached credentials cannot run aggregation; the retry UI requires a password for each action.
- Added SQLite boot-time and Supabase migration backfills so existing retry-capable administrators retain `analytics_read`, while future grants remain independently assignable.
- Added focused API-guard, page, route, permission-separation, missing/wrong-password, successful retry, and UI request-contract coverage.

### Complete acceptance and NFR suite

- Added `tests/an-001.acceptance.test.ts`, an exactly numbered AT-AN-001-01 through AT-AN-001-35 traceability gate tied to the canonical schema, services, routes, UI boundaries, migrations, and focused behavioral tests.
- Added `tests/an-001.nfr.test.ts` for the 500 ms buffer p95 budget, representative V1 daily-run duration, restart determinism, single-run/control/purge invariants, no raw-event growth, required cohort filters, UTC/Kolkata boundaries, and reversible migrations.
- Added `src/lib/analytics/run-monitor.ts` plus the internal scheduler-only monitor endpoint.
- The independent `00:50 Asia/Kolkata` monitor creates idempotent, identifier-free alerts for missed, failed, and overdue daily runs; the existing `00:15` aggregation schedule remains unchanged.
- Extended the scheduler script and workflow with the independent monitor invocation and added focused invocation tests.
- Corrected lesson-completion analytics to derive the activity date in `Asia/Kolkata` rather than slicing the UTC completion timestamp; added a midnight-boundary regression test.
- Added explicit manual down paths to all incremental AN-001 migrations without attempting to restore purged pseudonymous source rows.
- Added `npm run test:analytics` for the dedicated acceptance/NFR gate.

## Verification

- Dedicated AT-AN-001 acceptance/NFR gate: 2 test files, 48 tests passed.
- Broader analytics regression suite: 22 test files, 230 tests passed.
- Full Vitest suite: 72 test files passed; 619 tests passed and 6 provider-contract tests skipped.
- TypeScript: passed with no errors.
- Repository-scope boundary test: 3 tests passed after registering the new platform-service monitor.
- `git diff --check` passed.

## Open item — production execution evidence

**Status: OPEN (external production configuration/evidence only).**

Configure and observe the production scheduler and its independent monitor. The workflow, service-authenticated endpoints, missed/failed/overdue alerting, and local tests are complete, but successful deployed execution is not yet evidenced.

Closure evidence required:

1. The workflow is present on the GitHub default branch.
2. Actions secrets `ANALYTICS_BASE_URL` and `ANALYTICS_SCHEDULER_SERVICE_SECRET` are configured.
3. The deployed platform maps the scheduler key reference in `PLATFORM_SERVICE_SECRETS`.
4. One `00:15 Asia/Kolkata` aggregation run completes successfully for the explicit previous activity date.
5. One independent `00:50 Asia/Kolkata` monitor run reports `healthy`.

This item does not represent an incomplete AT-AN-001 functional criterion. All 35 acceptance criteria and the locally executable NFR suite are implemented and passing; only production configuration and execution evidence remain open.

## Next-session starting point

- Deploy the workflow to the default branch, configure its documented secrets, and capture one successful daily aggregation plus one healthy `00:50` monitor result.

## Shared-worktree note

The worktree contains this session's AN-001 changes plus concurrent AR-002 deployment work and pre-existing untracked requirements-inspection and `apps/` files. Nothing was staged or committed during this handoff. Preserve unrelated changes and inspect `git status` before any future staging or commit.
