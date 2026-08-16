import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { getSupportCase } from "@/lib/support-cases/service";
import { SupportCaseError } from "@/lib/support-cases/contracts";
import {
  createReassignmentCase, executeSubscriptionReassignment, type ReassignmentEffectiveMode,
} from "@/lib/billing/bi001-service";
import { createRefundCase, confirmProviderRefund, getRefundCase } from "@/lib/billing/bi005-service";
import { listOwnedLearners, getParentTimezone } from "@/lib/db/learner-repo";
import { calendarDateInTimeZone } from "@/lib/learner-profile/date";

// AD-003 rules 2-5: not a second billing engine — every mutation below
// delegates straight to BI-001/BI-005's own already-locked, already-tested
// functions. This module only ever adds the AD-002 case-scope check on top.
type Actor = { staffAccountId: string; roleKeys: readonly string[] };

type SubscriptionRow = {
  id: string; purchaser_parent_id: string; assigned_learner_id: string; product_id: string; product_version: number;
  status: string; payment_state: string; grace_ends_at: string | null; cancel_at_period_end: number;
  auto_renew_enabled: number; current_period_start: string; current_period_end: string; version: number;
  billing_price_id: string | null; billing_price_version: number | null;
};

// Rules 13-17, 74: a billing action can only proceed under an active
// (non-closed) AD-002 case visible to this staff, whose bound
// subscription_id (if any) matches the requested target — never a valid
// Billing capability alone.
function requireCaseScopedSubscription(actor: Actor, caseId: string, requestedSubscriptionId?: string): {
  kase: ReturnType<typeof getSupportCase>; subscription: SubscriptionRow;
} {
  const kase = getSupportCase(actor, caseId);
  if (kase.status === "closed") throw new SupportCaseError("CASE_CLOSED");
  const subscriptionId = requestedSubscriptionId ?? kase.subscription_id ?? undefined;
  if (!subscriptionId) throw new SupportCaseError("SUBSCRIPTION_NOT_BOUND");
  if (kase.subscription_id && kase.subscription_id !== subscriptionId) throw new SupportCaseError("CASE_RESOURCE_MISMATCH");
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as
    SubscriptionRow | undefined;
  if (!subscription) throw new SupportCaseError("CASE_NOT_FOUND");
  if (subscription.purchaser_parent_id !== kase.parent_id) throw new SupportCaseError("CASE_RESOURCE_MISMATCH");
  return { kase, subscription };
}

// API-AD-017: read-only safe billing workspace, composed live — no
// authoritative AD-003 table (rule 99).
export function composeBillingWorkspace(actor: Actor, caseId: string, subscriptionId?: string) {
  const { kase, subscription } = requireCaseScopedSubscription(actor, caseId, subscriptionId);
  const product = getDb().prepare("select name, product_type from products where id=?").get(subscription.product_id) as
    { name: string; product_type: string } | undefined;
  const price = subscription.billing_price_id ? getDb().prepare(
    "select unit_amount, currency from product_prices where id=? and version=?",
  ).get(subscription.billing_price_id, subscription.billing_price_version) as
    { unit_amount: number; currency: string } | undefined : undefined;
  const refunds = getDb().prepare(
    "select id, refund_type, amount, status, provider_refund_ref, refund_confirmed_at, version from refund_cases where subscription_id=? order by created_at desc",
  ).all(subscription.id) as Array<{ id: string; refund_type: string; amount: number | null; status: string;
    provider_refund_ref: string | null; refund_confirmed_at: string | null; version: number }>;

  return {
    caseHeader: { caseId: kase.id, status: kase.status, category: kase.category },
    subscription: {
      id: subscription.id, productName: product?.name ?? null, assignedLearnerId: subscription.assigned_learner_id,
      purchaserParentId: subscription.purchaser_parent_id, currentPeriodStart: subscription.current_period_start,
      currentPeriodEnd: subscription.current_period_end, amount: price?.unit_amount ?? null, currency: price?.currency ?? null,
      paymentState: subscription.payment_state, graceEndsAt: subscription.grace_ends_at,
      autoRenewEnabled: subscription.auto_renew_enabled === 1, cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
      version: subscription.version,
    },
    // Rule 22: entitlement consequence — the current effective-access state
    // for the assigned learner's apps, not the full progress/achievement set.
    entitlementImpact: (getDb().prepare(
      "select app_id, state from learner_app_effective_entitlements where learner_id=?",
    ).all(subscription.assigned_learner_id) as Array<{ app_id: string; state: string }>),
    documents: refunds.map((r) => ({
      refundCaseId: r.id, refundType: r.refund_type, amount: r.amount, status: r.status,
      providerRefundRef: r.provider_refund_ref, confirmedAt: r.refund_confirmed_at, version: r.version,
    })),
  };
}

// API-AD-018: advisory-only eligible reassignment targets — the purchaser's
// other owned learners, server-revalidated again at mutation time (rule 44).
export function getReassignmentEligibility(actor: Actor, caseId: string, subscriptionId?: string) {
  const { subscription } = requireCaseScopedSubscription(actor, caseId, subscriptionId);
  const ageAsOfDate = calendarDateInTimeZone(getParentTimezone(subscription.purchaser_parent_id));
  const eligibleTargets = listOwnedLearners(subscription.purchaser_parent_id, ageAsOfDate)
    .filter((l) => l.id !== subscription.assigned_learner_id)
    .map((l) => ({ learnerId: l.id, displayName: l.displayName }));
  return { subscriptionId: subscription.id, currentLearnerId: subscription.assigned_learner_id, eligibleTargets };
}

