import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { EntitlementIntegrityError } from "@/lib/entitlement-integrity/errors";
import {
  classifyPaidCycleGap, classifyBatchConsistency, severityForCategory,
  type GapCategory, type VerifiedPaidCycleSourceSnapshot, type EntitlementCycleTargetSnapshot,
} from "@/lib/entitlement-integrity/contracts";
import {
  applyPaidCycle, computeEntitlementCycleSourceHash, calendarMonthsBetween, addCalendarMonthsClamped,
} from "@/lib/entitlement-cycle/service";
import { recomputeEffectiveEntitlement } from "@/lib/entitlement-access/service";
import { ensureEntitlementPeriodStandardAllocation } from "@/lib/session-credit-standard/service";
import { productAppIds } from "@/lib/billing/bi001-service";
import { applyPendingEventById } from "@/lib/entitlement-lifecycle/service";
import { clearLauncherAccessCache } from "@/lib/entitlement-access/launcher-cache";

type BillingPeriodRow = {
  id: string; subscription_id: string; period_start: string; period_end: string;
  status: string; source_provider_event_id: string;
};

type SubscriptionRow = {
  id: string; purchaser_parent_id: string; assigned_learner_id: string; product_id: string;
  product_version: number; version: number; billing_anchor_at: string | null; provider_environment: string;
};

type EntitlementCycleRow = {
  id: string; status: "creating" | "ready" | "failed"; assigned_learner_id: string; product_id: string;
  product_version: number; app_ids_json: string; period_start: string; period_end: string;
  billing_anchor: string; source_event_hash: string;
};

type PeriodRow = {
  id: string; app_id: string; period_start: string; period_end: string;
  effective_source_role: string; standard_credit_batch_id: string | null;
};

type BatchRow = {
  entitlement_period_id: string; granted_count: number; effective_at: string; expires_at: string;
  reserved_count: number; consumed_count: number;
};

// Exported for sweep.ts's own orphan-entitlement pass (rule 31), which
// needs the same receipt/incident bookkeeping without duplicating it.
export function writeReceipt(db: ReturnType<typeof getDb>, r: {
  sourceType: string; sourceId: string; sourceVersion: number | null; sourceHash: string | null;
  expectedTargetHash: string | null; action: "healthy" | "repair" | "defer" | "incident";
  targetType: string | null; targetId: string | null; targetVersion: number | null;
  result: "applied" | "no_op" | "failed"; principalId: string; now: Date;
}) {
  const nowIso = r.now.toISOString();
  db.prepare(
    `insert into entitlement_reconciliation_receipts(id,source_type,source_id,source_version,source_hash,
     expected_target_hash,action,target_type,target_id,target_version,result,attempt_count,principal_id,
     created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)
     on conflict(source_type,source_id,source_version,target_type) do update set
       action=excluded.action, result=excluded.result, source_hash=excluded.source_hash,
       expected_target_hash=excluded.expected_target_hash, target_id=excluded.target_id,
       target_version=excluded.target_version,
       attempt_count=entitlement_reconciliation_receipts.attempt_count+1, updated_at=excluded.updated_at`,
  ).run(randomUUID(), r.sourceType, r.sourceId, r.sourceVersion, r.sourceHash, r.expectedTargetHash,
    r.action, r.targetType, r.targetId, r.targetVersion, r.result, r.principalId, nowIso, nowIso);
}

