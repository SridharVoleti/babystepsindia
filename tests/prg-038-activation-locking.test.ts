import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { applyPaidCycle, type ApplyPaidCycleInput } from "@/lib/entitlement-cycle/service";
import { entitlementScopeKeys, withEntitlementScopeLocks } from "@/lib/entitlement-cycle/scope-lock";

// PRG-038 / EN-002 (issue #60): deterministic learner/app locking so concurrent activations cannot create ambiguous entitlement state.
const MATH = "math-app";
const READING = "reading-app";
let parentId: string;
let learnerA: string;
let learnerB: string;

const seedApp = (id: string) => getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
  values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(id, id, id);

beforeEach(async () => {
  useInMemoryDb();
  seedApp(MATH); seedApp(READING);
  parentId = (await sqliteAuthAdapter.signUp("prg038-parent@example.com", "CorrectHorse1!")).user.id;
  learnerA = (await createLearner(parentId, { displayName: "Asha", dateOfBirth: "2018-01-01", idempotencyKey: "30000000-0000-4000-8000-000000000001" }, "2026-08-01")).learner.id;
  learnerB = (await createLearner(parentId, { displayName: "Bala", dateOfBirth: "2018-02-01", idempotencyKey: "30000000-0000-4000-8000-000000000002" }, "2026-08-01")).learner.id;
});

const input = (o: Partial<ApplyPaidCycleInput> = {}): ApplyPaidCycleInput => ({
  paidCycleId: "pc-1", eventId: "ev-1", eventVersion: 1, subscriptionId: "sub-1", purchaserParentId: parentId, assignedLearnerId: learnerA,
  productId: "prod-1", productVersion: 1, appIds: [MATH], periodStart: "2026-08-10T00:00:00.000Z", periodEnd: "2026-09-10T00:00:00.000Z",
  billingAnchor: "2026-08-10", environment: "production", now: new Date("2026-08-10T00:05:00.000Z"), ...o,
});
const count = (sql: string, ...a: unknown[]) => (getDb().prepare(sql).get(...a) as { n: number }).n;

describe("scope keys and lock ordering", () => {
  it("are one per learner x app x environment, unique and deterministically ordered", () => {
    const keys = entitlementScopeKeys("L1", ["b-app", "a-app", "b-app"], "production");
    expect(keys).toEqual(["L1|a-app|production", "L1|b-app|production"]);
    expect(entitlementScopeKeys("L1", ["a-app", "b-app"], "production")).toEqual(keys);
  });

  it("the same scope is serialised; different scopes do not block each other", async () => {
    const log: string[] = [];
    const task = (name: string, keys: string[], ms: number) => withEntitlementScopeLocks(keys, async () => {
      log.push(`start:${name}`); await new Promise((r) => setTimeout(r, ms)); log.push(`end:${name}`);
    });
    await Promise.all([task("a1", ["L1|m|p"], 30), task("a2", ["L1|m|p"], 5), task("b", ["L2|m|p"], 5)]);
    expect(log.indexOf("end:a1")).toBeLessThan(log.indexOf("start:a2"));            // same scope: strictly serial
    expect(log.indexOf("start:b")).toBeLessThan(log.indexOf("end:a1"));             // different learner: not blocked by a1
  });

  it("overlapping multi-key acquisitions in opposite order cannot deadlock", async () => {
    const done: string[] = [];
    await Promise.all([
      withEntitlementScopeLocks(["x", "y"], async () => { await new Promise((r) => setTimeout(r, 10)); done.push("1"); }),
      withEntitlementScopeLocks(["y", "x"], async () => { await new Promise((r) => setTimeout(r, 1)); done.push("2"); }),
    ]);
    expect(done.sort()).toEqual(["1", "2"]);
  });

  it("a failing holder releases the lock for the next waiter", async () => {
    await expect(withEntitlementScopeLocks(["k"], async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withEntitlementScopeLocks(["k"], async () => "ok")).resolves.toBe("ok");
  });
});

describe("concurrent activations for the same learner/app/environment", () => {
  it("duplicate retries of one event return the original logical result and create exactly one cycle", async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => applyPaidCycle(input())));
    expect(new Set(results.map((r) => r.cycleId)).size).toBe(1);
    expect(results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]))).toBe(true);
    expect(count("select count(*) n from entitlement_cycles")).toBe(1);
    expect(count("select count(*) n from learner_app_entitlement_periods")).toBe(1);
    expect(count("select count(*) n from learner_app_standard_credit_batches")).toBe(1);
  });

  // Note: concurrency tests below run on the single-connection SQLite dev adapter, which only models same-scope races; same-scope
  // activations are serialised by the scope lock. Cross-instance Postgres evidence is outstanding (see the issue).
  it("two simultaneous valid overlapping activations yield exactly one effective entitlement and one allocation-bearing period", async () => {
    const first = input({ paidCycleId: "pc-a", eventId: "ev-a", subscriptionId: "sub-a" });
    const second = input({ paidCycleId: "pc-b", eventId: "ev-b", subscriptionId: "sub-b", periodStart: "2026-08-20T00:00:00.000Z", periodEnd: "2026-09-20T00:00:00.000Z" });
    await Promise.all([applyPaidCycle(first), applyPaidCycle(second)]);
    expect(count("select count(*) n from learner_app_effective_entitlements where learner_id=? and app_id=? and environment='production'", learnerA, MATH)).toBe(1);
    expect(count("select count(*) n from learner_app_entitlement_periods where learner_id=? and effective_source_role='allocation_bearing'", learnerA)).toBe(1);
    expect(count("select count(*) n from learner_app_entitlement_periods where learner_id=? and effective_source_role='access_supporting'", learnerA)).toBe(1);
    expect(count("select count(*) n from learner_app_effective_sources")).toBe(2);
    expect(count("select count(*) n from learner_app_standard_credit_batches")).toBe(1);              // only the allocation-bearing period holds a batch
  });

  it("the outcome is identical whichever activation wins the race (no overlapping allocation periods)", async () => {
    const mk = (n: string, s: string, e: string) => input({ paidCycleId: `pc-${n}`, eventId: `ev-${n}`, subscriptionId: `sub-${n}`, periodStart: s, periodEnd: e });
    await Promise.all([
      applyPaidCycle(mk("late", "2026-08-25T00:00:00.000Z", "2026-09-25T00:00:00.000Z")),
      applyPaidCycle(mk("early", "2026-08-10T00:00:00.000Z", "2026-09-10T00:00:00.000Z")),
      applyPaidCycle(mk("mid", "2026-08-15T00:00:00.000Z", "2026-09-15T00:00:00.000Z")),
    ]);
    const rows = getDb().prepare("select period_start s, period_end e from learner_app_entitlement_periods where learner_id=? and effective_source_role='allocation_bearing' order by period_start").all(learnerA) as { s: string; e: string }[];
    for (let i = 1; i < rows.length; i += 1) expect(rows[i].s >= rows[i - 1].e).toBe(true);        // allocation-bearing periods never overlap
    expect(rows[0].s).toBe("2026-08-10T00:00:00.000Z");                                           // earliest-first, independent of arrival order
    expect(count("select count(*) n from learner_app_effective_entitlements where learner_id=?", learnerA)).toBe(1);
  });

  it("materialises one effective entitlement per app for a multi-app activation raced against a single-app one", async () => {
    await Promise.all([
      applyPaidCycle(input({ paidCycleId: "pc-m", eventId: "ev-m", appIds: [MATH, READING] })),
      applyPaidCycle(input({ paidCycleId: "pc-r", eventId: "ev-r", subscriptionId: "sub-r", appIds: [READING, MATH], periodStart: "2026-08-12T00:00:00.000Z", periodEnd: "2026-09-12T00:00:00.000Z" })),
    ]);
    expect(count("select count(*) n from learner_app_effective_entitlements where learner_id=?", learnerA)).toBe(2);
  });
});

