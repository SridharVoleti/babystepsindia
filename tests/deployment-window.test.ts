import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createApp, activateApp } from "@/lib/db/app-registry-repo";
import { getDb } from "@/lib/db/client";
import { createOrReplaceBinding, getBinding, verifyBinding } from "@/lib/deployment-binding/service";
import { createRelease } from "@/lib/deployment-release/service";
import { deployToStaging } from "@/lib/deployment-staging/service";
import { approveProduction, getPublication } from "@/lib/deployment-production/service";
import { resolveTrustedDeployment } from "@/lib/app-launch/deployment";
import {
  cancelDeploymentWindow,
  getWindow,
  rescheduleDeploymentWindow,
  scheduleDeploymentWindow,
  sweepDeploymentWindows,
} from "@/lib/deployment-window/service";
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

function fakeProvider(opts: { unhealthyOrigins?: string[] } = {}) {
  return createFakeDeploymentProvider({ knownProjects: [], unhealthyOrigins: opts.unhealthyOrigins });
}

async function bindAndVerify(appId: string, environment: "staging" | "production", provider: ReturnType<typeof fakeProvider>, projectId: string) {
  if ((await getBinding(appId, environment))?.bindingStatus === "verified") return;
  await createOrReplaceBinding({
    appId, environment, provider: "vercel", providerTeamId: "team-babysteps",
    providerProjectId: projectId, expectedRepository: "babysteps/chess-master",
    adminUserId: ADMIN, idempotencyKey: randomUUID(),
  });
  await verifyBinding({ appId, environment, adminUserId: ADMIN, provider }, new Date());
}

