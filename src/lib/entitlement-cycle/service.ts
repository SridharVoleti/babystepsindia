import { randomUUID, createHash } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { recomputeEffectiveEntitlement, type EffectiveSourceRole } from "@/lib/entitlement-access/service";
import { ensureEntitlementPeriodStandardAllocation } from "@/lib/session-credit-standard/service";

export class EntitlementCycleError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "EntitlementCycleError"; }
}

export type ApplyPaidCycleInput = {
  paidCycleId: string; eventId: string; eventVersion: number;
  subscriptionId: string; purchaserParentId: string; assignedLearnerId: string;
  productId: string; productVersion: number; appIds: string[];
  periodStart: string; periodEnd: string; billingAnchor: string;
  environment: string; now: Date;
};

export type AppPeriodResult = {
  appId: string; periodId: string; role: EffectiveSourceRole;
  effectiveEntitlementId: string; standardCreditBatchId: string | null;
};

export type ApplyPaidCycleResult = { cycleId: string; status: "ready"; appPeriods: AppPeriodResult[] };

// GAP-085/098: calendar-months between two instants, by month index alone
// (not day count) — Jan 31 -> Feb 28 is exactly 1 month, the same as
// Jan 31 -> Feb 29 would be, regardless of how many raw days apart they are.
export function calendarMonthsBetween(startIso: string, endIso: string): number {
  const start = new Date(startIso); const end = new Date(endIso);
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
}

// Adds whole calendar months to `baseIso`, landing on `anchorDay` in the
// target month when possible — clamped to that month's actual last day,
// never carrying the clamp forward (business rule 23's "rollover" example:
// a Jan-31 anchor clamped to Feb 28 restores to Mar 31 the following month,
// rather than drifting to Feb 28 + 28 days = Mar 28).
export function addCalendarMonthsClamped(baseIso: string, months: number, anchorDay: number): string {
  const base = new Date(baseIso);
  const monthIndex = base.getUTCFullYear() * 12 + base.getUTCMonth() + months;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = monthIndex % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(anchorDay, daysInTargetMonth);
  return new Date(Date.UTC(targetYear, targetMonth, day, base.getUTCHours(), base.getUTCMinutes(),
    base.getUTCSeconds(), base.getUTCMilliseconds())).toISOString();
}

