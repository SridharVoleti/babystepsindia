// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDbClientForTests, resolveDbClient } from "@/lib/db-client";
import { AchievementError, createAchievement, registerReleaseAchievementContract, revokeAchievement,
  validateReleaseAchievementContract, type AchievementWriteContext, type CreateAchievementInput } from "@/lib/achievements/service";

// Real-PostgreSQL evidence for PRG-042 / EG-001 (issue #62): concurrent duplicate achievement writes over separate pooled connections.
// Runs only when PG_TEST_URL points at a disposable, fully migrated database.
const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;
const now = new Date("2026-08-12T10:00:00.000Z");

suite("PRG-042 achievements on PostgreSQL", () => {
  const db = () => resolveDbClient();
  const previous = process.env.SUPABASE_DB_URL;
  let context: AchievementWriteContext; let learnerId: string; let appId: string; let sessionId: string;

  beforeAll(async () => {
    process.env.SUPABASE_DB_URL = url;
    resetDbClientForTests();
    const parentId = randomUUID(); learnerId = randomUUID(); appId = randomUUID(); sessionId = randomUUID();
    const releaseId = randomUUID(); const principalId = randomUUID(); const grantId = randomUUID(); const deploymentId = randomUUID();
    await db().run("insert into users(id, email, password_hash) values (?, ?, 'x')", [parentId, `pg042-${parentId}@example.com`]);
    await db().run("insert into profiles(id, display_name) values (?, 'Parent')", [parentId]);
    await db().run(`insert into learners(id, owner_parent_id, display_name, normalized_display_name, date_of_birth, locale, timezone)
      values (?, ?, 'Asha', 'asha', '2018-01-01', 'en-IN', 'Asia/Kolkata')`, [learnerId, parentId]);
    await db().run("insert into app_registry(id, app_key, display_name, short_description, icon_asset_key, registry_status) values (?, 'pg042-app', 'Achievement App', 'Learning app', 'icon-open-book', 'active')", [appId]);
    await db().run(`insert into app_releases(id, app_id, source_repository, source_commit_sha, dependency_lock_hash, build_input_hash, artifact_digest,
      manifest_json, gate_results_json, status, created_by_ci_principal) values (?, ?, 'org/repo', 'sha', 'lock', 'build', 'digest', '{}', '{}', 'verified', 'ci')`, [releaseId, appId]);
    await db().run(`insert into learner_sessions(id, learner_id, app_id, parent_user_id, device_session_id, week_key, week_timezone, weekly_slot_number, source,
      status, funding_state, schedule_authorization_id, started_at, resume_token_hash, release_id, deployment_environment, session_expires_at, created_at, updated_at)
      values (?, ?, ?, ?, ?, '2026-W33', 'Asia/Kolkata', 1, 'normal', 'active', 'consumed', 'schedule', '2026-08-12T09:00:00Z', 'hash', ?, 'production',
      '2026-08-12T11:00:00Z', '2026-08-12T09:00:00Z', '2026-08-12T09:00:00Z')`, [sessionId, learnerId, appId, parentId, randomUUID(), releaseId]);
    await db().run(`insert into app_service_principals(id, app_id, environment, deployment_id, client_id, key_ref, status, valid_from, valid_until)
      values (?, ?, 'production', ?, ?, 'key', 'active', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')`, [principalId, appId, deploymentId, `client-${principalId}`]);
    await db().run(`insert into learner_app_progress(learner_id, app_id, current_level_key, current_lesson_key, progress_version, state_hash)
      values (?, ?, 'level-2', 'lesson-3', 2, 'progress-hash')`, [learnerId, appId]);
    await registerReleaseAchievementContract({ appId, releaseId, achievementContractVersion: "1.0", appAchievementModelVersion: "model-1",
      allowedBadgeAssetKeys: ["icon-open-book"], now });
    expect(await validateReleaseAchievementContract(appId, releaseId, now)).toMatchObject({ passed: true });
    context = { grantId, learnerSessionId: sessionId, learnerId, appId, principalId, environment: "production", deploymentId, releaseId };
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = previous;
    resetDbClientForTests();
  });

  const achievement = (o: Partial<CreateAchievementInput> = {}): CreateAchievementInput => ({
    achievementContractVersion: "1.0", appAchievementKey: "fractions", achievementInstanceKey: "fractions:v1", title: "Fractions explorer",
    shortDescription: "Completed the fractions path.", badgeAssetKey: "icon-open-book", category: "mastery", earnedAt: "2026-08-12T09:55:00.000Z",
    appAchievementModelVersion: "model-1", sourceProgressVersion: 2, sourceSessionId: sessionId, idempotencyKey: `achievement-${randomUUID()}`, ...o });
  const n = async (sql: string, ...a: string[]) => Number(((await db().get<{ n: string }>(sql, a)) ?? { n: "0" }).n);

  it("concurrent creates of one logical achievement (distinct idempotency keys) yield exactly one row; the rest replay", async () => {
    const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(() => createAchievement(context, achievement(), now)));
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof createAchievement>>> => r.status === "fulfilled");
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(ok.filter((r) => r.value.created)).toHaveLength(1);
    expect(new Set(ok.map((r) => r.value.achievement.achievementId)).size).toBe(1);
    expect(await n("select count(*) n from learner_achievements where learner_id = ? and app_id = ?", learnerId, appId)).toBe(1);
    expect(await n("select count(*) n from achievement_journey_projection_outbox where learner_id = ?", learnerId)).toBe(1);
  });

  it("a conflicting body for the same instance is rejected safely under concurrency", async () => {
    const results = await Promise.allSettled([
      createAchievement(context, achievement({ achievementInstanceKey: "conflict:v1", title: "A" }), now),
      createAchievement(context, achievement({ achievementInstanceKey: "conflict:v1", title: "B" }), now),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(AchievementError);
    expect((rejected.reason as AchievementError).message).toBe("ACHIEVEMENT_INSTANCE_CONFLICT");
    expect(await n("select count(*) n from learner_achievements where achievement_instance_key = ?", "conflict:v1")).toBe(1);
  });

  it("concurrent revokes of one achievement revoke it exactly once", async () => {
    const created = await createAchievement(context, achievement({ achievementInstanceKey: "revoke:v1" }), now);
    const req = (key: string) => revokeAchievement({ achievementId: created.achievement.achievementId, appId, environment: "production", principalId: context.principalId, now,
      request: { expectedRecordVersion: 1, reasonCode: "app_error", idempotencyKey: key } });
    const results = await Promise.allSettled([req("rev-a"), req("rev-b"), req("rev-c")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await n("select count(*) n from achievement_mutation_receipts where achievement_id = ? and action = 'revoke'", created.achievement.achievementId)).toBe(1);
    expect(await n("select count(*) n from achievement_journey_projection_outbox where achievement_id = ? and action = 'remove'", created.achievement.achievementId)).toBe(1);
    expect(await n("select record_version n from learner_achievements where id = ?", created.achievement.achievementId)).toBe(2);
  });

  it("achievement writes never touch progress", async () => {
    expect(await n("select progress_version n from learner_app_progress where learner_id = ? and app_id = ?", learnerId, appId)).toBe(2);
  });
});
