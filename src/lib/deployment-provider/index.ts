import type { DeploymentProvider } from "@/lib/deployment-provider/types";
import { createFakeDeploymentProvider } from "@/lib/deployment-provider/fake-adapter";
import { VercelDeploymentProvider } from "@/lib/deployment-provider/vercel-adapter";

// Single seam every AR-002 route/service resolves the active provider
// through — real Vercel when VERCEL_API_TOKEN is configured, otherwise the
// permissive fake adapter so the admin flow is exercisable locally without
// live provider credentials (per the session's confirmed scoping decision).
export function resolveDeploymentProvider(): DeploymentProvider {
  const apiToken = process.env.VERCEL_API_TOKEN;
  if (apiToken) return new VercelDeploymentProvider({ apiToken });
  return createFakeDeploymentProvider({ knownProjects: [] });
}
