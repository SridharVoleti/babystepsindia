// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { registerAnalyticsLevel } from "@/lib/db/analytics-contribution-repo";
import { completeLesson, saveCheckpoint, type AppProgressContext } from "@/lib/app-progress/service";
import { createAchievement, registerReleaseAchievementContract, revokeAchievement,
  validateReleaseAchievementContract, type AchievementWriteContext } from "@/lib/achievements/service";
import { AUTHORIZATION_ACTIONS } from "@/lib/authorization/modes";
import { resolveApiRouteAuthorization } from "@/lib/authorization/route-actions";
import { JOURNEY_API_CONTRACTS } from "@/lib/journey/api-contracts";
import { addTwelveCalendarMonthsKolkata, createJourneyMilestone, JourneyError, listJourney,
  projectLessonOutbox, purgeLearnerJourneyIfDue, reconcileJourney, reconcileLearnerRetentionState,
  registerReleaseJourneyContract, validateReleaseJourneyContract } from "@/lib/journey/service";

const baseNow = new Date("2026-08-11T04:30:00.000Z"); // 10:00 Asia/Kolkata
let parentId: string;
let learnerId: string;

type SeededApp = { appId: string; releaseId: string; sessionId: string; principalId: string;
  progress: AppProgressContext; achievement: AchievementWriteContext };

function seedApp(suffix: string, active = true): SeededApp {
  const appId = `journey-app-${suffix}`;
  const releaseId = `journey-release-${suffix}`;
  const sessionId = `journey-session-${suffix}`;
  const principalId = `journey-principal-${suffix}`;
  const grantId = `journey-grant-${suffix}`;
  const deploymentId = `journey-deployment-${suffix}`;
  getDb().prepare(`insert into app_registry
    (id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`)
    .run(appId, appId, `Journey App ${suffix.toUpperCase()}`);
  getDb().prepare(`insert into app_releases
    (id,app_id,source_repository,source_commit_sha,dependency_lock_hash,build_input_hash,artifact_digest,
     manifest_json,gate_results_json,status,created_by_ci_principal)
    values(?,?,'org/repo',?,'lock','build',?,'{}','{}','verified','ci')`)
    .run(releaseId, appId, `sha-${suffix}`, `digest-${suffix}`);
  getDb().prepare(`insert into app_service_principals
    (id,app_id,environment,deployment_id,client_id,key_ref,public_key,status,valid_from,valid_until)
    values(?,?,'production',?,?,?,'','active','2026-01-01T00:00:00.000Z','2030-01-01T00:00:00.000Z')`)
    .run(principalId, appId, deploymentId, `client-${suffix}`, `key-${suffix}`);
  getDb().prepare("update learner_sessions set status='completed' where learner_id=? and status='active'")
    .run(learnerId);
  getDb().prepare(`insert into learner_sessions
    (id,learner_id,app_id,parent_user_id,device_session_id,week_key,week_timezone,weekly_slot_number,source,
     status,funding_state,schedule_authorization_id,started_at,resume_token_hash,deployment_id,release_id,
     deployment_environment,session_expires_at,current_level_key,current_lesson_key,created_at,updated_at)
    values(?,?,?,?,?,'2026-W33','Asia/Kolkata',1,'normal','active','consumed','schedule',?,'hash',?,?,
      'production','2030-01-01T00:00:00.000Z','level-1','lesson-1',?,?)`)
    .run(sessionId, learnerId, appId, parentId, `device-${suffix}`, "2026-08-11T03:30:00.000Z",
      deploymentId, releaseId, baseNow.toISOString(), baseNow.toISOString());
  getDb().prepare(`insert into app_session_grants
    (id,learner_session_id,learner_id,app_id,environment,deployment_id,release_id,app_principal_id,
     scopes_json,api_contract_version,grant_version,status,expires_at,created_at,updated_at)
    values(?,?,?,?,?,?,?,?,?,'1.0',1,'active','2030-01-01T00:00:00.000Z',?,?)`)
    .run(grantId, sessionId, learnerId, appId, "production", deploymentId, releaseId, principalId,
      JSON.stringify(["progress.read", "progress.write", "lesson.complete", "achievement.write",
        "journey.milestone.write"]), baseNow.toISOString(), baseNow.toISOString());
  const schema = JSON.stringify({ type: "object", required: ["state"], additionalProperties: false,
    properties: { state: { type: "string" } } });
  getDb().prepare(`insert into app_progress_schemas
    (app_id,release_id,schema_version,schema_json,schema_digest,status,created_at)
    values(?,?,?,?,?,'active',?)`).run(appId, releaseId, 1, schema,
      createHash("sha256").update(schema).digest("hex"), baseNow.toISOString());
  registerAnalyticsLevel(appId, "level-1", baseNow);
  getDb().prepare(`insert into learner_app_effective_entitlements
    (id,learner_id,app_id,environment,state,access_until,source_set_hash,created_at,updated_at)
    values(?,?,?,'production',?,?,'source',?,?)`).run(`entitlement-${suffix}`, learnerId, appId,
      active ? "active" : "inactive", active ? "2030-01-01T00:00:00.000Z" : baseNow.toISOString(),
      baseNow.toISOString(), baseNow.toISOString());
  registerReleaseJourneyContract({ appId, releaseId, journeyContractVersion: "1.0",
    lessonDisplayMetadata: true, milestoneDisplayMetadata: true,
    allowedIconAssetKeys: ["icon-open-book"], now: baseNow });
  expect(validateReleaseJourneyContract(appId, releaseId, baseNow)).toMatchObject({ passed: true });
  registerReleaseAchievementContract({ appId, releaseId, achievementContractVersion: "1.0",
    appAchievementModelVersion: "model-1", allowedBadgeAssetKeys: ["icon-open-book"], now: baseNow });
  expect(validateReleaseAchievementContract(appId, releaseId, baseNow)).toMatchObject({ passed: true });
  const progress = { grantId, principalId, learnerSessionId: sessionId, learnerId, appId };
  saveCheckpoint(progress, { expectedProgressVersion: 0, checkpointSequence: 1, stateSchemaVersion: 1,
    currentLevelKey: "level-1", currentLessonKey: "lesson-1", currentState: { state: "ready" },
    checkpointIdempotencyKey: `checkpoint-${suffix}` }, baseNow);
  return { appId, releaseId, sessionId, principalId, progress,
    achievement: { ...progress, environment: "production", deploymentId, releaseId } };
}

