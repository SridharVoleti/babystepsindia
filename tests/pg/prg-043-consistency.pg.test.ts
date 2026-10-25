// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDbClientForTests, resolveDbClient } from "@/lib/db-client";
import { applyStandardSessionConsistency, finalizeConsistencyWeek } from "@/lib/consistency/service";

// Real-PostgreSQL evidence for PRG-043 / EG-002 (issue #63): concurrent session completions and finalizers over separate pooled connections.
// Runs only when PG_TEST_URL points at a disposable, fully migrated database.
const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;
const timezone = "Asia/Kolkata";
const weekly = "2026-W33";

suite("PRG-043 weekly consistency on PostgreSQL", () => {
  const db = () => resolveDbClient();
  const previous = process.env.SUPABASE_DB_URL;
  let parentId: string; let principalId: string;

  beforeAll(async () => {
    process.env.SUPABASE_DB_URL = url;
    resetDbClientForTests();
    parentId = randomUUID(); principalId = randomUUID();
    await db().run("insert into users(id, email, password_hash) values (?, ?, 'x')", [parentId, `pg043-${parentId}@example.com`]);
    await db().run("insert into profiles(id, display_name) values (?, 'Parent')", [parentId]);
    await db().run(`insert into platform_service_principals(id, service_key, key_ref, status, valid_from, valid_until)
      values (?, ?, 'key', 'active', '2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z')`, [principalId, `pg043-${principalId}`]);
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = previous;
    resetDbClientForTests();
  });

  /** One learner + app with an active monthly period covering the week and two standard-monthly sessions already funded and launched. */
  async function seed() {
    const learnerId = randomUUID(); const appId = randomUUID(); const cycleId = randomUUID(); const periodId = randomUUID();
    const effectiveId = randomUUID(); const batchId = randomUUID(); const s1 = randomUUID(); const s2 = randomUUID();
    await db().run(`insert into learners(id, owner_parent_id, display_name, normalized_display_name, date_of_birth, locale, timezone)
      values (?, ?, ?, ?, '2018-01-01', 'en-IN', 'Asia/Kolkata')`, [learnerId, parentId, `L-${learnerId}`, `l-${learnerId}`]);
    await db().run("insert into app_registry(id, app_key, display_name, short_description, registry_status) values (?, ?, 'Consistency App', 'Learning app', 'active')", [appId, `pg043-${appId.slice(0, 8)}`]);
    await db().run(`insert into entitlement_cycles(id, paid_cycle_id, subscription_id, purchaser_parent_id, assigned_learner_id, product_id, product_version, app_ids_json,
      period_start, period_end, billing_anchor, status, source_event_id, source_event_version, source_event_hash, created_at, ready_at, version)
      values (?, ?, ?, ?, ?, 'product', 1, ?, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-08-01', 'ready', ?, 1, 'hash', now(), now(), 1)`,
      [cycleId, randomUUID(), randomUUID(), parentId, learnerId, JSON.stringify([appId]), randomUUID()]);
    await db().run(`insert into learner_app_effective_entitlements(id, learner_id, app_id, environment, state, access_until, effective_version, source_set_hash)
      values (?, ?, ?, 'production', 'active', '2026-09-01T00:00:00Z', 1, 'hash')`, [effectiveId, learnerId, appId]);
    await db().run(`insert into learner_app_entitlement_periods(id, entitlement_cycle_id, subscription_id, learner_id, app_id, product_version, period_start, period_end,
      status, effective_source_role, effective_entitlement_id) values (?, ?, ?, ?, ?, 1, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 'ready', 'allocation_bearing', ?)`,
      [periodId, cycleId, randomUUID(), learnerId, appId, effectiveId]);
    await db().run(`insert into learner_app_standard_credit_batches(id, learner_id, app_id, allocation_month, timezone, granted_count, reserved_count, consumed_count,
      effective_at, expires_at, version) values (?, ?, ?, '2026-08-01', ?, 8, 0, 2, '2026-07-31T18:30:00Z', '2026-10-01T00:00:00Z', 1)`, [batchId, learnerId, appId, timezone]);
    await db().run(`insert into learner_app_week_usage(learner_id, app_id, week_key, week_timezone, normal_sessions_started, standard_sessions_funded, version, updated_at)
      values (?, ?, ?, ?, 0, 2, 3, now())`, [learnerId, appId, weekly, timezone]);
    const session = async (id: string, ordinal: number, at: string) => db().run(`insert into learner_sessions(id, learner_id, app_id, parent_user_id, device_session_id, week_key, week_timezone,
      source, standard_credit_batch_id, weekly_session_ordinal, status, funding_state, schedule_authorization_id, started_at, usable_launch_established_at, hard_expires_at,
      resume_token_hash, deployment_environment, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, 'standard_monthly', ?, ?, 'completed', 'consumed', 'schedule', ?, ?, ?, 'hash', 'production', ?, ?)`,
      [id, learnerId, appId, parentId, randomUUID(), weekly, timezone, batchId, ordinal, at, at, new Date(new Date(at).getTime() + 3600_000).toISOString(), at, at]);
    await session(s1, 1, "2026-08-11T09:00:00.000Z");
    await session(s2, 2, "2026-08-12T09:00:00.000Z");
    return { learnerId, appId, s1, s2 };
  }
  const apply = (sessionId: string, version: number, at: string) => applyStandardSessionConsistency({ sourceSessionId: sessionId, weeklyUsageVersion: version,
    eventId: `standard-session:${sessionId}`, principalId, now: new Date(at) });
  const n = async (sql: string, ...a: string[]) => Number(((await db().get<{ n: string }>(sql, a)) ?? { n: "0" }).n);

  it("the two qualifying sessions completing concurrently count the week exactly once", async () => {
    const f = await seed();
    const results = await Promise.allSettled([apply(f.s1, 3, "2026-08-11T09:00:00.000Z"), apply(f.s2, 3, "2026-08-12T09:00:00.000Z")]);
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await n("select count(*) n from learner_app_consistency_weeks where learner_id = ? and app_id = ?", f.learnerId, f.appId)).toBe(1);
    expect(await n("select current_streak_weeks n from learner_app_consistency where learner_id = ? and app_id = ?", f.learnerId, f.appId)).toBe(1);
    expect(await n("select count(*) n from consistency_mutation_receipts where learner_id = ?", f.learnerId)).toBe(2);
  });

  it("duplicate concurrent deliveries of one session event apply once", async () => {
    const f = await seed();
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => apply(f.s2, 3, "2026-08-12T09:00:00.000Z")));
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await n("select count(*) n from consistency_mutation_receipts where learner_id = ? and source_session_id = ?", f.learnerId, f.s2)).toBe(1);
    expect(await n("select count(*) n from learner_app_consistency_weeks where learner_id = ?", f.learnerId)).toBe(1);
  });

  it("a finalizer racing live completion and repeated scheduler runs never double-count the streak", async () => {
    const f = await seed();
    const finalize = (key: string) => finalizeConsistencyWeek({ weeklyKey: weekly, limit: 50, runIdempotencyKey: key, principalId, now: new Date("2026-08-17T00:00:00.000Z") });
    const results = await Promise.allSettled([apply(f.s1, 3, "2026-08-11T09:00:00.000Z"), apply(f.s2, 3, "2026-08-12T09:00:00.000Z"), finalize(`fin-${randomUUID()}`), finalize(`fin-${randomUUID()}`)]);
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await n("select current_streak_weeks n from learner_app_consistency where learner_id = ? and app_id = ?", f.learnerId, f.appId)).toBe(1);
    expect(await n("select count(*) n from learner_app_consistency_weeks where learner_id = ? and status = 'cadence_complete'", f.learnerId)).toBe(1);
  });
});
