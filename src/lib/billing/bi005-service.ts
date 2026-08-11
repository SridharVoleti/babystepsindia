import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db/client";
import type { Subscription } from "@/lib/db/types";
import { BillingAssignmentError } from "@/lib/billing/errors";
import { localCheckoutProviderAdapter, type BillingCheckoutProviderAdapter } from "@/lib/billing/provider-adapter";
import { applyLifecycleEvent } from "@/lib/entitlement-lifecycle/service";

// Minimal BI-005: just enough of a refund/chargeback/dispute producer for
// EN-003's refund and chargeback rules to be real and end-to-end tested —
// no live payment-gateway integration (reuses BI-001's provider-adapter
// seam) and no dispute-resolution workflow.

type RefundCaseRow = {
  id: string; subscription_id: string; refund_type: "full" | "partial"; amount: number | null;
  entitlement_effect: "terminate_now" | "no_change" | null; reason_category: string;
  status: "pending_provider_confirmation" | "confirmed" | "reversed" | "rejected";
  provider_refund_ref: string | null; refund_confirmed_at: string | null; version: number;
  administrator_id: string | null;
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireText(value: string, code = "INVALID_REQUEST") {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) throw new BillingAssignmentError(code);
  return normalized;
}

function subscriptionRow(subscriptionId: string): Subscription {
  const row = getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as Subscription | undefined;
  if (!row) throw new BillingAssignmentError("RESOURCE_NOT_FOUND");
  return row;
}

function refundCaseRow(id: string): RefundCaseRow {
  const row = getDb().prepare("select * from refund_cases where id=?").get(id) as RefundCaseRow | undefined;
  if (!row) throw new BillingAssignmentError("RESOURCE_NOT_FOUND");
  return row;
}

function refundCaseSummary(row: RefundCaseRow) {
  return { refundCaseId: row.id, subscriptionId: row.subscription_id, refundType: row.refund_type,
    amount: row.amount, entitlementEffect: row.entitlement_effect, reasonCategory: row.reason_category,
    status: row.status, providerRefundRef: row.provider_refund_ref, refundConfirmedAt: row.refund_confirmed_at,
    version: row.version };
}

