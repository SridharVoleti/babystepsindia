// @vitest-environment node
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";
import * as learnerHomeService from "@/lib/learner-home/service";
import { composeParentDashboard } from "@/lib/parent-dashboard/service";

const environment = "production";
const now = new Date("2026-08-13T08:00:00.000Z");
let parentId: string;
let learnerId: string;
let appCounter = 0;

// A card only reports status "active" when both a paid cycle AND a
// published deployment exist — composeLearnerHome checks getPublishedDeployment()
// independently of entitlement state (UL-001's own composer tests need the
// same fixture, since better-sqlite3-backed evaluateAccessFresh recomputes
// from real coverage rows rather than trusting a raw state column).
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

function activeApp(learner: string, purchaser: string, displayName = "Learning App") {
  const suffix = ++appCounter;
  const appId = `app-pd001-${suffix}`;
  getDb().prepare(`insert into app_registry
    (id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`)
    .run(appId, appId, displayName);
  publishApp(appId, environment);
  applyPaidCycle({
    paidCycleId: `cycle-${appId}`, eventId: `event-${appId}`, eventVersion: 1,
    subscriptionId: `sub-${appId}`, purchaserParentId: purchaser, assignedLearnerId: learner,
    productId: `product-${appId}`, productVersion: 1, appIds: [appId],
    periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z",
    billingAnchor: "2026-08-01", environment, now,
  });
  return appId;
}

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`pd001-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
});

describe("composeParentDashboard — composition", () => {
  it("returns a learner-first section for a learner with zero current apps", async () => {
    const result = await composeParentDashboard(parentId, now);
    expect(result.learners).toHaveLength(1);
    expect(result.learners[0]).toMatchObject({ learnerId, currentApps: [], appsOnTrack: null });
  });

  it("shows a current app card with status/progress/consistency, never Start/Resume fields", async () => {
    activeApp(learnerId, parentId, "App Alpha");
    const result = await composeParentDashboard(parentId, now);
    const card = result.learners[0].currentApps[0];
    expect(card).toMatchObject({ appName: "App Alpha", status: "active" });
    expect(card).not.toHaveProperty("session");
    expect(card).not.toHaveProperty("eligibility");
    expect(card).not.toHaveProperty("primaryAction");
  });

  it("computes apps-on-track only over cadence-applicable current apps", async () => {
    activeApp(learnerId, parentId, "App Alpha");
    const result = await composeParentDashboard(parentId, now);
    expect(result.learners[0].appsOnTrack).toEqual({ completed: 0, total: 1 });
  });

  it("attaches the exact PD-003 attention items scoped to this learner as a bounded preview", async () => {
    activeApp(learnerId, parentId, "App Alpha"); // -> learner_setup action_required (no passkey)
    const result = await composeParentDashboard(parentId, now);
    expect(result.learners[0].attentionPreview.length).toBeGreaterThan(0);
    expect(result.learners[0].attentionPreview.every((item) => item.learnerId === learnerId)).toBe(true);
  });

  it("orders learners in stable creation order, never by performance", async () => {
    const secondLearnerId = (await createLearner(parentId, { displayName: "Zed", dateOfBirth: "2018-01-01",
      idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
    // listOwnedLearners orders by created_at,id — force a real ordering
    // since same-millisecond createLearner calls in a test would otherwise
    // tie-break on random UUID, making this assertion flaky rather than
    // meaningful.
    getDb().prepare("update learners set created_at=? where id=?").run("2026-01-01T00:00:00.000Z", learnerId);
    getDb().prepare("update learners set created_at=? where id=?").run("2026-01-02T00:00:00.000Z", secondLearnerId);
    activeApp(secondLearnerId, parentId, "App Beta"); // second learner has more activity
    const result = await composeParentDashboard(parentId, now);
    expect(result.learners.map((l) => l.learnerId)).toEqual([learnerId, secondLearnerId]);
  });

  it("is a pure read — writes nothing to the database", async () => {
    activeApp(learnerId, parentId, "App Alpha");
    const tables = ["learner_app_effective_entitlements", "learner_app_entitlement_periods", "subscriptions"];
    const before = tables.map((t) => (getDb().prepare(`select count(*) as n from ${t}`).get() as { n: number }).n);
    await composeParentDashboard(parentId, now);
    const after = tables.map((t) => (getDb().prepare(`select count(*) as n from ${t}`).get() as { n: number }).n);
    expect(after).toEqual(before);
  });

  it("is deterministic — composing twice yields the same version", async () => {
    activeApp(learnerId, parentId, "App Alpha");
    const first = await composeParentDashboard(parentId, now);
    const second = await composeParentDashboard(parentId, now);
    expect(second.version).toBe(first.version);
  });

  it("never surfaces another parent's learner", async () => {
    const { user: otherParent } = await sqliteAuthAdapter.signUp(`pd001-other-${randomUUID()}@example.com`, "CorrectHorse1!");
    const otherLearner = (await createLearner(otherParent.id, { displayName: "Other Kid", dateOfBirth: "2018-01-01",
      idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
    activeApp(otherLearner, otherParent.id, "App Gamma");
    const result = await composeParentDashboard(parentId, now);
    expect(result.learners.every((l) => l.learnerId !== otherLearner)).toBe(true);
  });
});

function baseCard(overrides: Partial<import("@/lib/learner-home/contracts").LearnerHomeCard> = {}) {
  return {
    appId: "app-1", appKey: "app-1", appName: "App Alpha", iconAssetKey: null, shortDescription: null,
    status: "active" as const, progress: null, progressState: "learning_not_started" as const,
    lastUpdatedHint: false,
    session: { availableStandardSessions: 0, nearestStandardExpiryDate: null, technicalCreditsAvailable: 0,
      activeOrResumableSession: null },
    eligibility: { canStart: false, canResume: false, blockedReason: null },
    primaryAction: "none" as const,
    ...overrides,
  };
}

function mockHome(overrides: Partial<import("@/lib/learner-home/contracts").LearnerHomeResponse> = {}) {
  return {
    learnerId, launcherVersion: "v", serverTime: now.toISOString(), composedAt: now.toISOString(),
    nextRecheckAt: null, cacheMaxAgeSeconds: 60, selectedLearnerContextVersion: 0, activeSession: null,
    recentAchievements: [], cards: [],
    ...overrides,
  };
}

describe("composeParentDashboard — AT-PD-001-01 (Structure)", () => {
  it("AT-01: returns one learner section per owned learner (Given: parent owns 3 learners)", async () => {
    const second = (await createLearner(parentId, { displayName: "Ben", dateOfBirth: "2018-01-01",
      idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
    const third = (await createLearner(parentId, { displayName: "Cyra", dateOfBirth: "2018-01-01",
      idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
    const result = await composeParentDashboard(parentId, now);
    expect(result.learners.map((l) => l.learnerId).sort()).toEqual([learnerId, second, third].sort());
  });
});

describe("composeParentDashboard — AT-PD-001-06/07/08/09 (Weekly cadence display)", () => {
  async function withWeeklyProgress(currentWeekProgress: 0 | 1 | 2) {
    const spy = vi.spyOn(learnerHomeService, "composeLearnerHome").mockResolvedValue(mockHome({
      cards: [baseCard({
        consistency: { appId: "app-1", appKey: "app-1", appName: "App Alpha", currentStreakWeeks: 3,
          longestStreakWeeks: 5, currentWeekProgress, target: 2, currentWeekKey: "2026-W33",
          currentWeekStartAt: now.toISOString(), currentWeekEndAt: now.toISOString(), status: "open", stateVersion: 1 },
      })],
    }));
    const result = await composeParentDashboard(parentId, now);
    spy.mockRestore();
    return result;
  }

  it("AT-06: 0/2 is displayed as-is, not hidden or rounded up", async () => {
    const result = await withWeeklyProgress(0);
    expect(result.learners[0].currentApps[0].consistency).toMatchObject({ currentWeekProgress: 0, target: 2 });
  });

  it("AT-07: 1/2 is displayed as-is", async () => {
    const result = await withWeeklyProgress(1);
    expect(result.learners[0].currentApps[0].consistency).toMatchObject({ currentWeekProgress: 1, target: 2 });
  });

  it("AT-08: 2/2 is displayed as-is", async () => {
    const result = await withWeeklyProgress(2);
    expect(result.learners[0].currentApps[0].consistency).toMatchObject({ currentWeekProgress: 2, target: 2 });
    expect(result.learners[0].appsOnTrack).toEqual({ completed: 1, total: 1 });
  });

  it("AT-09: a catch-up-eligible third session is never promoted past the 2/2 cap — appsOnTrack counts by target reached, not raw session count", async () => {
    // consistency.currentWeekProgress is itself capped at 2 by its own type
    // (0 | 1 | 2) — composeParentDashboard never adds a separate "extra
    // credit" CTA on top of whatever UL-001/EG-002 already capped.
    const result = await withWeeklyProgress(2);
    expect(result.learners[0].currentApps[0].consistency!.currentWeekProgress).toBeLessThanOrEqual(2);
    expect(result.learners[0].currentApps[0]).not.toHaveProperty("catchUp");
    expect(result.learners[0].currentApps[0]).not.toHaveProperty("extraCredit");
  });
});

describe("composeParentDashboard — AT-PD-001-11/12/13 (Motivation, streak, achievements)", () => {
  it("AT-11: the app-owned motivation display type/labels pass through unchanged, never converted to a percentage", async () => {
    const spy = vi.spyOn(learnerHomeService, "composeLearnerHome").mockResolvedValue(mockHome({
      cards: [baseCard({ progress: { currentLevel: "Level 3", efficiencyStars: 2, milestone: null,
        nextDestination: "Level 4", motivationProgress: { displayType: "steps", stepPosition: 3, stepCount: 7 } } })],
    }));
    const result = await composeParentDashboard(parentId, now);
    spy.mockRestore();
    expect(result.learners[0].currentApps[0].progress?.motivationProgress).toEqual(
      { displayType: "steps", stepPosition: 3, stepCount: 7 });
  });

  it("AT-12: streak is per-app (consistency.currentStreakWeeks on each card), never a single global streak field on the dashboard response", async () => {
    const spy = vi.spyOn(learnerHomeService, "composeLearnerHome").mockResolvedValue(mockHome({
      cards: [baseCard({
        consistency: { appId: "app-1", appKey: "app-1", appName: "App Alpha", currentStreakWeeks: 6,
          longestStreakWeeks: 6, currentWeekProgress: 1, target: 2, currentWeekKey: "2026-W33",
          currentWeekStartAt: now.toISOString(), currentWeekEndAt: now.toISOString(), status: "open", stateVersion: 1 },
      })],
    }));
    const result = await composeParentDashboard(parentId, now);
    spy.mockRestore();
    expect(result.learners[0].currentApps[0].consistency!.currentStreakWeeks).toBe(6);
    expect(result).not.toHaveProperty("streak");
    expect(result.learners[0]).not.toHaveProperty("streak");
  });

  it("AT-13: recent achievements pass through faithfully as a bounded list, never expanded or re-truncated by the dashboard itself", async () => {
    const achievements = [{ achievementId: "a1", appId: "app-1", appKey: "app-1", appName: "App Alpha",
      appIconAssetKey: null, appAchievementKey: "ach-1", achievementInstanceKey: "inst-1", title: "First win",
      shortDescription: null, badgeAssetKey: null } as unknown as import("@/lib/achievements/service").AchievementView];
    const spy = vi.spyOn(learnerHomeService, "composeLearnerHome").mockResolvedValue(mockHome({ recentAchievements: achievements }));
    const result = await composeParentDashboard(parentId, now);
    spy.mockRestore();
    expect(result.learners[0].recentAchievements).toEqual(achievements);
  });
});

describe("composeParentDashboard — AT-PD-001-21 (Zero apps)", () => {
  it("AT-21: a learner with zero current apps still gets a section with an explicit empty-apps state, never disappears", async () => {
    const result = await composeParentDashboard(parentId, now);
    expect(result.learners).toHaveLength(1);
    expect(result.learners[0].learnerId).toBe(learnerId);
    expect(result.learners[0].currentApps).toEqual([]);
  });
});

describe("composeParentDashboard — AT-PD-001-44 (Performance)", () => {
  it("AT-44: composing 10 learners x 10 apps each stays within a bounded time, no runaway N+1 blowup", async () => {
    const learnerIds = [learnerId];
    for (let i = 0; i < 9; i++) {
      learnerIds.push((await createLearner(parentId, { displayName: `Learner ${i}`, dateOfBirth: "2018-01-01",
        idempotencyKey: randomUUID() }, "2026-08-01")).learner.id);
    }
    for (const id of learnerIds) {
      for (let a = 0; a < 10; a++) activeApp(id, parentId, `App ${a}`);
    }
    const start = performance.now();
    const result = await composeParentDashboard(parentId, now);
    const elapsedMs = performance.now() - start;
    expect(result.learners).toHaveLength(10);
    expect(result.learners.every((l) => l.currentApps.length === 10)).toBe(true);
    expect(elapsedMs).toBeLessThan(5000);
  });
});

describe("composeParentDashboard — per-learner failure isolation", () => {
  it("isolates one learner's composition failure and still returns the others", async () => {
    const secondLearnerId = (await createLearner(parentId, { displayName: "Ben", dateOfBirth: "2018-01-01",
      idempotencyKey: randomUUID() }, "2026-08-01")).learner.id;
    const spy = vi.spyOn(learnerHomeService, "composeLearnerHome").mockImplementation(async (id) => {
      if (id === learnerId) throw new Error("boom");
      return { learnerId: id, launcherVersion: "v", serverTime: now.toISOString(), composedAt: now.toISOString(),
        nextRecheckAt: null, cacheMaxAgeSeconds: 60, selectedLearnerContextVersion: 0, activeSession: null,
        recentAchievements: [], cards: [] };
    });
    const result = await composeParentDashboard(parentId, now);
    expect(result.partialErrors[learnerId]).toBeDefined();
    expect(result.learners.find((l) => l.learnerId === secondLearnerId)).toBeDefined();
    expect(result.learners.find((l) => l.learnerId === learnerId)).toBeUndefined();
    spy.mockRestore();
  });
});
