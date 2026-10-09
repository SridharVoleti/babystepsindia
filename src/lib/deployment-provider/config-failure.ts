import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";
import { resolveDeploymentProvider } from "@/lib/deployment-provider";
import type { DeploymentProvider } from "@/lib/deployment-provider/types";

// PRG-023: a deployment attempt blocked by incomplete provider configuration is recorded (append-only, no credentials)
// so the failure is deterministic, visible and auditable.
export type ProviderConfigFailureInput = {
  operation: string;
  appId?: string | null;
  releaseId?: string | null;
  adminUserId?: string | null;
  code: string;
  now: Date;
};

export async function recordDeploymentProviderConfigFailure(input: ProviderConfigFailureInput): Promise<void> {
  await resolveDbClient().run(
    "insert into deployment_provider_config_failures (id, operation, app_id, release_id, admin_user_id, error_code, created_at) values (?, ?, ?, ?, ?, ?, ?)",
    [randomUUID(), input.operation, input.appId ?? null, input.releaseId ?? null, input.adminUserId ?? null, input.code, input.now.toISOString()],
  );
}

/** Resolve the provider; on a configuration failure record it (best effort) and rethrow the typed error. */
export async function resolveProviderRecordingFailure(ctx: { operation: string; appId?: string; releaseId?: string; adminUserId?: string }): Promise<DeploymentProvider> {
  try {
    return resolveDeploymentProvider();
  } catch (error) {
    if (error instanceof DeploymentPipelineError) {
      try { await recordDeploymentProviderConfigFailure({ ...ctx, code: error.code, now: new Date() }); } catch { /* never mask the configuration error */ }
    }
    throw error;
  }
}
