import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createApp, activateApp } from "@/lib/db/app-registry-repo";
import { getDb } from "@/lib/db/client";
import { createOrReplaceBinding, getBinding, verifyBinding } from "@/lib/deployment-binding/service";
import { createRelease } from "@/lib/deployment-release/service";
import { deployToStaging } from "@/lib/deployment-staging/service";
import { approveProduction, getPublication } from "@/lib/deployment-production/service";
import { scheduleDeploymentWindow } from "@/lib/deployment-window/service";
import { rollbackProduction, sweepReleaseSafetyObservations } from "@/lib/deployment-rollback/service";
import { createFakeDeploymentProvider } from "@/lib/deployment-provider/fake-adapter";
import type { DeploymentProvider } from "@/lib/deployment-provider/types";

let ADMIN: string;

async function seedActiveApp(appKey: string) {
  const app = createApp(ADMIN, {
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

function fakeProvider(opts: { unhealthyOrigins?: string[] } = {}) {
  return createFakeDeploymentProvider({ knownProjects: [], unhealthyOrigins: opts.unhealthyOrigins });
}

// The fake adapter derives origin purely from provider project + environment
// (deterministic, so tests can predict it ahead of time) — every release for
// the same app/project shares one production origin, so "release 2 becomes
// unhealthy while release 1 stayed healthy" can't be expressed via
// createFakeDeploymentProvider's static unhealthyOrigins list alone. This
// wraps one real fake-adapter instance (deploy/promote/verifyProject keep
// their normal deterministic behavior, including rollback's own re-promote
// call needing to find an earlier release's staged artifact in the same
// instance) with a checkHealth the test can flip live.
function providerWithToggleableHealth(): { provider: DeploymentProvider; setHealthy: (value: boolean) => void } {
  const base = createFakeDeploymentProvider({ knownProjects: [] });
  const state = { healthy: true };
  const provider: DeploymentProvider = { ...base, checkHealth: async () => ({ healthy: state.healthy }) };
  return { provider, setHealthy: (value: boolean) => { state.healthy = value; } };
}

async function bindAndVerify(appId: string, environment: "staging" | "production", provider: ReturnType<typeof fakeProvider>, projectId: string) {
  if (getBinding(appId, environment)?.bindingStatus === "verified") return;
  createOrReplaceBinding({
    appId, environment, provider: "vercel", providerTeamId: "team-babysteps",
    providerProjectId: projectId, expectedRepository: "babysteps/chess-master",
    adminUserId: ADMIN, idempotencyKey: randomUUID(),
  });
  await verifyBinding({ appId, environment, adminUserId: ADMIN, provider }, new Date());
}

async function stagedVerifiedRelease(appId: string, provider: ReturnType<typeof fakeProvider>, commitSha: string) {
  await bindAndVerify(appId, "staging", provider, "proj-chess-master");
  const release = createRelease({
    appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: commitSha,
    dependencyLockHash: `lock-${commitSha}`, buildInputHash: `build-${commitSha}`, artifactDigest: `sha256:${commitSha}`,
    manifest: manifestFor("chess-master"), gateResults: passingGates,
    createdByCiPrincipal: "ci-1", idempotencyKey: randomUUID(),
  });
  await deployToStaging({ appId, releaseId: release.id, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider, new Date());
  return release.id;
}

async function publish(appId: string, provider: ReturnType<typeof fakeProvider>, commitSha: string, scheduleAt: Date) {
  const releaseId = await stagedVerifiedRelease(appId, provider, commitSha);
  const startsAt = new Date(scheduleAt.getTime() + 61 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 45 * 60 * 1000);
  const window = scheduleDeploymentWindow({ appId, releaseId, startsAt, endsAt, adminUserId: ADMIN, idempotencyKey: randomUUID() }, scheduleAt);
  const result = await approveProduction({ appId, releaseId, adminUserId: ADMIN, idempotencyKey: randomUUID(), deploymentWindowId: window.id }, provider, startsAt);
  return { releaseId, ...result, nextNow: startsAt };
}

describe("AR-002 session 2: production rollback", () => {
  beforeEach(async () => {
    useInMemoryDb();
    ADMIN = (await sqliteAuthAdapter.signUp("rollback-admin@example.com", "CorrectHorse1!")).user.id;
  });

  it("rejects a rollback when there is no previous healthy deployment", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    const first = await publish(appId, provider, "commit-1", new Date());

    await expect(
      rollbackProduction({ appId, deploymentId: first.deployment.id, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider, first.nextNow),
    ).rejects.toMatchObject({ code: "ROLLBACK_TARGET_NOT_AVAILABLE" });
  });

  it("restores the previous healthy deployment and swaps the publication pointer", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    const first = await publish(appId, provider, "commit-1", new Date());
    const second = await publish(appId, provider, "commit-2", first.nextNow);

    const result = await rollbackProduction(
      { appId, deploymentId: second.deployment.id, adminUserId: ADMIN, idempotencyKey: randomUUID() },
      provider,
      second.nextNow,
    );

    expect(result.restoredDeploymentId).toBe(first.deployment.id);
    expect(result.rolledBackDeploymentId).toBe(second.deployment.id);
    expect(result.publication.currentPublishedDeploymentId).toBe(first.deployment.id);
    expect(result.publication.previousHealthyDeploymentId).toBeNull();

    const rolledBackRow = getDb().prepare("select status from app_deployments where id = ?").get(second.deployment.id) as { status: string };
    expect(rolledBackRow.status).toBe("rolled_back");
    const restoredRow = getDb().prepare("select status from app_deployments where id = ?").get(first.deployment.id) as { status: string };
    expect(restoredRow.status).toBe("published");
  });

  it("does not affect new-session resolution semantics for other apps and leaves the rollback target as the sole further target", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    const first = await publish(appId, provider, "commit-1", new Date());
    const second = await publish(appId, provider, "commit-2", first.nextNow);

    await rollbackProduction({ appId, deploymentId: second.deployment.id, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider, second.nextNow);

    // A second rollback attempt has nothing further to roll back to.
    await expect(
      rollbackProduction({ appId, deploymentId: first.deployment.id, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider, second.nextNow),
    ).rejects.toMatchObject({ code: "ROLLBACK_TARGET_NOT_AVAILABLE" });
  });

  it("rejects rolling back a deployment that is not the current publication", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    const first = await publish(appId, provider, "commit-1", new Date());
    const second = await publish(appId, provider, "commit-2", first.nextNow);

    await expect(
      rollbackProduction({ appId, deploymentId: first.deployment.id, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider, second.nextNow),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_VERSION_CONFLICT" });
  });

  describe("automated release-safety sweep", () => {
    it("runs the first check immediately but throttles further checks to once a minute", async () => {
      const provider = fakeProvider();
      const appId = await seedActiveApp("chess-master");
      await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
      const first = await publish(appId, provider, "commit-1", new Date());

      await sweepReleaseSafetyObservations(new Date(first.nextNow.getTime() + 10 * 1000), provider);
      // A second tick 10 seconds later (well under the one-minute interval)
      // must not run another check.
      await sweepReleaseSafetyObservations(new Date(first.nextNow.getTime() + 20 * 1000), provider);

      const observation = getDb().prepare("select checks_run, status from app_deployment_safety_observations where deployment_id = ?").get(first.deployment.id) as { checks_run: number; status: string };
      expect(observation.checks_run).toBe(1);
      expect(observation.status).toBe("observing");
    });

    it("marks the observation passed once ten minutes elapse with healthy checks", async () => {
      const provider = fakeProvider();
      const appId = await seedActiveApp("chess-master");
      await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
      const first = await publish(appId, provider, "commit-1", new Date());

      for (let minute = 1; minute <= 10; minute += 1) {
        await sweepReleaseSafetyObservations(new Date(first.nextNow.getTime() + minute * 60 * 1000), provider);
      }

      const observation = getDb().prepare("select checks_run, status from app_deployment_safety_observations where deployment_id = ?").get(first.deployment.id) as { checks_run: number; status: string };
      expect(observation.checks_run).toBe(10);
      expect(observation.status).toBe("passed");
      expect(getPublication(appId, "production")?.currentPublishedDeploymentId).toBe(first.deployment.id);
    });

    // AT-AR-002-27: three consecutive critical availability failures
    // trigger automated rollback through the same rollbackProduction core.
    it("automatically rolls back after three consecutive availability failures", async () => {
      const appId = await seedActiveApp("chess-master");
      const { provider, setHealthy } = providerWithToggleableHealth();
      await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
      const first = await publish(appId, provider, "commit-1", new Date());
      const second = await publish(appId, provider, "commit-2", first.nextNow);
      expect(getPublication(appId, "production")?.currentPublishedDeploymentId).toBe(second.deployment.id);

      setHealthy(false);
      let checkAt = second.nextNow;
      for (let i = 0; i < 3; i += 1) {
        checkAt = new Date(checkAt.getTime() + 60 * 1000);
        await sweepReleaseSafetyObservations(checkAt, provider);
      }

      expect(getPublication(appId, "production")?.currentPublishedDeploymentId).toBe(first.deployment.id);
      const rolledBackObservation = getDb().prepare("select status from app_deployment_safety_observations where deployment_id = ?").get(second.deployment.id) as { status: string };
      expect(rolledBackObservation.status).toBe("rollback_triggered");
      const alert = getDb().prepare("select alert_type, metadata from platform_alerts where json_extract(metadata,'$.deploymentId') = ?").get(second.deployment.id) as { alert_type: string; metadata: string } | undefined;
      expect(alert?.alert_type).toBe(`deployment_automated_rollback:${second.deployment.id}`);
      expect(JSON.parse(alert!.metadata)).toMatchObject({ capabilityFamily: "app_platform_contracts", severity: "critical", deploymentId: second.deployment.id });
    });
  });
});