// Rule 22: exactly one active incident per source record — a repeat
// reconciliation pass against the same still-unresolved conflict updates
// the existing row (attempt_count/version) rather than opening a duplicate.
export function openOrUpdateIncident(db: ReturnType<typeof getDb>, input: {
  environment: string; category: GapCategory; severity: "low" | "medium" | "high" | "critical";
  sourceType: string; sourceId: string; targetType: string | null; targetId: string | null;
  expectedHash: string | null; actualHash: string | null;
}, now: Date): string {
  const existing = db.prepare(
    `select id from entitlement_integrity_incidents where source_type=? and source_id=? and status in ('open','investigating')`,
  ).get(input.sourceType, input.sourceId) as { id: string } | undefined;
  const nowIso = now.toISOString();
  if (existing) {
    db.prepare(
      `update entitlement_integrity_incidents set attempt_count=attempt_count+1, version=version+1, updated_at=? where id=?`,
    ).run(nowIso, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(
    `insert into entitlement_integrity_incidents(id,environment,category,source_type,source_id,target_type,target_id,
     expected_hash,actual_hash,severity,status,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?, 'open',?,?)`,
  ).run(id, input.environment, input.category, input.sourceType, input.sourceId, input.targetType, input.targetId,
    input.expectedHash, input.actualHash, input.severity, nowIso, nowIso);
  return id;
}

export type ReconcilePaidCycleInput = {
  paidCycleId: string; expectedSourceVersion: number; principalId: string; runIdempotencyKey: string; now: Date;
};

export type ReconcilePaidCycleResult = {
  paidCycleId: string; action: "healthy" | "repair" | "defer";
  category: GapCategory | null; entitlementCycleId: string | null;
};

// EN-004 rules 9-22, 34-38: repairs a single paid cycle's entitlement state
// by calling the same applyPaidCycle (EN-001) EN-001's own producer (BI-002)
// uses — never inserting an entitlement_cycles/period/batch row directly.
export function reconcilePaidCycle(input: ReconcilePaidCycleInput): ReconcilePaidCycleResult {
  if (!input.runIdempotencyKey.trim()) throw new EntitlementIntegrityError("INVALID_REQUEST");
  const db = getDb();

  const billingPeriod = db.prepare("select * from billing_periods where id=?").get(input.paidCycleId) as
    BillingPeriodRow | undefined;
  if (!billingPeriod) throw new EntitlementIntegrityError("RESOURCE_NOT_FOUND");
  const subscription = db.prepare("select * from subscriptions where id=?").get(billingPeriod.subscription_id) as SubscriptionRow;
  if (subscription.version !== input.expectedSourceVersion) {
    throw new EntitlementIntegrityError("ENTITLEMENT_INTEGRITY_VERSION_CONFLICT");
  }

  // Rule 59: a source that isn't itself verified/paid is skipped outright —
  // it cannot grant access via reconciliation any more than it could via
  // normal processing.
  if (billingPeriod.status !== "paid") {
    writeReceipt(db, { sourceType: "paid_cycle", sourceId: input.paidCycleId, sourceVersion: input.expectedSourceVersion,
      sourceHash: null, expectedTargetHash: null, action: "defer", targetType: null, targetId: null, targetVersion: null,
      result: "no_op", principalId: input.principalId, now: input.now });
    return { paidCycleId: input.paidCycleId, action: "defer", category: null, entitlementCycleId: null };
  }

  const appIds = productAppIds(subscription.product_id, subscription.product_version);
  const billingAnchor = subscription.billing_anchor_at ?? billingPeriod.period_start;
  const source: VerifiedPaidCycleSourceSnapshot = {
    paidCycleId: input.paidCycleId, subscriptionId: subscription.id, learnerId: subscription.assigned_learner_id,
    productId: subscription.product_id, productVersion: subscription.product_version, appIds,
    periodStart: billingPeriod.period_start, periodEnd: billingPeriod.period_end, billingAnchor,
    sourceHash: computeEntitlementCycleSourceHash({
      paidCycleId: input.paidCycleId, subscriptionId: subscription.id, assignedLearnerId: subscription.assigned_learner_id,
      productId: subscription.product_id, productVersion: subscription.product_version, appIds,
      periodStart: billingPeriod.period_start, periodEnd: billingPeriod.period_end, billingAnchor,
    }),
  };

  const existingCycle = db.prepare("select * from entitlement_cycles where paid_cycle_id=?").get(input.paidCycleId) as
    EntitlementCycleRow | undefined;
  const target: EntitlementCycleTargetSnapshot | null = existingCycle ? {
    status: existingCycle.status, learnerId: existingCycle.assigned_learner_id, productId: existingCycle.product_id,
    productVersion: existingCycle.product_version, appIds: JSON.parse(existingCycle.app_ids_json),
    periodStart: existingCycle.period_start, periodEnd: existingCycle.period_end, billingAnchor: existingCycle.billing_anchor,
    sourceHash: existingCycle.source_event_hash,
  } : null;

  const gap = classifyPaidCycleGap(source, target);

  if (gap.classification === "conflict") {
    const severity = severityForCategory(gap.category!, {});
    openOrUpdateIncident(db, { environment: subscription.provider_environment, category: gap.category!, severity,
      sourceType: "paid_cycle", sourceId: input.paidCycleId, targetType: "entitlement_cycle", targetId: existingCycle!.id,
      expectedHash: source.sourceHash, actualHash: target!.sourceHash }, input.now);
    writeReceipt(db, { sourceType: "paid_cycle", sourceId: input.paidCycleId, sourceVersion: input.expectedSourceVersion,
      sourceHash: source.sourceHash, expectedTargetHash: source.sourceHash, action: "incident",
      targetType: "entitlement_cycle", targetId: existingCycle!.id, targetVersion: null, result: "failed",
      principalId: input.principalId, now: input.now });
    throw new EntitlementIntegrityError("ENTITLEMENT_INTEGRITY_CONFLICT");
  }

  let entitlementCycleId: string;
  let action: "healthy" | "repair" = "healthy";

  if (gap.classification === "repairable") {
    action = "repair";
    // Rule 11/30: applyPaidCycle unconditionally rejects (PAID_CYCLE_CONFLICT)
    // any existing entitlement_cycles row for this paid_cycle_id regardless
    // of status — a 'creating'/'failed' leftover was never completed, so it
    // is not the "immutable source period" rule 30 protects (that refers to
    // a genuinely 'ready' period); reconciliation clears the stuck attempt
    // (and its never-completed dependents) before retrying through EN-001
    // with the original source event and dates, same as a first attempt.
    if (existingCycle) {
      const stalePeriods = db.prepare("select id from learner_app_entitlement_periods where entitlement_cycle_id=?")
        .all(existingCycle.id) as { id: string }[];
      for (const { id } of stalePeriods) {
        db.prepare("update learner_app_entitlement_periods set standard_credit_batch_id=null where id=?").run(id);
        db.prepare("delete from learner_app_standard_credit_batches where entitlement_period_id=?").run(id);
      }
      db.prepare("delete from learner_app_entitlement_periods where entitlement_cycle_id=?").run(existingCycle.id);
      db.prepare("delete from entitlement_cycles where id=?").run(existingCycle.id);
      db.prepare("delete from entitlement_application_receipts where paid_cycle_id=?").run(input.paidCycleId);
    }
    const applied = applyPaidCycle({
      paidCycleId: input.paidCycleId, eventId: billingPeriod.source_provider_event_id, eventVersion: 1,
      subscriptionId: subscription.id, purchaserParentId: subscription.purchaser_parent_id,
      assignedLearnerId: subscription.assigned_learner_id, productId: subscription.product_id,
      productVersion: subscription.product_version, appIds: source.appIds, periodStart: source.periodStart,
      periodEnd: source.periodEnd, billingAnchor: source.billingAnchor, environment: subscription.provider_environment,
      now: input.now,
    });
    entitlementCycleId = applied.cycleId;
  } else {
    entitlementCycleId = existingCycle!.id;
    // Rules 34-35, 37-38: even a healthy cycle's SC-002 batch can go stale
    // independently (e.g. a manual edit) — validate/repair per
    // allocation-bearing period without touching access-supporting ones.
    const periods = db.prepare(
      `select id,app_id,period_start,period_end,effective_source_role,standard_credit_batch_id
       from learner_app_entitlement_periods where entitlement_cycle_id=?`,
    ).all(existingCycle!.id) as PeriodRow[];
    const cycleMonths = Math.max(1, calendarMonthsBetween(source.periodStart, source.periodEnd));
    const anchorDay = new Date(source.billingAnchor).getUTCDate();
    const expectedExpiresAt = addCalendarMonthsClamped(source.periodEnd, cycleMonths, anchorDay);

    for (const p of periods) {
      if (p.effective_source_role !== "allocation_bearing") continue;
      const batch = p.standard_credit_batch_id
        ? db.prepare(
            `select entitlement_period_id,granted_count,effective_at,expires_at,reserved_count,consumed_count
             from learner_app_standard_credit_batches where id=?`,
          ).get(p.standard_credit_batch_id) as BatchRow | undefined
        : db.prepare(
            `select entitlement_period_id,granted_count,effective_at,expires_at,reserved_count,consumed_count
             from learner_app_standard_credit_batches where entitlement_period_id=?`,
          ).get(p.id) as BatchRow | undefined;
      const batchGap = classifyBatchConsistency(
        { periodId: p.id, role: "allocation_bearing", periodStart: p.period_start, expiresAt: expectedExpiresAt },
        batch ? { entitlementPeriodId: batch.entitlement_period_id, grantedCount: batch.granted_count,
          effectiveAt: batch.effective_at, expiresAt: batch.expires_at, reservedCount: batch.reserved_count,
          consumedCount: batch.consumed_count } : null,
      );
      if (batchGap.classification === "missing") {
        const created = ensureEntitlementPeriodStandardAllocation(
          subscription.assigned_learner_id, p.app_id, p.id, p.period_start, expectedExpiresAt, input.now,
        );
        db.prepare("update learner_app_entitlement_periods set standard_credit_batch_id=? where id=?").run(created.id, p.id);
        action = "repair";
      } else if (batchGap.classification === "conflict") {
        const severity = severityForCategory(batchGap.category!, {});
        openOrUpdateIncident(db, { environment: subscription.provider_environment, category: batchGap.category!, severity,
          sourceType: "credit_batch", sourceId: p.id, targetType: "credit_batch", targetId: p.standard_credit_batch_id,
          expectedHash: null, actualHash: null }, input.now);
      }
    }
  }

  writeReceipt(db, { sourceType: "paid_cycle", sourceId: input.paidCycleId, sourceVersion: input.expectedSourceVersion,
    sourceHash: source.sourceHash, expectedTargetHash: source.sourceHash, action, targetType: "entitlement_cycle",
    targetId: entitlementCycleId, targetVersion: null, result: "applied", principalId: input.principalId, now: input.now });
  if (action === "repair") clearLauncherAccessCache();

  return { paidCycleId: input.paidCycleId, action, category: gap.category, entitlementCycleId };
}

export type ReconcileLearnerAppInput = {
  learnerId: string; appId: string; environment: string; expectedSourceVersion: number;
  principalId: string; runIdempotencyKey: string; now: Date;
};

export type ReconcileLearnerAppResult = {
  learnerId: string; appId: string; environment: string; effectiveEntitlementId: string;
  action: "healthy" | "repair"; replayedEventIds: string[];
};

// EN-004 rules 25-27, 54: rebuilds effective/lifecycle consistency for one
// learner+app by calling recomputeEffectiveEntitlement (EN-002) and
// replaying any of this learner's still-'pending' lifecycle events that
// affect this app through the exact same applyRecordedEvent path a repeat
// apply-lifecycle-event call would use — never inventing a transition.
export function reconcileLearnerApp(input: ReconcileLearnerAppInput): ReconcileLearnerAppResult {
  if (!input.runIdempotencyKey.trim()) throw new EntitlementIntegrityError("INVALID_REQUEST");
  const db = getDb();

  const before = db.prepare(
    "select id,effective_version from learner_app_effective_entitlements where learner_id=? and app_id=? and environment=?",
  ).get(input.learnerId, input.appId, input.environment) as { id: string; effective_version: number } | undefined;
  if (before && before.effective_version !== input.expectedSourceVersion) {
    throw new EntitlementIntegrityError("ENTITLEMENT_INTEGRITY_VERSION_CONFLICT");
  }

  const { effectiveEntitlementId } = recomputeEffectiveEntitlement({
    learnerId: input.learnerId, appId: input.appId, environment: input.environment, now: input.now,
  });

  const pending = db.prepare(
    "select id,app_ids_json from entitlement_lifecycle_events where learner_id=? and status='pending' order by created_at",
  ).all(input.learnerId) as { id: string; app_ids_json: string }[];
  const replayedEventIds: string[] = [];
  for (const row of pending) {
    const apps = JSON.parse(row.app_ids_json) as string[];
    if (!apps.includes(input.appId)) continue;
    try {
      applyPendingEventById(row.id, input.now);
      replayedEventIds.push(row.id);
    } catch {
      // Left 'pending' for the next reconciliation pass (rule 50: bounded
      // retry with backoff, not an immediate hard failure here).
    }
  }

  const action: "healthy" | "repair" = replayedEventIds.length > 0 ? "repair" : "healthy";
  const nowIso = input.now.toISOString();
  db.prepare(
    `update learner_app_effective_entitlements
     set integrity_state='healthy', last_reconciled_source_version=effective_version, last_reconciled_at=?
     where id=?`,
  ).run(nowIso, effectiveEntitlementId);

  const after = db.prepare("select effective_version from learner_app_effective_entitlements where id=?")
    .get(effectiveEntitlementId) as { effective_version: number };
  writeReceipt(db, { sourceType: "effective_entitlement", sourceId: `${input.learnerId}:${input.appId}:${input.environment}`,
    sourceVersion: input.expectedSourceVersion, sourceHash: null, expectedTargetHash: null, action,
    targetType: "effective_entitlement", targetId: effectiveEntitlementId, targetVersion: after.effective_version,
    result: "applied", principalId: input.principalId, now: input.now });
  if (action === "repair") clearLauncherAccessCache();

  return { learnerId: input.learnerId, appId: input.appId, environment: input.environment, effectiveEntitlementId,
    action, replayedEventIds };
}
