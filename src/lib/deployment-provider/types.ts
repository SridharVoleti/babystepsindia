// AR-002 business rule 2: the core deployment service is provider-neutral.
// Every provider implementation (Vercel today, others later) satisfies
// this exact interface, and the same contract test suite runs against all
// of them (AT-AR-002-01) so pipeline logic never depends on Vercel-specific
// behavior.
export type DeploymentEnvironment = "development" | "staging" | "production";

export type ProviderProjectVerification =
  | { verified: true }
  | { verified: false; reason: "TEAM_MISMATCH" | "PROJECT_NOT_FOUND" | "REPOSITORY_MISMATCH" | "PROVIDER_UNAVAILABLE" };

export type ProviderDeployInput = {
  providerTeamId: string;
  providerProjectId: string;
  environment: DeploymentEnvironment;
  artifactDigest: string;
  sourceCommitSha: string;
};

export type ProviderDeployResult = {
  providerDeploymentId: string;
  origin: string;
  status: "ready" | "error";
  // Diagnostic-only: the provider's own status/body when status is "error",
  // so a failed deploy is debuggable from validation_summary_json without
  // needing direct access to the provider's own dashboard/logs.
  errorDetail?: string;
};

export type ProviderPromoteInput = {
  providerTeamId: string;
  providerProjectId: string;
  providerDeploymentId: string;
};

export interface DeploymentProvider {
  readonly name: string;
  verifyProject(input: {
    providerTeamId: string;
    providerProjectId: string;
    expectedRepository: string;
  }): Promise<ProviderProjectVerification>;
  deploy(input: ProviderDeployInput): Promise<ProviderDeployResult>;
  promote(input: ProviderPromoteInput): Promise<ProviderDeployResult>;
  checkHealth(input: { origin: string; healthPath: string }): Promise<{ healthy: boolean }>;
}
