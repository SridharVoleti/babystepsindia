# BR-002 — Supabase Restore Runbook, Reconciliation & Six-Month Recovery Test

Gap ID `BR2-G01` / Building Block BB-18 / Requirement BR-002. Read
[BR-001's runbook](BR-001-BACKUP-RUNBOOK.md) first — this document assumes the same backup and
builds the restore/drill procedure on top of it.

## Status of this document

Same reality as BR-001: this codebase has never been deployed to a real Supabase production
project, so no drill has ever actually been run and no evidence record exists yet. What follows
is the pinned procedure and the evidence system, ready for the first drill once production exists.

## Frozen policy (BR-002)

1. **Super Admin uses Supabase-native restore to a known-good daily backup.** No custom restore
   tooling is built in this codebase — the restore itself happens through Supabase's own console/
   CLI, into a **restricted, temporary project**, never directly into the production project.
2. **No customer traffic or unintended outbound processing during the drill.** The temporary
   project must use non-production credentials for every external provider (payment, email,
   deployment/hosting) — dummy or sandboxed keys only, so a restored copy of production data can
   never actually charge a card, send a real email, or trigger a real deployment. This is a
   provisioning-time isolation guarantee, not a runtime toggle in the production app.
3. **After restore, in order:**
   1. Confirm outbound-processing suppression is in place (rule 2) before doing anything else.
   2. Replay PC-004 deletion obligations — run `replayDeletionObligations`
      (`src/lib/data-retention/service.ts`) against the restored temp project's database, so any
      learner data whose erasure had already completed before the backup was taken is re-erased.
   3. Reconcile externally-authoritative billing events — run BI-002's `reconcileBilling`
      (`src/lib/billing/bi002-service.ts`) against the temp project for the relevant date range,
      using the (sandboxed) payment provider's own reconciliation feed.
   4. Reconstruct derivable state — re-run AN-001's `runDailyAggregation` for the affected activity
      dates and AN-002's `syncMonitoringSnapshots`/`compactMonitoringHistory`
      (`src/lib/monitoring/service.ts`) against the temp project, per BR-001's derived-vs-
      authoritative table classification.
   5. Validate critical flows — exercise a representative set of this codebase's existing
      acceptance suites (e.g. `tests/ia-001.test.ts`, `tests/bi-001-routes.test.ts`,
      `tests/pd-001-*.test.ts`) against the temp project's connection, or manually walk the
      equivalent flows in a deployed instance pointed at it. This step is inherently manual —
      there is no automated way for this codebase to exercise a live temp-project connection from
      within a test run.
4. **Record evidence, then destroy the temporary project.** Every drill produces a
   `disaster_recovery_test_records` row in the **production** database (see below) — backup
   chosen, each step above confirmed with notes, and the temp project's teardown confirmed.
5. **Only Super Admin has default restore authority.** Both creating and updating a recovery-test
   evidence record require holding all 4 staff roles (`requireSuperAdminApi`,
   `src/lib/auth/admin-api-guard.ts` — the same gate AN-004 introduced for unrestricted analytics,
   reused as-is here). Reading the evidence log is available to any Platform Administrator.
   Separately and outside this codebase entirely: whoever holds Supabase project owner/admin
   credentials capable of performing the actual restore should be limited the same way — a
   production access-control decision, not something this application's authorization system can
   enforce.

## Evidence ledger (real, buildable today)

`disaster_recovery_test_records` (production database) is the compliance record BR-002's closure
criteria describe. It never orchestrates a live restore — it only records what a human operator
did, after the fact, against a temp project this app never connects to.

- `POST /v1/admin/platform/recovery-tests` — Super-Admin-only. Starts a record: which backup,
  which temp project, whether outbound-processing suppression was confirmed in place.
- `PATCH /v1/admin/platform/recovery-tests/{id}` — Super-Admin-only. Records the outcome
  (confirmed + free-text notes) of any of the four validation steps, and/or confirms teardown.
  A record is automatically marked `completed_at` the moment all four steps are confirmed.
- `GET /v1/admin/platform/recovery-tests` / `GET .../{id}` — any Platform Administrator. Read-only
  view of the evidence log.

## Six-month cadence

This is a manual scheduling responsibility, not something this codebase can trigger on its own —
there is no production infrastructure for a scheduled job to run a real Supabase restore against.
The evidence ledger's `started_at` column is the auditable record of when the last drill actually
happened; reviewing it periodically is how staleness against the ~6-month target is checked.
