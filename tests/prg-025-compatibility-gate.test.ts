import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createApp, activateApp } from "@/lib/db/app-registry-repo";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { createOrReplaceBinding, getBinding, verifyBinding } from "@/lib/deployment-binding/service";
import { createRelease } from "@/lib/deployment-release/service";
import { deployToStaging } from "@/lib/deployment-staging/service";
import { approveProduction, getPublishedDeployment } from "@/lib/deployment-production/service";
import { scheduleDeploymentWindow } from "@/lib/deployment-window/service";
import { createFakeDeploymentProvider } from "@/lib/deployment-provider/fake-adapter";
import { registerProgressSchema, registerSchemaMigration } from "@/lib/progress-schema-registry/service";
import { runCompatibilityGate } from "@/lib/deployment-compatibility/gate";

// PRG-025 (issue #68): mandatory release compatibility gate (read, migration, write) before promotion; evidence stored per release.
let ADMIN: string;
const now = new Date("2026-08-09T10:00:00.000Z");

async function seedActiveApp(appKey: string) {
  const app = await createApp(ADMIN, {
    appKey, displayName: appKey, shortDescription: "desc", iconAssetKey: "icon-chess-piece",
    category: "learning", owningTeam: "platform", internalNotes: null, idempotencyKey: randomUUID(),
  });
  await activateApp(ADMIN, app.id, { expectedVersion: app.version, idempotencyKey: randomUUID() });
  return app.id;
}
const manifest = (appKey: string) => ({ manifestVersion: 1, appKey, launchPath: "/launch", returnPath: "/return", identityPath: "/identity", healthPath: "/health", minimumSdkVersion: "1.0.0" });
const gates = { dependencyInstall: true, typeCheck: true, lint: true, unitTests: true, contractTests: true, security: true, build: true };
let shared = createFakeDeploymentProvider({ knownProjects: [] });
const provider = () => shared;

async function bind(appId: string, environment: "staging" | "production", projectId: string) {
  if ((await getBinding(appId, environment))?.bindingStatus === "verified") return;
  await createOrReplaceBinding({ appId, environment, provider: "vercel", providerTeamId: "team-babysteps", providerProjectId: projectId, expectedRepository: "babysteps/chess-master", adminUserId: ADMIN, idempotencyKey: randomUUID() });
  await verifyBinding({ appId, environment, adminUserId: ADMIN, provider: provider() }, new Date());
}
async function newRelease(appId: string, sha: string, readable: number[] = []) {
  return createRelease({
    appId, sourceRepository: "babysteps/chess-master", sourceCommitSha: sha, dependencyLockHash: `lock-${sha}`, buildInputHash: `build-${sha}`,
    artifactDigest: `sha256:${sha}`, manifest: manifest("chess-master"), gateResults: gates, createdByCiPrincipal: "ci-1", idempotencyKey: randomUUID(),
    readableSchemaVersions: readable,
  });
}
async function staged(appId: string, sha: string, readable: number[] = []) {
  await bind(appId, "staging", "proj-chess-master");
  const release = await newRelease(appId, sha, readable);
  await deployToStaging({ appId, releaseId: release.id, adminUserId: ADMIN, idempotencyKey: randomUUID() }, provider(), new Date());
  return release.id;
}
async function window(appId: string, releaseId: string) {
  const startsAt = new Date(Date.now() + 61 * 60 * 1000);
  const w = await scheduleDeploymentWindow({ appId, releaseId, startsAt, endsAt: new Date(startsAt.getTime() + 45 * 60 * 1000), adminUserId: ADMIN, idempotencyKey: randomUUID() }, new Date());
  return { id: w.id, executeAt: startsAt };
}
const promote = async (appId: string, releaseId: string) => {
  const w = await window(appId, releaseId);
  return approveProduction({ appId, releaseId, adminUserId: ADMIN, idempotencyKey: randomUUID(), deploymentWindowId: w.id }, provider(), w.executeAt);
};
async function learnerAtSchema(appId: string, version: number) {
  const { user } = await sqliteAuthAdapter.signUp(`prg025-${randomUUID()}@example.com`, "CorrectHorse1!");
  const learner = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01", idempotencyKey: randomUUID() }, "2026-08-09")).learner;
  getDb().prepare("insert into learner_app_progress(learner_id,app_id,schema_version,updated_at) values(?,?,?,?)").run(learner.id, appId, version, now.toISOString());
}
const schemaJson = JSON.stringify({ type: "object", properties: {}, additionalProperties: true });
const report = (releaseId: string) => getDb().prepare("select * from app_release_compatibility_reports where release_id = ?").get(releaseId) as Record<string, unknown> | undefined;

