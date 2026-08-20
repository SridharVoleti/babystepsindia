import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { applyPaidCycle, EntitlementCycleError, type ApplyPaidCycleInput } from "@/lib/entitlement-cycle/service";

const mathAppId = "math-app";
const readingAppId = "reading-app";
let parentId: string;
let learnerId: string;

function seedApp(id: string, name: string) {
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(id, id, name);
}

beforeEach(async () => {
  useInMemoryDb();
  seedApp(mathAppId, "Math App");
  seedApp(readingAppId, "Reading App");
  const { user } = await sqliteAuthAdapter.signUp("entitlement-parent@example.com", "CorrectHorse1!");
  parentId = user.id;
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: "20000000-0000-4000-8000-000000000001" }, "2026-08-01")).learner.id;
});

function baseInput(overrides: Partial<ApplyPaidCycleInput> = {}): ApplyPaidCycleInput {
  return {
    paidCycleId: "cycle-1", eventId: "event-1", eventVersion: 1,
    subscriptionId: "sub-1", purchaserParentId: parentId, assignedLearnerId: learnerId,
    productId: "product-1", productVersion: 1, appIds: [mathAppId],
    periodStart: "2026-08-10T00:00:00.000Z", periodEnd: "2026-09-10T00:00:00.000Z",
    billingAnchor: "2026-08-10", environment: "production", now: new Date("2026-08-10T00:05:00.000Z"),
    ...overrides,
  };
}

