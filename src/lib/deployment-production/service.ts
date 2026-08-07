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

export function getPublishedDeployment(appId: string, environment: string): TrustedDeploymentResolution | null {
  const publication = getPublication(appId, environment);
  if (!publication?.currentPublishedDeploymentId) return null;
  const deployment = getDb()
    .prepare("select * from app_deployments where id = ?")
    .get(publication.currentPublishedDeploymentId) as { id: string; release_id: string; verified_origin: string } | undefined;
  if (!deployment) return null;
  const release = getRelease(deployment.release_id);
  if (!release) return null;
  return {
    deploymentId: deployment.id,
    releaseId: release.id,
    environment,
    origin: deployment.verified_origin,
    launchPath: release.manifest.launchPath,
    // Backward-compatibility gating (business rules 46-49) and deployment-
    // window drain blocking (AU-001's app_deployment_launch_controls) are
    // both deferred/owned elsewhere — a published deployment is trusted by
    // default here; see README for the explicit gap list.
    compatibilityPassed: true,
    dispatchBlocked: false,
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

export type ApproveProductionInput = { appId: string; releaseId: string; adminUserId: string; idempotencyKey: string };
export type ApproveProductionResult = { release: ReleaseView; deployment: DeploymentView; publication: PublicationView };

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

  const hash = computeRequestHash({ appId: input.appId, releaseId: input.releaseId });
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
    const originApproved = providerReady && isOriginApproved(promoteResult.origin);
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
