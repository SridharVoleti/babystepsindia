import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createApp, activateApp } from "@/lib/db/app-registry-repo";
import { createOrReplaceBinding, verifyBinding } from "@/lib/deployment-binding/service";
import { createRelease } from "@/lib/deployment-release/service";
import { deployToStaging } from "@/lib/deployment-staging/service";
import { createFakeDeploymentProvider } from "@/lib/deployment-provider/fake-adapter";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";

let ADMIN: string;

async function seedActiveApp(appKey: string) {
  const app = await createApp(ADMIN, {
    appKey, displayName: appKey, shortDescription: "desc", iconAssetKey: "icon-chess-piece",
    category: "learning", owningTeam: "platform", internalNotes: null, idempotencyKey: randomUUID(),
  });
  await activateApp(ADMIN, app.id, { expectedVersion: app.version, idempotencyKey: randomUUID() });
  return app.id;
}

function manifestFor(appKey: string) {
  return {
    manifestVersion: 1, appKey, launchPath: "/launch", returnPath: "/return",
    identityPath: "/identity", healthPath: "/health", minimumSdkVersion: "1.0.0",
  };
}

const passingGates = {
  dependencyInstall: true, typeCheck: true, lint: true, unitTests: true, contractTests: true, security: true, build: true,
};

async function seedVerifiedStagingBinding(appId: string, provider: ReturnType<typeof createFakeDeploymentProvider>) {
  await createOrReplaceBinding({
    appId, environment: "staging", provider: "vercel", providerTeamId: "team-babysteps",
    providerProjectId: "proj-chess-master", expectedRepository: "babysteps/chess-master",
    adminUserId: ADMIN, idempotencyKey: randomUUID(),
  });
  await verifyBinding({ appId, environment: "staging", adminUserId: ADMIN, provider }, new Date());
}