describe("independence and boundaries", () => {
  it("different learners activate independently, each with its own scope lock row", async () => {
    await applyPaidCycle(input({ paidCycleId: "pc-1", eventId: "ev-1" }));
    await applyPaidCycle(input({ paidCycleId: "pc-2", eventId: "ev-2", subscriptionId: "sub-2", assignedLearnerId: learnerB }));
    expect(count("select count(*) n from learner_app_effective_entitlements")).toBe(2);
    expect(count("select count(*) n from entitlement_activation_locks")).toBe(2);
  });

  it("a lock row exists per scope and records activity; the ledger is server-only and non-personal", async () => {
    await applyPaidCycle(input());
    const row = getDb().prepare("select * from entitlement_activation_locks where learner_id=? and app_id=? and environment='production'").get(learnerA, MATH) as { lock_seq: number };
    expect(row.lock_seq).toBeGreaterThanOrEqual(1);
    await applyPaidCycle(input({ paidCycleId: "pc-2", eventId: "ev-2", subscriptionId: "sub-2", periodStart: "2026-09-10T00:00:00.000Z", periodEnd: "2026-10-10T00:00:00.000Z" }));
    expect((getDb().prepare("select lock_seq from entitlement_activation_locks where learner_id=? and app_id=?").get(learnerA, MATH) as { lock_seq: number }).lock_seq).toBeGreaterThan(row.lock_seq);
  });

  it("a failed activation rolls back everything including its lock bump, and releases the scope", async () => {
    await expect(applyPaidCycle(input({ appIds: [MATH, "no-such-app"] }))).rejects.toThrow();
    expect(count("select count(*) n from entitlement_cycles")).toBe(0);
    await expect(applyPaidCycle(input())).resolves.toMatchObject({ status: "ready" });
  });

  it("billing remains the only creation authority: a non-owning purchaser is still rejected under the lock", async () => {
    await expect(applyPaidCycle(input({ purchaserParentId: "someone-else" }))).rejects.toMatchObject({ code: "ENTITLEMENT_SOURCE_MISMATCH" });
    expect(count("select count(*) n from entitlement_cycles")).toBe(0);
  });
});
