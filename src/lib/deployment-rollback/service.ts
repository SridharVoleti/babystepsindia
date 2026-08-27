import { AppRegistryError } from "@/lib/app-registry/errors";
import { computeRequestHash } from "@/lib/app-registry/validation";
import { assertAppOperational } from "@/lib/db/app-registry-repo";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import { getBinding } from "@/lib/deployment-binding/service";
import { isOriginApproved } from "@/lib/deployment-pipeline/approved-domains";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";
import {
  beginDeploymentOperation,
  checkDeploymentIdempotency,
  completeDeploymentOperation,
} from "@/lib/deployment-pipeline/idempotency";
import type { DeploymentProvider } from "@/lib/deployment-provider/types";
import { getRelease } from "@/lib/deployment-release/service";
import { getLatestDeployment } from "@/lib/deployment-staging/service";
import { getPublication, type PublicationView } from "@/lib/deployment-production/service";
import { raiseDeduplicatedAlert, resolveDeduplicatedAlert } from "@/lib/monitoring/alerting";

// AR-002 session 2, business rules 27-29, 33, 35: the single rollback core
// used by both the automated ten-minute release-safety trigger and a
// manual admin action (rule 35 — "manual rollback uses the same automated
// path"). AU-001's own /deployments/{deploymentId}/rollback route
// (src/lib/authorization/deployment-service.ts) is left untouched — its
// acceptance suite (tests/au-001.acceptance.test.ts AC44) locks its five
// actions and mutateDeployment's implementation in place — but that route
// only ever flipped a projection-row status flag between two *already
// published* app_deployment_launch_controls rows; it never touched
// app_environment_publications or called a provider, so it isn't a
// competing writer to the one thing this module owns: the real, atomic,
// provider-confirmed production rollback.
async function requireActiveApp(appId: string) {
  try {
    return await assertAppOperational(appId);
  } catch (error) {
    if (error instanceof AppRegistryError) throw new DeploymentPipelineError(error.code);
    throw error;
  }
}

type DeploymentRow = { id: string; release_id: string; binding_id: string };

export type RollbackProductionInput = {
  appId: string;
  deploymentId: string;
  adminUserId: string;
  idempotencyKey: string;
  reason?: string;
};
export type RollbackProductionResult = {
  publication: PublicationView;
  rolledBackDeploymentId: string;
  restoredDeploymentId: string;
};

async function fail(adminUserId: string, idempotencyKey: string, code: string): Promise<never> {
  await completeDeploymentOperation({ actorPrincipalId: adminUserId, idempotencyKey, result: { failed: true, code } });
  throw new DeploymentPipelineError(code);
}

