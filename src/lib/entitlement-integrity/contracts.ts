// EN-004: pure, DB-free classification rules. These functions only compare
// already-loaded snapshots and never open a database connection — the
// repair/incident layer (repair.ts, incidents.ts, sweep.ts) is responsible
// for loading the real rows and acting on the classification returned here.

export type GapCategory =
  | "MISSING_ENTITLEMENT" | "INCOMPLETE_ENTITLEMENT"
  | "PRODUCT_SNAPSHOT_MISMATCH" | "LEARNER_MISMATCH" | "PERIOD_MISMATCH"
  | "SOURCE_HASH_MISMATCH" | "APP_SET_MISMATCH"
  | "ENTITLEMENT_WITHOUT_VERIFIED_SOURCE"
  | "MISSING_EFFECTIVE_ENTITLEMENT" | "MISSING_LIFECYCLE_EVENT"
  | "MISSING_ALLOCATION_BATCH" | "EXTRA_BATCH_UNKNOWN_SOURCE" | "BATCH_ATTRIBUTE_MISMATCH";

export type PaidCycleGapClassification = "healthy" | "repairable" | "conflict";

export type VerifiedPaidCycleSourceSnapshot = {
  paidCycleId: string; subscriptionId: string; learnerId: string;
  productId: string; productVersion: number; appIds: string[];
  periodStart: string; periodEnd: string; billingAnchor: string;
  sourceHash: string;
};

export type EntitlementCycleTargetSnapshot = {
  status: "creating" | "ready" | "failed";
  learnerId: string; productId: string; productVersion: number; appIds: string[];
  periodStart: string; periodEnd: string; billingAnchor: string;
  sourceHash: string;
};

function sortedEqual(a: string[], b: string[]): boolean {
  const sa = [...a].sort(); const sb = [...b].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
}

// Rules 9-11, 21-22: no target at all or a genuinely incomplete one is
// repairable through the same EN-001 function normal processing uses;
// an existing 'ready' target that disagrees with verified Billing on any
// immutable identity is a conflict, never silently rewritten. Fields are
// compared in a fixed, documented order so a divergence is always reported
// under one deterministic category rather than whichever happened to be
// checked last.
export function classifyPaidCycleGap(
  source: VerifiedPaidCycleSourceSnapshot,
  target: EntitlementCycleTargetSnapshot | null,
): { classification: PaidCycleGapClassification; category: GapCategory | null } {
  if (!target) return { classification: "repairable", category: "MISSING_ENTITLEMENT" };
  if (target.status === "creating" || target.status === "failed") {
    return { classification: "repairable", category: "INCOMPLETE_ENTITLEMENT" };
  }
  if (target.learnerId !== source.learnerId) return { classification: "conflict", category: "LEARNER_MISMATCH" };
  if (target.periodStart !== source.periodStart || target.periodEnd !== source.periodEnd) {
    return { classification: "conflict", category: "PERIOD_MISMATCH" };
  }
  if (target.productId !== source.productId || target.productVersion !== source.productVersion) {
    return { classification: "conflict", category: "PRODUCT_SNAPSHOT_MISMATCH" };
  }
  if (!sortedEqual(target.appIds, source.appIds)) return { classification: "conflict", category: "APP_SET_MISMATCH" };
  if (target.sourceHash !== source.sourceHash) return { classification: "conflict", category: "SOURCE_HASH_MISMATCH" };
  return { classification: "healthy", category: null };
}

export type AllocationBearingPeriodSnapshot = {
  periodId: string; role: "allocation_bearing" | "access_supporting" | "overlap_suppressed";
  periodStart: string; expiresAt: string;
};

export type CreditBatchSnapshot = {
  entitlementPeriodId: string; grantedCount: number; effectiveAt: string; expiresAt: string;
  reservedCount: number; consumedCount: number;
};

// Rules 34-35, 37-38: only an allocation-bearing period requires exactly one
// SC-002 batch. A mismatch against the frozen allocation policy (dates,
// granted_count) is never silently edited — even without prior usage, since
// nothing in this spec describes an "auto-correct batch attributes" repair
// action — it enters incident review instead (rule 38).
export function classifyBatchConsistency(
  period: AllocationBearingPeriodSnapshot,
  batch: CreditBatchSnapshot | null,
): { classification: "not_applicable" | "healthy" | "missing" | "conflict"; category: GapCategory | null } {
  if (period.role !== "allocation_bearing") return { classification: "not_applicable", category: null };
  if (!batch) return { classification: "missing", category: "MISSING_ALLOCATION_BATCH" };
  if (batch.entitlementPeriodId !== period.periodId || batch.grantedCount !== 8 ||
    batch.effectiveAt !== period.periodStart || batch.expiresAt !== period.expiresAt) {
    return { classification: "conflict", category: "BATCH_ATTRIBUTE_MISMATCH" };
  }
  return { classification: "healthy", category: null };
}

// Rule 31: the opposite traversal direction from classifyPaidCycleGap —
// starts from an already-'ready' target and asks whether a verified source
// backs it, rather than starting from a verified source and asking whether
// a target exists. Only meaningful for a 'ready' cycle; a 'creating'/'failed'
// cycle is classifyPaidCycleGap's concern, not this one.
export function classifyOrphanEntitlement(
  cycle: { status: "creating" | "ready" | "failed" },
  verifiedSourceExists: boolean,
): { classification: "healthy" | "quarantine"; category: GapCategory | null } {
  if (cycle.status === "ready" && !verifiedSourceExists) {
    return { classification: "quarantine", category: "ENTITLEMENT_WITHOUT_VERIFIED_SOURCE" };
  }
  return { classification: "healthy", category: null };
}

const AUTO_REPAIRABLE_CATEGORIES: GapCategory[] = [
  "MISSING_ENTITLEMENT", "INCOMPLETE_ENTITLEMENT", "MISSING_EFFECTIVE_ENTITLEMENT",
  "MISSING_ALLOCATION_BATCH", "MISSING_LIFECYCLE_EVENT",
];

// Rule: a discrepancy flagged as fraud/security risk (e.g. a missed
// security_revoked lifecycle event) is always critical regardless of which
// category it was otherwise classified under — mirrors EN-003's own
// fraudOrSecurityRisk override in resolveTransitionEffect.
export function severityForCategory(
  category: GapCategory,
  opts: { fraudOrSecurityRisk?: boolean },
): "low" | "medium" | "high" | "critical" {
  if (opts.fraudOrSecurityRisk) return "critical";
  return AUTO_REPAIRABLE_CATEGORIES.includes(category) ? "medium" : "high";
}
