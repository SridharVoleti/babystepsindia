import { randomUUID } from "node:crypto";
import type {
  DeploymentProvider,
  ProviderDeployInput,
  ProviderDeployResult,
  ProviderPromoteInput,
  ProviderProjectVerification,
} from "@/lib/deployment-provider/types";

type KnownProject = { providerTeamId: string; providerProjectId: string; expectedRepository: string };

// Deterministic in-memory provider used by tests and default local dev
// (no network calls, no credentials). Implements the exact same
// DeploymentProvider contract as VercelDeploymentProvider so pipeline
// services are provider-agnostic (business rule 2, AT-AR-002-01).
export function createFakeDeploymentProvider(config: {
  knownProjects: KnownProject[];
  unhealthyOrigins?: string[];
}): DeploymentProvider {
  const deployments = new Map<string, ProviderDeployResult>();

  function findProject(providerProjectId: string): KnownProject | undefined {
    return config.knownProjects.find((project) => project.providerProjectId === providerProjectId);
  }

  return {
    name: "vercel",

    async verifyProject(input): Promise<ProviderProjectVerification> {
      // Permissive mode: an empty fixture list means "no strict fixture
      // configured" — used only as the default local-dev provider so a
      // real Vercel account isn't required to exercise the admin flow
      // end-to-end. Every test that needs real accept/reject behavior
      // configures an explicit knownProjects fixture instead.
      if (config.knownProjects.length === 0) return { verified: true };
      const project = findProject(input.providerProjectId);
      if (!project) return { verified: false, reason: "PROJECT_NOT_FOUND" };
      if (project.providerTeamId !== input.providerTeamId) return { verified: false, reason: "TEAM_MISMATCH" };
      if (project.expectedRepository !== input.expectedRepository) return { verified: false, reason: "REPOSITORY_MISMATCH" };
      return { verified: true };
    },

    async deploy(input: ProviderDeployInput): Promise<ProviderDeployResult> {
      const providerDeploymentId = `dpl_${randomUUID()}`;
      // Deterministic per project+environment (not per call) so tests can
      // predict an origin ahead of time — e.g. to simulate an unhealthy
      // staging deployment via config.unhealthyOrigins.
      const origin = `https://${input.providerProjectId}-${input.environment}.example.dev`;
      const result: ProviderDeployResult = { providerDeploymentId, origin, status: "ready" };
      deployments.set(providerDeploymentId, result);
      return result;
    },

    async promote(input: ProviderPromoteInput): Promise<ProviderDeployResult> {
      const staged = deployments.get(input.providerDeploymentId);
      if (!staged) return { providerDeploymentId: input.providerDeploymentId, origin: "", status: "error" };
      // Build-once (business rule 14): promotion returns the same artifact
      // deployment under a production-facing origin, never a new build.
      const origin = staged.origin.replace(/-staging\./, "-production.");
      const result: ProviderDeployResult = { providerDeploymentId: staged.providerDeploymentId, origin, status: "ready" };
      deployments.set(input.providerDeploymentId, result);
      return result;
    },

    async checkHealth(input) {
      return { healthy: !config.unhealthyOrigins?.includes(input.origin) };
    },
  };
}