// Rule 26: creating (or later approving) a refund case never itself changes
// access — only confirmProviderRefund below, on verified provider success,
// does that.
export function createRefundCase(adminId: string, input: {
  subscriptionId: string;
  refundType: "full" | "partial";
  amount?: number;
  reasonCategory: string;
  entitlementEffect?: "terminate_now" | "no_change";
}, now = new Date()) {
  const reasonCategory = requireText(input.reasonCategory);
  const subscription = subscriptionRow(input.subscriptionId);
  if (input.refundType === "partial") {
    if (!input.entitlementEffect || !["terminate_now", "no_change"].includes(input.entitlementEffect)) {
      throw new BillingAssignmentError("INVALID_REQUEST");
    }
    if (!Number.isInteger(input.amount) || (input.amount as number) <= 0) throw new BillingAssignmentError("INVALID_REQUEST");
  } else if (input.entitlementEffect) {
    // Rule 36: entitlement_effect is meaningful only for a partial refund —
    // a full refund's effect is implicitly terminate_now, not a separate
    // caller-supplied choice.
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  const id = randomUUID();
  const timestamp = now.toISOString();
  getDb().prepare(
    `insert into refund_cases(id,subscription_id,refund_type,amount,entitlement_effect,reason_category,status,
     administrator_id,version,created_at,updated_at)
     values(?,?,?,?,?,?, 'pending_provider_confirmation',?,1,?,?)`,
  ).run(id, subscription.id, input.refundType, input.amount ?? null, input.entitlementEffect ?? null,
    reasonCategory, adminId, timestamp, timestamp);
  return refundCaseSummary(refundCaseRow(id));
}

export function getRefundCase(refundCaseId: string) {
  return refundCaseSummary(refundCaseRow(refundCaseId));
}

// Rules 27-38: access changes only after verified provider refund
// confirmation. Routes the resulting entitlement effect through EN-003's
// applyLifecycleEvent rather than writing learner_app_effective_entitlements
// directly — no admin/billing code path sets entitlement state itself.
export function confirmProviderRefund(adminId: string, refundCaseId: string, input: {
  expectedVersion: number; idempotencyKey: string;
}, options: { now?: Date; adapter?: BillingCheckoutProviderAdapter } = {}) {
  const now = options.now ?? new Date();
  const idempotencyKey = requireText(input.idempotencyKey);
  const row = refundCaseRow(refundCaseId);
  if (row.version !== input.expectedVersion) throw new BillingAssignmentError("VERSION_CONFLICT");
  if (row.status !== "pending_provider_confirmation") throw new BillingAssignmentError("PAYMENT_EVENT_STATE_CONFLICT");
  const subscription = subscriptionRow(row.subscription_id);
  const adapter = options.adapter ?? localCheckoutProviderAdapter;
  if (!adapter.confirmRefund) throw new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED");

  let confirmation: { confirmed: true; providerRefundRef: string; refundConfirmedAt: string };
  try {
    confirmation = adapter.confirmRefund({
      providerSubscriptionRef: subscription.provider_subscription_ref ?? subscription.razorpay_subscription_id,
      providerPaymentRef: subscription.provider_customer_ref ?? subscription.id,
      amount: row.amount ?? 0, idempotencyKey,
    });
    if (!confirmation.confirmed) throw new Error("not confirmed");
  } catch {
    throw new BillingAssignmentError("PROVIDER_UPDATE_FAILED");
  }

  const timestamp = now.toISOString();
  const terminatesAccess = row.refund_type === "full" || row.entitlement_effect === "terminate_now";
  return getDb().transaction(() => {
    const changed = getDb().prepare(
      `update refund_cases set status='confirmed',provider_refund_ref=?,refund_confirmed_at=?,version=version+1,
       updated_at=? where id=? and version=? and status='pending_provider_confirmation'`,
    ).run(confirmation.providerRefundRef, timestamp, timestamp, refundCaseId, input.expectedVersion).changes;
    if (changed !== 1) throw new BillingAssignmentError("VERSION_CONFLICT");
    if (row.refund_type === "full") {
      getDb().prepare("update subscriptions set status='refunded',version=version+1,updated_at=? where id=?")
        .run(timestamp, subscription.id);
    }
    const lifecycleResult = applyLifecycleEvent({
      eventId: `refund:${refundCaseId}`,
      eventType: terminatesAccess ? "refund_confirmed" : "refund_partial_no_change",
      source: "billing_refund", sourceVersion: input.expectedVersion + 1, effectiveAt: timestamp,
      sourceReference: { refundCaseId, subscriptionId: subscription.id, learnerId: subscription.assigned_learner_id,
        reasonCategory: row.reason_category, policyEffect: row.entitlement_effect ?? undefined },
      now,
    });
    return { ...refundCaseSummary(refundCaseRow(refundCaseId)), lifecycleResult };
  })();
}

const WEBHOOK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  return bufferA.length === bufferB.length && timingSafeEqual(bufferA, bufferB);
}

type FinancialWebhookPayload = {
  eventType: "chargeback_confirmed" | "chargeback_reversed" | "dispute_opened";
  subscriptionId: string;
  occurredAt: string;
  reasonCategory?: string;
  fraudOrSecurityRisk?: boolean;
};

export type IngestFinancialEventWebhookInput = {
  provider: string; providerEventId: string; timestampSeconds: number; signatureHex: string;
  rawBody: string; secret: string; now: Date;
};