function lessonInput(suffix = "1") {
  return { lessonKey: `lesson-${suffix}`, levelKey: "level-1", expectedProgressVersion: 1,
    checkpointSequence: 2, stateSchemaVersion: 1, nextLevelKey: "level-1", nextLessonKey: "lesson-2",
    nextState: { state: "next" }, completionIdempotencyKey: `completion-${suffix}`,
    journeyContractVersion: "1.0", journeyTitle: `Lesson ${suffix}`,
    journeyShortDescription: "A safe lesson summary.", journeyIconAssetKey: "icon-open-book" };
}

function achievementInput(app: SeededApp, instance = "one") {
  return { achievementContractVersion: "1.0", appAchievementKey: "shape-mastered",
    achievementInstanceKey: `shape-mastered:${instance}`, title: "Shape explorer",
    shortDescription: "Completed the shape path.", badgeAssetKey: "icon-open-book" as const,
    category: "mastery" as const, earnedAt: "2026-08-11T04:20:00.000Z", appAchievementModelVersion: "model-1",
    sourceProgressVersion: 1, sourceSessionId: app.sessionId, idempotencyKey: `achievement-${instance}` };
}

function milestone(app: SeededApp, instance: string, occurredAt = "2026-08-11T04:25:00.000Z") {
  return createJourneyMilestone({ learnerId, appId: app.appId, releaseId: app.releaseId, environment: "production" },
    { appJourneyMilestoneKey: "belt", journeyInstanceKey: instance, title: `Belt ${instance}`,
      shortDescription: "A meaningful app-owned milestone.", iconAssetKey: "icon-open-book", occurredAt,
      basedOnProgressVersion: 1, idempotencyKey: `milestone-${instance}` }, baseNow);
}

function endAll(at: Date) {
  getDb().prepare(`update learner_app_effective_entitlements set state='inactive',access_until=?,updated_at=?
    where learner_id=?`).run(at.toISOString(), at.toISOString(), learnerId);
  return reconcileLearnerRetentionState(learnerId, at, at);
}

