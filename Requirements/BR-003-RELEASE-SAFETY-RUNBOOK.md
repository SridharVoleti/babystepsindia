# BR-003 — Deployment Checks, Migration Safety, Smoke Tests & Rollback Evidence

Gap ID `BR3-G01` / Building Block BB-18 / Requirement BR-003.

## Status of this document

Unlike BR-001/BR-002, most of BR-003's machinery already existed before this issue — built during
an earlier AR-002 session, before the audit that raised this gap even ran. This document is
primarily an index into that existing machinery, plus the record of the 3 genuine gaps this build
closed. The one remaining manual step (enabling GitHub branch protection to actually require the
new CI checks below before merge) has never been done, since this repository has no branch
protection configured today — see ["One-time repository configuration"](#one-time-repository-configuration).

## What already existed (AR-002, unchanged by this build)

1. **Required checks before production** — `src/lib/deployment-release/service.ts`'s
   `createRelease` requires every field of `ReleaseGateResults` (dependency install, typecheck,
   lint, unit tests, contract tests, security, build) to be `true`, or the release is created with
   `status='gate_failed'` and `RELEASE_GATE_FAILED` is thrown.
2. **Preview/staging validation** — `src/lib/deployment-staging/service.ts`'s `deployToStaging`
   checks provider readiness, origin approval, health, manifest identity, and progress-schema
   compatibility before a release can become `verified`.
3. **Production promotion gate** — `src/lib/deployment-production/service.ts`'s
   `approveProduction` requires a ready deployment window, a verified+enabled production binding,
   a `verified` release, a `published` staging deployment, AND
   `assertReleaseSchemaCompatibility` (`src/lib/progress-schema-registry/service.ts`) — an existing
   app-schema compatibility gate, though scoped to learner progress-data schema, not raw SQL DDL
   (see the new migration-safety gate below for that).
4. **Reversible Vercel release / rollback** — `src/lib/deployment-rollback/service.ts`'s
   `rollbackProduction` re-promotes the previous healthy deployment and atomically swaps the
   publication pointer back; traceable via `app_deployments.status='rolled_back'` plus a
   `deployment_operation_requests` row.
5. **Automated regression → rollback** — `sweepReleaseSafetyObservations` runs a real 10-minute,
   once-a-minute post-publish observation window; 3 consecutive availability failures or 1
   identity/SSO integrity failure triggers the exact same `rollbackProduction` core a manual admin
   rollback uses — this IS the "critical smoke tests run after meaningful deployment" mechanism.
6. **Deny-by-default authorization** — 12+ `admin.deployment.*`/`deployment.*` actions
   (`src/lib/authorization/modes.ts`), all `mode:"administrator"`, granted only to
   `operations_administrator`. Manual rollback additionally requires an AD-004 operation-change
   record (`requireOperationChangeForMutation`, confirmed present in
   `src/app/v1/admin/apps/[appId]/deployments/[deploymentId]/rollback/route.ts`) and a live
   two-factor reauth receipt before it runs.
7. **Canary/blue-green deliberately absent** — matches the frozen rule "keep canary/blue-green out
   of V1"; there is exactly one production publication pointer per app+environment, swapped
   atomically, never a gradual traffic split.

## What this build actually changed

1. **Rollback alerting routed through AN-003's shared primitive.** `alertAdministrators`
   (`src/lib/deployment-rollback/service.ts`) previously wrote directly to `platform_alerts` with
   its own bespoke dedup-by-`deploymentId` query — a second, parallel alert mechanism alongside
   AN-003's `raiseDeduplicatedAlert`/`resolveDeduplicatedAlert`, unsurprising since AN-003 (issue
   #26) was built in a later session than AR-002. Now calls `raiseDeduplicatedAlert` directly, with
   the alert_type scoped per deployment (`deployment_automated_rollback:${deploymentId}`, the same
   scoping pattern AN-003's own `escalatePersistentJobFailures` uses) so two different apps rolling
   back concurrently can't collide under `raiseDeduplicatedAlert`'s own global-per-alert_type dedup.
   A successful rollback also resolves any earlier `..._failed` alert for the same deployment —
   this is the literal "significant unresolved regression invokes rollback + AN-003
   alert/communication" closure criterion, now through the canonical alerting path.
2. **Migration safety gate.** `scripts/check-migration-safety.mjs` (new) scans every
   `supabase/migrations/*.sql` file for drop-table/drop-column/rename-column/rename-table/
   alter-column-type patterns — the DDL shapes most likely to break "backward-compatible with the
   immediately previous app where practical." A file containing the literal comment
   `-- BR-003: reviewed-breaking-change` is exempted (a reviewable diff line making a deliberate
   breaking change explicit, not a silent bypass) — added to 3 pre-existing, already-shipped
   migrations (`0009`, `0020`, `0037`) that legitimately drop/rename as part of already-reviewed
   feature work, confirmed by reading each one's own inline rationale before adding the marker.
   `npm run check:migrations` runs it standalone.
3. **CI required-checks workflow.** `.github/workflows/release-safety-checks.yml` (new) — a
   `required-checks` job (`npm run typecheck && npm test`, the full suite, not just the narrow
   architecture subset the pre-existing `architecture-boundaries.yml` runs) and a
   `migration-safety` job (`npm run check:migrations`), both on every PR and push to `main`.

## Migration remediation policy (frozen, `03_v64_Requirements`)

> Incorrect migrations are normally corrected by tested forward migration; BR-002 restore is
> reserved for actual recovery scenarios.

A bad migration is fixed by writing and shipping a new, tested forward migration through the same
release gate above — never a manual hotfix applied directly to the production database, and never
reached for as a first resort to a full BR-002 disaster-recovery restore, which is for genuine data
loss/corruption, not an ordinary schema mistake.

## One-time repository configuration

This repository has no GitHub branch protection rule today. For the two jobs above to actually
**block** a merge (rather than just report status), a repository administrator must, once:

1. Go to Settings → Branches → Branch protection rules for `main`.
2. Require status checks to pass before merging: `required-checks` and `migration-safety` (from
   `release-safety-checks.yml`), plus the pre-existing `application-platform-boundary` (from
   `architecture-boundaries.yml`).
3. Do **not** additionally require canary/blue-green or environment-approval gates — out of V1
   scope per the frozen rule above.