beforeEach(async () => {
  useInMemoryDb();
  shared = createFakeDeploymentProvider({ knownProjects: [] });
  ADMIN = (await sqliteAuthAdapter.signUp("prg025-admin@example.com", "CorrectHorse1!")).user.id;
});

describe("the gate executes read, migration and write checks", () => {
  it("passes with no represented progress and records all three checks against the release", async () => {
    const appId = await seedActiveApp("chess-master");
    const releaseId = await staged(appId, "c1");
    const r = report(releaseId)!;
    expect(r).toMatchObject({ release_id: releaseId, status: "passed", read_status: "passed", migration_status: "passed", write_status: "passed" });
    const checks = JSON.parse(String(r.checks_json)) as { name: string; status: string }[];
    expect(checks.map((c) => c.name)).toEqual(["read", "migration", "write"]);
  });

  it("read check fails when retained progress is at a version the release cannot read", async () => {
    const appId = await seedActiveApp("chess-master");
    await learnerAtSchema(appId, 1);
    const result = await runCompatibilityGate({ appId, releaseId: "rel-x", readableSchemaVersions: [2], now });
    expect(result.status).toBe("failed");
    expect(result.checks.find((c) => c.name === "read")).toMatchObject({ status: "failed", versions: [1] });
  });

  it("migration check fails without a forward path; write check fails without a rollback path", async () => {
    const appId = await seedActiveApp("chess-master");
    await learnerAtSchema(appId, 1);
    await registerProgressSchema({ appId, releaseId: "rel-y", schemaVersion: 2, schemaJson, now });
    let result = await runCompatibilityGate({ appId, releaseId: "rel-y", readableSchemaVersions: [1, 2], now });
    expect(result.checks.find((c) => c.name === "migration")?.status).toBe("failed");
    expect(result.checks.find((c) => c.name === "write")?.status).toBe("failed");

    await registerSchemaMigration({ appId, fromSchemaVersion: 1, toSchemaVersion: 2, transform: {}, now });          // forward only
    result = await runCompatibilityGate({ appId, releaseId: "rel-y", readableSchemaVersions: [1, 2], now });
    expect(result.checks.find((c) => c.name === "migration")?.status).toBe("passed");
    expect(result.checks.find((c) => c.name === "write")?.status).toBe("failed");
    expect(result.status).toBe("failed");

    await registerSchemaMigration({ appId, fromSchemaVersion: 2, toSchemaVersion: 1, transform: {}, now });          // rollback too
    result = await runCompatibilityGate({ appId, releaseId: "rel-y", readableSchemaVersions: [1, 2], now });
    expect(result.status).toBe("passed");
  });
});

