import { randomUUID } from "node:crypto";
import { AppRegistryError } from "@/lib/app-registry/errors";
import { computeRequestHash } from "@/lib/app-registry/validation";
import { assertAppOperational } from "@/lib/db/app-registry-repo";
import { getDb } from "@/lib/db/client";
import { isOriginApproved } from "@/lib/deployment-pipeline/approved-domains";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";
import {
  beginDeploymentOperation,
  checkDeploymentIdempotency,
  completeDeploymentOperation,
} from "@/lib/deployment-pipeline/idempotency";
import { getBinding } from "@/lib/deployment-binding/service";
import { getRelease, type ReleaseView } from "@/lib/deployment-release/service";
import type { DeploymentProvider } from "@/lib/deployment-provider/types";

type DeploymentRow = {
  id: string;
  app_id: string;
  release_id: string;
  binding_id: string;
  environment: string;
  provider_deployment_id: string;
  verified_origin: string;
  status: "deploying" | "validating" | "published" | "superseded" | "failed";
  validation_summary_json: string;
  investigation_hold: number;
  started_at: string;
  validated_at: string | null;
  published_at: string | null;
  superseded_at: string | null;
  ended_at: string | null;
};

export type DeploymentView = {
  id: string;
  appId: string;
  releaseId: string;
  bindingId: string;
  environment: string;
  providerDeploymentId: string;
  verifiedOrigin: string;
  status: DeploymentRow["status"];
  validationSummary: Record<string, boolean>;
  startedAt: string;
  validatedAt: string | null;
  publishedAt: string | null;
};

function toDeploymentView(row: DeploymentRow): DeploymentView {
  return {
    id: row.id,
    appId: row.app_id,
    releaseId: row.release_id,
    bindingId: row.binding_id,
    environment: row.environment,
    providerDeploymentId: row.provider_deployment_id,
    verifiedOrigin: row.verified_origin,
    status: row.status,
    validationSummary: JSON.parse(row.validation_summary_json) as Record<string, boolean>,
    startedAt: row.started_at,
    validatedAt: row.validated_at,
    publishedAt: row.published_at,
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

export function getLatestDeployment(appId: string, releaseId: string, environment: string): DeploymentView | null {
  const row = getDb()
    .prepare(
      `select * from app_deployments where app_id = ? and release_id = ? and environment = ?
       order by started_at desc limit 1`,
    )
    .get(appId, releaseId, environment) as DeploymentRow | undefined;
  return row ? toDeploymentView(row) : null;
}

export type DeployToStagingInput = { appId: string; releaseId: string; adminUserId: string; idempotencyKey: string };
export type DeployToStagingResult = { release: ReleaseView; deployment: DeploymentView };

// AT-AR-002-15/16 (business rules 18-20): staging is where every mandatory
// runtime/contract check must pass before a release can ever be considered
// for production. Only the checks mechanically verifiable without a real
// running learner-app backend are executed here (provider readiness,
// approved-domain origin, health endpoint, manifest identity) — the wider
// SSO/CORS/progress/heartbeat/SDK/accessibility checks named in business
// rule 19 need a live app responding to the babysteps contract, which
// doesn't exist in this workspace; see README for the explicit gap.
export async function deployToStaging(
  input: DeployToStagingInput,
  provider: DeploymentProvider,
  now: Date,
): Promise<DeployToStagingResult> {
  const app = requireActiveApp(input.appId);

  const release = getRelease(input.releaseId);
  if (!release || release.appId !== input.appId) throw new DeploymentPipelineError("RELEASE_NOT_FOUND");
  if (release.status === "gate_failed") throw new DeploymentPipelineError("RELEASE_GATE_FAILED");
  if (release.status === "verified" || release.status === "promoted") {
    const existing = getLatestDeployment(input.appId, input.releaseId, "staging");
    if (existing) return { release, deployment: existing };
  }

  const hash = computeRequestHash({ appId: input.appId, releaseId: input.releaseId });
  const cached = checkDeploymentIdempotency<DeployToStagingResult>(input.adminUserId, input.idempotencyKey, hash);
  if (cached) {
    if (cached.deployment.status === "failed") throw new DeploymentPipelineError("STAGING_VALIDATION_FAILED");
    return cached;
  }

  const binding = getBinding(input.appId, "staging");
  if (!binding || binding.bindingStatus !== "verified") {
    throw new DeploymentPipelineError("DEPLOYMENT_PROJECT_NOT_VERIFIED");
  }

  const db = getDb();
  const run = db.transaction(() => {
    beginDeploymentOperation({
      actorPrincipalId: input.adminUserId,
      appId: input.appId,
      idempotencyKey: input.idempotencyKey,
      operation: "deploy_staging",
      hash,
    });
    return { app, binding };
  });
  run();

  const deployResult = await provider.deploy({
    providerTeamId: binding.providerTeamId,
    providerProjectId: binding.providerProjectId,
    environment: "staging",
    artifactDigest: release.artifactDigest,
    sourceCommitSha: release.sourceCommitSha,
  });

  const providerReady = deployResult.status === "ready";
  const originApproved = providerReady && isOriginApproved(deployResult.origin);
  const healthCheck = providerReady ? (await provider.checkHealth({ origin: deployResult.origin, healthPath: release.manifest.healthPath })).healthy : false;
  const manifestIdentity = release.manifest.appKey === app.app_key;
  const passed = providerReady && originApproved && healthCheck && manifestIdentity;

  const validationSummary = { providerReady, originApproved, healthCheck, manifestIdentity };
  const nowIso = now.toISOString();

  const finalize = db.transaction(() => {
    const deploymentId = randomUUID();
    db.prepare(
      `insert into app_deployments
       (id, app_id, release_id, binding_id, environment, provider_deployment_id, verified_origin, status,
        validation_summary_json, started_at, validated_at, published_at)
       values (?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      deploymentId,
      input.appId,
      input.releaseId,
      binding.id,
      deployResult.providerDeploymentId || `unavailable-${deploymentId}`,
      deployResult.origin,
      passed ? "published" : "failed",
      JSON.stringify(validationSummary),
      nowIso,
      nowIso,
      passed ? nowIso : null,
    );
    db.prepare(
      `update app_releases set status = ?, verified_at = ?, failed_at = ?, version = version + 1 where id = ?`,
    ).run(passed ? "verified" : "staging_failed", passed ? nowIso : null, passed ? null : nowIso, input.releaseId);

    const deployment = toDeploymentView(db.prepare("select * from app_deployments where id = ?").get(deploymentId) as DeploymentRow);
    const result: DeployToStagingResult = { release: getRelease(input.releaseId)!, deployment };
    completeDeploymentOperation({ actorPrincipalId: input.adminUserId, idempotencyKey: input.idempotencyKey, result, deploymentId });
    return result;
  });

  const result = finalize();
  if (!passed) throw new DeploymentPipelineError("STAGING_VALIDATION_FAILED");
  return result;
}
