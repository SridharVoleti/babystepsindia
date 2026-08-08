import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createApp, activateApp } from "@/lib/db/app-registry-repo";
import { getDb } from "@/lib/db/client";
import { createOrReplaceBinding, getBinding, verifyBinding } from "@/lib/deployment-binding/service";
import { createRelease } from "@/lib/deployment-release/service";
import { deployToStaging } from "@/lib/deployment-staging/service";
import { approveProduction, getPublication, getPublishedDeployment } from "@/lib/deployment-production/service";
import { scheduleDeploymentWindow } from "@/lib/deployment-window/service";
import { createFakeDeploymentProvider } from "@/lib/deployment-provider/fake-adapter";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";
import { registerProgressSchema } from "@/lib/progress-schema-registry/service";

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

// AR-002 session 2, business rule 38: production promotion now requires a
// scheduled deployment window. Schedules one 61 minutes out and returns
// both the windowId and the "now" at which it's ready to execute.
function scheduledWindow(appId: string, releaseId: string, scheduleAt: Date) {
  const startsAt = new Date(scheduleAt.getTime() + 61 * 60 * 1000);
  const endsAt = new Date(startsAt.getTime() + 45 * 60 * 1000);
  const window = scheduleDeploymentWindow(
    { appId, releaseId, startsAt, endsAt, adminUserId: ADMIN, idempotencyKey: randomUUID() },
    scheduleAt,
  );
  return { windowId: window.id, executeAt: startsAt };
}

