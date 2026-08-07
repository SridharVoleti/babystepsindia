import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createApp, activateApp } from "@/lib/db/app-registry-repo";
import { createRelease, getRelease } from "@/lib/deployment-release/service";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";

let ADMIN: string;

async function seedActiveApp(appKey: string) {
  const app = createApp(ADMIN, {
    appKey, displayName: appKey, shortDescription: "desc", iconAssetKey: "icon-chess-piece",
    category: "learning", owningTeam: "platform", internalNotes: null, idempotencyKey: randomUUID(),
  });
  await activateApp(ADMIN, app.id, { expectedVersion: app.version, idempotencyKey: randomUUID() });
  return app.id;
}

const passingGates = {
  dependencyInstall: true, typeCheck: true, lint: true, unitTests: true, contractTests: true, security: true, build: true,
};

function manifestFor(appKey: string) {
  return {
    manifestVersion: 1, appKey, launchPath: "/launch", returnPath: "/return",
    identityPath: "/identity", healthPath: "/health", minimumSdkVersion: "1.0.0",
  };
}

describe("AR-002 release creation", () => {
  beforeEach(async () => {
    useInMemoryDb();
    ADMIN = (await sqliteAuthAdapter.signUp("release-admin@example.com", "CorrectHorse1!")).user.id;
  });

  // AT-AR-002-09/10/11: CI alone creates an immutable release; artifact built once.
  it("creates an immutable release when all gates pass", () => {
    return (async () => {
      const appId = await seedActiveApp("chess-master");
      const view = createRelease({
        appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-1",
        dependencyLockHash: "lock-1", buildInputHash: "build-1", artifactDigest: "sha256:digest-1",
        manifest: manifestFor("chess-master"), gateResults: passingGates,
        createdByCiPrincipal: "ci-principal-1", idempotencyKey: randomUUID(),
      });
      expect(view.status).toBe("created");
      expect(view.artifactDigest).toBe("sha256:digest-1");
      expect(getRelease(view.id)?.sourceCommitSha).toBe("commit-1");
    })();
  });

  // AT-AR-002-07: manifest app-key mismatch blocks release creation entirely.
  it("rejects release creation when the manifest app key does not match the registry", async () => {
    const appId = await seedActiveApp("chess-master");
    expect(() =>
      createRelease({
        appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-1",
        dependencyLockHash: "lock-1", buildInputHash: "build-1", artifactDigest: "sha256:digest-1",
        manifest: manifestFor("wrong-key"), gateResults: passingGates,
        createdByCiPrincipal: "ci-principal-1", idempotencyKey: randomUUID(),
      }),
    ).toThrow(DeploymentPipelineError);
  });

  // AT-AR-002-13: a mandatory gate failure marks the release failed and blocks promotion,
  // but the failed attempt is still persisted (business rule 16, immutable audit trail).
  it("persists a gate-failed release and blocks it, but still records the attempt", async () => {
    const appId = await seedActiveApp("chess-master");
    let thrown: unknown;
    try {
      createRelease({
        appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-2",
        dependencyLockHash: "lock-2", buildInputHash: "build-2", artifactDigest: "sha256:digest-2",
        manifest: manifestFor("chess-master"), gateResults: { ...passingGates, unitTests: false },
        createdByCiPrincipal: "ci-principal-1", idempotencyKey: randomUUID(),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DeploymentPipelineError);
    expect((thrown as DeploymentPipelineError).code).toBe("RELEASE_GATE_FAILED");
    const releases = await import("@/lib/db/client").then((m) => m.getDb().prepare(
      "select status from app_releases where app_id=? and source_commit_sha='commit-2'",
    ).get(appId) as { status: string } | undefined);
    expect(releases?.status).toBe("gate_failed");
  });

  // Alt flow: duplicate release commit/artifact retry returns the original release,
  // it never creates a second row for the same immutable identity.
  it("returns the original release on a duplicate commit/artifact retry", async () => {
    const appId = await seedActiveApp("chess-master");
    const first = createRelease({
      appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-3",
      dependencyLockHash: "lock-3", buildInputHash: "build-3", artifactDigest: "sha256:digest-3",
      manifest: manifestFor("chess-master"), gateResults: passingGates,
      createdByCiPrincipal: "ci-principal-1", idempotencyKey: randomUUID(),
    });
    const retry = createRelease({
      appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: "commit-3",
      dependencyLockHash: "lock-3", buildInputHash: "build-3", artifactDigest: "sha256:digest-3",
      manifest: manifestFor("chess-master"), gateResults: passingGates,
      createdByCiPrincipal: "ci-principal-1", idempotencyKey: randomUUID(),
    });
    expect(retry.id).toBe(first.id);
  });

  it("rejects release creation for a soft-deleted or draft app", async () => {
    const app = createApp(ADMIN, {
      appKey: "draft-app", displayName: "draft", shortDescription: "d", iconAssetKey: null,
      category: null, owningTeam: null, internalNotes: null, idempotencyKey: randomUUID(),
    });
    expect(() =>
      createRelease({
        appId: app.id, sourceRepository: "babysteps/draft", sourceCommitSha: "commit-x",
        dependencyLockHash: "lock-x", buildInputHash: "build-x", artifactDigest: "sha256:digest-x",
        manifest: manifestFor("draft-app"), gateResults: passingGates,
        createdByCiPrincipal: "ci-principal-1", idempotencyKey: randomUUID(),
      }),
    ).toThrow(DeploymentPipelineError);
  });
});