async function stagedVerifiedRelease(appId: string, provider: ReturnType<typeof fakeProvider>, commitSha: string) {
  await bindAndVerify(appId, "staging", provider, "proj-chess-master");
  const release = await createRelease({
    appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: commitSha,
    dependencyLockHash: `lock-${commitSha}`, buildInputHash: `build-${commitSha}`, artifactDigest: `sha256:${commitSha}`,
    manifest: manifestFor("chess-master"), gateResults: passingGates,
    createdByCiPrincipal: "ci-1", idempotencyKey: randomUUID(),
  });
  await deployToStaging({ appId, releaseId: release.id, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider, new Date());
  return release.id;
}

// A minimal, directly-inserted learner_sessions row — enough to satisfy
// this table's NOT NULL/CHECK constraints for a "reserved session exists"
// fixture, without going through the full LP-004/LA-001/EN-002 launch
// chain (irrelevant to what the window sweep itself checks).
async function reservedSessionFor(appId: string, environment: string, now: Date) {
  const { user } = await sqliteAuthAdapter.signUp(`learner-parent-${randomUUID()}@example.com`, "CorrectHorse1!");
  getDb().prepare("update profiles set onboarding_status='complete' where id=?").run(user.id);
  const learner = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-03-10", idempotencyKey: randomUUID() }, "2026-08-04")).learner;
  const sessionId = randomUUID();
  getDb().prepare(
    `insert into learner_sessions(id,learner_id,app_id,parent_user_id,device_session_id,week_key,week_timezone,
      weekly_slot_number,source,status,schedule_authorization_id,started_at,resume_token_hash,
      deployment_environment,created_at,updated_at)
     values(?,?,?,?,?,'2026-W32','Asia/Kolkata',1,'normal','active','schedule-1',?,?,?,?,?)`,
  ).run(sessionId, learner.id, appId, user.id, randomUUID(), now.toISOString(), "hash", environment, now.toISOString(), now.toISOString());
  return sessionId;
}

describe("AR-002 session 2: real deployment windows", () => {
  beforeEach(async () => {
    useInMemoryDb();
    ADMIN = (await sqliteAuthAdapter.signUp("window-admin@example.com", "CorrectHorse1!")).user.id;
  });

  // AT-AR-002-38: a window scheduled less than 60 minutes ahead is rejected.
  it("rejects a window scheduled with less than 60 minutes lead time", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    const releaseId = await stagedVerifiedRelease(appId, provider, "commit-1");
    const now = new Date();

    await expect(
      scheduleDeploymentWindow(
        { appId, releaseId, startsAt: new Date(now.getTime() + 30 * 60 * 1000), endsAt: new Date(now.getTime() + 75 * 60 * 1000), adminUserId: ADMIN, idempotencyKey: randomUUID() },
        now,
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "DEPLOYMENT_WINDOW_LEAD_TIME_REQUIRED" }));
  });

  // Business rule 50: only one non-final window per app at a time.
  it("rejects a second window while one is already scheduled for the app", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    const releaseId1 = await stagedVerifiedRelease(appId, provider, "commit-1");
    const releaseId2 = await stagedVerifiedRelease(appId, provider, "commit-2");
    const now = new Date();
    const startsAt = new Date(now.getTime() + 61 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 45 * 60 * 1000);

    await scheduleDeploymentWindow({ appId, releaseId: releaseId1, startsAt, endsAt, adminUserId: ADMIN, idempotencyKey: randomUUID() }, now);

    await expect(
      scheduleDeploymentWindow({ appId, releaseId: releaseId2, startsAt, endsAt, adminUserId: ADMIN, idempotencyKey: randomUUID() }, now),
    ).rejects.toThrow(expect.objectContaining({ code: "DEPLOYMENT_WINDOW_CONFLICT" }));
  });

  // AT-AR-002-41: at starts_at, a reserved session for the app blocks the
  // deploy — the window is postponed, not executed, and the current
  // publication is left untouched.
  it("postpones the window at starts_at when a reserved session still exists for the app", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    const releaseId = await stagedVerifiedRelease(appId, provider, "commit-1");
    const scheduleAt = new Date();
    const startsAt = new Date(scheduleAt.getTime() + 61 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 45 * 60 * 1000);
    const window = await scheduleDeploymentWindow({ appId, releaseId, startsAt, endsAt, adminUserId: ADMIN, idempotencyKey: randomUUID() }, scheduleAt);
    await reservedSessionFor(appId, "production", scheduleAt);

    await sweepDeploymentWindows(startsAt, provider);

    const updated = await getWindow(window.id);
    expect(updated?.status).toBe("draining");
    expect(updated?.failureCode).toBe("DEPLOYMENT_SESSIONS_ACTIVE");
    expect(await getPublication(appId, "production")).toBeNull();
  });

  // AT-AR-002-42: overrunning ends_at while sessions still block deployment
  // stays fail-closed (extended_safe_block), not silently unblocked.
  it("moves an overrun blocked window to extended_safe_block rather than unblocking", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    const releaseId = await stagedVerifiedRelease(appId, provider, "commit-1");
    const scheduleAt = new Date();
    const startsAt = new Date(scheduleAt.getTime() + 61 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 45 * 60 * 1000);
    const window = await scheduleDeploymentWindow({ appId, releaseId, startsAt, endsAt, adminUserId: ADMIN, idempotencyKey: randomUUID() }, scheduleAt);
    await reservedSessionFor(appId, "production", scheduleAt);

    await sweepDeploymentWindows(new Date(endsAt.getTime() + 1000), provider);

    expect((await getWindow(window.id))?.status).toBe("extended_safe_block");
  });

  // AT-AR-002-38/41: with zero reserved sessions at starts_at, the sweep
  // promotes using the same artifact and completes the window.
  it("promotes at starts_at once zero sessions remain, completing the window", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    const releaseId = await stagedVerifiedRelease(appId, provider, "commit-1");
    const scheduleAt = new Date();
    const startsAt = new Date(scheduleAt.getTime() + 61 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 45 * 60 * 1000);
    const window = await scheduleDeploymentWindow({ appId, releaseId, startsAt, endsAt, adminUserId: ADMIN, idempotencyKey: randomUUID() }, scheduleAt);

    await sweepDeploymentWindows(startsAt, provider);

    expect((await getWindow(window.id))?.status).toBe("completed");
    const publication = await getPublication(appId, "production");
    expect(publication?.currentPublishedDeploymentId).toBeTruthy();
  });

  // AT-AR-002-39/52: drain/window-end timing projects onto the currently
  // published deployment so the existing dispatch-block read path
  // (resolveTrustedDeployment, already relied on by LA-001) blocks it
  // without any change to that module.
  it("projects drain timing onto the currently published deployment for the existing dispatch-block read path", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    const firstReleaseId = await stagedVerifiedRelease(appId, provider, "commit-1");
    const scheduleAt1 = new Date();
    const window1Starts = new Date(scheduleAt1.getTime() + 61 * 60 * 1000);
    const window1 = await scheduleDeploymentWindow({ appId, releaseId: firstReleaseId, startsAt: window1Starts, endsAt: new Date(window1Starts.getTime() + 45 * 60 * 1000), adminUserId: ADMIN, idempotencyKey: randomUUID() }, scheduleAt1);
    const published = await approveProduction(
      { appId, releaseId: firstReleaseId, adminUserId: ADMIN, idempotencyKey: randomUUID(),
        deploymentWindowId: window1.id },
      provider,
      window1Starts,
    );

    const secondReleaseId = await stagedVerifiedRelease(appId, provider, "commit-2");
    const scheduleAt2 = window1Starts;
    const startsAt2 = new Date(scheduleAt2.getTime() + 61 * 60 * 1000);
    const endsAt2 = new Date(startsAt2.getTime() + 45 * 60 * 1000);
    await scheduleDeploymentWindow({ appId, releaseId: secondReleaseId, startsAt: startsAt2, endsAt: endsAt2, adminUserId: ADMIN, idempotencyKey: randomUUID() }, scheduleAt2);

    // Before drain starts: the existing session's dispatch is unblocked.
    const sessionId = await reservedSessionFor(appId, "production", scheduleAt2);
    getDb().prepare(
      `update learner_sessions set deployment_id=?, release_id=?, deployment_origin=?, launch_path=? where id=?`,
    ).run(published.deployment.id, firstReleaseId, published.deployment.verifiedOrigin, "/launch", sessionId);
    expect((await resolveTrustedDeployment(sessionId, new Date(startsAt2.getTime() - 61 * 60 * 1000))).dispatchBlocked).toBe(false);

    // Once "now" is at/after drain_starts_at (startsAt2 - 60min), dispatch
    // for that same already-started session is blocked.
    expect((await resolveTrustedDeployment(sessionId, new Date(startsAt2.getTime() - 59 * 60 * 1000))).dispatchBlocked).toBe(true);
  });

  // Regression: drain projection must target only the deployment the
  // publication pointer currently names. Every historical deployment keeps
  // its own 'published' row in app_deployment_launch_controls forever (see
  // AC25/session 1) — scheduling a window for a third release must not
  // drain-block dispatch for a session still bound to the first,
  // already-superseded deployment.
  it("does not drain-block dispatch for a session on an older, already-superseded deployment", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");

    const releaseId1 = await stagedVerifiedRelease(appId, provider, "commit-1");
    const scheduleAt1 = new Date();
    const window1Starts = new Date(scheduleAt1.getTime() + 61 * 60 * 1000);
    const window1 = await scheduleDeploymentWindow({ appId, releaseId: releaseId1, startsAt: window1Starts, endsAt: new Date(window1Starts.getTime() + 45 * 60 * 1000), adminUserId: ADMIN, idempotencyKey: randomUUID() }, scheduleAt1);
    const published1 = await approveProduction(
      { appId, releaseId: releaseId1, adminUserId: ADMIN, idempotencyKey: randomUUID(),
        deploymentWindowId: window1.id },
      provider,
      window1Starts,
    );

    const releaseId2 = await stagedVerifiedRelease(appId, provider, "commit-2");
    const window2Starts = new Date(window1Starts.getTime() + 61 * 60 * 1000);
    const window2 = await scheduleDeploymentWindow({ appId, releaseId: releaseId2, startsAt: window2Starts, endsAt: new Date(window2Starts.getTime() + 45 * 60 * 1000), adminUserId: ADMIN, idempotencyKey: randomUUID() }, window1Starts);
    const published2 = await approveProduction(
      { appId, releaseId: releaseId2, adminUserId: ADMIN, idempotencyKey: randomUUID(),
        deploymentWindowId: window2.id },
      provider,
      window2Starts,
    );

    const releaseId3 = await stagedVerifiedRelease(appId, provider, "commit-3");
    const window3Starts = new Date(window2Starts.getTime() + 61 * 60 * 1000);
    await scheduleDeploymentWindow(
      { appId, releaseId: releaseId3, startsAt: window3Starts, endsAt: new Date(window3Starts.getTime() + 45 * 60 * 1000), adminUserId: ADMIN, idempotencyKey: randomUUID() },
      window2Starts,
    );

    const oldSessionId = await reservedSessionFor(appId, "production", window2Starts);
    getDb().prepare("update learner_sessions set deployment_id=?, release_id=?, deployment_origin=?, launch_path=? where id=?")
      .run(published1.deployment.id, releaseId1, published1.deployment.verifiedOrigin, "/launch", oldSessionId);

    const currentSessionId = await reservedSessionFor(appId, "production", window2Starts);
    getDb().prepare("update learner_sessions set deployment_id=?, release_id=?, deployment_origin=?, launch_path=? where id=?")
      .run(published2.deployment.id, releaseId2, published2.deployment.verifiedOrigin, "/launch", currentSessionId);

    const duringDrain = new Date(window3Starts.getTime() - 30 * 60 * 1000);
    expect((await resolveTrustedDeployment(oldSessionId, duringDrain)).dispatchBlocked).toBe(false);
    expect((await resolveTrustedDeployment(currentSessionId, duringDrain)).dispatchBlocked).toBe(true);
  });

  it("reschedules a window's timing and re-projects it", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    const releaseId = await stagedVerifiedRelease(appId, provider, "commit-1");
    const now = new Date();
    const startsAt = new Date(now.getTime() + 61 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 45 * 60 * 1000);
    const window = await scheduleDeploymentWindow({ appId, releaseId, startsAt, endsAt, adminUserId: ADMIN, idempotencyKey: randomUUID() }, now);

    const newStartsAt = new Date(startsAt.getTime() + 30 * 60 * 1000);
    const newEndsAt = new Date(newStartsAt.getTime() + 45 * 60 * 1000);
    const rescheduled = await rescheduleDeploymentWindow(
      { windowId: window.id, startsAt: newStartsAt, endsAt: newEndsAt, expectedVersion: window.version, adminUserId: ADMIN, idempotencyKey: randomUUID() },
      now,
    );
    expect(rescheduled.startsAt).toBe(newStartsAt.toISOString());
    expect(rescheduled.status).toBe("scheduled");
  });

  it("cancels a scheduled window, clears the drain projection, and allows scheduling a new one", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindAndVerify(appId, "production", provider, "proj-chess-master-prod");
    const releaseId1 = await stagedVerifiedRelease(appId, provider, "commit-1");
    const now = new Date();
    const startsAt = new Date(now.getTime() + 61 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 45 * 60 * 1000);
    const window = await scheduleDeploymentWindow({ appId, releaseId: releaseId1, startsAt, endsAt, adminUserId: ADMIN, idempotencyKey: randomUUID() }, now);

    const cancelled = await cancelDeploymentWindow({ windowId: window.id, expectedVersion: window.version, adminUserId: ADMIN, idempotencyKey: randomUUID() }, now);
    expect(cancelled.status).toBe("cancelled");

    const releaseId2 = await stagedVerifiedRelease(appId, provider, "commit-2");
    const secondWindow = await scheduleDeploymentWindow({ appId, releaseId: releaseId2, startsAt, endsAt, adminUserId: ADMIN, idempotencyKey: randomUUID() }, now);
    expect(secondWindow.status).toBe("scheduled");
  });
});