export type ReassignSubscriptionViaCaseInput = {
  subscriptionId: string; targetLearnerId: string; reasonCode: string;
  effectiveMode: ReassignmentEffectiveMode; expectedSubscriptionVersion: number; idempotencyKey: string;
};

// API-AD-019: delegates to BI-001's own two-step (create reassignment case,
// then execute under lock) flow — AD-003 never re-derives eligibility/
// overlap/session-in-progress rules itself (rule 40).
export function reassignSubscriptionViaCase(actor: Actor, caseId: string, input: ReassignSubscriptionViaCaseInput, now = new Date()) {
  const { kase, subscription } = requireCaseScopedSubscription(actor, caseId, input.subscriptionId);
  const biCase = createReassignmentCase(subscription.purchaser_parent_id, {
    subscriptionId: subscription.id, targetLearnerId: input.targetLearnerId, reasonCode: input.reasonCode,
    idempotencyKey: `${caseId}:${input.idempotencyKey}`,
  }, now);
  const result = executeSubscriptionReassignment(actor.staffAccountId, subscription.id, {
    caseId: biCase.caseId, targetLearnerId: input.targetLearnerId, effectiveMode: input.effectiveMode,
    reasonCode: input.reasonCode, expectedSubscriptionVersion: input.expectedSubscriptionVersion,
    expectedCaseVersion: biCase.version, idempotencyKey: input.idempotencyKey,
  }, now);
  getDb().prepare(
    `insert into support_case_activity(id,case_id,actor_staff_account_id,canonical_action,underlying_role,
     resource_safe_id,result,request_id,created_at) values(?,?,?,?,?,?,?,?,?)`,
  ).run(randomUUID(), kase.id, actor.staffAccountId, "admin.support.billing.reassign", "billing_administrator",
    subscription.id, "success", randomUUID(), now.toISOString());
  return result;
}

// API-AD-020: safe refundable-balance/current-outcome summary.
export function getRefundEligibility(actor: Actor, caseId: string, subscriptionId?: string) {
  const { subscription } = requireCaseScopedSubscription(actor, caseId, subscriptionId);
  const price = subscription.billing_price_id ? getDb().prepare(
    "select unit_amount, currency from product_prices where id=? and version=?",
  ).get(subscription.billing_price_id, subscription.billing_price_version) as
    { unit_amount: number; currency: string } | undefined : undefined;
  const priorRefunds = getDb().prepare(
    "select coalesce(sum(amount),0) as refunded from refund_cases where subscription_id=? and status='confirmed'",
  ).get(subscription.id) as { refunded: number };
  const maxRefundable = Math.max((price?.unit_amount ?? 0) - priorRefunds.refunded, 0);
  return { subscriptionId: subscription.id, maxRefundableAmount: maxRefundable, currency: price?.currency ?? null,
    version: subscription.version };
}

export type RefundViaCaseInput = {
  subscriptionId: string; refundType: "full" | "partial"; amount?: number; reasonCode: string;
  entitlementEffect?: "terminate_now" | "no_change"; idempotencyKey: string;
};

// API-AD-021: delegates to BI-005's own two-step (create refund case, then
// confirm under lock via the provider adapter) flow — AD-003 never marks a
// refund successful itself; a provider failure/uncertainty surfaces exactly
// as BI-005 reports it (rules 52-54).
export function refundViaCase(actor: Actor, caseId: string, input: RefundViaCaseInput, now = new Date()) {
  const { kase, subscription } = requireCaseScopedSubscription(actor, caseId, input.subscriptionId);
  const refundCase = createRefundCase(actor.staffAccountId, {
    subscriptionId: subscription.id, refundType: input.refundType, amount: input.amount,
    reasonCategory: input.reasonCode, entitlementEffect: input.entitlementEffect,
  }, now);
  try {
    const result = confirmProviderRefund(actor.staffAccountId, refundCase.refundCaseId,
      { expectedVersion: refundCase.version, idempotencyKey: input.idempotencyKey }, { now });
    getDb().prepare(
      `insert into support_case_activity(id,case_id,actor_staff_account_id,canonical_action,underlying_role,
       resource_safe_id,result,request_id,created_at) values(?,?,?,?,?,?,?,?,?)`,
    ).run(randomUUID(), kase.id, actor.staffAccountId, "admin.support.billing.refund", "billing_administrator",
      refundCase.refundCaseId, "success", randomUUID(), now.toISOString());
    return result;
  } catch (error) {
    getDb().prepare(
      `insert into support_case_activity(id,case_id,actor_staff_account_id,canonical_action,underlying_role,
       resource_safe_id,result,request_id,created_at) values(?,?,?,?,?,?,?,?,?)`,
    ).run(randomUUID(), kase.id, actor.staffAccountId, "admin.support.billing.refund", "billing_administrator",
      refundCase.refundCaseId, "failed", randomUUID(), now.toISOString());
    throw error;
  }
}

export { getRefundCase };
