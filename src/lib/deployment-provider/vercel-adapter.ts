import type {
  DeploymentProvider,
  ProviderDeployInput,
  ProviderDeployResult,
  ProviderPromoteInput,
  ProviderProjectVerification,
} from "@/lib/deployment-provider/types";

const VERCEL_API_BASE = "https://api.vercel.com";

// Real Vercel REST adapter (Version 1, business rule 2). Only ever invoked
// with a real `apiToken` when VERCEL_API_TOKEN is configured — nothing in
// this repo's automated tests exercises live network calls; the shared
// contract suite (tests/deployment-provider-contract.test.ts) instead runs
// against createFakeDeploymentProvider(). Any transport/parse failure is
// reported through the same result shape as an ordinary provider decision
// (never thrown) so callers apply one uniform DEPLOYMENT_PROVIDER_UNAVAILABLE
// handling path regardless of *why* the provider was unreachable.
export class VercelDeploymentProvider implements DeploymentProvider {
  readonly name = "vercel";
  private readonly apiToken: string;

  constructor(config: { apiToken: string }) {
    this.apiToken = config.apiToken;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiToken}`, "Content-Type": "application/json" };
  }

  async verifyProject(input: {
    providerTeamId: string;
    providerProjectId: string;
    expectedRepository: string;
  }): Promise<ProviderProjectVerification> {
    if (!this.apiToken) return { verified: false, reason: "PROVIDER_UNAVAILABLE" };
    try {
      const response = await fetch(
        `${VERCEL_API_BASE}/v9/projects/${encodeURIComponent(input.providerProjectId)}?teamId=${encodeURIComponent(input.providerTeamId)}`,
        { headers: this.headers() },
      );
      if (response.status === 404) return { verified: false, reason: "PROJECT_NOT_FOUND" };
      if (!response.ok) return { verified: false, reason: "PROVIDER_UNAVAILABLE" };
      const project = (await response.json()) as { accountId?: string; link?: { org?: string; repo?: string } };
      if (!project.link?.org || !project.link?.repo) return { verified: false, reason: "REPOSITORY_MISMATCH" };
      const actualRepository = `${project.link.org}/${project.link.repo}`;
      if (actualRepository !== input.expectedRepository) return { verified: false, reason: "REPOSITORY_MISMATCH" };
      return { verified: true };
    } catch {
      return { verified: false, reason: "PROVIDER_UNAVAILABLE" };
    }
  }

  async deploy(input: ProviderDeployInput): Promise<ProviderDeployResult> {
    if (!this.apiToken) return { providerDeploymentId: "", origin: "", status: "error", errorDetail: "NO_API_TOKEN" };
    const [org, repo] = input.expectedRepository.split("/");
    if (!org || !repo) {
      return { providerDeploymentId: "", origin: "", status: "error", errorDetail: `INVALID_EXPECTED_REPOSITORY: ${input.expectedRepository}` };
    }
    try {
      const response = await fetch(`${VERCEL_API_BASE}/v13/deployments?teamId=${encodeURIComponent(input.providerTeamId)}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          name: input.providerProjectId,
          project: input.providerProjectId,
          target: input.environment === "production" ? "production" : "staging",
          // The "org"/"repo" gitSource variant is the only one this app can
          // populate without a GitHub API credential of its own (the
          // alternative "repoId" variant needs a numeric id we have no way
          // to look up) — Vercel resolves org/repo through its own GitHub
          // integration on the project. `ref` accepts a commit sha directly.
          gitSource: { type: "github", ref: input.sourceCommitSha, org, repo },
          meta: { artifactDigest: input.artifactDigest },
        }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { providerDeploymentId: "", origin: "", status: "error", errorDetail: `HTTP ${response.status}: ${body.slice(0, 500)}` };
      }
      const deployment = (await response.json()) as { id?: string; url?: string };
      if (!deployment.id || !deployment.url) {
        return { providerDeploymentId: "", origin: "", status: "error", errorDetail: `MISSING_ID_OR_URL: ${JSON.stringify(deployment).slice(0, 500)}` };
      }
      return { providerDeploymentId: deployment.id, origin: `https://${deployment.url}`, status: "ready" };
    } catch (error) {
      return { providerDeploymentId: "", origin: "", status: "error", errorDetail: `THREW: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async promote(input: ProviderPromoteInput): Promise<ProviderDeployResult> {
    if (!this.apiToken) return { providerDeploymentId: input.providerDeploymentId, origin: "", status: "error" };
    try {
      const response = await fetch(
        `${VERCEL_API_BASE}/v10/projects/${encodeURIComponent(input.providerProjectId)}/promote/${encodeURIComponent(input.providerDeploymentId)}?teamId=${encodeURIComponent(input.providerTeamId)}`,
        { method: "POST", headers: this.headers() },
      );
      if (!response.ok) return { providerDeploymentId: input.providerDeploymentId, origin: "", status: "error" };
      const deployment = (await response.json()) as { url?: string };
      if (!deployment.url) return { providerDeploymentId: input.providerDeploymentId, origin: "", status: "error" };
      return { providerDeploymentId: input.providerDeploymentId, origin: `https://${deployment.url}`, status: "ready" };
    } catch {
      return { providerDeploymentId: input.providerDeploymentId, origin: "", status: "error" };
    }
  }

  async checkHealth(input: { origin: string; healthPath: string }): Promise<{ healthy: boolean }> {
    try {
      // redirect: "manual" so a Vercel Deployment Protection wall (a 302 to
      // vercel.com/sso-api on every protected preview/staging origin) is
      // never silently followed and mistaken for the target app's own
      // response — fetch's default redirect-following turned that SSO
      // page's own 200 into a false-positive health check, confirmed live
      // against a ChessMasters staging deploy that has no real /health
      // route at all. Only a genuine 2xx from the app itself counts.
      const response = await fetch(new URL(input.healthPath, input.origin).toString(), { method: "GET", redirect: "manual" });
      return { healthy: response.ok };
    } catch {
      return { healthy: false };
    }
  }
}
