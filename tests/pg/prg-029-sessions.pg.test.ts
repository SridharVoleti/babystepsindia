// @vitest-environment node
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDbClientForTests, resolveDbClient } from "@/lib/db-client";
import { confirmUsableLaunch, startLearnerSession } from "@/lib/learning-session/gateway";

// Real-PostgreSQL evidence for PRG-029 / SC-001 + SC-003 (issue #59): concurrent Start and usable-launch confirmation over separate pooled
// connections. Runs only when PG_TEST_URL points at a disposable, fully migrated database.
const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;
const now = new Date("2026-08-12T10:00:00.000Z");
const timezone = "Asia/Kolkata";

suite("PRG-029 session lifecycle on PostgreSQL", () => {
  const db = () => resolveDbClient();
  const previous = process.env.SUPABASE_DB_URL;
  let parentId: string; let appId: string; let deploymentId: string; let releaseId: string; let principalId: string;

  beforeAll(async () => {
    process.env.SUPABASE_DB_URL = url;
    process.env.SESSION_ENVELOPE_SIGNING_PRIVATE_KEY = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.ANALYTICS_HMAC_SECRET = "pg029-analytics-secret-at-least-32-characters";
    process.env.LEARNING_SESSION_SECRET = "pg029-learning-session-secret-at-least-32-chars";
    resetDbClientForTests();
    parentId = randomUUID(); appId = randomUUID(); deploymentId = randomUUID(); releaseId = randomUUID(); principalId = randomUUID();
    await db().run("insert into users(id, email, password_hash) values (?, ?, 'x')", [parentId, `pg029-${parentId}@example.com`]);
    await db().run("insert into profiles(id, display_name) values (?, 'Parent')", [parentId]);
    await db().run("insert into app_registry(id, app_key, display_name, short_description, registry_status) values (?, 'pg029-app', 'Session App', 'Learning app', 'active')", [appId]);
    await db().run(`insert into app_releases(id, app_id, source_repository, source_commit_sha, dependency_lock_hash, build_input_hash, artifact_digest,
      manifest_json, gate_results_json, status, created_by_ci_principal) values (?, ?, 'org/repo', 'sha', 'lock', 'build', 'digest', '{}', '{}', 'verified', 'ci')`, [releaseId, appId]);
    await db().run(`insert into app_service_principals(id, app_id, environment, deployment_id, client_id, key_ref, status, valid_from, valid_until)
      values (?, ?, 'production', ?, ?, 'key', 'active', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')`, [principalId, appId, deploymentId, `client-${principalId}`]);
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = previous;
    resetDbClientForTests();
  });

  async function learnerWithAccess() {
    const learnerId = randomUUID(); const cycleId = randomUUID(); const effectiveId = randomUUID(); const batchId = randomUUID();
    await db().run(`insert into learners(id, owner_parent_id, display_name, normalized_display_name, date_of_birth, locale, timezone)
      values (?, ?, ?, ?, '2018-01-01', 'en-IN', 'Asia/Kolkata')`, [learnerId, parentId, `L-${learnerId}`, `l-${learnerId}`]);
    await db().run(`insert into entitlement_cycles(id, paid_cycle_id, subscription_id, purchaser_parent_id, assigned_learner_id, product_id, product_version, app_ids_json,
      period_start, period_end, billing_anchor, status, source_event_id, source_event_version, source_event_hash, created_at, ready_at, version)
      values (?, ?, ?, ?, ?, 'product', 1, ?, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-08-01', 'ready', ?, 1, 'hash', now(), now(), 1)`,
      [cycleId, randomUUID(), randomUUID(), parentId, learnerId, JSON.stringify([appId]), randomUUID()]);
    await db().run(`insert into learner_app_effective_entitlements(id, learner_id, app_id, environment, state, access_until, effective_version, source_set_hash)
      values (?, ?, ?, 'production', 'active', '2026-09-01T00:00:00Z', 1, 'hash')`, [effectiveId, learnerId, appId]);
    await db().run(`insert into learner_app_entitlement_periods(id, entitlement_cycle_id, subscription_id, learner_id, app_id, product_version, period_start, period_end,
      status, effective_source_role, effective_entitlement_id) values (?, ?, ?, ?, ?, 1, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 'ready', 'allocation_bearing', ?)`,
      [randomUUID(), cycleId, randomUUID(), learnerId, appId, effectiveId]);
    await db().run(`insert into learner_app_standard_credit_batches(id, learner_id, app_id, allocation_month, timezone, granted_count, reserved_count, consumed_count,
      effective_at, expires_at, version) values (?, ?, ?, '2026-08-01', ?, 8, 0, 0, '2026-07-31T18:30:00Z', '2026-10-01T00:00:00Z', 1)`, [batchId, learnerId, appId, timezone]);
    return { learnerId, batchId };
  }

  const start = (learnerId: string, over: Record<string, unknown> = {}) => startLearnerSession({
    actorSessionId: randomUUID(), parentUserId: parentId, selectedLearnerId: learnerId, learnerId, appId, deviceSessionId: randomUUID(),
    scheduleAuthorizationId: "schedule-1", scheduleAuthorized: true, idempotencyKey: randomUUID(), now, fundingSource: "standard_monthly",
    deployment: { deploymentId, releaseId, environment: "production", origin: "https://app.example", launchPath: "/launch", compatibilityPassed: true, dispatchBlocked: false },
    ...over } as never);
  const n = async (sql: string, ...a: string[]) => Number(((await db().get<{ n: string }>(sql, a)) ?? { n: "0" }).n);
  const codes = (results: PromiseSettledResult<unknown>[]) => results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason?.code ?? String((r as PromiseRejectedResult).reason));

  it("simultaneous starts for one learner create exactly one reserved session; every loser gets LEARNER_SESSION_IN_PROGRESS and reserves nothing", async () => {
    const { learnerId, batchId } = await learnerWithAccess();
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => start(learnerId)));
    expect({ winners: results.filter((r) => r.status === "fulfilled").length, losers: codes(results) })
      .toEqual({ winners: 1, losers: Array(4).fill("LEARNER_SESSION_IN_PROGRESS") });
    expect(await n("select count(*) n from learner_sessions where learner_id = ?", learnerId)).toBe(1);
    expect(await n("select reserved_count n from learner_app_standard_credit_batches where id = ?", batchId)).toBe(1);
  });

  it("duplicate concurrent starts with the same idempotency key return one session", async () => {
    const { learnerId } = await learnerWithAccess();
    const same = { actorSessionId: randomUUID(), idempotencyKey: randomUUID(), deviceSessionId: randomUUID() };
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => start(learnerId, same)));
    const ok = results.filter((r): r is PromiseFulfilledResult<{ sessionId: string }> => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.value.sessionId)).size).toBe(1);
    expect(await n("select count(*) n from learner_sessions where learner_id = ?", learnerId)).toBe(1);
  });

  it("concurrent identical usable-launch confirmations activate once and consume exactly one credit", async () => {
    const { learnerId, batchId } = await learnerWithAccess();
    const started = await start(learnerId) as unknown as { sessionId: string };
    const grantId = randomUUID();
    await db().run(`insert into app_session_grants(id, learner_session_id, learner_id, app_id, environment, deployment_id, release_id, app_principal_id,
      scopes_json, api_contract_version, grant_version, status, expires_at, created_at, updated_at)
      values (?, ?, ?, ?, 'production', ?, ?, ?, '["progress.read"]', '1.0', 1, 'provisional', '2030-01-01T00:00:00Z', now(), now())`, [grantId, started.sessionId, learnerId, appId, deploymentId, releaseId, principalId]);
    const args = { runtimeInitializationId: "runtime-1", runtimeVersion: 1, expectedSessionVersion: 1, idempotencyKey: "confirm-1", now: new Date("2026-08-12T10:00:20.000Z") };
    const ctx = { grantId, principalId, learnerSessionId: started.sessionId, learnerId, appId };
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => confirmUsableLaunch(ctx, args)));
    const ok = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled");
    expect({ ok: ok.length, errors: codes(results) }).toMatchObject({ ok: expect.any(Number) });
    expect(ok.length, JSON.stringify(codes(results))).toBeGreaterThanOrEqual(1);
    expect(codes(results).filter((c) => !["USABLE_LAUNCH_ALREADY_CONFIRMED", "LEARNER_SESSION_VERSION_CONFLICT"].includes(c))).toEqual([]);
    expect(await n("select count(*) n from learner_sessions where learner_id = ? and status = 'active'", learnerId)).toBe(1);
    expect(await n("select consumed_count n from learner_app_standard_credit_batches where id = ?", batchId)).toBe(1);
    expect(await n("select reserved_count n from learner_app_standard_credit_batches where id = ?", batchId)).toBe(0);
  });
});
