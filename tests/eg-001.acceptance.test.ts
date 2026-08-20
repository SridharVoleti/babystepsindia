// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import {
  AchievementError,
  createAchievement,
  listAchievements,
  registerReleaseAchievementContract,
  revokeAchievement,
  validateReleaseAchievementContract,
  type AchievementWriteContext,
  type CreateAchievementInput,
} from "@/lib/achievements/service";
import { ACHIEVEMENT_API_CONTRACTS } from "@/lib/achievements/api-contracts";
import { AUTHORIZATION_ACTIONS } from "@/lib/authorization/modes";

const now = new Date("2026-08-12T10:00:00.000Z");
let parentId: string;
let learnerId: string;
let context: AchievementWriteContext;

async function seedApp(appId: string, releaseId: string, sessionId: string, name: string): Promise<AchievementWriteContext> {
  getDb().prepare(`insert into app_registry
    (id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, name);
  getDb().prepare(`insert into app_releases
    (id,app_id,source_repository,source_commit_sha,dependency_lock_hash,build_input_hash,artifact_digest,
     manifest_json,gate_results_json,status,created_by_ci_principal)
    values(?,?,'org/repo',?,'lock','build',?,'{}','{}','verified','ci-1')`)
    .run(releaseId, appId, `sha-${appId}`, `digest-${appId}`);
  getDb().prepare(`insert into learner_sessions
    (id,learner_id,app_id,parent_user_id,device_session_id,week_key,week_timezone,weekly_slot_number,source,
     status,funding_state,schedule_authorization_id,started_at,resume_token_hash,release_id,deployment_environment,
     session_expires_at,created_at,updated_at)
    values(?,?,?,?,?,'2026-W33','Asia/Kolkata',1,'normal','active','consumed','schedule-1',?,'hash',?,
      'production',?,?,?)`).run(sessionId, learnerId, appId, parentId, `device-${appId}`,
      "2026-08-12T09:00:00.000Z", releaseId, "2026-08-12T11:00:00.000Z",
      "2026-08-12T09:00:00.000Z", "2026-08-12T09:00:00.000Z");
  getDb().prepare(`insert into app_service_principals
    (id,app_id,environment,deployment_id,client_id,key_ref,public_key,status,valid_from,valid_until)
    values(?,?, 'production',?,?,?,'','active','2026-08-01T00:00:00.000Z','2026-09-01T00:00:00.000Z')`)
    .run(`principal-${appId}`, appId, `deployment-${appId}`, `client-${appId}`, `key-${appId}`);
  getDb().prepare(`insert into learner_app_progress
    (learner_id,app_id,current_level_key,current_lesson_key,progress_version,state_hash)
    values(?,?, 'level-2','lesson-3',2,'progress-hash')`).run(learnerId, appId);
  await registerReleaseAchievementContract({ appId, releaseId, achievementContractVersion: "1.0",
    appAchievementModelVersion: "model-1", allowedBadgeAssetKeys: ["icon-open-book"], now });
  expect(await validateReleaseAchievementContract(appId, releaseId, now)).toMatchObject({ passed: true });
  return { grantId: `grant-${appId}`, learnerSessionId: sessionId, learnerId, appId,
    principalId: `principal-${appId}`, environment: "production", deploymentId: `deployment-${appId}`, releaseId };
}

function achievement(overrides: Partial<CreateAchievementInput> = {}): CreateAchievementInput {
  return {
    achievementContractVersion: "1.0",
    appAchievementKey: "fractions-mastered",
    achievementInstanceKey: "fractions-mastered:v1",
    title: "Fractions explorer",
    shortDescription: "Completed the fractions mastery path.",
    badgeAssetKey: "icon-open-book",
    category: "mastery",
    earnedAt: "2026-08-12T09:55:00.000Z",
    appAchievementModelVersion: "model-1",
    sourceProgressVersion: 2,
    sourceSessionId: context.learnerSessionId,
    idempotencyKey: `achievement-${randomUUID()}`,
    ...overrides,
  };
}

beforeEach(async () => {
  useInMemoryDb();
  const { user } = await sqliteAuthAdapter.signUp(`eg001-${randomUUID()}@example.com`, "CorrectHorse1!");
  parentId = user.id;
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: randomUUID() }, "2026-08-12")).learner.id;
  context = await seedApp("app-math", "release-math", "session-math", "Magical Math");
});

describe("EG-001 trusted immutable achievements", () => {
  it("AT-EG-001-01/02/08/11 creates only an app-emitted achievement from acknowledged state", async () => {
    const result = await createAchievement(context, achievement(), now);
    expect(result).toMatchObject({ created: true, achievement: { appName: "Magical Math",
      title: "Fractions explorer", category: "mastery", appAchievementModelVersion: "model-1" } });
    expect(getDb().prepare("select count(*) n from learner_achievements").get()).toMatchObject({ n: 1 });
    expect(getDb().prepare("select action,status from achievement_journey_projection_outbox").get())
      .toEqual({ action: "upsert", status: "pending" });
    expect(Object.keys(result.achievement)).not.toEqual(expect.arrayContaining([
      "score", "points", "xp", "rank", "threshold", "rarity", "reward",
    ]));
  });

  it("AT-EG-001-06 permits repeatable app semantics only through distinct deterministic instances", async () => {
    await createAchievement(context, achievement({ achievementInstanceKey: "weekly-shape:1" }), now);
    await createAchievement(context, achievement({ achievementInstanceKey: "weekly-shape:2" }), now);
    expect(getDb().prepare("select count(*) n from learner_achievements").get()).toMatchObject({ n: 2 });
  });

  it("AT-EG-001-16/17/18 provides instance and request exact-once behavior", async () => {
    const input = achievement({ idempotencyKey: "idem-1" });
    const first = await createAchievement(context, input, now);
    expect(await createAchievement(context, input, now)).toEqual(first);
    const replay = await createAchievement(context, { ...input, idempotencyKey: "idem-2" }, now);
    expect(replay.created).toBe(false);
    await expect(createAchievement(context, { ...input, idempotencyKey: "idem-3", title: "Changed" }, now))
      .rejects.toThrowError(new AchievementError("ACHIEVEMENT_INSTANCE_CONFLICT"));
    await expect(createAchievement(context, { ...input, achievementInstanceKey: "another", title: "Changed" }, now))
      .rejects.toThrowError(new AchievementError("IDEMPOTENCY_KEY_REUSED"));
    expect(getDb().prepare("select count(*) n from learner_achievements").get()).toMatchObject({ n: 1 });
  });

  it.each([
    [{ sourceProgressVersion: undefined, sourceCompletionId: undefined }, "ACHIEVEMENT_SOURCE_NOT_ACKNOWLEDGED"],
    [{ earnedAt: "2026-08-12T10:06:00.000Z" }, "ACHIEVEMENT_TIME_INVALID"],
    [{ badgeAssetKey: "https://evil.example/badge.png" }, "ACHIEVEMENT_CONTENT_INVALID"],
    [{ title: "<script>alert(1)</script>" }, "ACHIEVEMENT_CONTENT_INVALID"],
    [{ shortDescription: "x".repeat(241) }, "ACHIEVEMENT_CONTENT_INVALID"],
  ] as const)("AT-EG-001 validation rejects %j", async (override, code) => {
    await expect(createAchievement(context, achievement(override), now)).rejects.toThrowError(new AchievementError(code));
    expect(getDb().prepare("select count(*) n from learner_achievements").get()).toMatchObject({ n: 0 });
  });

  it("AT-EG-001-14 enforces the 4KiB wire contract", async () => {
    await expect(createAchievement(context, achievement({ appAchievementKey: `key${"x".repeat(4000)}` }), now))
      .rejects.toThrow(AchievementError);
  });

  it("AT-EG-001-19/20/21 tombstones a correction and cannot mutate earned fields", async () => {
    const created = (await createAchievement(context, achievement(), now)).achievement;
    const before = {
      progress: getDb().prepare("select * from learner_app_progress where learner_id=? and app_id=?").get(learnerId, context.appId),
      sessions: getDb().prepare("select count(*) n from learner_sessions").get(),
    };
    const revoked = await revokeAchievement({ achievementId: created.achievementId, appId: context.appId,
      environment: context.environment, principalId: context.principalId,
      request: { expectedRecordVersion: 1, reasonCode: "app_error", idempotencyKey: "revoke-1" }, now });
    expect(revoked.recordVersion).toBe(2);
    expect((await listAchievements({ learnerId })).achievements).toEqual([]);
    expect(getDb().prepare("select count(*) n from learner_achievements").get()).toMatchObject({ n: 1 });
    expect(getDb().prepare("select action from achievement_journey_projection_outbox order by created_at,action").all())
      .toEqual(expect.arrayContaining([{ action: "upsert" }, { action: "remove" }]));
    expect(() => getDb().prepare("update learner_achievements set title='Changed' where id=?")
      .run(created.achievementId)).toThrow(/immutable/);
    expect(getDb().prepare("select * from learner_app_progress where learner_id=? and app_id=?")
      .get(learnerId, context.appId)).toEqual(before.progress);
    expect(getDb().prepare("select count(*) n from learner_sessions").get()).toEqual(before.sessions);
  });

  it("AT-EG-001-22/28/42 returns stable cross-app history without recreating access", async () => {
    await createAchievement(context, achievement({ achievementInstanceKey: "math-1", earnedAt: "2026-08-12T09:50:00.000Z" }), now);
    getDb().prepare("update learner_sessions set status='completed' where id=?").run(context.learnerSessionId);
    const reading = await seedApp("app-reading", "release-reading", "session-reading", "Speed Reading");
    await createAchievement(reading, achievement({ achievementInstanceKey: "reading-1", sourceSessionId: reading.learnerSessionId,
      earnedAt: "2026-08-12T09:56:00.000Z" }), now);
    const first = await listAchievements({ learnerId, limit: 1 });
    const second = await listAchievements({ learnerId, limit: 1, cursor: first.nextCursor });
    expect(first.achievements[0].appName).toBe("Speed Reading");
    expect(second.achievements[0].appName).toBe("Magical Math");
    expect(new Set([...first.achievements, ...second.achievements].map((item) => item.achievementId)).size).toBe(2);
    expect(getDb().prepare("select count(*) n from learner_app_effective_entitlements").get()).toMatchObject({ n: 0 });
  });

  it("AT-EG-001-30/31/34 never changes credit, cadence, progress, or access authority", async () => {
    const before = {
      progress: getDb().prepare("select progress_version,state_hash from learner_app_progress").all(),
      usage: getDb().prepare("select * from learner_app_week_usage").all(),
      credits: getDb().prepare("select * from learner_session_credits").all(),
      entitlements: getDb().prepare("select * from learner_app_effective_entitlements").all(),
    };
    await createAchievement(context, achievement(), now);
    const after = {
      progress: getDb().prepare("select progress_version,state_hash from learner_app_progress").all(),
      usage: getDb().prepare("select * from learner_app_week_usage").all(),
      credits: getDb().prepare("select * from learner_session_credits").all(),
      entitlements: getDb().prepare("select * from learner_app_effective_entitlements").all(),
    };
    expect(after).toEqual(before);
  });

  it("AT-EG-001-23/45/50 registers only aggregation APIs and exact authorization modes", () => {
    expect(Object.values(ACHIEVEMENT_API_CONTRACTS).map((contract) => contract.id))
      .toEqual(["API-EG-001", "API-EG-002", "API-EG-003", "API-EG-004", "API-EG-005", "API-EG-006"]);
    expect(AUTHORIZATION_ACTIONS["learner.achievements.read"].mode).toBe("learner_mode");
    expect(AUTHORIZATION_ACTIONS["parent.learner.achievements.read"].mode).toBe("parent_management");
    expect(AUTHORIZATION_ACTIONS["app.achievement.write"].mode).toBe("app_service");
    expect(JSON.stringify(ACHIEVEMENT_API_CONTRACTS)).not.toMatch(/leaderboard|admin.grant|points|wallet|score/i);
  });
});
