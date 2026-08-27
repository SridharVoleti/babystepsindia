import { randomUUID } from "node:crypto";
import { AppRegistryError } from "@/lib/app-registry/errors";
import { computeRequestHash } from "@/lib/app-registry/validation";
import { assertAppOperational } from "@/lib/db/app-registry-repo";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
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
import { validateReleaseAchievementContract } from "@/lib/achievements/service";
import { validatesCadenceCelebrationDeclaration, validatesMotivationDeclaration } from "@/lib/deployment-manifest/schema";
import { validateReleaseJourneyContract } from "@/lib/journey/service";

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
  validationSummary: Record<string, boolean | string>;
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
    validationSummary: JSON.parse(row.validation_summary_json) as Record<string, boolean | string>,
    startedAt: row.started_at,
    validatedAt: row.validated_at,
    publishedAt: row.published_at,
  };
}

async function requireActiveApp(appId: string) {
  try {
    return await assertAppOperational(appId);
  } catch (error) {
    if (error instanceof AppRegistryError) throw new DeploymentPipelineError(error.code);
    throw error;
  }
}

export async function getLatestDeployment(appId: string, releaseId: string, environment: string): Promise<DeploymentView | null> {
  const row = await resolveDbClient().get<DeploymentRow>(
    `select * from app_deployments where app_id = ? and release_id = ? and environment = ?
     order by started_at desc limit 1`,
    [appId, releaseId, environment],
  );
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
  const app = await requireActiveApp(input.appId);

  const release = await getRelease(input.releaseId);
  if (!release || release.appId !== input.appId) throw new DeploymentPipelineError("RELEASE_NOT_FOUND");
  if (release.status === "gate_failed") throw new DeploymentPipelineError("RELEASE_GATE_FAILED");
  if (release.status === "verified" || release.status === "promoted") {
    const existing = await getLatestDeployment(input.appId, input.releaseId, "staging");
    if (existing) return { release, deployment: existing };
  }

  const hash = computeRequestHash({ appId: input.appId, releaseId: input.releaseId });
  const cached = await checkDeploymentIdempotency<DeployToStagingResult>(input.adminUserId, input.idempotencyKey, hash);
  if (cached) {
    if (cached.deployment.status === "failed") throw new DeploymentPipelineError("STAGING_VALIDATION_FAILED");
    return cached;
  }

  const binding = await getBinding(input.appId, "staging");
  if (!binding || binding.bindingStatus !== "verified") {
    throw new DeploymentPipelineError("DEPLOYMENT_PROJECT_NOT_VERIFIED");
  }

  await beginDeploymentOperation({
    actorPrincipalId: input.adminUserId,
    appId: input.appId,
    idempotencyKey: input.idempotencyKey,
    operation: "deploy_staging",
    hash,
  });

  const deployResult = await provider.deploy({
    providerTeamId: binding.providerTeamId,
    providerProjectId: binding.providerProjectId,
    environment: "staging",
    artifactDigest: release.artifactDigest,
    sourceCommitSha: release.sourceCommitSha,
    expectedRepository: binding.expectedRepository,
  });

  const providerReady = deployResult.status === "ready";
  const originApproved = providerReady && await isOriginApproved(deployResult.origin);
  const healthCheck = providerReady ? (await provider.checkHealth({ origin: deployResult.origin, healthPath: release.manifest.healthPath })).healthy : false;
  const manifestIdentity = release.manifest.appKey === app.app_key;

  // Business rules 46-49 / AT-AR-002-36-37: before verification, enumerate
  // every schema_version actually represented in retained learner progress
  // for this app and require the release's own CI-attested
  // readableSchemaVersions to cover every one of them. A release that
  // still can't read/migrate a version genuinely present in retained
  // progress never becomes verified, regardless of every other check.
  const progressVersionRows = await resolveDbClient().all<{ schema_version: number }>(
    "select schema_version from learner_app_progress where app_id = ?", [input.appId]);
  const representedVersions = [...new Set(progressVersionRows.map((row) => row.schema_version))];
  const compatibilityPassed = representedVersions.every((version) => release.readableSchemaVersions.includes(version));
  const achievementContract = await validateReleaseAchievementContract(input.appId, input.releaseId, now);
  const achievementContractPassed = achievementContract.passed;
  const cadenceCelebrationContractPassed = validatesCadenceCelebrationDeclaration(release.manifest);
  const motivationContractPassed = validatesMotivationDeclaration(release.manifest);
  const journeyContractPassed = (await validateReleaseJourneyContract(input.appId, input.releaseId, now)).passed;

  const passed = providerReady && originApproved && healthCheck && manifestIdentity && compatibilityPassed
    && achievementContractPassed && cadenceCelebrationContractPassed && motivationContractPassed && journeyContractPassed;

  const validationSummary: Record<string, boolean | string> = { providerReady, originApproved, healthCheck, manifestIdentity, compatibilityPassed,
    achievementContractPassed, cadenceCelebrationContractPassed, motivationContractPassed, journeyContractPassed };
  if (!providerReady && deployResult.errorDetail) validationSummary.providerErrorDetail = deployResult.errorDetail;
  const nowIso = now.toISOString();

  const result = await resolveDbClient().transaction(async (db: DbClient) => {
    const deploymentId = randomUUID();
    await db.run(
      `insert into app_deployments
       (id, app_id, release_id, binding_id, environment, provider_deployment_id, verified_origin, status,
        validation_summary_json, started_at, validated_at, published_at)
       values (?, ?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ],
    );
    await db.run(
      `update app_releases set status = ?, verified_at = ?, failed_at = ?, version = version + 1 where id = ?`,
      [passed ? "verified" : "staging_failed", passed ? nowIso : null, passed ? null : nowIso, input.releaseId],
    );

    await db.run(
      `insert into app_release_compatibility_reports
       (release_id, platform_contract_version, represented_progress_schema_versions_json, status, generated_at)
       values (?, '1.0', ?, ?, ?)
       on conflict(release_id) do update set
         represented_progress_schema_versions_json = excluded.represented_progress_schema_versions_json,
         status = excluded.status, generated_at = excluded.generated_at`,
      [input.releaseId, JSON.stringify(representedVersions), compatibilityPassed ? "passed" : "failed", nowIso],
    );

    const deployment = toDeploymentView((await db.get<DeploymentRow>("select * from app_deployments where id = ?", [deploymentId]))!);
    const releaseView = (await getRelease(input.releaseId))!;
    const result: DeployToStagingResult = { release: releaseView, deployment };
    await completeDeploymentOperation({ actorPrincipalId: input.adminUserId, idempotencyKey: input.idempotencyKey, result, deploymentId });
    return result;
  });

  if (!passed) throw new DeploymentPipelineError(compatibilityPassed ? "STAGING_VALIDATION_FAILED" : "RELEASE_BACKWARD_COMPATIBILITY_FAILED");
  return result;
}
