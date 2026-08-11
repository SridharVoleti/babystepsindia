import { describe, expect, it } from "vitest";
import {
  classifyPaidCycleGap,
  classifyBatchConsistency,
  classifyOrphanEntitlement,
  severityForCategory,
  type VerifiedPaidCycleSourceSnapshot,
  type EntitlementCycleTargetSnapshot,
} from "@/lib/entitlement-integrity/contracts";

function source(overrides: Partial<VerifiedPaidCycleSourceSnapshot> = {}): VerifiedPaidCycleSourceSnapshot {
  return {
    paidCycleId: "bp-1", subscriptionId: "sub-1", learnerId: "learner-1",
    productId: "product-1", productVersion: 1, appIds: ["app-1"],
    periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z",
    billingAnchor: "2026-08-01T00:00:00.000Z", sourceHash: "hash-a",
    ...overrides,
  };
}

function target(overrides: Partial<EntitlementCycleTargetSnapshot> = {}): EntitlementCycleTargetSnapshot {
  return {
    status: "ready", learnerId: "learner-1", productId: "product-1", productVersion: 1,
    appIds: ["app-1"], periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-09-01T00:00:00.000Z",
    billingAnchor: "2026-08-01T00:00:00.000Z", sourceHash: "hash-a",
    ...overrides,
  };
}

describe("classifyPaidCycleGap", () => {
  it("rule 9: exact match is healthy with no category", () => {
    expect(classifyPaidCycleGap(source(), target())).toEqual({ classification: "healthy", category: null });
  });

  it("rule 10: no entitlement_cycle at all is repairable as MISSING_ENTITLEMENT", () => {
    expect(classifyPaidCycleGap(source(), null)).toEqual({ classification: "repairable", category: "MISSING_ENTITLEMENT" });
  });

  it("rule 11: status creating is repairable as INCOMPLETE_ENTITLEMENT", () => {
    expect(classifyPaidCycleGap(source(), target({ status: "creating" })))
      .toEqual({ classification: "repairable", category: "INCOMPLETE_ENTITLEMENT" });
  });

  it("rule 11: status failed is repairable as INCOMPLETE_ENTITLEMENT", () => {
    expect(classifyPaidCycleGap(source(), target({ status: "failed" })))
      .toEqual({ classification: "repairable", category: "INCOMPLETE_ENTITLEMENT" });
  });

  it("rule 22: learner mismatch is a conflict", () => {
    expect(classifyPaidCycleGap(source(), target({ learnerId: "learner-2" })))
      .toEqual({ classification: "conflict", category: "LEARNER_MISMATCH" });
  });

  it("rule 22: period boundary mismatch is a conflict", () => {
    expect(classifyPaidCycleGap(source(), target({ periodEnd: "2026-09-15T00:00:00.000Z" })))
      .toEqual({ classification: "conflict", category: "PERIOD_MISMATCH" });
  });

  it("rule 21/22: product snapshot mismatch is a conflict, not silently rewritten", () => {
    expect(classifyPaidCycleGap(source(), target({ productVersion: 2 })))
      .toEqual({ classification: "conflict", category: "PRODUCT_SNAPSHOT_MISMATCH" });
  });

  it("rule 22: app-set mismatch is a conflict", () => {
    expect(classifyPaidCycleGap(source(), target({ appIds: ["app-1", "app-2"] })))
      .toEqual({ classification: "conflict", category: "APP_SET_MISMATCH" });
  });

  it("rule 8/22: any other hash divergence (e.g. billing anchor) is a conflict", () => {
    expect(classifyPaidCycleGap(source(), target({ billingAnchor: "2026-08-02T00:00:00.000Z", sourceHash: "hash-b" })))
      .toEqual({ classification: "conflict", category: "SOURCE_HASH_MISMATCH" });
  });
});

