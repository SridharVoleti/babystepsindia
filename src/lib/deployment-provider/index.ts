import type { DeploymentProvider } from "@/lib/deployment-provider/types";
import { createFakeDeploymentProvider } from "@/lib/deployment-provider/fake-adapter";
import { VercelDeploymentProvider } from "@/lib/deployment-provider/vercel-adapter";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";

type Env = Record<string, string | undefined>;

// Single seam every AR-002 route/service resolves the active provider through.
//
// PRG-023: fail closed. A production environment (NODE_ENV or VERCEL_ENV = "production") requires VERCEL_API_TOKEN and can NEVER
// receive the simulated provider, whatever other flags are set. The simulated provider is available only when NODE_ENV is
// "development" or "test", or in a non-production environment that explicitly opts in with ALLOW_FAKE_DEPLOYMENT_PROVIDER=true.
// An unknown/unset environment is not trusted. The error carries no credential material.
export function isProductionEnvironment(env: Env = process.env): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

export function resolveDeploymentProvider(env: Env = process.env): DeploymentProvider {
  const apiToken = (env.VERCEL_API_TOKEN ?? "").trim();
  if (isProductionEnvironment(env)) {
    const requested = (env.DEPLOYMENT_PROVIDER ?? "vercel").trim().toLowerCase();
    if (requested !== "vercel") throw new DeploymentPipelineError("DEPLOYMENT_PROVIDER_NOT_CONFIGURED", `deployment provider "${requested}" is not permitted in production`);
    if (!apiToken) throw new DeploymentPipelineError("DEPLOYMENT_PROVIDER_NOT_CONFIGURED", "VERCEL_API_TOKEN is required in production");
    return new VercelDeploymentProvider({ apiToken });
  }
  if (apiToken) return new VercelDeploymentProvider({ apiToken });
  const fakeAllowed = env.NODE_ENV === "development" || env.NODE_ENV === "test" || env.ALLOW_FAKE_DEPLOYMENT_PROVIDER === "true";
  if (!fakeAllowed) throw new DeploymentPipelineError("DEPLOYMENT_PROVIDER_NOT_CONFIGURED", "no deployment provider configured and the simulated provider is not enabled for this environment");
  return createFakeDeploymentProvider({ knownProjects: [] });
}
