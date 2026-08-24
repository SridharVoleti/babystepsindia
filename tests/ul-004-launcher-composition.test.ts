// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";
import { composeLearnerHome, computeLauncherSourceVersionHash } from "@/lib/learner-home/service";
import { scheduleMaintenanceWindow } from "@/lib/app-availability/service";

const now = new Date("2026-08-11T10:00:00.000Z");
let parentId: string; let learnerId: string;
beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`ul004-home-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
  getDb().prepare(`insert into app_registry(id,app_key,display_name,registry_status) values('app-1','app-1','App 1','active')`).run();
  const binding = "binding-1", release = "release-1", deployment = "deployment-1";
  getDb().prepare(`insert into app_deployment_bindings(id,app_id,environment,provider,provider_team_id,
    provider_project_id,expected_repository,binding_status) values(?,'app-1','production','vercel','team','project','org/repo','verified')`).run(binding);
  getDb().prepare(`insert into app_releases(id,app_id,source_repository,source_commit_sha,dependency_lock_hash,
    build_input_hash,artifact_digest,manifest_json,gate_results_json,status,created_by_ci_principal)
    values(?,'app-1','org/repo','sha','lock','build','digest','{}','{}','verified','ci')`).run(release);
  getDb().prepare(`insert into app_deployments(id,app_id,release_id,binding_id,environment,provider_deployment_id,
    verified_origin,status,published_at) values(?,'app-1',?,?,'production','provider','https://app.example','published',?)`)
    .run(deployment, release, binding, now.toISOString());
  getDb().prepare(`insert into app_environment_publications(app_id,environment,current_published_deployment_id,version,published_at)
    values('app-1','production',?,1,?)`).run(deployment, now.toISOString());
  applyPaidCycle({ paidCycleId: "cycle", eventId: "event", eventVersion: 1, subscriptionId: "sub",
    purchaserParentId: parentId, assignedLearnerId: learnerId, productId: "product", productVersion: 1,
    appIds: ["app-1"], periodStart: "2026-08-01T00:00:00Z", periodEnd: "2026-09-01T00:00:00Z",
    billingAnchor: "2026-08-01", environment: "production", now });
});

describe("UL-004 launcher integration", () => {
  it("returns safe fields, keeps the card current, versions the change, and selects safeStartUntil as boundary", async () => {
    const before = await computeLauncherSourceVersionHash(learnerId, "production");
    const startsAt = new Date(now.getTime() + 7_200_000);
    scheduleMaintenanceWindow({ appId: "app-1", environment: "production", startsAt,
      endsAt: new Date(startsAt.getTime() + 1_800_000), reasonCategory: "planned",
      learnerMessage: "A planned update.", expectedAvailabilityVersion: 1,
      idempotencyKey: "schedule", actorId: parentId }, now);
    const home = await composeLearnerHome(learnerId, "production", now);
    expect(home.cards).toHaveLength(1);
    expect(home.cards[0].operationalAvailability).toMatchObject({ state: "maintenance_soon",
      availabilityVersion: 2, startBlocked: false, nextMaintenanceStartAt: startsAt.toISOString(),
      expectedReturnAt: new Date(startsAt.getTime() + 1_800_000).toISOString() });
    expect(home.nextRecheckAt).toBe(new Date(startsAt.getTime() - 3_900_000).toISOString());
    expect(await computeLauncherSourceVersionHash(learnerId, "production")).not.toBe(before);
  });
});

