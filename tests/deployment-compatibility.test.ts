import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { createApp, activateApp } from "@/lib/db/app-registry-repo";
import { getDb } from "@/lib/db/client";
import { createOrReplaceBinding, verifyBinding } from "@/lib/deployment-binding/service";
import { createRelease } from "@/lib/deployment-release/service";
import { deployToStaging } from "@/lib/deployment-staging/service";
import { createFakeDeploymentProvider } from "@/lib/deployment-provider/fake-adapter";

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

function fakeProvider() {
  return createFakeDeploymentProvider({ knownProjects: [] });
}

async function bindStaging(appId: string, provider: ReturnType<typeof fakeProvider>) {
  await createOrReplaceBinding({
    appId, environment: "staging", provider: "vercel", providerTeamId: "team-babysteps",
    providerProjectId: "proj-chess-master", expectedRepository: "babysteps/chess-master",
    adminUserId: ADMIN, idempotencyKey: randomUUID(),
  });
  await verifyBinding({ appId, environment: "staging", adminUserId: ADMIN, provider }, new Date());
}

async function progressRowFor(appId: string, schemaVersion: number) {
  const { user } = await sqliteAuthAdapter.signUp(`compat-parent-${randomUUID()}@example.com`, "CorrectHorse1!");
  const learner = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-03-10", idempotencyKey: randomUUID() }, "2026-08-04")).learner;
  getDb().prepare(
    "insert into learner_app_progress(learner_id, app_id, schema_version, updated_at) values(?,?,?,?)",
  ).run(learner.id, appId, schemaVersion, new Date().toISOString());
}

describe("AR-002 session 2: backward-compatibility gate", () => {
  beforeEach(async () => {
    useInMemoryDb();
    ADMIN = (await sqliteAuthAdapter.signUp("compat-admin@example.com", "CorrectHorse1!")).user.id;
  });

  it("passes with no represented progress regardless of readableSchemaVersions", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindStaging(appId, provider);
    const release = await createRelease({
      appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-1",
      dependencyLockHash: "lock-1", buildInputHash: "build-1", artifactDigest: "sha256:1",
      manifest: manifestFor("chess-master"), gateResults: passingGates,
      createdByCiPrincipal: "ci-1", idempotencyKey: randomUUID(),
    });

    const { release: staged } = await deployToStaging({ appId, releaseId: release.id, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider, new Date());
    expect(staged.status).toBe("verified");

    const report = getDb().prepare("select status, represented_progress_schema_versions_json from app_release_compatibility_reports where release_id = ?").get(release.id) as { status: string; represented_progress_schema_versions_json: string };
    expect(report.status).toBe("passed");
    expect(JSON.parse(report.represented_progress_schema_versions_json)).toEqual([]);
  });

  it("passes when the release declares every represented schema version as readable", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindStaging(appId, provider);
    await progressRowFor(appId, 1);
    await progressRowFor(appId, 2);
    const release = await createRelease({
      appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-2",
      dependencyLockHash: "lock-2", buildInputHash: "build-2", artifactDigest: "sha256:2",
      manifest: manifestFor("chess-master"), gateResults: passingGates, readableSchemaVersions: [1, 2, 3],
      createdByCiPrincipal: "ci-1", idempotencyKey: randomUUID(),
    });

    const { release: staged } = await deployToStaging({ appId, releaseId: release.id, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider, new Date());
    expect(staged.status).toBe("verified");
  });

  // AT-AR-002-36/37: a release that can't read a schema version genuinely
  // represented in retained progress never becomes verified.
  it("blocks verification when a represented schema version isn't declared readable", async () => {
    const provider = fakeProvider();
    const appId = await seedActiveApp("chess-master");
    await bindStaging(appId, provider);
    await progressRowFor(appId, 1);
    await progressRowFor(appId, 3);
    const release = await createRelease({
      appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-3",
      dependencyLockHash: "lock-3", buildInputHash: "build-3", artifactDigest: "sha256:3",
      manifest: manifestFor("chess-master"), gateResults: passingGates, readableSchemaVersions: [2, 3],
      createdByCiPrincipal: "ci-1", idempotencyKey: randomUUID(),
    });

    await expect(
      deployToStaging({ appId, releaseId: release.id, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider, new Date()),
    ).rejects.toMatchObject({ code: "RELEASE_BACKWARD_COMPATIBILITY_FAILED" });

    const releaseRow = getDb().prepare("select status from app_releases where id = ?").get(release.id) as { status: string };
    expect(releaseRow.status).toBe("staging_failed");
    const report = getDb().prepare("select status, represented_progress_schema_versions_json from app_release_compatibility_reports where release_id = ?").get(release.id) as { status: string; represented_progress_schema_versions_json: string };
    expect(report.status).toBe("failed");
    expect(JSON.parse(report.represented_progress_schema_versions_json).sort()).toEqual([1, 3]);
  });
});
