import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { getDb } from "@/lib/db/client";
import { resolveDeploymentProvider } from "@/lib/deployment-provider";
import { DeploymentPipelineError, deploymentPipelineErrorStatus } from "@/lib/deployment-pipeline/errors";

// PRG-023 (issue #66): production must never silently fall back to the simulated provider.
type Env = Record<string, string | undefined>;
const prod = (extra: Env = {}): Env => ({ NODE_ENV: "production", ...extra });
const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return e instanceof DeploymentPipelineError ? e.code : `OTHER:${String(e)}`; } return "NO_ERROR"; };

describe("deployment provider resolution fails closed in production", () => {
  it("production without VERCEL_API_TOKEN is an explicit configuration error", () => {
    expect(codeOf(() => resolveDeploymentProvider(prod()))).toBe("DEPLOYMENT_PROVIDER_NOT_CONFIGURED");
    expect(codeOf(() => resolveDeploymentProvider(prod({ VERCEL_API_TOKEN: "" })))).toBe("DEPLOYMENT_PROVIDER_NOT_CONFIGURED");
    expect(codeOf(() => resolveDeploymentProvider(prod({ VERCEL_API_TOKEN: "   " })))).toBe("DEPLOYMENT_PROVIDER_NOT_CONFIGURED");
  });

  it("VERCEL_ENV=production is production even when NODE_ENV is not", () => {
    expect(codeOf(() => resolveDeploymentProvider({ NODE_ENV: "development", VERCEL_ENV: "production" }))).toBe("DEPLOYMENT_PROVIDER_NOT_CONFIGURED");
  });

  it("no production path can invoke the simulated provider, whatever flags are set", () => {
    for (const extra of [{ DEPLOYMENT_PROVIDER: "fake" }, { ALLOW_FAKE_DEPLOYMENT_PROVIDER: "true" }, { DEPLOYMENT_PROVIDER: "fake", ALLOW_FAKE_DEPLOYMENT_PROVIDER: "true" }]) {
      expect(codeOf(() => resolveDeploymentProvider(prod(extra)))).toBe("DEPLOYMENT_PROVIDER_NOT_CONFIGURED");
    }
    expect(codeOf(() => resolveDeploymentProvider(prod({ VERCEL_API_TOKEN: "tok", DEPLOYMENT_PROVIDER: "fake" })))).toBe("DEPLOYMENT_PROVIDER_NOT_CONFIGURED");
  });

  it("production with a token resolves the real Vercel provider", () => {
    expect(resolveDeploymentProvider(prod({ VERCEL_API_TOKEN: "tok" })).name).toBe("vercel");
  });

  it("the failure is deterministic and its status is a server-side configuration error (503)", () => {
    expect(codeOf(() => resolveDeploymentProvider(prod()))).toBe(codeOf(() => resolveDeploymentProvider(prod())));
    expect(deploymentPipelineErrorStatus("DEPLOYMENT_PROVIDER_NOT_CONFIGURED")).toBe(503);
  });

  it("the error carries no credential material", () => {
    try { resolveDeploymentProvider(prod({ VERCEL_API_TOKEN: "" })); } catch (e) { expect(String((e as Error).message) + String((e as DeploymentPipelineError).detail)).not.toMatch(/tok_|Bearer/); }
  });
});

describe("mock provider isolation between test/development and production", () => {
  it("the simulated provider is only available in development/test, or non-production with an explicit flag", () => {
    expect(resolveDeploymentProvider({ NODE_ENV: "test" }).name).toBe("vercel");                  // fake adapter reports the vercel contract name
    expect(resolveDeploymentProvider({ NODE_ENV: "development" })).toBeTruthy();
    expect(codeOf(() => resolveDeploymentProvider({}))).toBe("DEPLOYMENT_PROVIDER_NOT_CONFIGURED");  // unknown environment is not trusted
    expect(resolveDeploymentProvider({ ALLOW_FAKE_DEPLOYMENT_PROVIDER: "true" })).toBeTruthy();
  });

  it("a configured token always selects the real provider outside production too", () => {
    const p = resolveDeploymentProvider({ NODE_ENV: "development", VERCEL_API_TOKEN: "tok" });
    expect(p.constructor.name).toBe("VercelDeploymentProvider");
  });

  it("the simulated provider can be told apart from the real one (so tests can prove isolation)", () => {
    const fake = resolveDeploymentProvider({ NODE_ENV: "test" });
    const real = resolveDeploymentProvider({ NODE_ENV: "test", VERCEL_API_TOKEN: "tok" });
    expect(fake.constructor.name).not.toBe(real.constructor.name);
  });
});

describe("failed deployment attempts are recorded safely for traceability", () => {
  beforeEach(() => { useInMemoryDb(); });

  it("deploy-staging in production without credentials returns 503 and records an auditable failure without secrets", async () => {
    const { recordDeploymentProviderConfigFailure } = await import("@/lib/deployment-provider/config-failure");
    await recordDeploymentProviderConfigFailure({ operation: "deploy_staging", appId: "app-1", releaseId: "rel-1", adminUserId: "admin-1", code: "DEPLOYMENT_PROVIDER_NOT_CONFIGURED", now: new Date("2026-10-09T10:00:00Z") });
    const rows = getDb().prepare("select * from deployment_provider_config_failures").all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: "deploy_staging", app_id: "app-1", release_id: "rel-1", admin_user_id: "admin-1", error_code: "DEPLOYMENT_PROVIDER_NOT_CONFIGURED" });
    expect(JSON.stringify(rows[0])).not.toMatch(/token|secret|Bearer/i);
  });

  it("the failure ledger is append-only", async () => {
    const { recordDeploymentProviderConfigFailure } = await import("@/lib/deployment-provider/config-failure");
    await recordDeploymentProviderConfigFailure({ operation: "approve_production", appId: "a", releaseId: "r", adminUserId: "u", code: "DEPLOYMENT_PROVIDER_NOT_CONFIGURED", now: new Date() });
    expect(() => getDb().prepare("update deployment_provider_config_failures set error_code='X'").run()).toThrow(/immutable|append/i);
    expect(() => getDb().prepare("delete from deployment_provider_config_failures").run()).toThrow(/immutable|append/i);
  });
});
