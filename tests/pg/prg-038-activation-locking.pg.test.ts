// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDbClientForTests, resolveDbClient } from "@/lib/db-client";
import { acquireEntitlementScopeRows } from "@/lib/entitlement-cycle/scope-lock";
import { applyPaidCycle, type ApplyPaidCycleInput } from "@/lib/entitlement-cycle/service";

// Real-PostgreSQL evidence for PRG-038 / EN-002 (issue #60): runs only when PG_TEST_URL points at a disposable database that already has every
// migration applied (see scripts/verify-migrations-postgres.mjs). The pool uses separate connections, so these activations genuinely overlap.
const url = process.env.PG_TEST_URL;
const suite = url ? describe : describe.skip;

suite("PRG-038 activation locking on PostgreSQL", () => {
  const db = () => resolveDbClient();
  let parentId: string; let learnerId: string; let otherLearnerId: string; let mathId: string; let readingId: string;
  const previous = process.env.SUPABASE_DB_URL;

  beforeAll(async () => {
    process.env.SUPABASE_DB_URL = url;
    resetDbClientForTests();
    parentId = randomUUID(); learnerId = randomUUID(); otherLearnerId = randomUUID(); mathId = randomUUID(); readingId = randomUUID();
    await db().run("insert into users(id, email, password_hash) values (?, ?, 'x')", [parentId, `pg038-${parentId}@example.com`]);
    await db().run("insert into profiles(id, display_name) values (?, 'Parent')", [parentId]);
    for (const [id, name] of [[learnerId, "Asha"], [otherLearnerId, "Bala"]]) {
      await db().run(`insert into learners(id, owner_parent_id, display_name, normalized_display_name, date_of_birth, locale, timezone)
        values (?, ?, ?, ?, '2018-01-01', 'en-IN', 'Asia/Kolkata')`, [id, parentId, name, name.toLowerCase()]);
    }
    for (const [id, key] of [[mathId, "pg038-math"], [readingId, "pg038-reading"]]) {
      await db().run(`insert into app_registry(id, app_key, display_name, short_description, registry_status) values (?, ?, ?, 'Learning app', 'active')`, [id, key, key]);
    }
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = previous;
    resetDbClientForTests();
  });

  const input = (o: Partial<ApplyPaidCycleInput> = {}): ApplyPaidCycleInput => ({
    paidCycleId: randomUUID(), eventId: randomUUID(), eventVersion: 1, subscriptionId: randomUUID(), purchaserParentId: parentId,
    assignedLearnerId: learnerId, productId: "prod-1", productVersion: 1, appIds: [mathId],
    periodStart: "2026-08-10T00:00:00.000Z", periodEnd: "2026-09-10T00:00:00.000Z", billingAnchor: "2026-08-10", environment: "production",
    now: new Date("2026-08-10T00:05:00.000Z"), ...o });
  const n = async (sql: string, ...a: (string | number)[]) => Number(((await db().get<{ n: string | number }>(sql, a)) ?? { n: 0 }).n);

  it("duplicate concurrent retries of one event create exactly one cycle and every caller gets the same result", async () => {
    const one = input();
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(() => applyPaidCycle(one)));
    expect(new Set(results.map((r) => r.cycleId)).size).toBe(1);
    expect(await n("select count(*) n from entitlement_cycles where paid_cycle_id = ?", one.paidCycleId)).toBe(1);
  });

  it("two simultaneous overlapping activations for one learner/app yield one effective entitlement and exactly one allocation-bearing period", async () => {
    const a = input({ appIds: [readingId], periodStart: "2026-08-10T00:00:00.000Z", periodEnd: "2026-09-10T00:00:00.000Z" });
    const b = input({ appIds: [readingId], periodStart: "2026-08-20T00:00:00.000Z", periodEnd: "2026-09-20T00:00:00.000Z" });
    await Promise.all([applyPaidCycle(a), applyPaidCycle(b)]);
    expect(await n("select count(*) n from learner_app_effective_entitlements where learner_id = ? and app_id = ? and environment = 'production'", learnerId, readingId)).toBe(1);
    expect(await n("select count(*) n from learner_app_entitlement_periods where learner_id = ? and app_id = ? and effective_source_role = 'allocation_bearing'", learnerId, readingId)).toBe(1);
    expect(await n("select count(*) n from learner_app_entitlement_periods where learner_id = ? and app_id = ? and effective_source_role = 'access_supporting'", learnerId, readingId)).toBe(1);
  });

  it("different learners activate concurrently and independently", async () => {
    await Promise.all([applyPaidCycle(input({ assignedLearnerId: otherLearnerId })), applyPaidCycle(input({ assignedLearnerId: learnerId, appIds: [readingId], periodStart: "2026-10-10T00:00:00.000Z", periodEnd: "2026-11-10T00:00:00.000Z" }))]);
    expect(await n("select count(*) n from learner_app_effective_entitlements where learner_id = ?", otherLearnerId)).toBe(1);
  });

  it("one lock row per scope records the activations", async () => {
    expect(await n("select lock_seq n from entitlement_activation_locks where learner_id = ? and app_id = ? and environment = 'production'", learnerId, readingId)).toBeGreaterThanOrEqual(2);
  });

  it("the database row lock itself serialises two connections on the same scope, and does not block a different scope", async () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const log: string[] = [];
    const now = new Date("2026-08-10T00:05:00.000Z");
    const holder = db().transaction(async (tx) => {
      await acquireEntitlementScopeRows(tx, learnerId, [mathId], "lock-test", now);
      log.push("A-acquired");
      await sleep(400);
      log.push("A-commit");
    });
    await sleep(100);
    const sameScope = db().transaction(async (tx) => {
      await acquireEntitlementScopeRows(tx, learnerId, [mathId], "lock-test", now);
      log.push("B-acquired-same-scope");
    });
    const otherScope = db().transaction(async (tx) => {
      await acquireEntitlementScopeRows(tx, otherLearnerId, [mathId], "lock-test", now);
      log.push("C-acquired-other-scope");
    });
    await Promise.all([holder, sameScope, otherScope]);
    expect(log.indexOf("B-acquired-same-scope")).toBeGreaterThan(log.indexOf("A-commit"));            // waited for A's commit
    expect(log.indexOf("C-acquired-other-scope")).toBeLessThan(log.indexOf("A-commit"));              // independent scope was not blocked
  });
});