// Rules 41-48: signed, idempotent, replay-rejecting chargeback/dispute
// ingestion, mirroring ingestDeploymentWebhook's shape (AR-002 session 2).
// A verified chargeback_confirmed applies immediately (rule 41); a
// dispute_opened only applies a suspension when explicitly policy-
// configured (rule 46); a chargeback_reversed is recorded only — actual
// restoration requires exact reconciliation (rule 47, see
// reconcileEntitlementLifecycle), never this webhook alone.
export function ingestFinancialEventWebhook(input: IngestFinancialEventWebhookInput) {
  if (!Number.isFinite(input.timestampSeconds)) throw new BillingAssignmentError("PAYMENT_EVENT_AUTHENTICATION_FAILED");
  const skewMs = Math.abs(input.now.getTime() - input.timestampSeconds * 1000);
  if (skewMs > WEBHOOK_TIMESTAMP_TOLERANCE_MS) throw new BillingAssignmentError("PAYMENT_EVENT_AUTHENTICATION_FAILED");
  const expectedSignature = createHmac("sha256", input.secret)
    .update(`${input.timestampSeconds}.${input.rawBody}`).digest("hex");
  if (!safeEqual(expectedSignature, input.signatureHex)) throw new BillingAssignmentError("PAYMENT_EVENT_AUTHENTICATION_FAILED");

  let payload: FinancialWebhookPayload;
  try { payload = JSON.parse(input.rawBody); } catch { throw new BillingAssignmentError("INVALID_REQUEST"); }
  if (typeof payload.subscriptionId !== "string" || typeof payload.occurredAt !== "string" ||
    !["chargeback_confirmed", "chargeback_reversed", "dispute_opened"].includes(payload.eventType)) {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }

  const db = getDb();
  const existing = db.prepare("select 1 from financial_dispute_events where provider=? and provider_event_id=?")
    .get(input.provider, input.providerEventId);
  if (existing) throw new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED");

  const subscription = subscriptionRow(payload.subscriptionId);
  const payloadHash = hash(payload);
  const id = randomUUID();
  const timestamp = input.now.toISOString();
  db.prepare(
    `insert into financial_dispute_events(id,provider,provider_event_id,event_type,subscription_id,
     fraud_or_security_risk,occurred_at,payload_hash,status,created_at)
     values(?,?,?,?,?,?,?,?, 'received',?)`,
  ).run(id, input.provider, input.providerEventId, payload.eventType, subscription.id,
    payload.fraudOrSecurityRisk ? 1 : 0, payload.occurredAt, payloadHash, timestamp);

  if (payload.eventType === "chargeback_confirmed") {
    db.prepare("update subscriptions set status='charged_back',version=version+1,updated_at=? where id=?")
      .run(timestamp, subscription.id);
    const latest = db.prepare(
      "select max(source_version) v from entitlement_lifecycle_events where source='billing_chargeback' and subscription_id=?",
    ).get(subscription.id) as { v: number | null };
    applyLifecycleEvent({
      eventId: `${input.provider}:${input.providerEventId}`, eventType: "chargeback_confirmed",
      source: "billing_chargeback", sourceVersion: (latest.v ?? 0) + 1, effectiveAt: payload.occurredAt,
      sourceReference: { subscriptionId: subscription.id, learnerId: subscription.assigned_learner_id,
        reasonCategory: payload.reasonCategory ?? "chargeback", fraudOrSecurityRisk: !!payload.fraudOrSecurityRisk },
      now: input.now,
    });
    db.prepare("update financial_dispute_events set status='processed',processed_at=? where id=?").run(timestamp, id);
  } else if (payload.eventType === "dispute_opened") {
    if (process.env.DISPUTE_POLICY_SUSPEND_ON_OPEN === "true") {
      const latest = db.prepare(
        "select max(source_version) v from entitlement_lifecycle_events where source='billing_dispute' and subscription_id=?",
      ).get(subscription.id) as { v: number | null };
      applyLifecycleEvent({
        eventId: `${input.provider}:${input.providerEventId}`, eventType: "chargeback_confirmed",
        source: "billing_dispute", sourceVersion: (latest.v ?? 0) + 1, effectiveAt: payload.occurredAt,
        sourceReference: { subscriptionId: subscription.id, learnerId: subscription.assigned_learner_id,
          reasonCategory: "dispute_policy_suspension" },
        now: input.now,
      });
    }
    db.prepare("update financial_dispute_events set status='processed',processed_at=? where id=?").run(timestamp, id);
  }
  // chargeback_reversed: recorded, left status='received' for
  // reconcileEntitlementLifecycle to pick up (rule 47).

  return { id, provider: input.provider, providerEventId: input.providerEventId, eventType: payload.eventType };
}