describe("AR-002 production promotion and atomic publish", () => {
  beforeEach(async () => {
    useInMemoryDb();
    ADMIN = (await sqliteAuthAdapter.signUp("prod-admin@example.com", "CorrectHorse1!")).user.id;
  });

  // AT-AR-002-18/23/24/26: verified release is promoted, published atomically,
  // and future new-session resolution returns it.
  it("promotes a verified release and atomically publishes it", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    const releaseId = await stagedVerifiedRelease(appId, provider, "commit-1");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");

    const { windowId, executeAt } = scheduledWindow(appId, releaseId, new Date());
    const result = await approveProduction({ appId, releaseId, adminUserId: ADMIN, idempotencyKey: randomUUID(), deploymentWindowId: windowId }, provider, executeAt);
    expect(result.release.status).toBe("promoted");
    expect(result.deployment.status).toBe("published");
    expect(result.publication.currentPublishedDeploymentId).toBe(result.deployment.id);
    expect(result.publication.previousHealthyDeploymentId).toBeNull();

    const published = getPublishedDeployment(appId, "production");
    expect(published?.deploymentId).toBe(result.deployment.id);
    expect(published?.releaseId).toBe(releaseId);
  });

  // AT-AR-002-27: the second publish retains the first as the rollback target.
  it("tracks the previous healthy deployment across a second publish", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");

    const releaseId1 = await stagedVerifiedRelease(appId, provider, "commit-1");
    const window1 = scheduledWindow(appId, releaseId1, new Date());
    const first = await approveProduction({ appId, releaseId: releaseId1, adminUserId: ADMIN, idempotencyKey: randomUUID(), deploymentWindowId: window1.windowId }, provider, window1.executeAt);

    const releaseId2 = await stagedVerifiedRelease(appId, provider, "commit-2");
    const window2 = scheduledWindow(appId, releaseId2, window1.executeAt);
    const second = await approveProduction({ appId, releaseId: releaseId2, adminUserId: ADMIN, idempotencyKey: randomUUID(), deploymentWindowId: window2.windowId }, provider, window2.executeAt);

    expect(second.publication.previousHealthyDeploymentId).toBe(first.deployment.id);
    expect(second.publication.currentPublishedDeploymentId).toBe(second.deployment.id);
  });

  // AT-AR-002-15/19: only a fully staging-verified release can be promoted.
  // Business rule 38 means this is now enforced at window-scheduling time —
  // there is no way to reach approveProduction without a scheduled window,
  // and scheduling one requires the same staging-verified check.
  it("rejects scheduling a deployment window for a release that has not passed staging", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "staging", provider, "proj-chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    const release = createRelease({
      appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-unstaged",
      dependencyLockHash: "lock", buildInputHash: "build", artifactDigest: "sha256:unstaged",
      manifest: manifestFor("chess-master"), gateResults: passingGates,
      createdByCiPrincipal: "ci-1", idempotencyKey: randomUUID(),
    });

    expect(() => scheduledWindow(appId, release.id, new Date())).toThrow(
      expect.objectContaining({ code: "RELEASE_NOT_VERIFIED" }),
    );
  });

  // AT-AR-002-19: pipeline-disabled app cannot promote.
  it("rejects promotion when the production binding has deployment disabled", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    const releaseId = await stagedVerifiedRelease(appId, provider, "commit-1");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    getDb().prepare("update app_deployment_bindings set deployment_enabled=0 where app_id=? and environment='production'").run(appId);
    const { windowId, executeAt } = scheduledWindow(appId, releaseId, new Date());

    await expect(
      approveProduction({ appId, releaseId, adminUserId: ADMIN, idempotencyKey: randomUUID(), deploymentWindowId: windowId }, provider, executeAt),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_PIPELINE_DISABLED" });
  });

  // AT-AR-002-21/22: an unapproved provider origin is rejected and the
  // current publication is left unchanged.
  it("rejects an unapproved production origin and leaves publication unchanged", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    const releaseId = await stagedVerifiedRelease(appId, provider, "commit-1");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    // Sabotage: no approved_domains row matches this suffix.
    getDb().prepare("update approved_domains set status='retired'").run();
    const { windowId, executeAt } = scheduledWindow(appId, releaseId, new Date());

    await expect(
      approveProduction({ appId, releaseId, adminUserId: ADMIN, idempotencyKey: randomUUID(), deploymentWindowId: windowId }, provider, executeAt),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_ORIGIN_REJECTED" });
    expect(getPublication(appId, "production")).toBeNull();
  });

  // AT-AR-002-23: a production smoke failure leaves the current publication unchanged.
  it("rejects a production smoke-test failure and leaves publication unchanged", async () => {
    // The fake provider's promote() derives the production origin from the
    // exact staging origin it deployed ("-staging." -> "-production."), so
    // it's predictable ahead of time for a single shared provider instance.
    const prodOrigin = "https://proj-chess-master-production.example.dev";
    const provider = fakeProvider({ unhealthyOrigins: [prodOrigin] });
    const appId = await seedActiveApp("chess-master");
    const releaseId = await stagedVerifiedRelease(appId, provider, "commit-1");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    const { windowId, executeAt } = scheduledWindow(appId, releaseId, new Date());

    await expect(
      approveProduction({ appId, releaseId, adminUserId: ADMIN, idempotencyKey: randomUUID(), deploymentWindowId: windowId }, provider, executeAt),
    ).rejects.toMatchObject({ code: "PRODUCTION_VALIDATION_FAILED" });
    expect(getPublication(appId, "production")).toBeNull();
  });

  // AT-AR-002-20: concurrent production promotions for the same app
  // serialize; only one commits. Business rule 50 (one non-final window
  // per app) means two different releases can no longer even have windows
  // scheduled concurrently for the same app, so this now models the
  // realistic remaining race: two concurrent approval attempts against the
  // exact same scheduled window (e.g. a double-submitted admin click).
  it("serializes concurrent promotion attempts for the same app", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    const releaseId = await stagedVerifiedRelease(appId, provider, "commit-1");
    const { windowId, executeAt } = scheduledWindow(appId, releaseId, new Date());

    const [resultA, resultB] = await Promise.allSettled([
      approveProduction({ appId, releaseId, adminUserId: ADMIN, idempotencyKey: randomUUID(), deploymentWindowId: windowId }, provider, executeAt),
      approveProduction({ appId, releaseId, adminUserId: ADMIN, idempotencyKey: randomUUID(), deploymentWindowId: windowId }, provider, executeAt),
    ]);

    const outcomes = [resultA, resultB];
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "DEPLOYMENT_PROMOTION_IN_PROGRESS" });
  });

  // GAP-037/059: PR-001's compatibility gate blocks a release from
  // reaching production if it declared a progress schema version that has
  // no registered forward+rollback migration path from a schema version
  // still in use by an existing learner's stored progress.
  it("blocks production promotion when the release's progress schema has no migration path from an in-use version", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    const releaseId = await stagedVerifiedRelease(appId, provider, "commit-1");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    getDb().prepare(`insert into learners(id,owner_parent_id,display_name,normalized_display_name,date_of_birth,version,locale,timezone)
      values('learner-1',?,'Asha','asha','2018-01-01',1,'en-IN','Asia/Kolkata')`).run(ADMIN);
    getDb().prepare(`insert into learner_app_progress(learner_id,app_id,schema_version,updated_at)
      values('learner-1',?,1,?)`).run(appId, new Date().toISOString());
    registerProgressSchema({ appId, releaseId, schemaVersion: 2, schemaJson: '{"type":"object"}', now: new Date() });
    // Deliberately no app_progress_schema_migrations row registered.

    const { windowId, executeAt } = scheduledWindow(appId, releaseId, new Date());
    await expect(
      approveProduction({ appId, releaseId, adminUserId: ADMIN, idempotencyKey: randomUUID(), deploymentWindowId: windowId }, provider, executeAt),
    ).rejects.toMatchObject({ code: "RELEASE_PROGRESS_SCHEMA_INCOMPATIBLE" });
    expect(getPublication(appId, "production")).toBeNull();
  });
});