// EN-001 business rules 1-24, 33-42, 51-55: pure event consumer. BI-002 now
// invokes this in-process after verified initial-payment and renewal events;
// the internal route remains available to other trusted producers. Every
// caller supplies the full well-formed paid-cycle event and immutable app-id snapshot
// (there is no bundle catalog to re-derive it from either). Grace/
// cancellation/catalog-versioning overlays (rules 25-32) are intentionally
// not implemented — nothing produces those events yet.
// EN-004 rule 8: exported so reconciliation can compute the exact same
// immutable-identity hash from a freshly-loaded verified source and compare
// it against an existing entitlement_cycles.source_event_hash, without
// duplicating (and risking drift from) this canonicalization.
export function computeEntitlementCycleSourceHash(input: {
  paidCycleId: string; subscriptionId: string; assignedLearnerId: string; productId: string;
  productVersion: number; appIds: string[]; periodStart: string; periodEnd: string; billingAnchor: string;
}): string {
  const canonical = JSON.stringify({
    paidCycleId: input.paidCycleId, subscriptionId: input.subscriptionId,
    assignedLearnerId: input.assignedLearnerId, productId: input.productId, productVersion: input.productVersion,
    appIds: [...input.appIds].sort(), periodStart: input.periodStart, periodEnd: input.periodEnd,
    billingAnchor: input.billingAnchor,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function applyPaidCycle(input: ApplyPaidCycleInput): ApplyPaidCycleResult {
  const db = getDb();
  if (input.appIds.length === 0) throw new EntitlementCycleError("ENTITLEMENT_APP_CONFIGURATION_INVALID");
  if (new Date(input.periodEnd).getTime() <= new Date(input.periodStart).getTime()) {
    throw new EntitlementCycleError("INVALID_ENTITLEMENT_CONTEXT");
  }

  const hash = computeEntitlementCycleSourceHash(input);

  const receipt = db.prepare(
    "select request_hash,result_json from entitlement_application_receipts where paid_cycle_id=? and event_id=?",
  ).get(input.paidCycleId, input.eventId) as { request_hash: string; result_json: string } | undefined;
  if (receipt) {
    if (receipt.request_hash !== hash) throw new EntitlementCycleError("IDEMPOTENCY_KEY_REUSED");
    return JSON.parse(receipt.result_json) as ApplyPaidCycleResult;
  }

  const learner = db.prepare("select owner_parent_id from learners where id=?").get(input.assignedLearnerId) as
    { owner_parent_id: string } | undefined;
  // GAP-095: the learner must actually belong to whoever paid for the
  // cycle — without this, any paid-cycle event naming an arbitrary
  // assignedLearnerId could grant entitlement to a learner its purchaser
  // doesn't own.
  if (!learner || learner.owner_parent_id !== input.purchaserParentId) {
    throw new EntitlementCycleError("ENTITLEMENT_SOURCE_MISMATCH");
  }

  for (const appId of input.appIds) {
    const app = db.prepare("select registry_status from app_registry where id=?").get(appId) as
      { registry_status: string } | undefined;
    if (!app || app.registry_status !== "active") throw new EntitlementCycleError("ENTITLEMENT_APP_CONFIGURATION_INVALID");
  }

  // Business rule 36/AC27: a different event touching an already-applied
  // paid_cycle_id (not caught by the exact-replay check above, since the
  // event_id differs) is a conflicting duplicate, quarantined rather than applied.
  const existingCycle = db.prepare("select id from entitlement_cycles where paid_cycle_id=?").get(input.paidCycleId) as
    { id: string } | undefined;
  if (existingCycle) throw new EntitlementCycleError("PAID_CYCLE_CONFLICT");

  const timestamp = input.now.toISOString();
  const cycleId = randomUUID();
  // Business rule 23: batch expiry preserves SC-002's one-cycle rollover —
  // one more cycle beyond this cycle's own end, computed from the verified
  // period dates so it doesn't depend on a future event arriving. GAP-085/
  // 098: this must be a calendar-anchor-based following-cycle boundary, not
  // duration-in-milliseconds arithmetic — adding raw days breaks the moment
  // periodStart/periodEnd straddle months of different lengths (e.g. a
  // Jan-31 anchored cycle ending Feb 28 must roll to Mar 31, not Mar 28).
  const cycleMonths = Math.max(1, calendarMonthsBetween(input.periodStart, input.periodEnd));
  const anchorDay = new Date(input.billingAnchor).getUTCDate();
  const batchExpiresAt = addCalendarMonthsClamped(input.periodEnd, cycleMonths, anchorDay);

  const run = db.transaction((): ApplyPaidCycleResult => {
    db.prepare(
      `insert into entitlement_cycles(id,paid_cycle_id,subscription_id,purchaser_parent_id,assigned_learner_id,
       product_id,product_version,app_ids_json,period_start,period_end,billing_anchor,status,
       source_event_id,source_event_version,source_event_hash,created_at,ready_at,version)
       values(?,?,?,?,?,?,?,?,?,?,?,'ready',?,?,?,?,?,1)`,
    ).run(cycleId, input.paidCycleId, input.subscriptionId, input.purchaserParentId, input.assignedLearnerId,
      input.productId, input.productVersion, JSON.stringify(input.appIds), input.periodStart, input.periodEnd,
      input.billingAnchor, input.eventId, input.eventVersion, hash, timestamp, timestamp);

    const appPeriods: AppPeriodResult[] = [];
    for (const appId of input.appIds) {
      const periodId = randomUUID();
      db.prepare(
        `insert into learner_app_entitlement_periods(id,entitlement_cycle_id,subscription_id,learner_id,app_id,
         product_version,period_start,period_end,status,effective_source_role,created_at)
         values(?,?,?,?,?,?,?,?,'ready','access_supporting',?)`,
      ).run(periodId, cycleId, input.subscriptionId, input.assignedLearnerId, appId,
        input.productVersion, input.periodStart, input.periodEnd, timestamp);

      const { effectiveEntitlementId, roleById } = recomputeEffectiveEntitlement({
        learnerId: input.assignedLearnerId, appId, environment: input.environment, now: input.now,
      });
      const role = roleById.get(periodId)!;

      let standardCreditBatchId: string | null = null;
      // Business rules 52-53: only the allocation-bearing role creates a
      // recurring batch; access-supporting/overlap-suppressed periods retain
      // immutable source history but never a second batch.
      if (role === "allocation_bearing") {
        const batch = ensureEntitlementPeriodStandardAllocation(
          input.assignedLearnerId, appId, periodId, input.periodStart, batchExpiresAt, input.now,
        );
        standardCreditBatchId = batch.id;
        db.prepare("update learner_app_entitlement_periods set standard_credit_batch_id=? where id=?")
          .run(standardCreditBatchId, periodId);
      }
      appPeriods.push({ appId, periodId, role, effectiveEntitlementId, standardCreditBatchId });
    }

    const result: ApplyPaidCycleResult = { cycleId, status: "ready", appPeriods };
    db.prepare(
      `insert into entitlement_application_receipts(paid_cycle_id,event_id,request_hash,result_json,status,created_at)
       values(?,?,?,?,'ready',?)`,
    ).run(input.paidCycleId, input.eventId, hash, JSON.stringify(result), timestamp);
    return result;
  });
  return run();
}