describe("AR-002 staging deploy and validation", () => {
  beforeEach(async () => {
    useInMemoryDb();
    ADMIN = (await sqliteAuthAdapter.signUp("staging-admin@example.com", "CorrectHorse1!")).user.id;
  });

  // AT-AR-002-15: staging contracts are validated and the release becomes verified.
  it("deploys a release to staging and marks it verified when all checks pass", async () => {
    const provider = createFakeDeploymentProvider({
      knownProjects: [{ providerTeamId: "team-babysteps", providerProjectId: "proj-chess-master", expectedRepository: "babysteps/chess-master" }],
    });
    const appId = await seedActiveApp("chess-master");
    await seedVerifiedStagingBinding(appId, provider);
    const release = await createRelease({
      appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-1",
      dependencyLockHash: "lock-1", buildInputHash: "build-1", artifactDigest: "sha256:digest-1",
      manifest: manifestFor("chess-master"), gateResults: passingGates,
      createdByCiPrincipal: "ci-1", idempotencyKey: randomUUID(),
    });

    const result = await deployToStaging({ appId, releaseId: release.id, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider, new Date());
    expect(result.release.status).toBe("verified");
    expect(result.deployment.status).toBe("published");
    expect(result.deployment.verifiedOrigin).toMatch(/\.example\.dev$/);
  });

  // AT-AR-002-16: a heartbeat/health failure blocks verified status.
  it("marks the release staging_failed when the health check fails", async () => {
    const origin = "https://proj-chess-master-staging.example.dev";
    const provider = createFakeDeploymentProvider({
      knownProjects: [{ providerTeamId: "team-babysteps", providerProjectId: "proj-chess-master", expectedRepository: "babysteps/chess-master" }],
      unhealthyOrigins: [origin],
    });
    const appId = await seedActiveApp("chess-master");
    await seedVerifiedStagingBinding(appId, provider);
    const release = await createRelease({
      appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-2",
      dependencyLockHash: "lock-2", buildInputHash: "build-2", artifactDigest: "sha256:digest-2",
      manifest: manifestFor("chess-master"), gateResults: passingGates,
      createdByCiPrincipal: "ci-1", idempotencyKey: randomUUID(),
    });

    await expect(
      deployToStaging({ appId, releaseId: release.id, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider, new Date()),
    ).rejects.toMatchObject({ code: "STAGING_VALIDATION_FAILED" });
  });

  it("fails staging when an app declares an unsupported EG-003 context version", async () => {
    const provider = createFakeDeploymentProvider({
      knownProjects: [{ providerTeamId: "team-babysteps", providerProjectId: "proj-chess-master",
        expectedRepository: "babysteps/chess-master" }],
    });
    const appId = await seedActiveApp("chess-master");
    await seedVerifiedStagingBinding(appId, provider);
    const release = await createRelease({
      appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-eg003",
      dependencyLockHash: "lock-eg003", buildInputHash: "build-eg003", artifactDigest: "sha256:digest-eg003",
      manifest: { ...manifestFor("chess-master"), weeklyCadenceCelebration: {
        celebrationContextVersion: "2.0", accessibility: { immediateSkip: true, reducedMotion: true,
          keyboardNavigation: true, screenReaderText: true, mobileMinimumTargetCssPixels: 44 },
      } }, gateResults: passingGates, createdByCiPrincipal: "ci-1", idempotencyKey: randomUUID(),
    });
    await expect(deployToStaging({ appId, releaseId: release.id, adminUserId: ADMIN,
      idempotencyKey: randomUUID() }, provider, new Date())).rejects.toMatchObject({ code: "STAGING_VALIDATION_FAILED" });
    const failed = (await import("@/lib/deployment-release/service")).getRelease(release.id);
    expect(failed?.status).toBe("staging_failed");
  });

  it("fails staging when an app declares an unsupported EG-004 motivation contract", async () => {
    const provider = createFakeDeploymentProvider({
      knownProjects: [{ providerTeamId: "team-babysteps", providerProjectId: "proj-chess-master",
        expectedRepository: "babysteps/chess-master" }],
    });
    const appId = await seedActiveApp("chess-master");
    await seedVerifiedStagingBinding(appId, provider);
    const release = await createRelease({
      appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-eg004",
      dependencyLockHash: "lock-eg004", buildInputHash: "build-eg004", artifactDigest: "sha256:digest-eg004",
      manifest: { ...manifestFor("chess-master"), motivation: { motivationContractVersion: "2.0",
        supportedDisplayTypes: ["steps"] } }, gateResults: passingGates, createdByCiPrincipal: "ci-1",
      idempotencyKey: randomUUID(),
    });
    await expect(deployToStaging({ appId, releaseId: release.id, adminUserId: ADMIN,
      idempotencyKey: randomUUID() }, provider, new Date())).rejects.toMatchObject({ code: "STAGING_VALIDATION_FAILED" });
  });

  it("refuses to stage a release when the staging binding is not verified", async () => {
    const provider = createFakeDeploymentProvider({ knownProjects: [] });
    const appId = await seedActiveApp("chess-master");
    const release = await createRelease({
      appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-3",
      dependencyLockHash: "lock-3", buildInputHash: "build-3", artifactDigest: "sha256:digest-3",
      manifest: manifestFor("chess-master"), gateResults: passingGates,
      createdByCiPrincipal: "ci-1", idempotencyKey: randomUUID(),
    });

    await expect(
      deployToStaging({ appId, releaseId: release.id, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider, new Date()),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_PROJECT_NOT_VERIFIED" });
  });

  it("rejects staging a release that already failed its build gates", async () => {
    const provider = createFakeDeploymentProvider({ knownProjects: [] });
    const appId = await seedActiveApp("chess-master");
    await seedVerifiedStagingBinding(appId, provider);
    let releaseId = "";
    try {
      await createRelease({
        appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-4",
        dependencyLockHash: "lock-4", buildInputHash: "build-4", artifactDigest: "sha256:digest-4",
        manifest: manifestFor("chess-master"), gateResults: { ...passingGates, build: false },
        createdByCiPrincipal: "ci-1", idempotencyKey: randomUUID(),
      });
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentPipelineError);
    }
    const { getDb } = await import("@/lib/db/client");
    const row = getDb().prepare("select id from app_releases where app_id=? and source_commit_sha='commit-4'").get(appId) as { id: string };
    releaseId = row.id;

    await expect(
      deployToStaging({ appId, releaseId, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider, new Date()),
    ).rejects.toMatchObject({ code: "RELEASE_GATE_FAILED" });
  });
});
