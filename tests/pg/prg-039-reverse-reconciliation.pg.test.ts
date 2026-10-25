// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDbClientForTests, resolveDbClient } from "@/lib/db-client";
import { evaluateAccessFresh } from "@/lib/entitlement-access/service";
import { runReverseEntitlementIntegritySweep } from "@/lib/entitlement-integrity/reverse-sweep";

// Real-PostgreSQL evidence for PRG-039 / EN-004 (issue #61): entitlement targets without verified billing source truth are detected, audited and
// quarantined. Runs only when PG_TEST_URL points at a disposable, fully migrated database.
const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;
const now = new Date("2026-08-15T00:00:00.000Z");

suite("PRG-039 reverse reconciliation on PostgreSQL", () => {
  const db = () => resolveDbClient();
  const previous = process.env.SUPABASE_DB_URL;
  let parentId: string; let appId: string; let principalId: string;

  beforeAll(async () => {
    process.env.SUPABASE_DB_URL = url;
    resetDbClientForTests();
    parentId = randomUUID(); appId = randomUUID(); principalId = randomUUID();
    await db().run("insert into users(id, email, password_hash) values (?, ?, 'x')", [parentId, `pg039-${parentId}@example.com`]);
    await db().run("insert into profiles(id, display_name) values (?, 'Parent')", [parentId]);
    await db().run("insert into app_registry(id, app_key, display_name, short_description, registry_status) values (?, 'pg039-app', 'Integrity App', 'Learning app', 'active')", [appId]);
    await db().run(`insert into platform_service_principals(id, service_key, key_ref, status, valid_from, valid_until)
      values (?, ?, 'key', 'active', '2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z')`, [principalId, `pg039-${principalId}`]);
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = previous;
    resetDbClientForTests();
  });

  /** A ready entitlement cycle (with periods and effective access) whose paid cycle / subscription do not exist in billing: an orphan target. */
  async function orphan() {
    const learnerId = randomUUID(); const cycleId = randomUUID(); const effectiveId = randomUUID(); const paidCycleId = randomUUID();
    await db().run(`insert into learners(id, owner_parent_id, display_name, normalized_display_name, date_of_birth, locale, timezone)
      values (?, ?, ?, ?, '2018-01-01', 'en-IN', 'Asia/Kolkata')`, [learnerId, parentId, `L-${learnerId}`, `l-${learnerId}`]);
    await db().run(`insert into entitlement_cycles(id, paid_cycle_id, subscription_id, purchaser_parent_id, assigned_learner_id, product_id, product_version, app_ids_json,
      period_start, period_end, billing_anchor, status, source_event_id, source_event_version, source_event_hash, created_at, ready_at, version)
      values (?, ?, ?, ?, ?, 'product', 1, ?, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', '2026-08-01', 'ready', ?, 1, 'hash', now(), now(), 1)`,
      [cycleId, paidCycleId, randomUUID(), parentId, learnerId, JSON.stringify([appId]), randomUUID()]);
    await db().run(`insert into learner_app_effective_entitlements(id, learner_id, app_id, environment, state, access_until, effective_version, source_set_hash)
      values (?, ?, ?, 'production', 'active', '2026-09-01T00:00:00Z', 1, 'hash')`, [effectiveId, learnerId, appId]);
    await db().run(`insert into learner_app_entitlement_periods(id, entitlement_cycle_id, subscription_id, learner_id, app_id, product_version, period_start, period_end,
      status, effective_source_role, effective_entitlement_id) values (?, ?, ?, ?, ?, 1, '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z', 'ready', 'allocation_bearing', ?)`,
      [randomUUID(), cycleId, randomUUID(), learnerId, appId, effectiveId]);
    return { learnerId, paidCycleId, cycleId };
  }
  const n = async (sql: string, ...a: string[]) => Number(((await db().get<{ n: string }>(sql, a)) ?? { n: "0" }).n);
  const sweep = (key: string) => runReverseEntitlementIntegritySweep(principalId, { environment: "production", limit: 100, runIdempotencyKey: key, cursor: undefined }, now);

  it("detects an orphan target, audits it first, and quarantines access", async () => {
    const o = await orphan();
    expect((await evaluateAccessFresh({ learnerId: o.learnerId, appId, environment: "production", useCase: "start", now })).allowed).toBe(true);
    const result = await sweep(`rev-${randomUUID()}`);
    expect(result.incidentsOpenedCount).toBeGreaterThanOrEqual(1);
    expect(await n("select count(*) n from entitlement_integrity_incidents where source_id = ? and category = 'ENTITLEMENT_WITHOUT_VERIFIED_SOURCE' and status = 'open'", o.paidCycleId)).toBe(1);
    expect(await n("select count(*) n from entitlement_reconciliation_receipts where source_id = ?", o.paidCycleId)).toBe(1);
    const state = await db().get<{ integrity_state: string }>("select integrity_state from learner_app_effective_entitlements where learner_id = ?", [o.learnerId]);
    expect(state!.integrity_state).toBe("quarantined");
    expect((await evaluateAccessFresh({ learnerId: o.learnerId, appId, environment: "production", useCase: "start", now })).allowed).toBe(false);
  });

  it("racing reverse sweeps leave exactly one incident and one receipt per orphan, and never create entitlement or billing state", async () => {
    const o = await orphan();
    const before = { cycles: await n("select count(*) n from entitlement_cycles"), billing: await n("select count(*) n from billing_periods") };
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => sweep(`rev-${randomUUID()}`)));
    expect(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
    expect(await n("select count(*) n from entitlement_integrity_incidents where source_id = ?", o.paidCycleId)).toBe(1);
    expect(await n("select count(*) n from entitlement_reconciliation_receipts where source_id = ?", o.paidCycleId)).toBe(1);
    expect({ cycles: await n("select count(*) n from entitlement_cycles"), billing: await n("select count(*) n from billing_periods") }).toEqual(before);
  });
});
