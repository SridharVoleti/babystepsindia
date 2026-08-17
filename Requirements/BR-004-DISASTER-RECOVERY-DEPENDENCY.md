# BR-004 — PaaS Disaster-Recovery Dependency & Post-Recovery Procedure

Gap ID `BR4-G01` / Building Block BB-18 / Requirement BR-004. Read
[BR-001](BR-001-BACKUP-RUNBOOK.md), [BR-002](BR-002-RESTORE-RUNBOOK.md) and
[BR-003](BR-003-RELEASE-SAFETY-RUNBOOK.md) first — BR-004 is the one BR-* requirement that
introduces no new capability of its own; it names the platform-level dependency underneath all
three and points back at their procedures for what happens after that dependency recovers.

## Frozen policy (BR-004)

> Babysteps shall rely on the disaster-recovery capabilities provided by its underlying PaaS
> platforms, including Vercel and Supabase. No separate Babysteps-specific disaster-recovery
> infrastructure is required for V1. Provider recovery processes are used for platform-wide
> disasters; Babysteps-specific recovery/reconciliation remains governed by BR-002 and BR-003.

This is the one requirement in the whole BR-* set whose own audit finding was a compliment, not a
gap: *"the architecture correctly avoids a custom DR stack."* The only real gap was that this
dependency, and the handoff back to BR-002/BR-003 once a provider recovers, had never been written
down anywhere in the repository. Confirmed the same 3 sessions later — this codebase still, today,
has no custom backup/dump/PITR tooling (`tests/br-001-architecture.test.ts`, `package.json`
scan) and no duplicate privileged data copy: every "copy" this session's own audit found
(`monitoring_job_snapshots`/`monitoring_job_monthly_aggregates`, AN-002) is explicitly
observational and non-authoritative by construction, never a second source of truth.

## Provider dependency and ownership

- **Vercel** — application hosting, build/deploy pipeline, and Vercel's own platform-level
  disaster recovery for the hosting/edge layer. BR-003's release/rollback machinery operates
  *within* a running Vercel platform; it has no answer for "Vercel itself is down."
- **Supabase** — the Postgres database, including the provider-native daily backup BR-001
  documents. A Supabase platform-wide outage or the underlying infrastructure disaster is
  Supabase's own recovery responsibility, not something BR-001's backup evidence or BR-002's
  restore-drill ledger can substitute for.
- **Ownership/escalation**: whoever holds Vercel and Supabase organization/project owner
  credentials is, by construction, the only population that can even observe or act on a
  provider-wide incident — this is the same production-access population BR-001/BR-002 already
  scope their one-time manual configuration steps to. There is no separate BR-004-specific role;
  escalation for a provider-wide disaster routes to whoever holds that production access today.
- **Provider status as the source of truth**: Vercel's own status page
  (`https://www.vercel-status.com`) and Supabase's own status page
  (`https://status.supabase.com`) are the authoritative signal for a platform-wide incident.
  Babysteps' own monitoring (AN-002's job-run projection, AN-003's deduplicated alerting) observes
  only this application's own job runs and alert conditions — it has no independent visibility
  into the underlying PaaS infrastructure's health, and isn't meant to; duplicating that would be
  exactly the "unnecessary privileged system" the frozen rule forbids building.

## Post-provider-recovery procedure

Once Vercel and/or Supabase confirm restoration via their own status page, Babysteps does **not**
run a separate BR-004 procedure — it runs the applicable steps BR-002 and BR-003 already define,
same as after any other event that could have left data or a deployment in a stale/inconsistent
state:

1. **If the outage was database-layer (Supabase)**: walk the same four validation steps BR-002's
   evidence ledger tracks for a restore drill — deletion-obligation replay
   (`replayDeletionObligations`), billing reconciliation (`reconcileBilling`), derivable-state
   rebuild (`runDailyAggregation`/`syncMonitoringSnapshots`), and critical-flow validation —
   before treating the service as fully resumed. This is a validation *procedure*, not a BR-002
   restore-drill *evidence record*: BR-002's `disaster_recovery_test_records` table is scoped to
   the temporary-restricted-project drill scenario specifically (`backup_reference`/
   `temp_project_reference` columns describe a disposable temp project, not a live incident on the
   production project itself) — reusing it here would misrepresent what actually happened. A
   provider-wide incident is instead the kind of significant operational event AD-004's existing
   `platform_operation_changes`/`platform_operation_activity` ledger already exists to record, if
   and when a specific triggering mutation needs one; BR-004 itself introduces no new
   `OPERATION_CHANGE_TYPES` entry, since the acceptance test for this requirement
   (`AT-BR-004-01`) is tagged Manual/Provider — the response is procedural, not a new gated
   mutation this codebase's own authorization system needs to intercept.
2. **If the outage was hosting-layer (Vercel)**: once deployments/hosting resume, BR-003's
   existing post-deploy safety observation (`sweepReleaseSafetyObservations`) already re-validates
   availability and identity/SSO integrity for the current production deployment on its normal
   cadence — no separate BR-004-specific smoke suite is needed.
3. **Communication**: if a provider-wide incident caused a significant, unresolved regression, it
   is surfaced the same way BR-003 already surfaces one — through AN-003's deduplicated alerting
   (`raiseDeduplicatedAlert`) — not a fourth, parallel notification mechanism.

## What this requirement explicitly does NOT introduce

- No custom Babysteps disaster-recovery infrastructure, stack, or service.
- No duplicate privileged copy of any authoritative data store.
- No new evidence table, route, or authorization action — BR-004 is fully satisfied by this
  document naming the dependency and the handoff, per its own Manual/Provider acceptance test.
