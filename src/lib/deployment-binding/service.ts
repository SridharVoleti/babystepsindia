import { randomUUID } from "node:crypto";
import { AppRegistryError } from "@/lib/app-registry/errors";
import { computeRequestHash } from "@/lib/app-registry/validation";
import { assertAppOperational } from "@/lib/db/app-registry-repo";
import { getDb } from "@/lib/db/client";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";
import {
  beginDeploymentOperation,
  checkDeploymentIdempotency,
  completeDeploymentOperation,
} from "@/lib/deployment-pipeline/idempotency";
import type { DeploymentProvider } from "@/lib/deployment-provider/types";

export type DeploymentBindingEnvironment = "development" | "staging" | "production";

type BindingRow = {
  id: string;
  app_id: string;
  environment: string;
  provider: string;
  provider_team_id: string;
  provider_project_id: string;
  expected_repository: string;
  approved_domain_id: string | null;
  binding_status: "unverified" | "verified" | "disabled";
  deployment_enabled: number;
  verified_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export type DeploymentBindingView = {
  id: string;
  appId: string;
  environment: string;
  provider: string;
  providerTeamId: string;
  providerProjectId: string;
  expectedRepository: string;
  approvedDomainId: string | null;
  bindingStatus: "unverified" | "verified" | "disabled";
  deploymentEnabled: boolean;
  verifiedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

function toView(row: BindingRow): DeploymentBindingView {
  return {
    id: row.id,
    appId: row.app_id,
    environment: row.environment,
    provider: row.provider,
    providerTeamId: row.provider_team_id,
    providerProjectId: row.provider_project_id,
    expectedRepository: row.expected_repository,
    approvedDomainId: row.approved_domain_id,
    bindingStatus: row.binding_status,
    deploymentEnabled: !!row.deployment_enabled,
    verifiedAt: row.verified_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

export function getBinding(appId: string, environment: DeploymentBindingEnvironment): DeploymentBindingView | null {
  const row = getDb()
    .prepare("select * from app_deployment_bindings where app_id = ? and environment = ?")
    .get(appId, environment) as BindingRow | undefined;
  return row ? toView(row) : null;
}

export function listBindings(appId: string): DeploymentBindingView[] {
  const rows = getDb().prepare("select * from app_deployment_bindings where app_id = ? order by environment").all(appId) as BindingRow[];
  return rows.map(toView);
}

export type CreateBindingInput = {
  appId: string;
  environment: DeploymentBindingEnvironment;
  provider: string;
  providerTeamId: string;
  providerProjectId: string;
  expectedRepository: string;
  approvedDomainId?: string | null;
  adminUserId: string;
  idempotencyKey: string;
};

// AT-AR-002-02/05: only provider-discovered project selections are ever
// trusted; the same provider project/environment can never back two apps
// (business rule 5), and a verified binding cannot be silently overwritten.
export async function createOrReplaceBinding(input: CreateBindingInput): Promise<DeploymentBindingView> {
  await requireActiveApp(input.appId);

  const hash = computeRequestHash({
    appId: input.appId,
    environment: input.environment,
    provider: input.provider,
    providerTeamId: input.providerTeamId,
    providerProjectId: input.providerProjectId,
    expectedRepository: input.expectedRepository,
    approvedDomainId: input.approvedDomainId ?? null,
  });
  const cached = checkDeploymentIdempotency<DeploymentBindingView>(input.adminUserId, input.idempotencyKey, hash);
  if (cached) return cached;

  const db = getDb();
  const run = db.transaction(() => {
    beginDeploymentOperation({
      actorPrincipalId: input.adminUserId,
      appId: input.appId,
      idempotencyKey: input.idempotencyKey,
      operation: "bind",
      hash,
    });

    const conflict = db
      .prepare(
        `select app_id from app_deployment_bindings
         where provider = ? and provider_team_id = ? and provider_project_id = ? and environment = ? and app_id <> ?`,
      )
      .get(input.provider, input.providerTeamId, input.providerProjectId, input.environment, input.appId);
    if (conflict) throw new DeploymentPipelineError("DEPLOYMENT_PROJECT_ALREADY_BOUND");

    const existing = db
      .prepare("select * from app_deployment_bindings where app_id = ? and environment = ?")
      .get(input.appId, input.environment) as BindingRow | undefined;
    if (existing?.binding_status === "verified") {
      throw new DeploymentPipelineError("DEPLOYMENT_PROJECT_ALREADY_BOUND");
    }

    const now = new Date().toISOString();
    if (existing) {
      db.prepare(
        `update app_deployment_bindings
         set provider = ?, provider_team_id = ?, provider_project_id = ?, expected_repository = ?,
             approved_domain_id = ?, binding_status = 'unverified', verified_at = null,
             version = version + 1, updated_at = ?
         where id = ?`,
      ).run(input.provider, input.providerTeamId, input.providerProjectId, input.expectedRepository, input.approvedDomainId ?? null, now, existing.id);
    } else {
      db.prepare(
        `insert into app_deployment_bindings
         (id, app_id, environment, provider, provider_team_id, provider_project_id, expected_repository,
          approved_domain_id, binding_status, deployment_enabled, version, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, 'unverified', 1, 1, ?, ?)`,
      ).run(
        randomUUID(),
        input.appId,
        input.environment,
        input.provider,
        input.providerTeamId,
        input.providerProjectId,
        input.expectedRepository,
        input.approvedDomainId ?? null,
        now,
        now,
      );
    }

    const view = toView(
      db.prepare("select * from app_deployment_bindings where app_id = ? and environment = ?").get(input.appId, input.environment) as BindingRow,
    );
    completeDeploymentOperation({ actorPrincipalId: input.adminUserId, idempotencyKey: input.idempotencyKey, result: view });
    return view;
  });

  return run();
}

// AT-AR-002-03/04: the provider is the sole source of truth for team
// ownership and repository linkage — no admin-asserted fact is trusted.
export async function verifyBinding(
  input: { appId: string; environment: DeploymentBindingEnvironment; adminUserId: string; provider: DeploymentProvider },
  now: Date,
): Promise<DeploymentBindingView> {
  await requireActiveApp(input.appId);
  const binding = getBinding(input.appId, input.environment);
  if (!binding) throw new DeploymentPipelineError("DEPLOYMENT_BINDING_NOT_FOUND");

  const verification = await input.provider.verifyProject({
    providerTeamId: binding.providerTeamId,
    providerProjectId: binding.providerProjectId,
    expectedRepository: binding.expectedRepository,
  });

  if (!verification.verified) {
    const code =
      verification.reason === "REPOSITORY_MISMATCH"
        ? "DEPLOYMENT_REPOSITORY_MISMATCH"
        : verification.reason === "PROVIDER_UNAVAILABLE"
          ? "DEPLOYMENT_PROVIDER_UNAVAILABLE"
          : "DEPLOYMENT_PROJECT_NOT_VERIFIED";
    throw new DeploymentPipelineError(code);
  }

  getDb()
    .prepare(
      `update app_deployment_bindings set binding_status = 'verified', verified_at = ?, version = version + 1, updated_at = ?
       where id = ?`,
    )
    .run(now.toISOString(), now.toISOString(), binding.id);

  return getBinding(input.appId, input.environment)!;
}
