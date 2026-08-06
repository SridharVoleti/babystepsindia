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

// EN-001 business rules 1-24, 33-42, 51-55: pure event consumer — no
// BI-002/BI-005 producer exists in this codebase yet, so the caller (a
// future billing webhook, or a manual/test caller) supplies the full
// well-formed paid-cycle event, including its immutable app-id snapshot
// (there is no bundle catalog to re-derive it from either). Grace/
// cancellation/catalog-versioning overlays (rules 25-32) are intentionally
// not implemented — nothing produces those events yet.
export function applyPaidCycle(input: ApplyPaidCycleInput): ApplyPaidCycleResult {
  const db = getDb();
  if (input.appIds.length === 0) throw new EntitlementCycleError("ENTITLEMENT_APP_CONFIGURATION_INVALID");
  if (new Date(input.periodEnd).getTime() <= new Date(input.periodStart).getTime()) {
    throw new EntitlementCycleError("INVALID_ENTITLEMENT_CONTEXT");
  }

  const canonical = JSON.stringify({
    paidCycleId: input.paidCycleId, subscriptionId: input.subscriptionId,
    assignedLearnerId: input.assignedLearnerId, productId: input.productId, productVersion: input.productVersion,
    appIds: [...input.appIds].sort(), periodStart: input.periodStart, periodEnd: input.periodEnd,
    billingAnchor: input.billingAnchor,
  });
  const hash = createHash("sha256").update(canonical).digest("hex");

  const receipt = db.prepare(
    "select request_hash,result_json from entitlement_application_receipts where paid_cycle_id=? and event_id=?",
  ).get(input.paidCycleId, input.eventId) as { request_hash: string; result_json: string } | undefined;
  if (receipt) {
    if (receipt.request_hash !== hash) throw new EntitlementCycleError("IDEMPOTENCY_KEY_REUSED");
    return JSON.parse(receipt.result_json) as ApplyPaidCycleResult;
  }

  const learner = db.prepare("select id from learners where id=?").get(input.assignedLearnerId);
  if (!learner) throw new EntitlementCycleError("ENTITLEMENT_SOURCE_MISMATCH");

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
  // one more cycle-length beyond this cycle's own end, computed from the
  // verified period dates so it doesn't depend on a future event arriving.
  const cycleLengthMs = new Date(input.periodEnd).getTime() - new Date(input.periodStart).getTime();
  const batchExpiresAt = new Date(new Date(input.periodEnd).getTime() + cycleLengthMs).toISOString();

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
