// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDbClient } from "@/lib/db-client";
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


// PRG-042 (issue #62): exact-once achievement authority under write races. The pre-check read is made stale (as a concurrent Postgres transaction
// would see it) to reproduce "both writers passed the existence check" deterministically.
const count = (sql: string, ...a: unknown[]) => (getDb().prepare(sql).get(...a) as { n: number }).n;

function staleOnce(match: RegExp, stale: unknown = undefined) {
  const client = resolveDbClient();
  const real = client.get.bind(client);
  let fired = false;
  return vi.spyOn(client, "get").mockImplementation((async (sql: string, params?: unknown[]) => {
    if (!fired && match.test(sql)) { fired = true; return stale; }
    return real(sql, params as never);
  }) as never);
}

describe("PRG-042 create races", () => {
  it("a writer that lost the unique-instance race is treated as a replay, not an error", async () => {
    const winner = await createAchievement(context, achievement({ idempotencyKey: "idem-win" }), now);
    const spy = staleOnce(/from learner_achievements\s+where learner_id=\? and app_id=\? and achievement_instance_key=\?/);
    const loser = await createAchievement(context, achievement({ idempotencyKey: "idem-lose" }), now);
    spy.mockRestore();
    expect(loser.created).toBe(false);
    expect(loser.achievement.achievementId).toBe(winner.achievement.achievementId);
    expect(count("select count(*) n from learner_achievements")).toBe(1);
    expect(count("select count(*) n from achievement_journey_projection_outbox")).toBe(1);
    expect(count("select count(*) n from account_events where event_type='achievement_created'")).toBe(1);
  });

  it("a losing writer with a CONFLICTING body is rejected safely and writes nothing", async () => {
    await createAchievement(context, achievement({ idempotencyKey: "idem-win" }), now);
    const spy = staleOnce(/from learner_achievements\s+where learner_id=\? and app_id=\? and achievement_instance_key=\?/);
    await expect(createAchievement(context, achievement({ idempotencyKey: "idem-other", title: "Different" }), now))
      .rejects.toThrowError(new AchievementError("ACHIEVEMENT_INSTANCE_CONFLICT"));
    spy.mockRestore();
    expect(count("select count(*) n from learner_achievements")).toBe(1);
    expect(count("select count(*) n from achievement_mutation_receipts where idempotency_key='idem-other'")).toBe(0);
  });

  it("many sequential duplicate retries create exactly one logical achievement and leave progress untouched", async () => {
    const before = getDb().prepare("select * from learner_app_progress where learner_id=? and app_id=?").get(learnerId, context.appId);
    for (let i = 0; i < 6; i += 1) await createAchievement(context, achievement({ idempotencyKey: `idem-${i}` }), now);
    expect(count("select count(*) n from learner_achievements")).toBe(1);
    expect(getDb().prepare("select * from learner_app_progress where learner_id=? and app_id=?").get(learnerId, context.appId)).toEqual(before);
  });
});

describe("PRG-042 revocation races", () => {
  it("a stale second revoke cannot write a second receipt, outbox row or audit event", async () => {
    const created = await createAchievement(context, achievement(), now);
    const id = created.achievement.achievementId;
    const req = (key: string) => ({ achievementId: id, appId: context.appId, environment: "production", principalId: context.principalId, now,
      request: { expectedRecordVersion: 1, reasonCode: "app_error" as const, idempotencyKey: key } });
    const preRevokeRow = getDb().prepare("select * from learner_achievements where id=?").get(id);      // what a concurrent transaction still sees
    await revokeAchievement(req("rev-1"));
    const spy = staleOnce(/select \* from learner_achievements where id=\?/, { ...(preRevokeRow as object) });
    await expect(revokeAchievement(req("rev-2"))).rejects.toThrow(AchievementError);
    spy.mockRestore();
    expect(count("select count(*) n from achievement_mutation_receipts where action='revoke'")).toBe(1);
    expect(count("select count(*) n from achievement_journey_projection_outbox where action='remove'")).toBe(1);
    expect(count("select count(*) n from account_events where event_type='achievement_revoked'")).toBe(1);
    expect(getDb().prepare("select record_version v from learner_achievements where id=?").get(id)).toEqual({ v: 2 });
  });

  it("a revoke racing a create replay still ends revoked exactly once", async () => {
    const created = await createAchievement(context, achievement({ idempotencyKey: "c-1" }), now);
    await revokeAchievement({ achievementId: created.achievement.achievementId, appId: context.appId, environment: "production", principalId: context.principalId, now,
      request: { expectedRecordVersion: 1, reasonCode: "duplicate_emission", idempotencyKey: "rev-x" } });
    const replay = await createAchievement(context, achievement({ idempotencyKey: "c-2" }), now);
    expect(replay.created).toBe(false);
    expect(count("select count(*) n from learner_achievements where revoked_at is not null")).toBe(1);
  });

  it("revocation never touches progress, credits or entitlements", async () => {
    const tables = ["learner_app_progress", "learner_app_effective_entitlements", "learner_app_standard_credit_batches"];
    const snap = () => tables.map((t) => JSON.stringify(getDb().prepare(`select * from ${t}`).all()));
    const created = await createAchievement(context, achievement(), now);
    const before = snap();
    await revokeAchievement({ achievementId: created.achievement.achievementId, appId: context.appId, environment: "production", principalId: context.principalId, now,
      request: { expectedRecordVersion: 1, reasonCode: "invalid_source", idempotencyKey: "rev-z" } });
    expect(snap()).toEqual(before);
  });
});
