import { describe, expect, it } from "vitest";
import type { DeploymentProvider } from "@/lib/deployment-provider/types";
import { createFakeDeploymentProvider } from "@/lib/deployment-provider/fake-adapter";
import { VercelDeploymentProvider } from "@/lib/deployment-provider/vercel-adapter";

// AT-AR-002-01: the generic provider interface and the Vercel Version 1
// adapter both pass the same contract suite — core pipeline logic never
// depends on provider-specific behavior.
function contractSuite(name: string, makeProvider: () => DeploymentProvider, opts: { live: boolean }) {
  describe(`DeploymentProvider contract: ${name}`, () => {
    const provider = makeProvider();

    it("has a stable provider name", () => {
      expect(provider.name).toBe("vercel");
    });

    (opts.live ? it.skip : it)("verifies a known, correctly-owned project", async () => {
      const result = await provider.verifyProject({
        providerTeamId: "team-babysteps",
        providerProjectId: "proj-chess-master",
        expectedRepository: "babysteps/chess-master",
      });
      expect(result.verified).toBe(true);
    });

    (opts.live ? it.skip : it)("rejects a project outside the approved team", async () => {
      const result = await provider.verifyProject({
        providerTeamId: "team-other",
        providerProjectId: "proj-chess-master",
        expectedRepository: "babysteps/chess-master",
      });
      expect(result.verified).toBe(false);
      if (!result.verified) expect(result.reason).toBe("TEAM_MISMATCH");
    });

    (opts.live ? it.skip : it)("rejects a repository mismatch", async () => {
      const result = await provider.verifyProject({
        providerTeamId: "team-babysteps",
        providerProjectId: "proj-chess-master",
        expectedRepository: "babysteps/wrong-repo",
      });
      expect(result.verified).toBe(false);
      if (!result.verified) expect(result.reason).toBe("REPOSITORY_MISMATCH");
    });

    (opts.live ? it.skip : it)("deploys an artifact and returns a stable origin", async () => {
      const result = await provider.deploy({
        providerTeamId: "team-babysteps",
        providerProjectId: "proj-chess-master",
        environment: "staging",
        artifactDigest: "sha256:abc123",
        sourceCommitSha: "commit-abc",
      });
      expect(result.status).toBe("ready");
      expect(result.origin).toMatch(/^https:\/\//);
      expect(result.providerDeploymentId).toBeTruthy();
    });

    (opts.live ? it.skip : it)("promotes the exact same artifact without producing a new digest", async () => {
      const staged = await provider.deploy({
        providerTeamId: "team-babysteps",
        providerProjectId: "proj-chess-master",
        environment: "staging",
        artifactDigest: "sha256:def456",
        sourceCommitSha: "commit-def",
      });
      const promoted = await provider.promote({
        providerTeamId: "team-babysteps",
        providerProjectId: "proj-chess-master",
        providerDeploymentId: staged.providerDeploymentId,
      });
      expect(promoted.status).toBe("ready");
      expect(promoted.origin).toBeTruthy();
    });

    (opts.live ? it.skip : it)("reports health check outcome for an origin", async () => {
      const healthy = await provider.checkHealth({ origin: "https://chess-master.example.com", healthPath: "/health" });
      expect(typeof healthy.healthy).toBe("boolean");
    });
  });
}

contractSuite("fake adapter", () => createFakeDeploymentProvider({
  knownProjects: [{ providerTeamId: "team-babysteps", providerProjectId: "proj-chess-master", expectedRepository: "babysteps/chess-master" }],
}), { live: false });

// Real network calls only run when VERCEL_API_TOKEN is configured; this
// keeps the suite green with zero live credentials while still proving the
// adapter type-checks against the shared interface.
contractSuite("vercel adapter", () => new VercelDeploymentProvider({ apiToken: process.env.VERCEL_API_TOKEN ?? "" }), {
  live: !process.env.VERCEL_API_TOKEN,
});
