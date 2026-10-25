// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDbClientForTests, resolveDbClient } from "@/lib/db-client";
import { AppProgressError, saveCheckpoint, type AppProgressContext } from "@/lib/app-progress/service";
import { registerProgressSchema } from "@/lib/progress-schema-registry/service";

// Real-PostgreSQL evidence for PRG-037 / EG-001 (issue #58): concurrent duplicate achievement writes over separate pooled connections.
// Runs only when PG_TEST_URL points at a disposable, fully migrated database.
const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;
const now = new Date("2026-08-12T10:00:00.000Z");

suite("PRG-037 progress integrity on PostgreSQL", () => {
  const db = () => resolveDbClient();
  const previous = process.env.SUPABASE_DB_URL;
  let context: AppProgressContext; let learnerId: string; let appId: string; let sessionId: string;

  beforeAll(async () => {
    process.env.SUPABASE_DB_URL = url;
    resetDbClientForTests();
    const parentId = randomUUID(); learnerId = randomUUID(); appId = randomUUID(); sessionId = randomUUID();
    const releaseId = randomUUID(); const principalId = randomUUID(); const grantId = randomUUID(); const deploymentId = randomUUID();
    await db().run("insert into users(id, email, password_hash) values (?, ?, 'x')", [parentId, `pg037-${parentId}@example.com`]);
    await db().run("insert into profiles(id, display_name) values (?, 'Parent')", [parentId]);
    await db().run(`insert into learners(id, owner_parent_id, display_name, normalized_display_name, date_of_birth, locale, timezone)
      values (?, ?, 'Asha', 'asha', '2018-01-01', 'en-IN', 'Asia/Kolkata')`, [learnerId, parentId]);
    await db().run("insert into app_registry(id, app_key, display_name, short_description, icon_asset_key, registry_status) values (?, 'pg037-app', 'Achievement App', 'Learning app', 'icon-open-book', 'active')", [appId]);
    await db().run(`insert into app_releases(id, app_id, source_repository, source_commit_sha, dependency_lock_hash, build_input_hash, artifact_digest,
      manifest_json, gate_results_json, status, created_by_ci_principal) values (?, ?, 'org/repo', 'sha', 'lock', 'build', 'digest', '{}', '{}', 'verified', 'ci')`, [releaseId, appId]);
    await db().run(`insert into learner_sessions(id, learner_id, app_id, parent_user_id, device_session_id, week_key, week_timezone, weekly_slot_number, source,
      status, funding_state, schedule_authorization_id, started_at, resume_token_hash, release_id, deployment_environment, session_expires_at, created_at, updated_at)
      values (?, ?, ?, ?, ?, '2026-W33', 'Asia/Kolkata', 1, 'normal', 'active', 'consumed', 'schedule', '2026-08-12T09:00:00Z', 'hash', ?, 'production',
      '2026-08-12T11:00:00Z', '2026-08-12T09:00:00Z', '2026-08-12T09:00:00Z')`, [sessionId, learnerId, appId, parentId, randomUUID(), releaseId]);
    await db().run(`insert into app_service_principals(id, app_id, environment, deployment_id, client_id, key_ref, status, valid_from, valid_until)
      values (?, ?, 'production', ?, ?, 'key', 'active', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')`, [principalId, appId, deploymentId, `client-${principalId}`]);
    await db().run(`insert into app_session_grants(id, learner_session_id, learner_id, app_id, environment, deployment_id, release_id, app_principal_id,
      scopes_json, api_contract_version, grant_version, status, expires_at, created_at, updated_at)
      values (?, ?, ?, ?, 'production', ?, ?, ?, '["progress.read","progress.write","lesson.complete"]', '1.0', 1, 'active', '2030-01-01T00:00:00Z', now(), now())`,
      [grantId, sessionId, learnerId, appId, deploymentId, releaseId, principalId]);
    await registerProgressSchema({ appId, releaseId, schemaVersion: 1, schemaJson: JSON.stringify({ type: "object", required: ["state"], additionalProperties: false, properties: { state: { type: "string" } } }), now });
    context = { grantId, principalId, learnerSessionId: sessionId, learnerId, appId };
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = previous;
    resetDbClientForTests();
  });

  const cp = (version: number, seq: number, key: string) => ({ expectedProgressVersion: version, checkpointSequence: seq, stateSchemaVersion: 1,
    currentLevelKey: "level-1", currentLessonKey: "lesson-1", currentState: { state: "ok" }, checkpointIdempotencyKey: key });
  const n = async (sql: string, ...a: string[]) => Number(((await db().get<{ n: string }>(sql, a)) ?? { n: "0" }).n);

  it("a healthy checkpoint is accepted; corrupting the stored state then blocks further mutations without any repair", async () => {
    await saveCheckpoint(context, cp(0, 1, `cp-${randomUUID()}`), now);
    expect(await n("select progress_version n from learner_app_progress where learner_id = ? and app_id = ?", learnerId, appId)).toBe(1);
    await db().run("update learner_app_progress set current_state_json = ? where learner_id = ? and app_id = ?", [JSON.stringify({ state: "tampered" }), learnerId, appId]);
    const before = JSON.stringify(await db().get("select * from learner_app_progress where learner_id = ? and app_id = ?", [learnerId, appId]));
    await expect(saveCheckpoint(context, cp(1, 2, `cp-${randomUUID()}`), now)).rejects.toThrowError(new AppProgressError("PROGRESS_INTEGRITY_UNREADABLE"));
    expect(JSON.stringify(await db().get("select * from learner_app_progress where learner_id = ? and app_id = ?", [learnerId, appId]))).toBe(before);
    expect(await n("select count(*) n from progress_integrity_incidents where learner_id = ? and app_id = ?", learnerId, appId)).toBeGreaterThan(0);
  });

  it("repeated and concurrent blocked attempts keep a single active incident", async () => {
    await Promise.allSettled([1, 2, 3, 4].map((i) => saveCheckpoint(context, cp(1, 3 + i, `cp-${randomUUID()}`), now)));
    expect(await n("select count(*) n from progress_integrity_incidents where learner_id = ? and app_id = ? and status in ('open','investigating')", learnerId, appId)).toBe(1);
  });
});