beforeEach(async () => {
  useInMemoryDb();
  process.env.ANALYTICS_HMAC_SECRET = "eg005-analytics-secret-at-least-32-characters";
  delete process.env.JOURNEY_PROJECTION_FAILURE_FOR_TESTS;
  const { user } = await sqliteAuthAdapter.signUp(`eg005-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-11").learner.id;
});

describe("EG-005 per-app learner journey", () => {
  it("AT-EG-005-01/02 creates exactly one event for the first authoritative lesson completion", () => {
    const app = seedApp("a");
    const input = lessonInput();
    completeLesson(app.progress, input, baseNow);
    completeLesson(app.progress, input, new Date(baseNow.getTime() + 1000));
    expect(listJourney({ learnerId, appId: app.appId }).events).toMatchObject([
      { eventType: "lesson_completed", title: "Lesson 1" },
    ]);
  });

  it("AT-EG-005-03/40 keeps lesson authority committed and repairs a failed projection", () => {
    const app = seedApp("a");
    process.env.JOURNEY_PROJECTION_FAILURE_FOR_TESTS = "lesson";
    expect(completeLesson(app.progress, lessonInput(), baseNow).alreadyCompleted).toBe(false);
    expect(getDb().prepare("select count(*) n from lesson_completions").get()).toMatchObject({ n: 1 });
    expect(getDb().prepare("select count(*) n from learner_app_journey_events").get()).toMatchObject({ n: 0 });
    delete process.env.JOURNEY_PROJECTION_FAILURE_FOR_TESTS;
    expect(reconcileJourney({ mode: "reconcile", learnerId, limit: 20, principalId: "retention",
      runIdempotencyKey: "repair-lesson", now: baseNow }).repaired).toBe(1);
  });

  it("AT-EG-005-04/05/06/11/41 projects achievement create/replay and removes revoke without rollback", () => {
    const app = seedApp("a");
    const created = createAchievement(app.achievement, achievementInput(app), baseNow);
    createAchievement(app.achievement, achievementInput(app), baseNow);
    expect(listJourney({ learnerId, appId: app.appId }).events).toHaveLength(1);
    revokeAchievement({ achievementId: created.achievement.achievementId, appId: app.appId,
      environment: "production", principalId: app.principalId,
      request: { expectedRecordVersion: 1, reasonCode: "app_error", idempotencyKey: "revoke-one" }, now: baseNow });
    expect(listJourney({ learnerId, appId: app.appId }).events).toEqual([]);
    expect(getDb().prepare("select revoked_at from learner_achievements").get()).toMatchObject({ revoked_at: baseNow.toISOString() });
  });

  it("AT-EG-005-07/08/09/10 creates only explicit, stable app milestones", () => {
    const app = seedApp("a");
    const first = milestone(app, "green");
    const replay = milestone(app, "green");
    saveCheckpoint(app.progress, { expectedProgressVersion: 1, checkpointSequence: 2, stateSchemaVersion: 1,
      currentLevelKey: "level-2", currentLessonKey: "lesson-2", currentState: { state: "moved" },
      checkpointIdempotencyKey: "move-step" }, baseNow);
    expect(replay.journeyEventId).toBe(first.journeyEventId);
    expect(listJourney({ learnerId, appId: app.appId }).events.map((event) => event.eventType))
      .toEqual(["milestone_reached"]);
  });

  it("AT-EG-005-12/13/14/15 provides per-app stable asc/desc cursor pages", () => {
    const appA = seedApp("a");
    const appB = seedApp("b");
    milestone(appA, "one", "2026-08-09T04:25:00.000Z");
    milestone(appA, "two", "2026-08-10T04:25:00.000Z");
    milestone(appA, "three", "2026-08-10T04:25:00.000Z");
    milestone(appB, "foreign", "2026-08-11T04:25:00.000Z");
    const desc = listJourney({ learnerId, appId: appA.appId, limit: 2 });
    const tail = listJourney({ learnerId, appId: appA.appId, limit: 2, cursor: desc.nextCursor });
    expect(new Set([...desc.events, ...tail.events].map((event) => event.journeyEventId)).size).toBe(3);
    expect(desc.events.every((event) => event.sourceApp.appId === appA.appId)).toBe(true);
    const asc = listJourney({ learnerId, appId: appA.appId, order: "asc" });
    expect(asc.events.map((event) => event.eventAt)).toEqual([...asc.events.map((event) => event.eventAt)].sort());
  });

  it("AT-EG-005-16/17/18 keeps learner current access separate from parent ended-app history", () => {
    const appA = seedApp("a");
    seedApp("b");
    milestone(appA, "ended");
    getDb().prepare("update learner_app_effective_entitlements set state='inactive',access_until=? where app_id=?")
      .run(baseNow.toISOString(), appA.appId);
    expect(listJourney({ learnerId, appId: appA.appId, exposeRetentionDeadline: true }).events).toHaveLength(1);
    expect(resolveApiRouteAuthorization("GET", `/v1/learner-apps/${appA.appId}/journey`)).toBe("learner.journey.read");
    expect(AUTHORIZATION_ACTIONS["parent.learner.journey.read"].mode).toBe("parent_management");
  });

  it("AT-EG-005-19/20/21/22 defines retention only from any active or approved-grace entitlement", () => {
    const appA = seedApp("a");
    const appB = seedApp("b");
    getDb().prepare("update learner_app_effective_entitlements set state='inactive',access_until=? where app_id=?")
      .run(baseNow.toISOString(), appA.appId);
    expect(reconcileLearnerRetentionState(learnerId, baseNow, baseNow).state).toBe("active");
    getDb().prepare("update learner_app_effective_entitlements set state='approved_grace' where app_id=?")
      .run(appB.appId);
    expect(reconcileLearnerRetentionState(learnerId, new Date("2026-12-01T00:00:00Z"), baseNow).state).toBe("active");
    expect(getDb().prepare("select count(*) n from learner_sessions where learner_id=?").get(learnerId)).toMatchObject({ n: 2 });
  });

  it("AT-EG-005-23/24/25 starts one clamped 12-calendar-month clock", () => {
    seedApp("a");
    const state = endAll(baseNow);
    expect(state.inactive_since).toBe(baseNow.toISOString());
    expect(state.journey_delete_after).toBe("2027-08-11T04:30:00.000Z");
    expect(addTwelveCalendarMonthsKolkata(new Date("2024-02-29T04:30:00.000Z")).toISOString())
      .toBe("2025-02-28T04:30:00.000Z");
  });

  it("AT-EG-005-26/27/31 retains old and inactive history and never purges early", () => {
    const app = seedApp("a");
    milestone(app, "five-years", "2021-08-11T04:25:00.000Z");
    endAll(baseNow);
    expect(listJourney({ learnerId, appId: app.appId, exposeRetentionDeadline: true }).events).toHaveLength(1);
    expect(purgeLearnerJourneyIfDue(learnerId, new Date("2027-08-10T04:30:00.000Z"))).toMatchObject({ purged: false });
  });

  it("AT-EG-005-28/29/30 cancels pre-purge deletion across apps and starts a later new clock", () => {
    const appA = seedApp("a"); const appB = seedApp("b");
    milestone(appA, "a"); milestone(appB, "b");
    endAll(baseNow);
    getDb().prepare("update learner_app_effective_entitlements set state='active',access_until='2030-01-01T00:00:00Z' where app_id=?")
      .run(appB.appId);
    expect(reconcileLearnerRetentionState(learnerId, new Date("2027-07-11T04:30:00Z")).state).toBe("active");
    expect(listJourney({ learnerId, appId: appA.appId }).events).toHaveLength(1);
    const later = new Date("2028-01-01T04:30:00Z"); endAll(later);
    expect(getDb().prepare("select inactive_since from learner_journey_retention_state where learner_id=?")
      .get(learnerId)).toMatchObject({ inactive_since: later.toISOString() });
  });

  it("AT-EG-005-32/33/34/35/36 purges all journey content only after a locked entitlement recheck", () => {
    const appA = seedApp("a"); const appB = seedApp("b");
    milestone(appA, "a"); milestone(appB, "b");
    endAll(baseNow);
    const progressBefore = getDb().prepare("select count(*) n from learner_app_progress").get();
    const due = new Date("2027-08-11T04:30:00.000Z");
    getDb().prepare("update learner_app_effective_entitlements set state='active',access_until='2030-01-01T00:00:00Z' where app_id=?")
      .run(appB.appId);
    expect(purgeLearnerJourneyIfDue(learnerId, due)).toMatchObject({ purged: false, reason: "not_due" });
    getDb().prepare("update learner_app_effective_entitlements set state='inactive',access_until=? where learner_id=?")
      .run(baseNow.toISOString(), learnerId);
    endAll(baseNow);
    expect(purgeLearnerJourneyIfDue(learnerId, due)).toMatchObject({ purged: true, deletedEvents: 2 });
    expect(getDb().prepare("select count(*) n from journey_mutation_receipts").get()).toMatchObject({ n: 0 });
    expect(getDb().prepare("select count(*) n from learner_app_progress").get()).toEqual(progressBefore);
  });

  it("AT-EG-005-37/38/39/40/41 blocks historical rebuild but allows a new post-purge generation", () => {
    const app = seedApp("a"); milestone(app, "old"); endAll(baseNow);
    const purgedAt = new Date("2027-08-11T04:30:00.000Z");
    purgeLearnerJourneyIfDue(learnerId, purgedAt);
    getDb().prepare("update learner_app_effective_entitlements set state='active',access_until='2030-01-01T00:00:00Z' where learner_id=?")
      .run(learnerId);
    reconcileLearnerRetentionState(learnerId, new Date("2027-08-12T04:30:00Z"));
    expect(() => milestone(app, "delayed-old", "2026-08-11T04:25:00.000Z"))
      .toThrowError(new JourneyError("JOURNEY_PURGED_OLD_SOURCE"));
    createJourneyMilestone({ learnerId, appId: app.appId, releaseId: app.releaseId, environment: "production" },
      { appJourneyMilestoneKey: "belt", journeyInstanceKey: "new", title: "New belt",
        occurredAt: "2027-08-12T04:25:00.000Z", basedOnProgressVersion: 1, idempotencyKey: "milestone-new" },
      new Date("2027-08-12T04:30:00.000Z"));
    expect(listJourney({ learnerId, appId: app.appId }).events.map((event) => event.title)).toEqual(["New belt"]);
    expect(getDb().prepare("select retention_generation,purged_through_at from learner_journey_retention_state")
      .get()).toMatchObject({ retention_generation: 2, purged_through_at: purgedAt.toISOString() });
  });

  it("AT-EG-005-40/41 allows a delayed pre-purge source without extending the deadline", () => {
    const app = seedApp("a"); endAll(baseNow);
    const before = getDb().prepare("select journey_delete_after from learner_journey_retention_state").get();
    milestone(app, "delayed", "2026-08-10T04:25:00.000Z");
    expect(listJourney({ learnerId, appId: app.appId }).events).toHaveLength(1);
    expect(getDb().prepare("select journey_delete_after from learner_journey_retention_state").get()).toEqual(before);
  });

  it("AT-EG-005-42/43/44 exposes no browser/admin write, retention extension, or restore API", () => {
    expect(resolveApiRouteAuthorization("POST", "/v1/internal/learner-journey/milestones"))
      .toBe("app.journey.milestone.write");
    expect(resolveApiRouteAuthorization("POST", "/v1/internal/learner-journey/retention-reconcile"))
      .toBe("service.journey.retention");
    expect(JSON.stringify(JOURNEY_API_CONTRACTS)).not.toMatch(/admin|restore|extend|global-feed/i);
  });

  it("AT-EG-005-45/47/48/49 returns safe, side-effect-free history with no universal score", () => {
    const app = seedApp("a"); milestone(app, "safe");
    const before = { progress: getDb().prepare("select * from learner_app_progress").all(),
      sessions: getDb().prepare("select * from learner_sessions").all(),
      entitlements: getDb().prepare("select * from learner_app_effective_entitlements").all() };
    const page = listJourney({ learnerId, appId: app.appId });
    const after = { progress: getDb().prepare("select * from learner_app_progress").all(),
      sessions: getDb().prepare("select * from learner_sessions").all(),
      entitlements: getDb().prepare("select * from learner_app_effective_entitlements").all() };
    expect(after).toEqual(before);
    expect(Object.keys(page.events[0])).not.toEqual(expect.arrayContaining([
      "score", "points", "xp", "rank", "answers", "sessions", "progressJson",
    ]));
  });

  it("AT-EG-005-46/47/50 declares date-wise desktop/mobile presentation and neutral retention copy", () => {
    const source = require("node:fs").readFileSync("src/components/journey/journey-timeline.tsx", "utf8");
    expect(source).toMatch(/md:border-l-2/);
    expect(source).toMatch(/space-y-4/);
    expect(source).toMatch(/min-h-\[44px\]/);
    expect(source).toContain("Journey retained until");
    expect(source).not.toMatch(/subscribe to save|resubscribe|save your history/i);
  });
});
