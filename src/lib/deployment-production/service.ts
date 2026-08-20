import { randomUUID } from "node:crypto";
import { AppRegistryError } from "@/lib/app-registry/errors";
import { computeRequestHash } from "@/lib/app-registry/validation";
import { assertAppOperational } from "@/lib/db/app-registry-repo";
import { getDb } from "@/lib/db/client";
import { getBinding } from "@/lib/deployment-binding/service";
import { isOriginApproved } from "@/lib/deployment-pipeline/approved-domains";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";
import {
  beginDeploymentOperation,
  checkDeploymentIdempotency,
  completeDeploymentOperation,
} from "@/lib/deployment-pipeline/idempotency";
import type { DeploymentProvider } from "@/lib/deployment-provider/types";
import { getLatestDeployment, type DeploymentView } from "@/lib/deployment-staging/service";
import { getRelease, type ReleaseView } from "@/lib/deployment-release/service";
import { assertReleaseSchemaCompatibility, ProgressSchemaRegistryError } from "@/lib/progress-schema-registry/service";

type PublicationRow = {
  app_id: string;
  environment: string;
  current_published_deployment_id: string | null;
  previous_healthy_deployment_id: string | null;
  version: number;
  published_at: string | null;
};

export type PublicationView = {
  appId: string;
  environment: string;
  currentPublishedDeploymentId: string | null;
  previousHealthyDeploymentId: string | null;
  version: number;
  publishedAt: string | null;
};

function toPublicationView(row: PublicationRow): PublicationView {
  return {
    appId: row.app_id,
    environment: row.environment,
    currentPublishedDeploymentId: row.current_published_deployment_id,
    previousHealthyDeploymentId: row.previous_healthy_deployment_id,
    version: row.version,
    publishedAt: row.published_at,
  };
}

export function getPublication(appId: string, environment: string): PublicationView | null {
  const row = getDb().prepare("select * from app_environment_publications where app_id = ? and environment = ?").get(appId, environment) as
    | PublicationRow
    | undefined;
  return row ? toPublicationView(row) : null;
}

// AC24/29: the sole trusted source for "which deployment does a brand-new
// learner session get" — resolves strictly through the atomic publication
// pointer, never by scanning for a status='published' row. AR-002 session 1
// deliberately does not wire this into learning-session/gateway.ts's
// startLearnerSession (concurrently owned, fast-moving file) — see README
// for the explicit integration gap; this function is the correct, tested
// seam for whichever session wires it in next.
export type TrustedDeploymentResolution = {
  deploymentId: string;
  releaseId: string;
  environment: string;
  origin: string;
  launchPath: string;
  compatibilityPassed: boolean;
  dispatchBlocked: boolean;
};

// Session 2: backs the spec's GET /v1/internal/apps/{appId}/deployment-start-block
// (business rules 29, 39, 52). dispatchBlocked/compatibilityPassed now read
// the same app_deployment_launch_controls projection
// resolveTrustedDeployment (src/lib/app-launch/deployment.ts) already reads
// for an existing session's dispatch — same source of truth, just keyed by
// app+environment instead of an existing session's deployment_id, since a
// brand-new start has no session yet to key by.
export function getPublishedDeployment(appId: string, environment: string, now: Date = new Date()): TrustedDeploymentResolution | null {
  const publication = getPublication(appId, environment);
  if (!publication?.currentPublishedDeploymentId) return null;
  const deployment = getDb()
    .prepare("select * from app_deployments where id = ?")
    .get(publication.currentPublishedDeploymentId) as { id: string; release_id: string; verified_origin: string } | undefined;
  if (!deployment) return null;
  const release = getRelease(deployment.release_id);
  if (!release) return null;
  const controls = getDb()
    .prepare("select * from app_deployment_launch_controls where deployment_id = ?")
    .get(deployment.id) as { drain_starts_at: string | null; deployment_window_ends_at: string | null; status: string; compatibility_status: string } | undefined;
  const inWindow = !!controls &&
    (controls.status === "draining" || controls.status === "deploying" ||
      (!!controls.drain_starts_at && now >= new Date(controls.drain_starts_at) &&
        (!controls.deployment_window_ends_at || now < new Date(controls.deployment_window_ends_at))));
  return {
    deploymentId: deployment.id,
    releaseId: release.id,
    environment,
    origin: deployment.verified_origin,
    launchPath: release.manifest.launchPath,
    compatibilityPassed: controls ? controls.compatibility_status === "passed" : true,
    dispatchBlocked: inWindow || (!!controls && controls.status !== "published"),
  };
}