describe("classifyBatchConsistency", () => {
  const period = { periodId: "period-1", role: "allocation_bearing" as const,
    periodStart: "2026-08-01T00:00:00.000Z", expiresAt: "2026-10-01T00:00:00.000Z" };

  it("rule 34-35: no batch at all for an allocation-bearing period is missing", () => {
    expect(classifyBatchConsistency(period, null)).toEqual({ classification: "missing", category: "MISSING_ALLOCATION_BATCH" });
  });

  it("rule 34: access-supporting periods never require a batch", () => {
    expect(classifyBatchConsistency({ ...period, role: "access_supporting" }, null))
      .toEqual({ classification: "not_applicable", category: null });
  });

  it("rule 9: a batch matching the frozen policy exactly is healthy", () => {
    const batch = { entitlementPeriodId: "period-1", grantedCount: 8, effectiveAt: period.periodStart,
      expiresAt: period.expiresAt, reservedCount: 2, consumedCount: 1 };
    expect(classifyBatchConsistency(period, batch)).toEqual({ classification: "healthy", category: null });
  });

  it("rule 37-38: mismatched dates enter incident review, not silent edit", () => {
    const batch = { entitlementPeriodId: "period-1", grantedCount: 8, effectiveAt: "2026-08-05T00:00:00.000Z",
      expiresAt: period.expiresAt, reservedCount: 0, consumedCount: 0 };
    expect(classifyBatchConsistency(period, batch)).toEqual({ classification: "conflict", category: "BATCH_ATTRIBUTE_MISMATCH" });
  });

  it("rule 37-38: mismatched granted_count enters incident review even with prior usage preserved", () => {
    const batch = { entitlementPeriodId: "period-1", grantedCount: 8, effectiveAt: period.periodStart,
      expiresAt: "2026-11-01T00:00:00.000Z", reservedCount: 3, consumedCount: 2 };
    expect(classifyBatchConsistency(period, batch)).toEqual({ classification: "conflict", category: "BATCH_ATTRIBUTE_MISMATCH" });
  });
});

describe("classifyOrphanEntitlement", () => {
  it("rule 31: a ready cycle with no verified source is quarantined", () => {
    expect(classifyOrphanEntitlement({ status: "ready" }, false))
      .toEqual({ classification: "quarantine", category: "ENTITLEMENT_WITHOUT_VERIFIED_SOURCE" });
  });

  it("rule 9: a ready cycle with a verified source is healthy", () => {
    expect(classifyOrphanEntitlement({ status: "ready" }, true)).toEqual({ classification: "healthy", category: null });
  });

  it("a non-ready cycle is not orphan-checked here (handled by classifyPaidCycleGap instead)", () => {
    expect(classifyOrphanEntitlement({ status: "creating" }, false)).toEqual({ classification: "healthy", category: null });
  });
});

describe("severityForCategory", () => {
  it("rule: any fraud/security-risk gap is always critical regardless of category", () => {
    expect(severityForCategory("MISSING_ENTITLEMENT", { fraudOrSecurityRisk: true })).toBe("critical");
    expect(severityForCategory("BATCH_ATTRIBUTE_MISMATCH", { fraudOrSecurityRisk: true })).toBe("critical");
  });

  it("auto-repairable gaps default to medium severity", () => {
    expect(severityForCategory("MISSING_ENTITLEMENT", {})).toBe("medium");
    expect(severityForCategory("INCOMPLETE_ENTITLEMENT", {})).toBe("medium");
    expect(severityForCategory("MISSING_EFFECTIVE_ENTITLEMENT", {})).toBe("medium");
    expect(severityForCategory("MISSING_ALLOCATION_BATCH", {})).toBe("medium");
    expect(severityForCategory("MISSING_LIFECYCLE_EVENT", {})).toBe("medium");
  });

  it("genuine conflicts default to high severity", () => {
    expect(severityForCategory("PRODUCT_SNAPSHOT_MISMATCH", {})).toBe("high");
    expect(severityForCategory("LEARNER_MISMATCH", {})).toBe("high");
    expect(severityForCategory("PERIOD_MISMATCH", {})).toBe("high");
    expect(severityForCategory("SOURCE_HASH_MISMATCH", {})).toBe("high");
    expect(severityForCategory("APP_SET_MISMATCH", {})).toBe("high");
    expect(severityForCategory("BATCH_ATTRIBUTE_MISMATCH", {})).toBe("high");
    expect(severityForCategory("EXTRA_BATCH_UNKNOWN_SOURCE", {})).toBe("high");
    expect(severityForCategory("ENTITLEMENT_WITHOUT_VERIFIED_SOURCE", {})).toBe("high");
  });
});
