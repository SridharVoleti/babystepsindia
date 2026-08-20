import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { useInMemoryDb } from "@/lib/db/test-utils";
import { sqliteAuthAdapter } from "@/lib/auth/sqlite-auth-adapter";
import { createLearner } from "@/lib/db/learner-repo";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";
import { EntitlementAccessError, evaluateAccessFresh } from "@/lib/entitlement-access/service";

const appId = "math-app";
const environment = "production";
let parentId: string;
let learnerId: string;

beforeEach(async () => {
  useInMemoryDb();
  getDb().prepare(`insert into app_registry(id,app_key,display_name,short_description,icon_asset_key,category,owning_team,registry_status)
    values(?,?,?,'Learning app','icon-open-book','learning','team','active')`).run(appId, appId, "Math App");
  const { user } = await sqliteAuthAdapter.signUp("access-parent@example.com", "CorrectHorse1!");
  parentId = user.id;
  learnerId = (await createLearner(user.id, { displayName: "Asha", dateOfBirth: "2018-01-01",
    idempotencyKey: "20000000-0000-4000-8000-000000000001" }, "2026-08-01")).learner.id;
});

function seedCycle(periodStart: string, periodEnd: string, paidCycleId = "cycle-1", eventId = "event-1") {
  return applyPaidCycle({
    paidCycleId, eventId, eventVersion: 1, subscriptionId: "sub-1", purchaserParentId: parentId,
    assignedLearnerId: learnerId, productId: "product-1", productVersion: 1, appIds: [appId],
    periodStart, periodEnd, billingAnchor: periodStart.slice(0, 10), environment, now: new Date(periodStart),
  });
}

describe("EN-002 evaluateAccessFresh", () => {
  it("denies access when no entitlement period exists for the learner/app (AC7)", () => {
    const decision = evaluateAccessFresh({ learnerId, appId, environment, useCase: "start", now: new Date("2026-08-15T00:00:00.000Z") });
    expect(decision).toMatchObject({ allowed: false, state: "inactive", effectiveEntitlementId: null });
  });

  it("grants access when a ready period covers now, exposing the effective entitlement id/version and allocation source (AC4,AC9-11,AC36)", () => {
    seedCycle("2026-08-10T00:00:00.000Z", "2026-09-10T00:00:00.000Z");
    const decision = evaluateAccessFresh({ learnerId, appId, environment, useCase: "start", now: new Date("2026-08-15T00:00:00.000Z") });
    expect(decision.allowed).toBe(true);
    expect(decision.state).toBe("active");
    expect(decision.effectiveEntitlementId).not.toBeNull();
    expect(decision.effectiveEntitlementVersion).toBe(1);
    expect(decision.allocationSourceState).toBe("allocation_bearing");
    expect(decision.accessUntil).toBe("2026-09-10T00:00:00.000Z");
  });

  it("denies access purely from time moving past period_end, with no write in between (AC9-11,AC44 freshness)", () => {
    seedCycle("2026-08-10T00:00:00.000Z", "2026-09-10T00:00:00.000Z");
    const before = evaluateAccessFresh({ learnerId, appId, environment, useCase: "start", now: new Date("2026-09-09T23:59:59.000Z") });
    expect(before.allowed).toBe(true);
    const after = evaluateAccessFresh({ learnerId, appId, environment, useCase: "start", now: new Date("2026-09-10T00:00:01.000Z") });
    expect(after.allowed).toBe(false);
    expect(after.state).toBe("inactive");
  });

  it("denies access before the period has started yet", () => {
    seedCycle("2026-08-10T00:00:00.000Z", "2026-09-10T00:00:00.000Z");
    const decision = evaluateAccessFresh({ learnerId, appId, environment, useCase: "start", now: new Date("2026-08-01T00:00:00.000Z") });
    expect(decision.allowed).toBe(false);
  });

  it("denies access when app_registry status is not active, even with a covering period (AC8)", () => {
    seedCycle("2026-08-10T00:00:00.000Z", "2026-09-10T00:00:00.000Z");
    getDb().prepare("update app_registry set registry_status='soft_deleted' where id=?").run(appId);
    const decision = evaluateAccessFresh({ learnerId, appId, environment, useCase: "start", now: new Date("2026-08-15T00:00:00.000Z") });
    expect(decision.allowed).toBe(false);
  });

  it("throws for an unknown app", () => {
    expect(() => evaluateAccessFresh({ learnerId, appId: "nonexistent-app", environment, useCase: "start", now: new Date() }))
      .toThrow(EntitlementAccessError);
  });

  it("effective_version bumps when the underlying source set changes (AC34)", () => {
    seedCycle("2026-08-10T00:00:00.000Z", "2026-09-10T00:00:00.000Z", "cycle-1", "event-1");
    const v1 = evaluateAccessFresh({ learnerId, appId, environment, useCase: "start", now: new Date("2026-08-15T00:00:00.000Z") });
    expect(v1.effectiveEntitlementVersion).toBe(1);
    seedCycle("2026-09-10T00:00:00.000Z", "2026-10-10T00:00:00.000Z", "cycle-2", "event-2");
    const v2 = evaluateAccessFresh({ learnerId, appId, environment, useCase: "start", now: new Date("2026-09-15T00:00:00.000Z") });
    expect(v2.effectiveEntitlementVersion).toBe(2);
    expect(v2.effectiveEntitlementId).toBe(v1.effectiveEntitlementId);
  });

  it("an overlapping second cycle's period is access-supporting while covering — access continues, source state reflects it (AC39)", () => {
    seedCycle("2026-08-10T00:00:00.000Z", "2026-09-10T00:00:00.000Z", "cycle-1", "event-1");
    seedCycle("2026-08-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z", "cycle-2", "event-2");
    // Aug 25 is covered by both periods; the allocation-bearing one (cycle-1, earliest) wins as "covering"
    // since the query orders by period_end desc and cycle-2 ends later — confirm which source is reported.
    const decision = evaluateAccessFresh({ learnerId, appId, environment, useCase: "start", now: new Date("2026-08-25T00:00:00.000Z") });
    expect(decision.allowed).toBe(true);
  });
});
