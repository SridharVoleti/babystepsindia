// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDbClient } from "@/lib/db-client";
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

async function seedApp(suffix: string, active = true): Promise<SeededApp> {
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
  await registerAnalyticsLevel(appId, "level-1", baseNow);
  getDb().prepare(`insert into learner_app_effective_entitlements
    (id,learner_id,app_id,environment,state,access_until,source_set_hash,created_at,updated_at)
    values(?,?,?,'production',?,?,'source',?,?)`).run(`entitlement-${suffix}`, learnerId, appId,
      active ? "active" : "inactive", active ? "2030-01-01T00:00:00.000Z" : baseNow.toISOString(),
      baseNow.toISOString(), baseNow.toISOString());
  await registerReleaseJourneyContract({ appId, releaseId, journeyContractVersion: "1.0",
    lessonDisplayMetadata: true, milestoneDisplayMetadata: true,
    allowedIconAssetKeys: ["icon-open-book"], now: baseNow });
  expect(await validateReleaseJourneyContract(appId, releaseId, baseNow)).toMatchObject({ passed: true });
  await registerReleaseAchievementContract({ appId, releaseId, achievementContractVersion: "1.0",
    appAchievementModelVersion: "model-1", allowedBadgeAssetKeys: ["icon-open-book"], now: baseNow });
  expect(await validateReleaseAchievementContract(appId, releaseId, baseNow)).toMatchObject({ passed: true });
  const progress = { grantId, principalId, learnerSessionId: sessionId, learnerId, appId };
  await saveCheckpoint(progress, { expectedProgressVersion: 0, checkpointSequence: 1, stateSchemaVersion: 1,
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

async function milestone(app: SeededApp, instance: string, occurredAt = "2026-08-11T04:25:00.000Z") {
  return await createJourneyMilestone({ learnerId, appId: app.appId, releaseId: app.releaseId, environment: "production" },
    { appJourneyMilestoneKey: "belt", journeyInstanceKey: instance, title: `Belt ${instance}`,
      shortDescription: "A meaningful app-owned milestone.", iconAssetKey: "icon-open-book", occurredAt,
      basedOnProgressVersion: 1, idempotencyKey: `milestone-${instance}` }, baseNow);
}

async function endAll(at: Date) {
  getDb().prepare(`update learner_app_effective_entitlements set state='inactive',access_until=?,updated_at=?
    where learner_id=?`).run(at.toISOString(), at.toISOString(), learnerId);
  return await reconcileLearnerRetentionState(learnerId, at, at);
}

beforeEach(async () => {
  useInMemoryDb();
  process.env.ANALYTICS_HMAC_SECRET = "eg005-analytics-secret-at-least-32-characters";
  delete process.env.JOURNEY_PROJECTION_FAILURE_FOR_TESTS;
  const { user } = await sqliteAuthAdapter.signUp(`eg005-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-11")).learner.id;
});


// PRG-040 (issue #64): purge cannot race reactivation; a projection that read pre-purge state cannot resurrect deleted history.
const n = (sql: string, ...a: unknown[]) => (getDb().prepare(sql).get(...a) as { n: number }).n;

function staleReads(rules: { match: RegExp; value: unknown }[]) {
  const client = resolveDbClient();
  const real = client.get.bind(client);
  return vi.spyOn(client, "get").mockImplementation((async (sql: string, params?: unknown[]) => {
    const rule = rules.find((r) => r.match.test(sql));
    return rule ? rule.value : real(sql, params as never);
  }) as never);
}

describe("PRG-040 purge versus reactivation", () => {
  it("a purge holding a stale 'due' view cannot delete the journey of a learner who reactivated meanwhile", async () => {
    const app = await seedApp("a"); await milestone(app, "keep"); await endAll(baseNow);
    const staleState = { ...(getDb().prepare("select * from learner_journey_retention_state where learner_id=?").get(learnerId) as object) };
    expect((staleState as { state: string }).state).toBe("inactive_retention");

    // reactivation commits (real database), but the purge transaction still sees the pre-reactivation picture
    getDb().prepare("update learner_app_effective_entitlements set state='active',access_until='2030-01-01T00:00:00Z' where learner_id=?").run(learnerId);
    await reconcileLearnerRetentionState(learnerId, new Date("2027-08-10T04:30:00Z"));
    expect((getDb().prepare("select state from learner_journey_retention_state where learner_id=?").get(learnerId) as { state: string }).state).toBe("active");

    const spy = staleReads([
      { match: /from learner_journey_retention_state/, value: staleState },
      { match: /from learner_app_effective_entitlements|from subscriptions/, value: undefined },
    ]);
    const result = await purgeLearnerJourneyIfDue(learnerId, new Date("2027-08-11T04:30:00.000Z"));
    spy.mockRestore();

    expect(result).toMatchObject({ purged: false });
    expect(n("select count(*) n from learner_app_journey_events where learner_id=?", learnerId)).toBe(1);
    expect(n("select count(*) n from journey_mutation_receipts where learner_id=?", learnerId)).toBeGreaterThan(0);
    expect((getDb().prepare("select state,retention_generation g from learner_journey_retention_state where learner_id=?").get(learnerId) as { state: string; g: number })).toEqual({ state: "active", g: 1 });
  });

  it("repeated purge runs delete once and advance the generation exactly once", async () => {
    const app = await seedApp("a"); await milestone(app, "x"); await endAll(baseNow);
    const due = new Date("2027-08-11T04:30:00.000Z");
    const results = [await purgeLearnerJourneyIfDue(learnerId, due), await purgeLearnerJourneyIfDue(learnerId, due), await purgeLearnerJourneyIfDue(learnerId, due)];
    expect(results.filter((r) => r.purged)).toHaveLength(1);
    expect(getDb().prepare("select retention_generation g from learner_journey_retention_state where learner_id=?").get(learnerId)).toEqual({ g: 2 });
    expect(n("select count(*) n from learner_app_journey_events where learner_id=?", learnerId)).toBe(0);
  });

  it("purge removes journey data only: progress, achievements' source records and entitlements are untouched", async () => {
    const app = await seedApp("a"); await milestone(app, "m"); await endAll(baseNow);
    const snap = () => JSON.stringify([getDb().prepare("select * from learner_app_progress").all(), getDb().prepare("select * from learner_app_effective_entitlements").all()]);
    const before = snap();
    await purgeLearnerJourneyIfDue(learnerId, new Date("2027-08-11T04:30:00.000Z"));
    expect(snap()).toBe(before);
  });
});

describe("PRG-040 no resurrection from source events", () => {
  it("a projection that read pre-purge state cannot insert an old-generation event after the purge", async () => {
    const app = await seedApp("a"); await endAll(baseNow);
    const preState = { ...(getDb().prepare("select * from learner_journey_retention_state where learner_id=?").get(learnerId) as object) };
    await purgeLearnerJourneyIfDue(learnerId, new Date("2027-08-11T04:30:00.000Z"));
    expect(n("select count(*) n from learner_app_journey_events where learner_id=?", learnerId)).toBe(0);

    const spy = staleReads([{ match: /from learner_journey_retention_state/, value: preState }]);
    await milestone(app, "late-old", "2026-08-10T04:25:00.000Z").catch(() => undefined);
    spy.mockRestore();
    expect(n("select count(*) n from learner_app_journey_events where learner_id=?", learnerId)).toBe(0);
  });

  it("source events replayed after a purge never rebuild deleted history", async () => {
    const app = await seedApp("a"); await completeLesson(app.progress, lessonInput(), baseNow); await endAll(baseNow);
    await purgeLearnerJourneyIfDue(learnerId, new Date("2027-08-11T04:30:00.000Z"));
    await reconcileJourney({ mode: "reconcile", limit: 50, principalId: "journey-reconciler", runIdempotencyKey: "after-purge", now: new Date("2027-08-12T04:30:00.000Z") });
    expect(n("select count(*) n from learner_app_journey_events where learner_id=?", learnerId)).toBe(0);
  });

  it("projection failure leaves the source domains intact", async () => {
    const app = await seedApp("a");
    process.env.JOURNEY_PROJECTION_FAILURE_FOR_TESTS = "lesson";
    await completeLesson(app.progress, lessonInput(), baseNow);
    delete process.env.JOURNEY_PROJECTION_FAILURE_FOR_TESTS;
    expect(n("select count(*) n from lesson_journey_projection_outbox")).toBe(1);
    expect(n("select count(*) n from learner_app_journey_events")).toBe(0);
    await reconcileJourney({ mode: "reconcile", limit: 50, principalId: "journey-reconciler", runIdempotencyKey: "repair", now: baseNow });
    expect(n("select count(*) n from learner_app_journey_events")).toBe(1);
  });
});
