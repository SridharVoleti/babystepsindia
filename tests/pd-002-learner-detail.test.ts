// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";
import * as achievementsService from "@/lib/achievements/service";
import {
  composeParentAppDetail,
  composeParentLearnerDetail,
  composeParentLearnerDetailContract,
  listParentLearnerAppSelectors,
  ParentLearnerDetailError,
  ParentLearnerDetailStaleSelectionError,
} from "@/lib/parent-learner-detail/service";

const environment = "production";
const now = new Date("2026-08-13T08:00:00.000Z");
let parentId: string;
let learnerId: string;
let appCounter = 0;

function publishApp(appId: string, environmentValue: string) {
  const bindingId = `binding-${appId}`;
  const releaseId = `release-${appId}`;
  const deploymentId = `deployment-${appId}`;
  getDb().prepare(`insert into app_deployment_bindings(id,app_id,environment,provider,provider_team_id,provider_project_id,
    expected_repository,binding_status) values(?,?,?,'vercel',?,?,'org/repo','verified')`)
    .run(bindingId, appId, environmentValue, `team-${appId}`, `proj-${appId}`);
  getDb().prepare(`insert into app_releases(id,app_id,source_repository,source_commit_sha,dependency_lock_hash,build_input_hash,
    artifact_digest,manifest_json,gate_results_json,status,created_by_ci_principal)
    values(?,?,'org/repo','sha1','lock1','build1','sha256:digest1',?,'{}','verified','ci-1')`)
    .run(releaseId, appId, JSON.stringify({ manifestVersion: 1, appKey: appId, launchPath: "/launch", returnPath: "/return",
      identityPath: "/identity", healthPath: "/health", minimumSdkVersion: "1.0.0" }));
  getDb().prepare(`insert into app_deployments(id,app_id,release_id,binding_id,environment,provider_deployment_id,
    verified_origin,status,published_at) values(?,?,?,?,?,?,?, 'published',?)`)
    .run(deploymentId, appId, releaseId, bindingId, environmentValue, `provider-dep-${appId}`, `https://${appId}.example.test`, now.toISOString());
  getDb().prepare(`insert into app_environment_publications(app_id,environment,current_published_deployment_id,version,published_at)
    values(?,?,?,1,?)`).run(appId, environmentValue, deploymentId, now.toISOString());
  getDb().prepare(`insert into app_deployment_launch_controls(deployment_id,app_id,release_id,environment,immutable_origin,
    launch_path,compatibility_status,status,updated_at) values(?,?,?,?,?,?,'passed','published',?)`)
    .run(deploymentId, appId, releaseId, environmentValue, `https://${appId}.example.test`, "/launch", now.toISOString());
}

function registerApp(displayName: string) {
  const suffix = ++appCounter;
  const appId = `app-pd002-${suffix}`;
  getDb().prepare(`insert into app_registry
    (id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`)
    .run(appId, appId, displayName);
  return appId;
}

function activeApp(displayName = "Learning App") {
  const appId = registerApp(displayName);
  publishApp(appId, environment);
  applyPaidCycle({
    paidCycleId: `cycle-${appId}`, eventId: `event-${appId}`, eventVersion: 1,
    subscriptionId: `sub-${appId}`, purchaserParentId: parentId, assignedLearnerId: learnerId,
    productId: `product-${appId}`, productVersion: 1, appIds: [appId],
    periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z",
    billingAnchor: "2026-08-01", environment, now,
  });
  return appId;
}

