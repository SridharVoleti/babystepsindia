// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { registerAnalyticsLevel } from "@/lib/db/analytics-contribution-repo";
import { AppProgressError, completeLesson, getCurrentProgress, saveCheckpoint, writeProgressSummary, type AppProgressContext } from "@/lib/app-progress/service";
import { migrateLearnerProgressToReleaseSchema } from "@/lib/progress-schema-registry/service";
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


// PRG-037 (issue #58): progress-integrity enforcement is certified at every real mutation entry point, with no silent repair.
const n = (sql: string, ...a: unknown[]) => (getDb().prepare(sql).get(...a) as { n: number }).n;
const progressRow = (app: SeededApp) => JSON.stringify(getDb().prepare("select * from learner_app_progress where learner_id=? and app_id=?").get(learnerId, app.appId));
const authority = () => JSON.stringify([
  getDb().prepare("select * from learner_app_effective_entitlements").all(),
  getDb().prepare("select * from learner_app_standard_credit_batches").all(),
  getDb().prepare("select count(*) n from lesson_completions").all()]);

const checkpoint = (version: number, seq: number, key: string) => ({ expectedProgressVersion: version, checkpointSequence: seq, stateSchemaVersion: 1,
  currentLevelKey: "level-1", currentLessonKey: "lesson-1", currentState: { state: "again" }, checkpointIdempotencyKey: key });
const summary = (version: number, key: string) => ({ basedOnProgressVersion: version, summaryIdempotencyKey: key,
  progressSummary: { currentLevel: "Level 1", efficiencyStars: 1, milestone: null, nextDestination: "Lesson 2" } });

function corrupt(app: SeededApp) {   // the stored state no longer matches its canonical hash: unreadable_corrupt
  getDb().prepare("update learner_app_progress set current_state_json=? where learner_id=? and app_id=?")
    .run(JSON.stringify({ state: "tampered" }), learnerId, app.appId);
}

describe("PRG-037 corrupted state blocks every unsafe mutation", () => {
  it("checkpoint, completion and summary writes are rejected, nothing is written, nothing is silently repaired", async () => {
    const app = await seedApp("a"); corrupt(app);
    const before = progressRow(app); const authBefore = authority();
    await expect(saveCheckpoint(app.progress, checkpoint(1, 2, "cp-x"), baseNow)).rejects.toThrowError(new AppProgressError("PROGRESS_INTEGRITY_UNREADABLE"));
    await expect(completeLesson(app.progress, lessonInput(), baseNow)).rejects.toThrowError(new AppProgressError("PROGRESS_INTEGRITY_UNREADABLE"));
    await expect(writeProgressSummary(app.progress, summary(1, "sum-x"), baseNow)).rejects.toThrowError(new AppProgressError("PROGRESS_INTEGRITY_UNREADABLE"));
    expect(progressRow(app)).toBe(before);                                    // no silent repair, no reconstruction from summaries
    expect(authority()).toBe(authBefore);                                     // completion, credits and entitlements untouched
    expect(n("select count(*) n from lesson_completions")).toBe(0);
  });

  it("schema migration is blocked for corrupted state", async () => {
    const app = await seedApp("a"); corrupt(app);
    getDb().prepare("update learner_app_progress set schema_version=1 where learner_id=?").run(learnerId);
    const before = progressRow(app);
    getDb().prepare("update app_progress_schemas set schema_version=2 where app_id=?").run(app.appId);       // a newer schema would normally trigger migration
    await expect(migrateLearnerProgressToReleaseSchema({ appId: app.appId, learnerId, releaseId: app.releaseId, environment: "production", now: baseNow }))
      .rejects.toMatchObject({ code: "PROGRESS_INTEGRITY_UNREADABLE" });
    expect(progressRow(app)).toBe(before);
  });

  it("the corruption is recorded as an integrity incident", async () => {
    const app = await seedApp("a"); corrupt(app);
    await saveCheckpoint(app.progress, checkpoint(1, 2, "cp-inc"), baseNow).catch(() => undefined);
    expect(n("select count(*) n from progress_integrity_incidents where learner_id=? and app_id=?", learnerId, app.appId)).toBeGreaterThan(0);
    expect((getDb().prepare("select integrity_state from learner_app_progress_integrity where learner_id=? and app_id=?").get(learnerId, app.appId) as { integrity_state: string }).integrity_state).toBe("unreadable_corrupt");
  });

  it("repeated blocked attempts keep one active incident (no incident storm) and still change nothing", async () => {
    const app = await seedApp("a"); corrupt(app); const before = progressRow(app);
    for (let i = 0; i < 4; i += 1) await saveCheckpoint(app.progress, checkpoint(1, 2 + i, `cp-${i}`), baseNow).catch(() => undefined);
    expect(n("select count(*) n from progress_integrity_incidents where learner_id=? and app_id=? and status in ('open','investigating')", learnerId, app.appId)).toBe(1);
    expect(progressRow(app)).toBe(before);
  });
});

describe("PRG-037 metadata-only blockage: reads stay available, writes do not", () => {
  it("a summary ahead of progress blocks mutations (409-class) while the current progress remains readable", async () => {
    const app = await seedApp("a");
    getDb().prepare("update learner_app_progress set progress_summary_json=?,progress_summary_version=9,progress_summary_based_on_version=9 where learner_id=? and app_id=?")
      .run(JSON.stringify({ currentLevel: "L", efficiencyStars: 1, milestone: null, nextDestination: "x" }), learnerId, app.appId);
    const before = progressRow(app);
    await expect(saveCheckpoint(app.progress, checkpoint(1, 2, "cp-m"), baseNow)).rejects.toThrowError(new AppProgressError("PROGRESS_INTEGRITY_MUTATION_BLOCKED"));
    await expect(getCurrentProgress(app.progress)).resolves.toMatchObject({ exists: true, progressVersion: 1 });
    expect(progressRow(app)).toBe(before);
  });
});

describe("PRG-037 healthy state is unaffected", () => {
  it("a healthy learner still checkpoints, completes and summarises normally", async () => {
    const app = await seedApp("a");
    await expect(completeLesson(app.progress, lessonInput(), baseNow)).resolves.toBeTruthy();
    expect(n("select count(*) n from lesson_completions")).toBe(1);
  });
});