function requireActiveApp(appId: string) {
  try {
    return assertAppOperational(appId);
  } catch (error) {
    if (error instanceof AppRegistryError) throw new DeploymentPipelineError(error.code);
    throw error;
  }
}

export type ApproveProductionInput = {
  appId: string;
  releaseId: string;
  adminUserId: string;
  idempotencyKey: string;
  deploymentWindowId: string;
};
export type ApproveProductionResult = { release: ReleaseView; deployment: DeploymentView; publication: PublicationView };

type WindowGateRow = { app_id: string; release_id: string; starts_at: string; status: string };

// AT-AR-002-17..26: production promotion — permission/reauth are enforced
// by the calling route (mirrors AR-001's activate/soft-delete pattern: a
// fresh password re-check per sensitive call, not a cached timestamp), so
// this service starts from "an already-authorized admin approved this
// exact release."
export async function approveProduction(
  input: ApproveProductionInput,
  provider: DeploymentProvider,
  now: Date,
): Promise<ApproveProductionResult> {
  requireActiveApp(input.appId);

  // AT-AR-002-38 (business rule 38): no immediate unscheduled promotion —
  // queried by raw SQL rather than importing deployment-window/service.ts,
  // which itself imports approveProduction for its own sweep; this keeps
  // the dependency one-directional.
  const window = getDb()
    .prepare("select app_id, release_id, starts_at, status from app_deployment_windows where id = ?")
    .get(input.deploymentWindowId) as WindowGateRow | undefined;
  if (!window || window.app_id !== input.appId || window.release_id !== input.releaseId) {
    throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_NOT_FOUND");
  }
  if ((window.status !== "scheduled" && window.status !== "executing") || now.getTime() < new Date(window.starts_at).getTime()) {
    throw new DeploymentPipelineError("DEPLOYMENT_WINDOW_NOT_READY");
  }

  const binding = getBinding(input.appId, "production");
  if (!binding || binding.bindingStatus !== "verified") throw new DeploymentPipelineError("DEPLOYMENT_PROJECT_NOT_VERIFIED");
  // Business rule 39: soft-deleted apps are already rejected by
  // requireActiveApp above; deployment_enabled=false is the other half.
  if (!binding.deploymentEnabled) throw new DeploymentPipelineError("DEPLOYMENT_PIPELINE_DISABLED");

  const release = getRelease(input.releaseId);
  if (!release || release.appId !== input.appId) throw new DeploymentPipelineError("RELEASE_NOT_FOUND");

  if (release.status === "promoted") {
    const existing = getLatestDeployment(input.appId, input.releaseId, "production");
    const publication = getPublication(input.appId, "production");
    if (existing && publication) return { release, deployment: existing, publication };
  }
  if (release.status !== "verified") throw new DeploymentPipelineError("RELEASE_NOT_VERIFIED");

  const staging = getLatestDeployment(input.appId, input.releaseId, "staging");
  if (!staging || staging.status !== "published") throw new DeploymentPipelineError("RELEASE_NOT_VERIFIED");

  // PR-001/GAP-037/059: a release whose progress schema has no safe
  // forward+rollback migration path from every schema_version still in use
  // by an existing learner never reaches production.
  try { assertReleaseSchemaCompatibility(input.appId, input.releaseId, now); }
  catch (error) {
    if (error instanceof ProgressSchemaRegistryError) throw new DeploymentPipelineError(error.code);
    throw error;
  }

  const hash = computeRequestHash({ appId: input.appId, releaseId: input.releaseId, deploymentWindowId: input.deploymentWindowId });
  const cached = checkDeploymentIdempotency<ApproveProductionResult>(input.adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  const db = getDb();

  // AT-AR-002-20: concurrent production promotions for the same app
  // serialize — an already-processing promotion for this app (any admin,
  // any idempotency key) blocks a second one from starting.
  db.transaction(() => {
    const inFlight = db
      .prepare(
        `select 1 from deployment_operation_requests
         where app_id = ? and operation = 'approve_production' and status = 'processing'`,
      )
      .get(input.appId);
    if (inFlight) throw new DeploymentPipelineError("DEPLOYMENT_PROMOTION_IN_PROGRESS");
    beginDeploymentOperation({
      actorPrincipalId: input.adminUserId,
      appId: input.appId,
      idempotencyKey: input.idempotencyKey,
      operation: "approve_production",
      hash,
    });
  })();

  let outcome: { passed: false; code: string } | { passed: true };
  let promoteOrigin = "";
  let promoteProviderDeploymentId = "";
  try {
    const promoteResult = await provider.promote({
      providerTeamId: binding.providerTeamId,
      providerProjectId: binding.providerProjectId,
      providerDeploymentId: staging.providerDeploymentId,
    });
    const providerReady = promoteResult.status === "ready" && !!promoteResult.origin;
    const originApproved = providerReady && await isOriginApproved(promoteResult.origin);
    const healthCheck = providerReady && originApproved ? (await provider.checkHealth({ origin: promoteResult.origin, healthPath: release.manifest.healthPath })).healthy : false;
    promoteOrigin = promoteResult.origin;
    // Real providers promote a deployment in place (same provider-side ID,
    // new production alias/origin) — our schema keeps one row per
    // environment materialization, so the production row's stored
    // provider_deployment_id is disambiguated from the staging row's,
    // rather than colliding with app_deployments' unique constraint.
    promoteProviderDeploymentId = `${promoteResult.providerDeploymentId || `unavailable-${randomUUID()}`}::production`;
    outcome = providerReady && originApproved && healthCheck
      ? { passed: true }
      : { passed: false, code: !providerReady ? "PRODUCTION_VALIDATION_FAILED" : !originApproved ? "DEPLOYMENT_ORIGIN_REJECTED" : "PRODUCTION_VALIDATION_FAILED" };
  } catch {
    outcome = { passed: false, code: "PRODUCTION_VALIDATION_FAILED" };
  }

  const nowIso = now.toISOString();
  const finalize = db.transaction(() => {
    if (!outcome.passed) {
      // AC22-23: current publication is left completely untouched; only
      // the failed attempt itself is recorded for audit.
      const deploymentId = randomUUID();
      db.prepare(
        `insert into app_deployments
         (id, app_id, release_id, binding_id, environment, provider_deployment_id, verified_origin, status,
          validation_summary_json, started_at, validated_at)
         values (?, ?, ?, ?, 'production', ?, ?, 'failed', ?, ?, ?)`,
      ).run(deploymentId, input.appId, input.releaseId, binding.id, promoteProviderDeploymentId || `unavailable-${deploymentId}`, promoteOrigin, JSON.stringify({ passed: false }), nowIso, nowIso);
      const failureResult = { failed: true, code: outcome.code };
      completeDeploymentOperation({ actorPrincipalId: input.adminUserId, idempotencyKey: input.idempotencyKey, result: failureResult, deploymentId });
      return { passed: false as const, code: outcome.code };
    }

    const priorPublication = getPublication(input.appId, "production");
    if (priorPublication?.currentPublishedDeploymentId) {
      db.prepare("update app_deployments set status = 'superseded', superseded_at = ? where id = ?").run(nowIso, priorPublication.currentPublishedDeploymentId);
      // Main Flow step 26 / rule 58's inverse: on safe completion the
      // start-block is removed. The just-superseded deployment may have
      // been the one a window drained toward this exact publish (session
      // 2's deployment-window/service.ts) — clear its drain timing now
      // rather than waiting for the window's raw ends_at to pass, so an
      // existing session still on it isn't held blocked for the remainder
      // of a window that has, in fact, already completed safely.
      db.prepare(
        "update app_deployment_launch_controls set drain_starts_at = null, deployment_window_ends_at = null, version = version + 1, updated_at = ? where deployment_id = ?",
      ).run(nowIso, priorPublication.currentPublishedDeploymentId);
    }

    const deploymentId = randomUUID();
    db.prepare(
      `insert into app_deployments
       (id, app_id, release_id, binding_id, environment, provider_deployment_id, verified_origin, status,
        validation_summary_json, started_at, validated_at, published_at)
       values (?, ?, ?, ?, 'production', ?, ?, 'published', ?, ?, ?, ?)`,
    ).run(deploymentId, input.appId, input.releaseId, binding.id, promoteProviderDeploymentId, promoteOrigin, JSON.stringify({ passed: true }), nowIso, nowIso, nowIso);

    db.prepare(
      `insert into app_environment_publications (app_id, environment, current_published_deployment_id, previous_healthy_deployment_id, version, published_at)
       values (?, 'production', ?, ?, 1, ?)
       on conflict(app_id, environment) do update set
         previous_healthy_deployment_id = app_environment_publications.current_published_deployment_id,
         current_published_deployment_id = excluded.current_published_deployment_id,
         version = app_environment_publications.version + 1,
         published_at = excluded.published_at`,
    ).run(input.appId, deploymentId, priorPublication?.currentPublishedDeploymentId ?? null, nowIso);

    db.prepare("update app_releases set status = 'promoted', version = version + 1 where id = ?").run(input.releaseId);

    // Derived projection for LA-001/LP-004's existing dispatch-block read
    // path (resolveTrustedDeployment) — one row per historical deployment,
    // keyed by this new deployment_id; prior rows are never mutated so an
    // existing session bound to an older deployment_id is unaffected
    // (AC25) by a later publication.
    db.prepare(
      `insert into app_deployment_launch_controls
       (deployment_id, app_id, release_id, environment, immutable_origin, launch_path, compatibility_status, status, version, updated_at)
       values (?, ?, ?, 'production', ?, ?, 'passed', 'published', 1, ?)`,
    ).run(deploymentId, input.appId, input.releaseId, promoteOrigin, release.manifest.launchPath, nowIso);

    // Business rules 32-33: starts the ten-minute/one-check-per-minute
    // release-safety observation window. deployment-rollback/service.ts's
    // sweepReleaseSafetyObservations reads this row; restart-safe by
    // construction since the state lives here, not in process memory.
    db.prepare(
      "insert into app_deployment_safety_observations (deployment_id, app_id, started_at) values (?, ?, ?)",
    ).run(deploymentId, input.appId, nowIso);

    // Business rule 60 / AT-AR-002-38: the window is a one-shot approval
    // target — completing it here (not only from deployment-window's own
    // sweep) means a manual admin approval via this route also frees the
    // app up to have a new window scheduled, and a stale/reused window can
    // never gate a second promotion (the readiness check above only
    // accepts status scheduled/executing).
    db.prepare("update app_deployment_windows set status = 'completed', completed_at = ?, version = version + 1, updated_at = ? where id = ?")
      .run(nowIso, nowIso, input.deploymentWindowId);

    const deploymentView = getLatestDeployment(input.appId, input.releaseId, "production")!;
    const publicationView = getPublication(input.appId, "production")!;
    const result: ApproveProductionResult = { release: getRelease(input.releaseId)!, deployment: deploymentView, publication: publicationView };
    completeDeploymentOperation({ actorPrincipalId: input.adminUserId, idempotencyKey: input.idempotencyKey, result, deploymentId });
    return { passed: true as const, result };
  });

  const finalized = finalize();
  if (!finalized.passed) throw new DeploymentPipelineError(finalized.code);
  return finalized.result;
}