function endedApp(displayName = "Ended App") {
  const appId = registerApp(displayName);
  publishApp(appId, environment);
  applyPaidCycle({
    paidCycleId: `cycle-${appId}`, eventId: `event-${appId}`, eventVersion: 1,
    subscriptionId: `sub-${appId}`, purchaserParentId: parentId, assignedLearnerId: learnerId,
    productId: `product-${appId}`, productVersion: 1, appIds: [appId],
    periodStart: "2026-06-01T00:00:00.000Z", periodEnd: "2026-07-01T00:00:00.000Z",
    billingAnchor: "2026-06-01", environment, now,
  });
  return appId;
}

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`pd002-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
});

afterEach(() => vi.restoreAllMocks());

describe("composeParentLearnerDetail", () => {
  it("throws RESOURCE_NOT_FOUND for a learner the parent doesn't own", async () => {
    const { user: other } = await sqliteAuthAdapter.signUp(`pd002-other-${randomUUID()}@example.com`, "CorrectHorse1!");
    const otherLearner = (await createLearner(other.id, { displayName: "Other", dateOfBirth: "2018-01-01",
      idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
    await expect(composeParentLearnerDetail(parentId, otherLearner, now))
      .rejects.toThrow(ParentLearnerDetailError);
  });

  it("separates current and past apps into distinct lists", async () => {
    const currentId = activeApp("Current App");
    const pastId = endedApp("Past App");
    const detail = await composeParentLearnerDetail(parentId, learnerId, now);
    expect(detail.current.map((c) => c.appId)).toEqual([currentId]);
    expect(detail.past.map((c) => c.appId)).toEqual([pastId]);
  });

  it("strips Start/Resume fields from current app cards", async () => {
    activeApp("Current App");
    const detail = await composeParentLearnerDetail(parentId, learnerId, now);
    expect(detail.current[0]).not.toHaveProperty("session");
    expect(detail.current[0]).not.toHaveProperty("eligibility");
    expect(detail.current[0]).not.toHaveProperty("primaryAction");
  });
});

describe("composeParentAppDetail", () => {
  it("expands a current app with level/streak/current+longest and no billing-blind spots", async () => {
    const appId = activeApp("Current App");
    const detail = await composeParentAppDetail(parentId, learnerId, appId, now);
    expect(detail.scope).toBe("current");
    expect(detail.current).not.toBeNull();
    expect(detail.past).toBeNull();
    expect(detail.current!.consistency).toMatchObject({ currentStreakWeeks: expect.any(Number), longestStreakWeeks: expect.any(Number) });
  });

  it("expands a past app with the last safe snapshot and subscribe-again eligibility", async () => {
    const appId = endedApp("Past App");
    const detail = await composeParentAppDetail(parentId, learnerId, appId, now);
    expect(detail.scope).toBe("past");
    expect(detail.past).not.toBeNull();
    expect(detail.past!.subscribeAgain).toBeDefined();
  });

  it("scopes the bounded achievement preview to this exact app, not a learner-wide top 3", async () => {
    const appA = activeApp("App A");
    const appB = activeApp("App B");
    function seedAchievement(appId: string, title: string) {
      getDb().prepare(`insert into learner_achievements
        (id,learner_id,app_id,environment,app_achievement_key,achievement_instance_key,achievement_contract_version,
         app_achievement_model_version,title,category,earned_at,source_release_id,app_key_snapshot,app_name_snapshot,
         state_hash,acknowledged_at,created_at)
        values(?,?,?,'production',?,?,'1.0','model-1',?,'milestone',?,?,?,?,'hash',?,?)`)
        .run(randomUUID(), learnerId, appId, `key-${appId}`, `instance-${appId}`, title, now.toISOString(),
          `release-${appId}`, appId, appId, now.toISOString(), now.toISOString());
    }
    seedAchievement(appA, "First win on A");
    seedAchievement(appB, "First win on B");
    const detailA = await composeParentAppDetail(parentId, learnerId, appA, now);
    expect(detailA.recentAchievements).toHaveLength(1);
    expect(detailA.recentAchievements[0].title).toBe("First win on A");
  });

  it("provides a journey link without re-embedding the journey feed", async () => {
    const appId = activeApp("Current App");
    const detail = await composeParentAppDetail(parentId, learnerId, appId, now);
    expect(detail.journeyHref).toBe(`/account/learners/${learnerId}/apps/${appId}/journey`);
  });

  it("throws RESOURCE_NOT_FOUND for an app that is neither current nor past for this learner", async () => {
    await expect(composeParentAppDetail(parentId, learnerId, "nonexistent-app", now))
      .rejects.toThrow(ParentLearnerDetailError);
  });

  it("has no mutation surface — writes nothing to the database", async () => {
    const appId = activeApp("Current App");
    const tables = ["learner_app_effective_entitlements", "learner_app_progress", "learner_achievements"];
    const before = tables.map((t) => (getDb().prepare(`select count(*) as n from ${t}`).get() as { n: number }).n);
    await composeParentAppDetail(parentId, learnerId, appId, now);
    const after = tables.map((t) => (getDb().prepare(`select count(*) as n from ${t}`).get() as { n: number }).n);
    expect(after).toEqual(before);
  });

  it("PD2-G06: isolates an achievements-component failure — the app/progress detail still returns", async () => {
    const appId = activeApp("Current App");
    vi.spyOn(achievementsService, "listAchievements").mockImplementation(async () => { throw new Error("achievements unavailable"); });
    try {
      const detail = await composeParentAppDetail(parentId, learnerId, appId, now);
      expect(detail.componentErrors).toContain("achievements");
      expect(detail.current).not.toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("listParentLearnerAppSelectors — API-PD-003 (AT-PD-002-01/07)", () => {
  it("returns compact current/past selectors with a compositionVersion", async () => {
    const currentId = activeApp("Current App");
    const pastId = endedApp("Past App");
    const selectors = await listParentLearnerAppSelectors(parentId, learnerId, now);
    expect(selectors.currentApps).toEqual([{ appId: currentId, appName: "Current App" }]);
    expect(selectors.pastApps).toEqual([{ appId: pastId, appName: "Past App" }]);
    expect(selectors.compositionVersion).toEqual(expect.any(String));
  });
});

describe("composeParentLearnerDetailContract — API-PD-002 (PD2-G01/G03/G04/G05)", () => {
  it("AT-PD-002-04: defaults to the first current app when section=current and no appId is given", async () => {
    const appId = activeApp("Current App");
    const composite = await composeParentLearnerDetailContract(parentId, learnerId, { section: "current" }, now);
    expect(composite.selectedAppDetail?.appId).toBe(appId);
    expect(composite.header).toMatchObject({ learnerId, currentCount: 1, pastCount: 0 });
    expect(composite.selectors.current).toEqual([{ appId, appName: "Current App" }]);
  });

  it("AT-PD-002-05: defaults to the first past app when section=past and no appId is given", async () => {
    const appId = endedApp("Past App");
    const composite = await composeParentLearnerDetailContract(parentId, learnerId, { section: "past" }, now);
    expect(composite.selectedAppDetail?.appId).toBe(appId);
    expect(composite.selectedAppDetail?.scope).toBe("past");
  });

  it("returns a null selectedAppDetail when the requested section is empty", async () => {
    const composite = await composeParentLearnerDetailContract(parentId, learnerId, { section: "past" }, now);
    expect(composite.selectedAppDetail).toBeNull();
  });

  it("PD2-G04/AT-PD-002 stale selection: an appId real for this learner but in the other section returns 409 (via a thrown StaleSelectionError)", async () => {
    const currentId = activeApp("Current App");
    endedApp("Past App");
    await expect(composeParentLearnerDetailContract(parentId, learnerId, { section: "past", appId: currentId }, now))
      .rejects.toThrow(ParentLearnerDetailStaleSelectionError);
  });

  it("a genuinely foreign/nonexistent appId still throws RESOURCE_NOT_FOUND, not stale selection", async () => {
    activeApp("Current App");
    await expect(composeParentLearnerDetailContract(parentId, learnerId, { section: "current", appId: "nonexistent" }, now))
      .rejects.toThrow(ParentLearnerDetailError);
  });

  it("PD2-G06: surfaces selectedAppDetail's componentErrors at the composite level", async () => {
    const appId = activeApp("Current App");
    vi.spyOn(achievementsService, "listAchievements").mockImplementation(async () => { throw new Error("achievements unavailable"); });
    try {
      const composite = await composeParentLearnerDetailContract(parentId, learnerId, { section: "current", appId }, now);
      expect(composite.componentErrors).toContain("achievements");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("is deterministic and pure — same inputs yield the same detailVersion, writes nothing", async () => {
    activeApp("Current App");
    const tables = ["learner_app_effective_entitlements", "learner_app_progress"];
    const before = tables.map((t) => (getDb().prepare(`select count(*) as n from ${t}`).get() as { n: number }).n);
    const first = await composeParentLearnerDetailContract(parentId, learnerId, { section: "current" }, now);
    const second = await composeParentLearnerDetailContract(parentId, learnerId, { section: "current" }, now);
    const after = tables.map((t) => (getDb().prepare(`select count(*) as n from ${t}`).get() as { n: number }).n);
    expect(second.detailVersion).toBe(first.detailVersion);
    expect(after).toEqual(before);
  });
});
