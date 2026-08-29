import type {
  DeploymentProvider,
  ProviderDeployInput,
  ProviderDeployResult,
  ProviderPromoteInput,
  ProviderProjectVerification,
} from "@/lib/deployment-provider/types";

const VERCEL_API_BASE = "https://api.vercel.com";

// A fresh Vercel deployment reports readyState QUEUED/BUILDING and only
// serves the app's real routes once READY — health-checking before then is
// a guaranteed false negative (confirmed live: every ChessMasters staging
// attempt recorded healthCheck:false while the same origin returned 200
// minutes later once the build finished). deploy()/promote() therefore
// poll to READY before returning. The budget stays comfortably under the
// route's maxDuration (60s); a genuine slow build that exceeds it returns
// an error and the operator retries — the retry then reuses the
// now-READY deployment via the existing-deployment lookup below.
const DEPLOY_POLL_INTERVAL_MS = 3000;
const DEPLOY_READY_TIMEOUT_MS = 35000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type VercelDeploymentRecord = {
  id?: string;
  uid?: string;
  url?: string;
  readyState?: string;
  state?: string;
  target?: string | null;
  meta?: { githubCommitSha?: string; artifactDigest?: string } & Record<string, string | undefined>;
};

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

  private isReady(record: VercelDeploymentRecord): boolean {
    return record.readyState === "READY" || record.state === "READY";
  }

  private failedState(record: VercelDeploymentRecord): string | null {
    const state = record.readyState ?? record.state;
    return state === "ERROR" || state === "CANCELED" || state === "DELETED" ? state : null;
  }

  // Look for a deployment of this exact commit/artifact that is already
  // READY — the app's own team may have deployed it, and re-triggering a
  // build just to health-check it races the build. Returns null on any
  // lookup problem so the caller falls back to creating a fresh build.
  private async findReadyDeployment(input: ProviderDeployInput): Promise<ProviderDeployResult | null> {
    try {
      const url = `${VERCEL_API_BASE}/v6/deployments`
        + `?projectId=${encodeURIComponent(input.providerProjectId)}`
        + `&teamId=${encodeURIComponent(input.providerTeamId)}&limit=40`;
      const response = await fetch(url, { headers: this.headers() });
      if (!response.ok) return null;
      const body = (await response.json()) as { deployments?: VercelDeploymentRecord[] };
      const match = (body.deployments ?? []).find((record) =>
        this.isReady(record)
        && !!record.url
        && (record.meta?.githubCommitSha === input.sourceCommitSha
          || record.meta?.artifactDigest === input.artifactDigest));
      if (!match?.url) return null;
      return {
        providerDeploymentId: match.uid ?? match.id ?? "",
        origin: `https://${match.url}`,
        status: "ready",
      };
    } catch {
      return null;
    }
  }

  private async pollUntilReady(
    deploymentId: string,
    fallbackUrl: string,
    providerTeamId: string,
  ): Promise<ProviderDeployResult> {
    const deadline = Date.now() + DEPLOY_READY_TIMEOUT_MS;
    let lastState = "UNKNOWN";
    while (Date.now() < deadline) {
      await sleep(DEPLOY_POLL_INTERVAL_MS);
      try {
        const response = await fetch(
          `${VERCEL_API_BASE}/v13/deployments/${encodeURIComponent(deploymentId)}?teamId=${encodeURIComponent(providerTeamId)}`,
          { headers: this.headers() },
        );
        if (!response.ok) continue;
        const record = (await response.json()) as VercelDeploymentRecord;
        lastState = record.readyState ?? record.state ?? lastState;
        const url = record.url ?? fallbackUrl;
        if (this.isReady(record) && url) {
          return { providerDeploymentId: deploymentId, origin: `https://${url}`, status: "ready" };
        }
        const failed = this.failedState(record);
        if (failed) {
          return { providerDeploymentId: deploymentId, origin: "", status: "error", errorDetail: `BUILD_${failed}` };
        }
      } catch {
        // transient — keep polling until the deadline
      }
    }
    return {
      providerDeploymentId: deploymentId,
      origin: "",
      status: "error",
      errorDetail: `BUILD_TIMEOUT: still ${lastState} after ${Math.round(DEPLOY_READY_TIMEOUT_MS / 1000)}s (retry to reuse the finished build)`,
    };
  }

  async deploy(input: ProviderDeployInput): Promise<ProviderDeployResult> {
    if (!this.apiToken) return { providerDeploymentId: "", origin: "", status: "error", errorDetail: "NO_API_TOKEN" };
    const [org, repo] = input.expectedRepository.split("/");
    if (!org || !repo) {
      return { providerDeploymentId: "", origin: "", status: "error", errorDetail: `INVALID_EXPECTED_REPOSITORY: ${input.expectedRepository}` };
    }

    const existing = await this.findReadyDeployment(input);
    if (existing) return existing;

    let deploymentId = "";
    let deploymentUrl = "";
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
      const deployment = (await response.json()) as VercelDeploymentRecord;
      if (!deployment.id || !deployment.url) {
        return { providerDeploymentId: "", origin: "", status: "error", errorDetail: `MISSING_ID_OR_URL: ${JSON.stringify(deployment).slice(0, 500)}` };
      }
      deploymentId = deployment.id;
      deploymentUrl = deployment.url;
      // Vercel dedupes an unchanged commit — a "new" deployment can already be READY.
      if (this.isReady(deployment)) {
        return { providerDeploymentId: deploymentId, origin: `https://${deploymentUrl}`, status: "ready" };
      }
    } catch (error) {
      return { providerDeploymentId: "", origin: "", status: "error", errorDetail: `THREW: ${error instanceof Error ? error.message : String(error)}` };
    }

    return this.pollUntilReady(deploymentId, deploymentUrl, input.providerTeamId);
  }

  async promote(input: ProviderPromoteInput): Promise<ProviderDeployResult> {
    if (!this.apiToken) return { providerDeploymentId: input.providerDeploymentId, origin: "", status: "error", errorDetail: "NO_API_TOKEN" };
    try {
      const response = await fetch(
        `${VERCEL_API_BASE}/v10/projects/${encodeURIComponent(input.providerProjectId)}/promote/${encodeURIComponent(input.providerDeploymentId)}?teamId=${encodeURIComponent(input.providerTeamId)}`,
        { method: "POST", headers: this.headers() },
      );
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { providerDeploymentId: input.providerDeploymentId, origin: "", status: "error", errorDetail: `HTTP ${response.status}: ${body.slice(0, 500)}` };
      }
    } catch (error) {
      return { providerDeploymentId: input.providerDeploymentId, origin: "", status: "error", errorDetail: `THREW: ${error instanceof Error ? error.message : String(error)}` };
    }
    // promote() acts on an already-built deployment (build-once, business
    // rule 14) — confirm it is READY and read back its canonical url.
    const settled = await this.pollUntilReady(input.providerDeploymentId, "", input.providerTeamId);
    return { ...settled, providerDeploymentId: input.providerDeploymentId };
  }

  async checkHealth(input: { origin: string; healthPath: string }): Promise<{ healthy: boolean }> {
    // redirect: "manual" so a Vercel Deployment Protection wall (a 302 to
    // vercel.com/sso-api on every protected preview/staging origin) is
    // never silently followed and mistaken for the target app's own
    // response — fetch's default redirect-following turned that SSO
    // page's own 200 into a false-positive health check. Only a genuine
    // 2xx from the app itself counts. A couple of short retries absorb the
    // brief window between READY and the origin actually serving traffic.
    const target = new URL(input.healthPath, input.origin).toString();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(2000);
      try {
        const response = await fetch(target, { method: "GET", redirect: "manual" });
        if (response.ok) return { healthy: true };
      } catch {
        // transient — retry
      }
    }
    return { healthy: false };
  }
}