export async function rollbackProduction(
  input: RollbackProductionInput,
  provider: DeploymentProvider,
  now: Date,
): Promise<RollbackProductionResult> {
  await requireActiveApp(input.appId);

  const publication = await getPublication(input.appId, "production");
  if (!publication || publication.currentPublishedDeploymentId !== input.deploymentId) {
    throw new DeploymentPipelineError("DEPLOYMENT_VERSION_CONFLICT");
  }
  if (!publication.previousHealthyDeploymentId) throw new DeploymentPipelineError("ROLLBACK_TARGET_NOT_AVAILABLE");

  const hash = computeRequestHash({ appId: input.appId, deploymentId: input.deploymentId });
  const cached = await checkDeploymentIdempotency<RollbackProductionResult>(input.adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  // Serializes against any in-flight promotion or rollback for the same
  // app — same in-flight guard shape as approveProduction's own.
  await resolveDbClient().transaction(async (db: DbClient) => {
    const inFlight = await db.get(
      `select 1 from deployment_operation_requests
       where app_id = ? and operation in ('approve_production', 'rollback') and status = 'processing'`,
      [input.appId],
    );
    if (inFlight) throw new DeploymentPipelineError("DEPLOYMENT_PROMOTION_IN_PROGRESS");
    await beginDeploymentOperation({ actorPrincipalId: input.adminUserId, appId: input.appId, idempotencyKey: input.idempotencyKey, operation: "rollback", hash });
  });

  const target = await resolveDbClient().get<DeploymentRow>(
    "select id, release_id, binding_id from app_deployments where id = ?", [publication.previousHealthyDeploymentId]);
  const binding = await getBinding(input.appId, "production");
  const targetStaging = target ? await getLatestDeployment(input.appId, target.release_id, "staging") : null;
  if (!target || !binding || !targetStaging) await fail(input.adminUserId, input.idempotencyKey, "ROLLBACK_FAILED");

  // Rule 33: restore the previous healthy deployment. The provider
  // abstraction has no separate "rollback" primitive (business rule 2's
  // DeploymentProvider interface is verifyProject/deploy/promote/
  // checkHealth only) — re-promoting the target's own already-staged
  // artifact is build-once-safe (rule 14) and exercises the exact same
  // fake-provider-testable path approveProduction already uses.
  let restoredOrigin = "";
  try {
    const result = await provider.promote({
      providerTeamId: binding!.providerTeamId,
      providerProjectId: binding!.providerProjectId,
      providerDeploymentId: targetStaging!.providerDeploymentId,
    });
    if (result.status !== "ready" || !result.origin) await fail(input.adminUserId, input.idempotencyKey, "ROLLBACK_FAILED");
    if (!(await isOriginApproved(result.origin))) await fail(input.adminUserId, input.idempotencyKey, "DEPLOYMENT_ORIGIN_REJECTED");
    restoredOrigin = result.origin;
  } catch (error) {
    // Alternate Flows: "Rollback provider failure: ROLLBACK_FAILED; fail
    // closed, keep last known publication pointer and alert." A
    // DeploymentPipelineError thrown by fail() above must propagate as-is
    // (it already completed the operation record); anything else from the
    // provider call itself is a fresh failure to record and convert.
    if (error instanceof DeploymentPipelineError) throw error;
    await fail(input.adminUserId, input.idempotencyKey, "ROLLBACK_FAILED");
  }

  const nowIso = now.toISOString();
  return resolveDbClient().transaction(async (db: DbClient) => {
    await db.run("update app_deployments set status = 'rolled_back', ended_at = ? where id = ?", [nowIso, input.deploymentId]);
    await db.run("update app_deployments set status = 'published', verified_origin = ?, superseded_at = null where id = ?", [restoredOrigin, target!.id]);

    // This repo's publication model retains exactly current + previous
    // healthy (rule 41). Once we've rolled back to `target`, nothing
    // further back is tracked — a second rollback attempt correctly hits
    // ROLLBACK_TARGET_NOT_AVAILABLE rather than silently reusing a stale
    // pointer.
    await db.run(
      `update app_environment_publications set current_published_deployment_id = ?, previous_healthy_deployment_id = null,
       version = version + 1, published_at = ? where app_id = ? and environment = 'production'`,
      [target!.id, nowIso, input.appId],
    );

    await db.run(
      "update app_deployment_launch_controls set status = 'retired', drain_starts_at = null, deployment_window_ends_at = null, version = version + 1, updated_at = ? where deployment_id = ?",
      [nowIso, input.deploymentId],
    );
    await db.run(
      "update app_deployment_launch_controls set status = 'published', drain_starts_at = null, deployment_window_ends_at = null, version = version + 1, updated_at = ? where deployment_id = ?",
      [nowIso, target!.id],
    );

    await db.run(
      "update app_deployment_safety_observations set status = 'rollback_triggered', last_checked_at = ? where deployment_id = ?",
      [nowIso, input.deploymentId],
    );

    const result: RollbackProductionResult = {
      publication: (await getPublication(input.appId, "production"))!,
      rolledBackDeploymentId: input.deploymentId,
      restoredDeploymentId: target!.id,
    };
    await completeDeploymentOperation({ actorPrincipalId: input.adminUserId, idempotencyKey: input.idempotencyKey, result });
    return result;
  });
}

// BR-003: routed through AN-003's shared deduplicated-alerting primitive
// (src/lib/monitoring/alerting.ts) instead of a bespoke local dedup
// helper — never a second alert engine. alert_type is scoped per
// deployment (":${deploymentId}", same pattern AN-003's own
// escalatePersistentJobFailures uses for scheduled_job_persistent_failure)
// so two different apps rolling back concurrently don't collide under
// raiseDeduplicatedAlert's own global-per-alert_type dedup.
async function alertAdministrators(alertTypePrefix: string, message: string, metadata: { deploymentId: string; appId: string }) {
  await raiseDeduplicatedAlert({
    alertType: `${alertTypePrefix}:${metadata.deploymentId}`,
    capabilityFamily: "app_platform_contracts",
    severity: "critical",
    message,
    safeContext: metadata,
  });
}

const OBSERVATION_WINDOW_MS = 10 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 1000;

type ObservationRow = {
  deployment_id: string;
  app_id: string;
  started_at: string;
  checks_run: number;
  consecutive_critical_failures: number;
  identity_failure: number;
  status: "observing" | "passed" | "rollback_triggered";
  last_checked_at: string | null;
};

// AT-AR-002-27 (business rules 32-33): one critical check per minute for
// ten minutes after every production publish. One identity/SSO-integrity
// failure, or three consecutive critical availability failures, triggers
// automated rollback through the exact same rollbackProduction core a
// manual admin rollback uses (rule 35). Restart-safe: all state lives in
// app_deployment_safety_observations, nothing in process memory, so a
// missed tick or process restart just means the next sweep call picks up
// wherever the row says it left off.
export async function sweepReleaseSafetyObservations(now: Date, provider: DeploymentProvider): Promise<void> {
  const observing = await resolveDbClient().all<ObservationRow>(
    "select * from app_deployment_safety_observations where status = 'observing'");
  for (const observation of observing) {
    await processObservation(observation, now, provider);
  }
}

async function processObservation(observation: ObservationRow, now: Date, provider: DeploymentProvider) {
  const db = resolveDbClient();
  const elapsedSinceLastCheck = observation.last_checked_at ? now.getTime() - new Date(observation.last_checked_at).getTime() : Infinity;
  if (elapsedSinceLastCheck < CHECK_INTERVAL_MS) return;

  const deployment = await db.get<{ verified_origin: string; release_id: string }>(
    "select verified_origin, release_id from app_deployments where id = ?", [observation.deployment_id]);
  if (!deployment) return;
  const release = await getRelease(deployment.release_id);
  const controls = await db.get<{ compatibility_status: string }>(
    "select compatibility_status from app_deployment_launch_controls where deployment_id = ?", [observation.deployment_id]);

  const identityOk = !!controls && controls.compatibility_status === "passed" && await isOriginApproved(deployment.verified_origin);
  let availabilityOk = false;
  if (release) {
    try {
      availabilityOk = (await provider.checkHealth({ origin: deployment.verified_origin, healthPath: release.manifest.healthPath })).healthy;
    } catch {
      availabilityOk = false;
    }
  }

  const nowIso = now.toISOString();
  const checksRun = observation.checks_run + 1;
  const consecutiveFailures = availabilityOk ? 0 : observation.consecutive_critical_failures + 1;

  if (!identityOk || consecutiveFailures >= 3) {
    await db.run(
      "update app_deployment_safety_observations set checks_run = ?, consecutive_critical_failures = ?, identity_failure = ?, last_checked_at = ? where deployment_id = ?",
      [checksRun, consecutiveFailures, identityOk ? 0 : 1, nowIso, observation.deployment_id],
    );

    try {
      await rollbackProduction(
        {
          appId: observation.app_id,
          deploymentId: observation.deployment_id,
          adminUserId: "system-release-safety-sweep",
          idempotencyKey: `safety-rollback-${observation.deployment_id}`,
          reason: identityOk ? "release_safety_availability_failures" : "release_safety_identity_integrity_failure",
        },
        provider,
        now,
      );
      await alertAdministrators(
        "deployment_automated_rollback",
        `Automated rollback triggered for deployment ${observation.deployment_id}: ${identityOk ? "3 consecutive availability failures" : "identity/SSO integrity failure"}.`,
        { deploymentId: observation.deployment_id, appId: observation.app_id },
      );
      // A prior tick may have already raised the "rollback FAILED" alert
      // for this same deployment — this attempt just succeeded, so close it.
      await resolveDeduplicatedAlert(`deployment_automated_rollback_failed:${observation.deployment_id}`, now);
    } catch {
      // rollbackProduction already fails closed (publication pointer
      // untouched) and recorded its own operation failure — this is the
      // "no previous healthy deployment to restore to" or a provider
      // failure case. Alert loudly rather than retry silently forever;
      // the observation row stays 'observing' so the next tick still
      // tries again once the underlying problem is fixed.
      await alertAdministrators(
        "deployment_automated_rollback_failed",
        `Automated rollback FAILED for deployment ${observation.deployment_id} — manual intervention required.`,
        { deploymentId: observation.deployment_id, appId: observation.app_id },
      );
    }
    return;
  }

  const elapsedSinceStart = now.getTime() - new Date(observation.started_at).getTime();
  const status = elapsedSinceStart >= OBSERVATION_WINDOW_MS ? "passed" : "observing";
  await db.run(
    "update app_deployment_safety_observations set checks_run = ?, consecutive_critical_failures = ?, identity_failure = ?, status = ?, last_checked_at = ? where deployment_id = ?",
    [checksRun, consecutiveFailures, identityOk ? 0 : 1, status, nowIso, observation.deployment_id],
  );
}