describe("EN-001 applyPaidCycle", () => {
  it("creates a ready entitlement cycle, one allocation-bearing period and one 8-credit batch (AC1,AC4,AC10,AC12,AC16-18)", () => {
    const result = applyPaidCycle(baseInput());
    expect(result.status).toBe("ready");
    expect(result.appPeriods).toHaveLength(1);
    expect(result.appPeriods[0]).toMatchObject({ appId: mathAppId, role: "allocation_bearing" });
    expect(result.appPeriods[0].standardCreditBatchId).not.toBeNull();

    const period = getDb().prepare("select * from learner_app_entitlement_periods where id=?")
      .get(result.appPeriods[0].periodId) as Record<string, unknown>;
    expect(period).toMatchObject({
      learner_id: learnerId, app_id: mathAppId, period_start: "2026-08-10T00:00:00.000Z",
      period_end: "2026-09-10T00:00:00.000Z", status: "ready", effective_source_role: "allocation_bearing",
    });

    const batch = getDb().prepare("select * from learner_app_standard_credit_batches where entitlement_period_id=?")
      .get(period.id) as Record<string, unknown>;
    expect(batch).toMatchObject({ granted_count: 8, reserved_count: 0, consumed_count: 0,
      effective_at: "2026-08-10T00:00:00.000Z", allocation_month: null });
    // AC19/GAP-085/098: one-cycle rollover — expires on the billing-anchor
    // day (10th) one calendar month beyond this cycle's own end, not 31
    // raw days later (which would drift to the 11th).
    expect(batch.expires_at).toBe("2026-10-10T00:00:00.000Z");
  });

  it("GAP-085/098: a short-month clamp restores to the full anchor day the following month", () => {
    // Billing anchor is the 31st; Jan 31 -> Feb 28 (Feb has no 31st, so the
    // cycle itself is clamped). The batch created from that cycle must
    // still roll forward to Mar 31 — not Feb 28 + 28 raw days = Mar 28.
    const result = applyPaidCycle(baseInput({
      periodStart: "2026-01-31T00:00:00.000Z", periodEnd: "2026-02-28T00:00:00.000Z",
      billingAnchor: "2026-01-31", now: new Date("2026-01-31T00:05:00.000Z"),
    }));
    const batch = getDb().prepare("select expires_at from learner_app_standard_credit_batches where entitlement_period_id=?")
      .get(result.appPeriods[0].periodId) as { expires_at: string };
    expect(batch.expires_at).toBe("2026-03-31T00:00:00.000Z");
  });

  it("no calendar-month proration — period matches the exact event dates, not month boundaries (AC7-9)", () => {
    const result = applyPaidCycle(baseInput({ periodStart: "2026-08-10T00:00:00.000Z", periodEnd: "2026-09-10T00:00:00.000Z" }));
    const period = getDb().prepare("select period_start,period_end from learner_app_entitlement_periods where id=?")
      .get(result.appPeriods[0].periodId);
    expect(period).toEqual({ period_start: "2026-08-10T00:00:00.000Z", period_end: "2026-09-10T00:00:00.000Z" });
  });

  it("a bundle grants the exact snapshot apps, each with an independent batch and no shared pool (AC5,AC6,AC13-15)", () => {
    const result = applyPaidCycle(baseInput({ appIds: [mathAppId, readingAppId] }));
    expect(result.appPeriods).toHaveLength(2);
    for (const p of result.appPeriods) {
      expect(p.role).toBe("allocation_bearing");
      expect(p.standardCreditBatchId).not.toBeNull();
    }
    const batchIds = result.appPeriods.map((p) => p.standardCreditBatchId);
    expect(new Set(batchIds).size).toBe(2);
    const learners = new Set(getDb().prepare("select distinct learner_id from learner_app_entitlement_periods where entitlement_cycle_id=?")
      .all(result.cycleId).map((r: any) => r.learner_id));
    expect(learners.size).toBe(1);
  });

  it("exact duplicate event is idempotent — returns the original result, creates nothing new (AC26)", () => {
    const first = applyPaidCycle(baseInput());
    const cycleCountBefore = (getDb().prepare("select count(*) n from entitlement_cycles").get() as { n: number }).n;
    const second = applyPaidCycle(baseInput());
    expect(second).toEqual(first);
    const cycleCountAfter = (getDb().prepare("select count(*) n from entitlement_cycles").get() as { n: number }).n;
    expect(cycleCountAfter).toBe(cycleCountBefore);
  });

  it("a conflicting duplicate for the same paid_cycle_id under a different event is rejected (AC27)", () => {
    applyPaidCycle(baseInput());
    expect(() => applyPaidCycle(baseInput({ eventId: "event-2", appIds: [mathAppId, readingAppId] })))
      .toThrow(EntitlementCycleError);
  });

  it("an inactive/unknown app in the snapshot is rejected and creates nothing (error flow)", () => {
    expect(() => applyPaidCycle(baseInput({ appIds: ["nonexistent-app"] }))).toThrow(EntitlementCycleError);
    expect((getDb().prepare("select count(*) n from entitlement_cycles").get() as { n: number }).n).toBe(0);
  });

  it("GAP-095: rejects a paid-cycle event naming a learner the purchaser doesn't own", async () => {
    const { user: otherParent } = await sqliteAuthAdapter.signUp("other-parent@example.com", "CorrectHorse1!");
    expect(() => applyPaidCycle(baseInput({ purchaserParentId: otherParent.id })))
      .toThrow(new EntitlementCycleError("ENTITLEMENT_SOURCE_MISMATCH"));
    expect((getDb().prepare("select count(*) n from entitlement_cycles").get() as { n: number }).n).toBe(0);
  });

  it("a second non-overlapping paid cycle becomes its own allocation-bearing source with its own batch (AC41,AC44)", () => {
    applyPaidCycle(baseInput({ paidCycleId: "cycle-1", eventId: "event-1",
      periodStart: "2026-08-10T00:00:00.000Z", periodEnd: "2026-09-10T00:00:00.000Z" }));
    const second = applyPaidCycle(baseInput({ paidCycleId: "cycle-2", eventId: "event-2",
      periodStart: "2026-09-10T00:00:00.000Z", periodEnd: "2026-10-10T00:00:00.000Z" }));
    expect(second.appPeriods[0].role).toBe("allocation_bearing");
    expect(second.appPeriods[0].standardCreditBatchId).not.toBeNull();
  });

  it("a second overlapping paid cycle for the same learner/app is access-supporting and creates no second batch (AC42)", () => {
    applyPaidCycle(baseInput({ paidCycleId: "cycle-1", eventId: "event-1",
      periodStart: "2026-08-10T00:00:00.000Z", periodEnd: "2026-09-10T00:00:00.000Z" }));
    const second = applyPaidCycle(baseInput({ paidCycleId: "cycle-2", eventId: "event-2",
      periodStart: "2026-08-20T00:00:00.000Z", periodEnd: "2026-09-20T00:00:00.000Z" }));
    expect(second.appPeriods[0].role).toBe("access_supporting");
    expect(second.appPeriods[0].standardCreditBatchId).toBeNull();
    const batchCount = (getDb().prepare("select count(*) n from learner_app_standard_credit_batches where entitlement_period_id is not null").get() as { n: number }).n;
    expect(batchCount).toBe(1);
  });

  it("immutable paid-source history is retained — earlier period rows are never deleted (AC43)", () => {
    applyPaidCycle(baseInput({ paidCycleId: "cycle-1", eventId: "event-1" }));
    applyPaidCycle(baseInput({ paidCycleId: "cycle-2", eventId: "event-2",
      periodStart: "2026-09-10T00:00:00.000Z", periodEnd: "2026-10-10T00:00:00.000Z" }));
    expect((getDb().prepare("select count(*) n from learner_app_entitlement_periods").get() as { n: number }).n).toBe(2);
  });
});
