// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { activateApp, createApp } from "@/lib/db/app-registry-repo";
import { createRelease } from "@/lib/deployment-release/service";
import { getReleaseAchievementContract, validateReleaseAchievementContract } from "@/lib/achievements/service";

let adminId: string;
const gates = { dependencyInstall: true, typeCheck: true, lint: true, unitTests: true,
  contractTests: true, security: true, build: true };

async function activeApp(appKey: string) {
  const app = createApp(adminId, { appKey, displayName: appKey, shortDescription: "Learning app",
    iconAssetKey: "icon-open-book", category: "learning", owningTeam: "team", internalNotes: null,
    idempotencyKey: randomUUID() });
  await activateApp(adminId, app.id, { expectedVersion: app.version, idempotencyKey: randomUUID() });
  return app.id;
}

function release(appId: string, appKey: string, asset: string) {
  return createRelease({ appId, sourceRepository: "org/repo", sourceCommitSha: randomUUID(),
    dependencyLockHash: "lock", buildInputHash: "build", artifactDigest: randomUUID(),
    manifest: { manifestVersion: 1, appKey, launchPath: "/launch", returnPath: "/return",
      identityPath: "/identity", healthPath: "/health", minimumSdkVersion: "1.0.0",
      achievement: { contractVersion: "1.0", modelVersion: "model-1", allowedBadgeAssetKeys: [asset] } },
    gateResults: gates, createdByCiPrincipal: "ci-1", idempotencyKey: randomUUID() });
}

beforeEach(async () => {
  useInMemoryDb();
  adminId = (await sqliteAuthAdapter.signUp(`eg-release-${randomUUID()}@example.com`, "CorrectHorse1!")).user.id;
});

describe("EG-001 release-bound achievement contract", () => {
  it("AT-EG-001-47 registers and approves a declared contract with approved assets", async () => {
    const appId = await activeApp("eg-app");
    const created = release(appId, "eg-app", "icon-open-book");
    expect(await getReleaseAchievementContract(appId, created.id)).toMatchObject({ status: "pending",
      contractVersion: "1.0", modelVersion: "model-1", allowedBadgeAssetKeys: ["icon-open-book"] });
    expect(await validateReleaseAchievementContract(appId, created.id, new Date())).toMatchObject({
      declared: true, passed: true,
    });
    expect((await getReleaseAchievementContract(appId, created.id)).status).toBe("approved");
  });

  it("blocks achievement emission when a release declares an unapproved badge asset", async () => {
    const appId = await activeApp("eg-bad-asset-app");
    const created = release(appId, "eg-bad-asset-app", "unapproved-badge");
    expect(await validateReleaseAchievementContract(appId, created.id, new Date())).toMatchObject({
      declared: true, passed: false, missingAssetKeys: ["unapproved-badge"],
    });
    expect((await getReleaseAchievementContract(appId, created.id)).status).toBe("blocked");
  });
});
