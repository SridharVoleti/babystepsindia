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

## Verification

- Full Vitest suite: 58 test files, 477 tests passed.
- TypeScript: `npm run typecheck` passed.
- `git diff --check` passed.

## Remaining AN-001 gaps

Remaining known gaps from the audit:

1. Validate real calendar dates consistently on all analytics routes.
2. Add granular analytics-read permission and recent reauthentication for retry where required.
3. Add a dedicated AT-AN-001-01 through AT-AN-001-35 traceable acceptance suite and operational/NFR tests.
4. Configure and observe the production scheduler; code exists, but successful deployed execution is not yet evidenced.

## Next-session starting point

- Start with gap 1: replace regex-only date checks with one shared strict calendar-date validator and apply it to every analytics route/filter boundary.
- Follow TDD with invalid leap days, impossible month/day combinations, and valid leap-day coverage.
- Re-run the full suite because entitlement development is continuing concurrently and may change the architecture inventory or test count.

## Shared-worktree note

The worktree contains concurrent changes from another development session. Nothing was staged or committed during this handoff. Preserve unrelated changes and inspect `git status` before any future staging or commit.