describe("incompatible releases cannot be promoted to production", () => {
  async function stagedThenIncompatible() {
    const appId = await seedActiveApp("chess-master");
    await bind(appId, "production", "proj-chess-master-prod");
    const releaseId = await staged(appId, "c-inc", [1, 2]);
    await registerProgressSchema({ appId, releaseId, schemaVersion: 2, schemaJson, now });
    await learnerAtSchema(appId, 1);                                              // progress at v1 appears after staging, no migration path
    return { appId, releaseId };
  }

  it("blocks promotion with RELEASE_BACKWARD_COMPATIBILITY_FAILED and leaves production untouched", async () => {
    const { appId, releaseId } = await stagedThenIncompatible();
    await expect(promote(appId, releaseId)).rejects.toThrow(expect.objectContaining({ code: "RELEASE_PROGRESS_SCHEMA_INCOMPATIBLE" }));
    expect(await getPublishedDeployment(appId, "production")).toBeNull();
    expect((getDb().prepare("select status from app_releases where id = ?").get(releaseId) as { status: string }).status).toBe("verified");
    expect((getDb().prepare("select count(*) as n from app_deployments where release_id = ? and environment = 'production'").get(releaseId) as { n: number }).n).toBe(0);
  });

  it("makes the failure visible and traceable: the failed report with failing checks is stored against the release", async () => {
    const { appId, releaseId } = await stagedThenIncompatible();
    await promote(appId, releaseId).catch(() => undefined);
    const r = report(releaseId)!;
    expect(r).toMatchObject({ status: "failed", migration_status: "failed", write_status: "failed" });
    const checks = JSON.parse(String(r.checks_json)) as { name: string; status: string; versions?: number[] }[];
    expect(checks.find((c) => c.name === "migration")).toMatchObject({ status: "failed", versions: [1] });
  });

  it("cannot be bypassed by editing the stored report: the gate is recomputed from live state at promotion", async () => {
    const { appId, releaseId } = await stagedThenIncompatible();
    getDb().prepare("update app_release_compatibility_reports set status='passed', read_status='passed', migration_status='passed', write_status='passed' where release_id = ?").run(releaseId);
    await expect(promote(appId, releaseId)).rejects.toThrow(expect.objectContaining({ code: "RELEASE_PROGRESS_SCHEMA_INCOMPATIBLE" }));
  });

  it("a read-compatibility failure at promotion is RELEASE_BACKWARD_COMPATIBILITY_FAILED and is recorded", async () => {
    const appId = await seedActiveApp("chess-master");
    await bind(appId, "production", "proj-chess-master-prod");
    const releaseId = await staged(appId, "c-read", [2]);
    await learnerAtSchema(appId, 1);                                              // release only reads v2
    await expect(promote(appId, releaseId)).rejects.toThrow(expect.objectContaining({ code: "RELEASE_BACKWARD_COMPATIBILITY_FAILED" }));
    expect(report(releaseId)).toMatchObject({ status: "failed", read_status: "failed" });
    expect(await getPublishedDeployment(appId, "production")).toBeNull();
  });
});

describe("successful promotion proves the gate passed", () => {
  it("stores gate evidence on the production deployment and derives launch-control compatibility from it", async () => {
    const appId = await seedActiveApp("chess-master");
    await bind(appId, "production", "proj-chess-master-prod");
    const releaseId = await staged(appId, "c-ok");
    const result = await promote(appId, releaseId);
    const dep = getDb().prepare("select validation_summary_json from app_deployments where id = ?").get(result.deployment.id) as { validation_summary_json: string };
    expect(JSON.parse(dep.validation_summary_json)).toMatchObject({ passed: true, compatibilityGate: { releaseId, status: "passed", read: "passed", migration: "passed", write: "passed" } });
    expect(report(releaseId)).toMatchObject({ status: "passed" });
    const lc = getDb().prepare("select compatibility_status from app_deployment_launch_controls where deployment_id = ?").get(result.deployment.id) as { compatibility_status: string };
    expect(lc.compatibility_status).toBe("passed");
  });

  it("a compatible release with a registered two-way migration promotes", async () => {
    const appId = await seedActiveApp("chess-master");
    await bind(appId, "production", "proj-chess-master-prod");
    await learnerAtSchema(appId, 1);
    await registerSchemaMigration({ appId, fromSchemaVersion: 1, toSchemaVersion: 2, transform: {}, now });
    await registerSchemaMigration({ appId, fromSchemaVersion: 2, toSchemaVersion: 1, transform: {}, now });
    const releaseId = await staged(appId, "c-two", [1, 2]);
    await registerProgressSchema({ appId, releaseId, schemaVersion: 2, schemaJson, now });
    const result = await promote(appId, releaseId);
    expect(result.release.status).toBe("promoted");
  });
});

describe("gate execution is a mandatory part of the pipeline source", () => {
  it("production promotion and staging both call the gate and nothing else writes a 'passed' launch control", async () => {
    const { readFileSync } = await import("node:fs");
    const prod = readFileSync("src/lib/deployment-production/service.ts", "utf8");
    const stagingSrc = readFileSync("src/lib/deployment-staging/service.ts", "utf8");
    expect(prod).toMatch(/runCompatibilityGate/);
    expect(stagingSrc).toMatch(/runCompatibilityGate/);
    expect(prod).not.toMatch(/, 'passed', 'published'/);                            // launch-control compatibility is derived from the gate, never hard-coded
  });
});
