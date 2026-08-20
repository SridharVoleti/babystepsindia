import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createApp, activateApp } from "@/lib/db/app-registry-repo";
import { createFakeDeploymentProvider } from "@/lib/deployment-provider/fake-adapter";
import {
  createOrReplaceBinding,
  verifyBinding,
} from "@/lib/deployment-binding/service";
import { DeploymentPipelineError } from "@/lib/deployment-pipeline/errors";

// app_deployment_bindings mutations record against a real admin principal
// (deployment_operation_requests has no FK, but createApp/activateApp's own
// mutation ledger does) — same reasoning as tests/app-registry-repo.test.ts.
let ADMIN: string;

async function seedActiveApp(appKey: string) {
  const app = await createApp(ADMIN, {
    appKey,
    displayName: appKey,
    shortDescription: "desc",
    iconAssetKey: "icon-chess-piece",
    category: "learning",
    owningTeam: "platform",
    internalNotes: null,
    idempotencyKey: randomUUID(),
  });
  await activateApp(ADMIN, app.id, { expectedVersion: app.version, idempotencyKey: randomUUID() });
  return app.id;
}

const provider = createFakeDeploymentProvider({
  knownProjects: [{ providerTeamId: "team-babysteps", providerProjectId: "proj-chess-master", expectedRepository: "babysteps/chess-master" }],
});

describe("AR-002 deployment binding", () => {
  beforeEach(async () => {
    useInMemoryDb();
    ADMIN = (await sqliteAuthAdapter.signUp("deployment-admin@example.com", "CorrectHorse1!")).user.id;
  });

  // AT-AR-002-02: project selection is provider-discovered, not free text.
  it("creates an unverified binding and verifies it against the provider", async () => {
    const appId = await seedActiveApp("chess-master");
    const binding = await createOrReplaceBinding({
      appId, environment: "production", provider: "vercel", providerTeamId: "team-babysteps",
      providerProjectId: "proj-chess-master", expectedRepository: "babysteps/chess-master",
      adminUserId: ADMIN, idempotencyKey: randomUUID(),
    });
    expect(binding.bindingStatus).toBe("unverified");

    const verified = await verifyBinding({ appId, environment: "production", adminUserId: ADMIN, provider }, new Date());
    expect(verified.bindingStatus).toBe("verified");
    expect(verified.verifiedAt).toBeTruthy();
  });

  // AT-AR-002-03: wrong-team project ownership rejected.
  it("rejects verification when the project belongs to a different provider team", async () => {
    const appId = await seedActiveApp("chess-master");
    await createOrReplaceBinding({
      appId, environment: "production", provider: "vercel", providerTeamId: "team-attacker",
      providerProjectId: "proj-chess-master", expectedRepository: "babysteps/chess-master",
      adminUserId: ADMIN, idempotencyKey: randomUUID(),
    });
    await expect(
      verifyBinding({ appId, environment: "production", adminUserId: ADMIN, provider }, new Date()),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_PROJECT_NOT_VERIFIED" });
    const row = getDb().prepare("select binding_status from app_deployment_bindings where app_id=? and environment='production'").get(appId) as { binding_status: string };
    expect(row.binding_status).toBe("unverified");
  });

  // AT-AR-002-04: repository mismatch rejected.
  it("rejects verification when the linked repository does not match", async () => {
    const appId = await seedActiveApp("chess-master");
    await createOrReplaceBinding({
      appId, environment: "production", provider: "vercel", providerTeamId: "team-babysteps",
      providerProjectId: "proj-chess-master", expectedRepository: "babysteps/wrong-repo",
      adminUserId: ADMIN, idempotencyKey: randomUUID(),
    });
    await expect(
      verifyBinding({ appId, environment: "production", adminUserId: ADMIN, provider }, new Date()),
    ).rejects.toMatchObject({ code: "DEPLOYMENT_REPOSITORY_MISMATCH" });
  });

  // AT-AR-002-05: the same provider project/environment cannot be bound to two apps.
  it("rejects binding the same provider project/environment to a second app", async () => {
    const appA = await seedActiveApp("chess-master");
    const appB = await seedActiveApp("magical-math");
    await createOrReplaceBinding({
      appId: appA, environment: "production", provider: "vercel", providerTeamId: "team-babysteps",
      providerProjectId: "proj-shared", expectedRepository: "babysteps/chess-master",
      adminUserId: ADMIN, idempotencyKey: randomUUID(),
    });
    await expect(
      createOrReplaceBinding({
        appId: appB, environment: "production", provider: "vercel", providerTeamId: "team-babysteps",
        providerProjectId: "proj-shared", expectedRepository: "babysteps/magical-math",
        adminUserId: ADMIN, idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(DeploymentPipelineError);
    const rowA = getDb().prepare("select provider_project_id from app_deployment_bindings where app_id=?").get(appA) as { provider_project_id: string };
    expect(rowA.provider_project_id).toBe("proj-shared");
  });

  it("rejects binding an app that is not active", async () => {
    const app = await createApp(ADMIN, {
      appKey: "draft-app", displayName: "draft", shortDescription: "d", iconAssetKey: null,
      category: null, owningTeam: null, internalNotes: null, idempotencyKey: randomUUID(),
    });
    await expect(
      createOrReplaceBinding({
        appId: app.id, environment: "production", provider: "vercel", providerTeamId: "team-babysteps",
        providerProjectId: "proj-draft", expectedRepository: "babysteps/draft",
        adminUserId: ADMIN, idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(DeploymentPipelineError);
  });

  it("rejects re-binding an already-verified environment without going through disable first", async () => {
    const appId = await seedActiveApp("chess-master");
    await createOrReplaceBinding({
      appId, environment: "production", provider: "vercel", providerTeamId: "team-babysteps",
      providerProjectId: "proj-chess-master", expectedRepository: "babysteps/chess-master",
      adminUserId: ADMIN, idempotencyKey: randomUUID(),
    });
    await verifyBinding({ appId, environment: "production", adminUserId: ADMIN, provider }, new Date());
    await expect(
      createOrReplaceBinding({
        appId, environment: "production", provider: "vercel", providerTeamId: "team-babysteps",
        providerProjectId: "proj-chess-master-2", expectedRepository: "babysteps/chess-master",
        adminUserId: ADMIN, idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow(DeploymentPipelineError);
  });
});
