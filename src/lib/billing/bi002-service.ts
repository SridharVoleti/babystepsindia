import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import type { ProductPriceRow, ProductRow, Subscription } from "@/lib/db/types";
import { BillingAssignmentError } from "@/lib/billing/errors";
import { BILLING_GRACE_DURATION_MS, BILLING_REMINDER_LEAD_MS } from "@/lib/billing/contracts";
import { recoveryWindowKey } from "@/lib/billing/grace-policy";
import {
  assertNoProductAccessOverlap,
  applyDueSubscriptionReassignment,
  productAppIds,
} from "@/lib/billing/bi001-service";
import { applyPaidCycle } from "@/lib/entitlement-cycle/service";
import { getCancellationBillingStatus, processVerifiedRecurringAgreementEvent } from "@/lib/billing/bi004-service";
import {
  resolveBillingProviderAdapter,
  type BillingCheckoutProviderAdapter,
  type BillingEnvironment,
  type BillingInterval,
  type VerifiedProviderBillingEvent,
  type VerifiedProviderPaymentEvent,
  type VerifiedProviderRecurringAgreementEvent,
} from "@/lib/billing/provider-adapter";

type ProviderEventReceipt = {
  payload_hash: string;
  status: "received" | "processed" | "duplicate" | "ignored" | "rejected" | "deferred";
  result_json: string | null;
  error_code: string | null;
};

type CheckoutIntentBillingRow = {
  id: string;
  purchaser_parent_id: string;
  assigned_learner_id: string;
  product_id: string;
  product_version: number;
  price_id: string;
  price_version: number;
  amount: number;
  currency: string;
  billing_interval: BillingInterval;
  interval_count: number;
  auto_renew_enabled: number;
  provider: string;
  provider_environment: BillingEnvironment;
  provider_account_id: string;
  provider_checkout_ref: string;
  provider_mandate_ref: string | null;
  status: string;
  expires_at: string;
  subscription_id: string;
};

export type RenewalReminderNotifier = {
  send(input: {
    reminderId: string;
    parentId: string;
    recipientEmail: string;
    subscriptionId: string;
    renewalAt: string;
    amount: number;
    currency: string;
    productName: string;
    learnerName: string;
    manageUrl: string;
  }): void;
};

const localRenewalReminderNotifier: RenewalReminderNotifier = { send() {} };

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireIso(value: string, code = "INVALID_REQUEST") {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new BillingAssignmentError(code);
  return date;
}

function requireEnvironment(value: string): asserts value is BillingEnvironment {
  if (!(value === "test" || value === "production")) {
    throw new BillingAssignmentError("PAYMENT_EVENT_AUTHENTICATION_FAILED");
  }
}

function isRecurringAgreementEvent(event: VerifiedProviderBillingEvent):
  event is VerifiedProviderRecurringAgreementEvent {
  return event.eventType === "recurring_agreement_confirmed" || event.eventType === "recurring_agreement_failed";
}

function eventHash(input: VerifiedProviderPaymentEvent) {
  return hash({ ...input });
}

function priceRow(id: string, version: number): ProductPriceRow {
  const row = getDb().prepare("select * from product_prices where id=? and version=?").get(id, version) as
    ProductPriceRow | undefined;
  if (!row) throw new BillingAssignmentError("PAYMENT_EVENT_CONTEXT_MISMATCH");
  return row;
}

function productRow(id: string, version: number): ProductRow {
  const row = getDb().prepare("select * from products where id=? and version=? and status='active'").get(id, version) as
    ProductRow | undefined;
  if (!row) throw new BillingAssignmentError("PAYMENT_EVENT_CONTEXT_MISMATCH");
  return row;
}

function safeEventResult(event: VerifiedProviderPaymentEvent, result: Record<string, unknown>) {
  const value = { providerEventId: event.providerEventId, ...result };
  getDb().prepare(
    `update payment_provider_events set status='processed',result_code=?,result_json=?,processed_at=?
     where provider=? and environment=? and account_id=? and provider_event_id=?`,
  ).run(String(result.resultCode ?? "PROCESSED"), JSON.stringify(value), new Date().toISOString(),
    event.provider, event.environment, event.accountId, event.providerEventId);
  return value;
}

function insertProviderReceipt(event: VerifiedProviderPaymentEvent, payloadHash: string, now: Date) {
  getDb().prepare(
    `insert into payment_provider_events(provider,environment,account_id,provider_event_id,event_type,payload_hash,
     checkout_intent_id,subscription_id,provider_checkout_ref,provider_payment_ref,status,received_at)
     values(?,?,?,?,?,?,?,?,?,?,'received',?)`,
  ).run(event.provider, event.environment, event.accountId, event.providerEventId, event.eventType, payloadHash,
    event.checkoutIntentId ?? null, event.subscriptionId ?? null, event.providerCheckoutRef ?? null,
    event.providerPaymentRef, now.toISOString());
}

function markProviderEventRejected(event: VerifiedProviderPaymentEvent, code: string, now: Date) {
  getDb().prepare(
    `update payment_provider_events set status='rejected',error_code=?,processed_at=?
     where provider=? and environment=? and account_id=? and provider_event_id=?`,
  ).run(code, now.toISOString(), event.provider, event.environment, event.accountId, event.providerEventId);
}

function checkoutForEvent(event: VerifiedProviderPaymentEvent): CheckoutIntentBillingRow {
  const row = getDb().prepare("select * from checkout_intents where id=?").get(event.checkoutIntentId ?? "") as
    CheckoutIntentBillingRow | undefined;
  if (!row || !row.price_id || !row.subscription_id) {
    throw new BillingAssignmentError("PAYMENT_EVENT_CONTEXT_MISMATCH");
  }
  const exact = row.provider === event.provider && row.provider_checkout_ref === event.providerCheckoutRef &&
    row.provider_environment === event.environment && row.provider_account_id === event.accountId &&
    row.price_id === event.priceId && row.price_version === event.priceVersion &&
    row.amount === event.amount && row.currency === event.currency;
  if (!exact) {
    const amountMismatch = row.amount !== event.amount || row.currency !== event.currency ||
      row.price_id !== event.priceId || row.price_version !== event.priceVersion;
    throw new BillingAssignmentError(amountMismatch ? "PAYMENT_AMOUNT_MISMATCH" : "PAYMENT_EVENT_CONTEXT_MISMATCH");
  }
  return row;
}

function subscriptionForEvent(event: VerifiedProviderPaymentEvent): Subscription {
  const row = event.subscriptionId
    ? getDb().prepare("select * from subscriptions where id=?").get(event.subscriptionId)
    : getDb().prepare("select * from subscriptions where provider=? and provider_subscription_ref=?")
      .get(event.provider, event.providerSubscriptionRef ?? "") as Subscription | undefined;
  if (!row) throw new BillingAssignmentError("PAYMENT_EVENT_CONTEXT_MISMATCH");
  return row as Subscription;
}

function validateCommercialBinding(subscription: Subscription, event: VerifiedProviderPaymentEvent) {
  if (subscription.provider !== event.provider || subscription.billing_price_id !== event.priceId ||
    subscription.billing_price_version !== event.priceVersion ||
    subscription.provider_environment !== event.environment || subscription.provider_account_id !== event.accountId) {
    throw new BillingAssignmentError("PAYMENT_EVENT_CONTEXT_MISMATCH");
  }
  const price = priceRow(event.priceId, event.priceVersion);
  if (event.amount !== price.unit_amount || event.currency !== price.currency) {
    throw new BillingAssignmentError("PAYMENT_AMOUNT_MISMATCH");
  }
  return price;
}

export function addBillingInterval(baseIso: string, interval: BillingInterval, intervalCount: number,
  originalAnchorDay: number): string {
  const base = requireIso(baseIso);
  const months = interval === "year" ? intervalCount * 12 : intervalCount;
  const monthIndex = base.getUTCFullYear() * 12 + base.getUTCMonth() + months;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(originalAnchorDay, lastDay), base.getUTCHours(),
    base.getUTCMinutes(), base.getUTCSeconds(), base.getUTCMilliseconds())).toISOString();
}

function scheduleRenewalReminder(subscriptionId: string, renewalAt: string, price: ProductPriceRow, now: Date) {
  const dueAt = new Date(requireIso(renewalAt).getTime() - BILLING_REMINDER_LEAD_MS).toISOString();
  getDb().prepare(
    `insert into subscription_renewal_reminders(id,subscription_id,renewal_cycle_at,reminder_due_at,
     expected_amount,currency,price_id,price_version,channel,status,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,'email','pending',?,?)
     on conflict(subscription_id,renewal_cycle_at) do update set
       reminder_due_at=excluded.reminder_due_at,expected_amount=excluded.expected_amount,
       currency=excluded.currency,price_id=excluded.price_id,price_version=excluded.price_version,
       status=case when subscription_renewal_reminders.status='sent' then 'sent' else 'pending' end,
       last_error_code=null,updated_at=excluded.updated_at`,
  ).run(randomUUID(), subscriptionId, renewalAt, dueAt, price.unit_amount, price.currency,
    price.id, price.version, now.toISOString(), now.toISOString());
}

// BI-004 calls this after it has explicitly and successfully restored the
// provider mandate. BI-002 owns the reminder outcome: normal T-7 scheduling
// before the point, exact charge details (and no late reminder) after it.
export function syncReminderAfterAutoRenewalResumed(subscriptionId: string, now = new Date()) {
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as
    Subscription | undefined;
  if (!subscription || subscription.auto_renew_enabled !== 1 || !subscription.next_renewal_at ||
    !subscription.billing_price_id || !subscription.billing_price_version) {
    throw new BillingAssignmentError("PAYMENT_EVENT_STATE_CONFLICT");
  }
  const price = priceRow(subscription.billing_price_id, subscription.billing_price_version);
  const dueAt = new Date(requireIso(subscription.next_renewal_at).getTime() - BILLING_REMINDER_LEAD_MS).toISOString();
  if (now.toISOString() < dueAt) {
    scheduleRenewalReminder(subscription.id, subscription.next_renewal_at, price, now);
    return { scheduled: true, reminderDueAt: dueAt, renewalAt: subscription.next_renewal_at };
  }
  getDb().prepare(
    `update subscription_renewal_reminders set status='skipped',last_error_code='LATE_RESUMPTION',updated_at=?
     where subscription_id=? and renewal_cycle_at=? and status in ('pending','retry_pending')`,
  ).run(now.toISOString(), subscription.id, subscription.next_renewal_at);
  return { scheduled: false, lateConfirmationRequired: true, renewalAt: subscription.next_renewal_at,
    expectedAmount: price.unit_amount, currency: price.currency };
}

function recordBillingEvent(parentId: string, eventType: string, metadata: Record<string, unknown>) {
  getDb().prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,?,?)")
    .run(randomUUID(), parentId, eventType, JSON.stringify(metadata));
}

function activateInitialPayment(event: VerifiedProviderPaymentEvent, now: Date) {
  const intent = checkoutForEvent(event);
  const subscription = getDb().prepare("select * from subscriptions where id=?").get(intent.subscription_id) as
    Subscription | undefined;
  if (!subscription || subscription.status !== "pending_payment" || intent.status !== "pending_provider") {
    throw new BillingAssignmentError("PAYMENT_EVENT_STATE_CONFLICT");
  }
  if (requireIso(event.settledAt).getTime() > requireIso(intent.expires_at).getTime()) {
    throw new BillingAssignmentError("PAYMENT_EVENT_CONTEXT_MISMATCH");
  }
  const price = validateCommercialBinding(subscription, event);
  if (event.providerSubscriptionRef && subscription.provider_subscription_ref &&
    !subscription.provider_subscription_ref.startsWith("pending:") &&
    event.providerSubscriptionRef !== subscription.provider_subscription_ref) {
    throw new BillingAssignmentError("PAYMENT_EVENT_CONTEXT_MISMATCH");
  }
  if (event.eventType === "initial_payment_failed") {
    return getDb().transaction(() => {
      getDb().prepare("update checkout_intents set status='payment_failed',provider_payment_ref=?,updated_at=? where id=?")
        .run(event.providerPaymentRef, now.toISOString(), intent.id);
      getDb().prepare(
        "update subscriptions set status='cancelled',payment_state='failed',version=version+1,updated_at=? where id=?",
      ).run(now.toISOString(), subscription.id);
      return safeEventResult(event, { resultCode: "INITIAL_PAYMENT_FAILED", subscriptionId: subscription.id,
        activated: false });
    })();
  }
  if (intent.auto_renew_enabled === 1 && !(event.providerMandateRef ?? intent.provider_mandate_ref)) {
    throw new BillingAssignmentError("RECURRING_PAYMENT_SETUP_FAILED");
  }
  try {
    assertNoProductAccessOverlap(subscription.assigned_learner_id, subscription.product_id,
      subscription.product_version, new Date(event.settledAt));
  } catch (error) {
    if (!(error instanceof BillingAssignmentError) || error.code !== "PRODUCT_ACCESS_OVERLAP") throw error;
    return getDb().transaction(() => {
      getDb().prepare(
        `update subscriptions set payment_state='overlap_resolution_required',version=version+1,updated_at=? where id=?`,
      ).run(now.toISOString(), subscription.id);
      recordBillingEvent(subscription.purchaser_parent_id, "billing_overlap_resolution_required", {
        subscriptionId: subscription.id, learnerId: subscription.assigned_learner_id,
        productId: subscription.product_id, providerEventId: event.providerEventId,
      });
      return safeEventResult(event, { resultCode: "OVERLAP_RESOLUTION_REQUIRED",
        subscriptionId: subscription.id, activated: false });
    })();
  }
  const product = productRow(subscription.product_id, subscription.product_version);
  const periodStart = requireIso(event.settledAt).toISOString();
  const anchorDay = new Date(periodStart).getUTCDate();
  const periodEnd = addBillingInterval(periodStart, price.billing_interval, price.interval_count, anchorDay);
  const billingPeriodId = randomUUID();
  const autoRenewEnabled = intent.auto_renew_enabled === 1;
  return getDb().transaction(() => {
    getDb().prepare(
      `insert into billing_periods(id,subscription_id,period_start,period_end,provider_payment_ref,amount,
       currency,price_id,price_version,status,source_provider_event_id,created_at)
       values(?,?,?,?,?,?,?,?,?,'paid',?,?)`,
    ).run(billingPeriodId, subscription.id, periodStart, periodEnd, event.providerPaymentRef,
      event.amount, event.currency, event.priceId, event.priceVersion, event.providerEventId, now.toISOString());
    getDb().prepare(
      `update subscriptions set status='active',payment_state='paid',auto_renew_enabled=?,cancel_at_period_end=0,
       provider_customer_ref=?,provider_payment_method_ref=?,provider_mandate_ref=?,provider_mandate_status=?,provider_subscription_ref=?,
       razorpay_subscription_id=?,current_period_start=?,current_period_end=?,next_renewal_at=?,billing_anchor_at=?,
       original_anchor_day=?,original_anchor_time=?,version=version+1,updated_at=? where id=? and status='pending_payment'`,
    ).run(autoRenewEnabled ? 1 : 0, event.providerCustomerRef ?? null, event.providerPaymentMethodRef ?? null,
      event.providerMandateRef ?? intent.provider_mandate_ref, autoRenewEnabled ? "valid" : "unknown",
      event.providerSubscriptionRef ?? subscription.provider_subscription_ref,
      event.providerSubscriptionRef ?? subscription.razorpay_subscription_id, periodStart, periodEnd,
      autoRenewEnabled ? periodEnd : null, periodStart, anchorDay, periodStart.slice(11, 23), now.toISOString(), subscription.id);
    getDb().prepare(
      "update checkout_intents set status='activated',provider_payment_ref=?,subscription_id=?,updated_at=? where id=?",
    ).run(event.providerPaymentRef, subscription.id, now.toISOString(), intent.id);
    const entitlement = applyPaidCycle({ paidCycleId: billingPeriodId, eventId: event.providerEventId,
      eventVersion: 1, subscriptionId: subscription.id, purchaserParentId: subscription.purchaser_parent_id,
      assignedLearnerId: subscription.assigned_learner_id, productId: product.id,
      productVersion: product.version, appIds: productAppIds(product.id, product.version),
      periodStart, periodEnd, billingAnchor: periodStart, environment: event.environment, now });
    if (autoRenewEnabled) scheduleRenewalReminder(subscription.id, periodEnd, price, now);
    recordBillingEvent(subscription.purchaser_parent_id, "subscription_activated", {
      subscriptionId: subscription.id, billingPeriodId, learnerId: subscription.assigned_learner_id,
      productId: product.id, autoRenewEnabled, periodStart, periodEnd,
    });
    return safeEventResult(event, { resultCode: "SUBSCRIPTION_ACTIVATED", subscriptionId: subscription.id,
      billingPeriodId, status: "active", autoRenewEnabled, currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd, nextRenewalAt: autoRenewEnabled ? periodEnd : null,
      entitlementCycleId: entitlement.cycleId });
  })();
}

const FAILED_RENEWAL_EVENTS = new Set<VerifiedProviderPaymentEvent["eventType"]>([
  "renewal_payment_failed", "renewal_failed", "retry_failed",
]);

function recordRenewalAttempt(subscription: Subscription, event: VerifiedProviderPaymentEvent,
  status: "failed" | "settled" | "late_exception", now: Date) {
  const attemptedAt = event.attemptedAt ?? event.settledAt;
  requireIso(attemptedAt);
  getDb().prepare(
    `insert or ignore into renewal_payment_attempts(id,subscription_id,provider,environment,account_id,
     provider_invoice_ref,provider_payment_ref,provider_attempt_ref,attempt_number,status,amount,currency,
     price_id,price_version,attempted_at,settled_at,failure_code,provider_event_id,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(randomUUID(), subscription.id, event.provider, event.environment, event.accountId,
    event.providerInvoiceRef ?? null, event.providerPaymentRef, event.providerAttemptRef ?? null, 1, status,
    event.amount, event.currency, event.priceId, event.priceVersion, attemptedAt,
    status === "failed" ? null : event.settledAt, event.failureCode ?? null, event.providerEventId,
    now.toISOString(), now.toISOString());
}

function queueInitialRecoveryNotification(subscription: Subscription, graceEndsAt: string, now: Date) {
  const context = JSON.stringify({ subscriptionId: subscription.id, productId: subscription.product_id,
    learnerId: subscription.assigned_learner_id, graceEndsAt,
    updatePaymentPath: `/account/subscriptions#${subscription.id}` });
  getDb().prepare(
    `insert or ignore into billing_recovery_notifications(id,subscription_id,notification_type,channel,
     window_key,status,safe_context_json,created_at,updated_at)
     values(?,?,'initial_failure','email',?,'pending',?,?,?)`,
  ).run(randomUUID(), subscription.id, recoveryWindowKey(now), context, now.toISOString(), now.toISOString());
}

function queueRecoveredNotification(subscription: Subscription, billingPeriodId: string, now: Date) {
  getDb().prepare(
    `update billing_recovery_notifications set status='cancelled',updated_at=?
     where subscription_id=? and notification_type='routine_recovery' and status in ('pending','retry_pending')`,
  ).run(now.toISOString(), subscription.id);
  const context = JSON.stringify({ subscriptionId: subscription.id, billingPeriodId,
    productId: subscription.product_id, learnerId: subscription.assigned_learner_id, recoveredAt: now.toISOString() });
  getDb().prepare(
    `insert or ignore into billing_recovery_notifications(id,subscription_id,notification_type,channel,
     window_key,status,safe_context_json,created_at,updated_at)
     values(?,?,'recovered','in_product',?,'pending',?,?,?)`,
  ).run(randomUUID(), subscription.id, recoveryWindowKey(now), context, now.toISOString(), now.toISOString());
}

function applyFailedRenewal(subscription: Subscription, event: VerifiedProviderPaymentEvent, now: Date) {
  return getDb().transaction(() => {
    recordRenewalAttempt(subscription, event, "failed", now);
    if (subscription.payment_state === "past_due_grace" && subscription.grace_ends_at) {
      return safeEventResult(event, { resultCode: "RENEWAL_FAILED_GRACE_UNCHANGED",
        subscriptionId: subscription.id, renewed: false, paymentState: "past_due_grace",
        graceStartedAt: subscription.grace_started_at, graceEndsAt: subscription.grace_ends_at });
    }
    const eligible = subscription.auto_renew_enabled === 1 && subscription.cancel_at_period_end === 0 &&
      (subscription.status === "active" || subscription.status === "past_due");
    if (!eligible || now.toISOString() < subscription.current_period_end) {
      getDb().prepare(
        `update subscriptions set payment_state='renewal_failed',renewal_failure_at=coalesce(renewal_failure_at,?),
         last_recovery_attempt_at=?,recovery_version=recovery_version+1,version=version+1,updated_at=? where id=?`,
      ).run(event.attemptedAt ?? event.settledAt, now.toISOString(), now.toISOString(), subscription.id);
      return safeEventResult(event, { resultCode: eligible ? "RENEWAL_FAILURE_RECORDED" : "RENEWAL_FAILURE_NO_GRACE",
        subscriptionId: subscription.id, renewed: false, currentPeriodEnd: subscription.current_period_end });
    }
    const graceStartedAt = subscription.current_period_end;
    const graceEndsAt = new Date(requireIso(graceStartedAt).getTime() + BILLING_GRACE_DURATION_MS).toISOString();
    getDb().prepare(
      `update subscriptions set status='past_due',payment_state='past_due_grace',grace_started_at=?,grace_ends_at=?,
       renewal_failure_at=coalesce(renewal_failure_at,?),last_recovery_attempt_at=?,provider_retry_stop_state=null,
       recovery_version=recovery_version+1,version=version+1,updated_at=?
       where id=? and payment_state<>'past_due_grace'`,
    ).run(graceStartedAt, graceEndsAt, event.attemptedAt ?? event.settledAt,
      now.toISOString(), now.toISOString(), subscription.id);
    queueInitialRecoveryNotification(subscription, graceEndsAt, now);
    recordBillingEvent(subscription.purchaser_parent_id, "subscription_renewal_failed", {
      subscriptionId: subscription.id, providerEventId: event.providerEventId, graceStartedAt, graceEndsAt,
    });
    recordBillingEvent(subscription.purchaser_parent_id, "subscription_grace_started", {
      subscriptionId: subscription.id, graceStartedAt, graceEndsAt,
    });
    return safeEventResult(event, { resultCode: "RENEWAL_FAILED_GRACE_STARTED",
      subscriptionId: subscription.id, renewed: false, paymentState: "past_due_grace",
      currentPeriodEnd: subscription.current_period_end, graceStartedAt, graceEndsAt });
  })();
}

function applyRenewal(event: VerifiedProviderPaymentEvent, now: Date) {
  let subscription = subscriptionForEvent(event);
  const price = validateCommercialBinding(subscription, event);
  if (!event.providerSubscriptionRef || event.providerSubscriptionRef !== subscription.provider_subscription_ref) {
    throw new BillingAssignmentError("PAYMENT_EVENT_CONTEXT_MISMATCH");
  }
  if (FAILED_RENEWAL_EVENTS.has(event.eventType)) return applyFailedRenewal(subscription, event, now);
  const recovering = subscription.payment_state === "past_due_grace" ||
    subscription.payment_state === "inactive_nonpayment" || event.eventType === "payment_recovered" ||
    event.eventType === "delayed_settlement";
  if (recovering && (!subscription.grace_ends_at || event.settledAt > subscription.grace_ends_at)) {
    recordRenewalAttempt(subscription, event, "late_exception", now);
    throw new BillingAssignmentError("PAYMENT_RECOVERY_WINDOW_EXPIRED");
  }
  if (!recovering && (subscription.status !== "active" || subscription.auto_renew_enabled !== 1 ||
    subscription.cancel_at_period_end === 1)) {
    return getDb().transaction(() => safeEventResult(event, { resultCode: "RENEWAL_IGNORED",
      subscriptionId: subscription.id, renewed: false }))();
  }
  const periodStart = subscription.current_period_end;
  const anchorDay = subscription.original_anchor_day ?? new Date(subscription.billing_anchor_at!).getUTCDate();
  const periodEnd = addBillingInterval(periodStart, price.billing_interval, price.interval_count, anchorDay);
  // BI-001 scheduled learner corrections become effective at this exact paid
  // boundary before the new entitlement cycle is allocated.
  if (subscription.pending_reassignment_learner_id && subscription.pending_reassignment_effective_at! <= periodStart) {
    applyDueSubscriptionReassignment(subscription.id, new Date(periodStart));
    subscription = getDb().prepare("select * from subscriptions where id=?").get(subscription.id) as Subscription;
  }
  const billingPeriodId = randomUUID();
  const product = productRow(subscription.product_id, subscription.product_version);
  const continuesAutoRenew = subscription.auto_renew_enabled === 1 && subscription.cancel_at_period_end === 0;
  return getDb().transaction(() => {
    recordRenewalAttempt(subscription, event, "settled", now);
    getDb().prepare(
      `insert into billing_periods(id,subscription_id,period_start,period_end,provider_payment_ref,amount,
       currency,price_id,price_version,status,source_provider_event_id,created_at)
       values(?,?,?,?,?,?,?,?,?,'paid',?,?)`,
    ).run(billingPeriodId, subscription.id, periodStart, periodEnd, event.providerPaymentRef,
      event.amount, event.currency, event.priceId, event.priceVersion, event.providerEventId, now.toISOString());
    const subscriptionUpdate = getDb().prepare(
      `update subscriptions set status='active',payment_state='paid',current_period_start=?,current_period_end=?,
       next_renewal_at=?,grace_started_at=null,grace_ends_at=null,last_recovery_attempt_at=?,nonpayment_ended_at=null,
       provider_retry_stop_state=null,recovery_version=recovery_version+1,version=version+1,updated_at=?
       where id=? and current_period_end=? and payment_state in ('paid','renewal_failed','past_due_grace','inactive_nonpayment')`,
    ).run(periodStart, periodEnd, continuesAutoRenew ? periodEnd : null, now.toISOString(), now.toISOString(),
      subscription.id, periodStart);
    if (subscriptionUpdate.changes !== 1) throw new BillingAssignmentError("PAYMENT_EVENT_STATE_CONFLICT");
    const entitlement = applyPaidCycle({ paidCycleId: billingPeriodId, eventId: event.providerEventId,
      eventVersion: 1, subscriptionId: subscription.id, purchaserParentId: subscription.purchaser_parent_id,
      assignedLearnerId: subscription.assigned_learner_id, productId: product.id,
      productVersion: product.version, appIds: productAppIds(product.id, product.version),
      periodStart, periodEnd, billingAnchor: subscription.billing_anchor_at!, environment: event.environment, now });
    if (continuesAutoRenew) scheduleRenewalReminder(subscription.id, periodEnd, price, now);
    recordBillingEvent(subscription.purchaser_parent_id, "subscription_renewed", {
      subscriptionId: subscription.id, billingPeriodId, learnerId: subscription.assigned_learner_id,
      productId: product.id, periodStart, periodEnd,
    });
    if (recovering) recordBillingEvent(subscription.purchaser_parent_id, "subscription_payment_recovered", {
      subscriptionId: subscription.id, billingPeriodId, settledAt: event.settledAt,
      originalBoundary: periodStart,
    });
    if (recovering) queueRecoveredNotification(subscription, billingPeriodId, now);
    return safeEventResult(event, { resultCode: recovering ? "SUBSCRIPTION_PAYMENT_RECOVERED" : "SUBSCRIPTION_RENEWED",
      subscriptionId: subscription.id,
      billingPeriodId, renewed: true, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd,
      nextRenewalAt: periodEnd, entitlementCycleId: entitlement.cycleId });
  })();
}

export function processVerifiedPaymentEvent(event: VerifiedProviderPaymentEvent, now = new Date()) {
  requireEnvironment(event.environment);
  requireIso(event.settledAt);
  if (!event.provider || !event.accountId || !event.providerEventId || !event.providerPaymentRef ||
    !Number.isInteger(event.amount) || event.amount < 0 || !Number.isInteger(event.priceVersion)) {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  const payloadHash = eventHash(event);
  const db = getDb();
  const existing = db.prepare(
    `select payload_hash,status,result_json,error_code from payment_provider_events
     where provider=? and environment=? and account_id=? and provider_event_id=?`,
  ).get(event.provider, event.environment, event.accountId, event.providerEventId) as ProviderEventReceipt | undefined;
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED");
    if (existing.result_json) return JSON.parse(existing.result_json);
    if (existing.status === "rejected") throw new BillingAssignmentError(existing.error_code ?? "PAYMENT_EVENT_STATE_CONFLICT");
  } else {
    insertProviderReceipt(event, payloadHash, now);
  }
  try {
    return event.eventType.startsWith("initial_") ? activateInitialPayment(event, now) : applyRenewal(event, now);
  } catch (error) {
    if (error instanceof BillingAssignmentError) markProviderEventRejected(event, error.code, now);
    throw error;
  }
}

export function processSignedProviderWebhook(provider: string, input: {
  rawBody: string;
  signature: string;
  environment: string;
  accountId: string;
}, now = new Date(), adapter = resolveBillingProviderAdapter(provider)) {
  if (!adapter.verifyWebhook) throw new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED");
  const event = adapter.verifyWebhook(input);
  if (event.provider !== provider) throw new BillingAssignmentError("PAYMENT_EVENT_AUTHENTICATION_FAILED");
  return isRecurringAgreementEvent(event)
    ? processVerifiedRecurringAgreementEvent(event, now)
    : processVerifiedPaymentEvent(event, now);
}

export function getSubscriptionBillingStatus(parentId: string, subscriptionId: string, now = new Date()) {
  const cancellation = getCancellationBillingStatus(parentId, subscriptionId, now);
  const row = getDb().prepare(
    `select s.*,p.name product_name,l.display_name learner_name,pp.unit_amount,pp.currency
     from subscriptions s join products p on p.id=s.product_id join learners l on l.id=s.assigned_learner_id
     left join product_prices pp on pp.id=s.billing_price_id
     where s.id=? and s.purchaser_parent_id=?`,
  ).get(subscriptionId, parentId) as (Subscription & { product_name: string; learner_name: string;
    unit_amount: number | null; currency: string | null }) | undefined;
  if (!row) throw new BillingAssignmentError("RESOURCE_NOT_FOUND");
  return { subscriptionId: row.id, status: row.status, paymentState: row.payment_state,
    autoRenewEnabled: row.auto_renew_enabled === 1, cancelAtPeriodEnd: row.cancel_at_period_end === 1,
    currentPeriodStart: row.current_period_start, currentPeriodEnd: row.current_period_end,
    graceStartedAt: row.grace_started_at, graceEndsAt: row.grace_ends_at,
    nonpaymentEndedAt: row.nonpayment_ended_at,
    cancellationEffectiveAt: cancellation.cancellationEffectiveAt,
    canResumeAutoRenew: cancellation.canResumeAutoRenew,
    providerMandateStatus: cancellation.providerMandateStatus,
    nextChargeAt: cancellation.nextChargeAt,
    nextRenewalAt: row.next_renewal_at, expectedAmount: row.unit_amount, currency: row.currency,
    product: { id: row.product_id, name: row.product_name },
    assignedLearner: { id: row.assigned_learner_id, displayName: row.learner_name }, version: row.version };
}

export function disableSubscriptionAutoRenewal(parentId: string, subscriptionId: string, input: {
  expectedVersion: number;
  idempotencyKey: string;
}, options: { now?: Date; adapter?: BillingCheckoutProviderAdapter } = {}) {
  const now = options.now ?? new Date();
  if (!input.idempotencyKey.trim() || !Number.isInteger(input.expectedVersion)) {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  const requestHash = hash({ operation: "disable_auto_renew", expectedVersion: input.expectedVersion });
  const existing = getDb().prepare(
    `select request_hash,result_json from billing_mutation_requests
     where actor_id=? and subscription_id=? and idempotency_key=?`,
  ).get(parentId, subscriptionId, input.idempotencyKey) as { request_hash: string; result_json: string | null } | undefined;
  if (existing) {
    if (existing.request_hash !== requestHash) throw new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED");
    if (existing.result_json) return JSON.parse(existing.result_json);
  }
  const subscription = getDb().prepare(
    "select * from subscriptions where id=? and purchaser_parent_id=?",
  ).get(subscriptionId, parentId) as Subscription | undefined;
  if (!subscription) throw new BillingAssignmentError("RESOURCE_NOT_FOUND");
  if (subscription.version !== input.expectedVersion) throw new BillingAssignmentError("VERSION_CONFLICT");
  if (!(subscription.status === "active" || subscription.status === "past_due")) {
    throw new BillingAssignmentError("PAYMENT_EVENT_STATE_CONFLICT");
  }
  const result = { subscriptionId, autoRenewEnabled: false, cancelAtPeriodEnd: true,
    cancellationEffectiveAt: subscription.current_period_end,
    currentPeriodEnd: subscription.current_period_end, graceEndsAt: subscription.grace_ends_at,
    version: subscription.version + (subscription.auto_renew_enabled ? 1 : 0) };
  if (subscription.auto_renew_enabled === 1) {
    const adapter = options.adapter ?? resolveBillingProviderAdapter(subscription.provider);
    if (!adapter.disableAutoRenewal || !subscription.provider_subscription_ref) {
      throw new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED");
    }
    let providerResult: { confirmed: true };
    try {
      providerResult = adapter.disableAutoRenewal({ providerSubscriptionRef: subscription.provider_subscription_ref,
        providerMandateRef: subscription.provider_mandate_ref, cancelAtPeriodEnd: true });
    } catch {
      throw new BillingAssignmentError("PROVIDER_UPDATE_FAILED");
    }
    if (!providerResult.confirmed) throw new BillingAssignmentError("PROVIDER_UPDATE_FAILED");
  }
  return getDb().transaction(() => {
    getDb().prepare(
      `insert into billing_mutation_requests(actor_id,subscription_id,idempotency_key,operation,request_hash,
       status,created_at,expires_at) values(?,?,?,'disable_auto_renew',?,'processing',?,?)`,
    ).run(parentId, subscriptionId, input.idempotencyKey, requestHash, now.toISOString(),
      new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString());
    if (subscription.auto_renew_enabled === 1) {
      const changed = getDb().prepare(
        `update subscriptions set auto_renew_enabled=0,cancel_at_period_end=1,next_renewal_at=null,
         cancellation_requested_at=?,cancellation_effective_at=current_period_end,
         cancellation_reason_code='self_service',cancellation_version=cancellation_version+1,
         version=version+1,updated_at=? where id=? and version=? and auto_renew_enabled=1`,
      ).run(now.toISOString(), now.toISOString(), subscriptionId, input.expectedVersion).changes;
      if (changed !== 1) throw new BillingAssignmentError("VERSION_CONFLICT");
      getDb().prepare(
        `update subscription_renewal_reminders set status='cancelled',updated_at=?
         where subscription_id=? and status in ('pending','retry_pending')`,
      ).run(now.toISOString(), subscriptionId);
      recordBillingEvent(parentId, "subscription_auto_renew_disabled", {
        subscriptionId, currentPeriodEnd: subscription.current_period_end,
      });
    }
    getDb().prepare(
      `update billing_mutation_requests set status='completed',result_json=?,completed_at=?
       where actor_id=? and subscription_id=? and idempotency_key=?`,
    ).run(JSON.stringify(result), now.toISOString(), parentId, subscriptionId, input.idempotencyKey);
    return result;
  })();
}

function beginJob(principalId: string, jobType: "reconcile" | "renewal_reminder", key: string,
  requestHash: string, now: Date) {
  const existing = getDb().prepare(
    "select request_hash,status,result_json from billing_job_runs where principal_id=? and job_type=? and run_idempotency_key=?",
  ).get(principalId, jobType, key) as { request_hash: string; status: string; result_json: string | null } | undefined;
  if (existing) {
    if (existing.request_hash !== requestHash) throw new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED");
    if (existing.status === "completed" && existing.result_json) return JSON.parse(existing.result_json);
    if (existing.status === "failed") {
      getDb().prepare(
        `update billing_job_runs set status='running',result_json=null,completed_at=null,created_at=?
         where principal_id=? and job_type=? and run_idempotency_key=?`,
      ).run(now.toISOString(), principalId, jobType, key);
      return null;
    }
    throw new BillingAssignmentError("PAYMENT_EVENT_STATE_CONFLICT");
  }
  getDb().prepare(
    `insert into billing_job_runs(principal_id,job_type,run_idempotency_key,request_hash,status,created_at)
     values(?,?,?,?,'running',?)`,
  ).run(principalId, jobType, key, requestHash, now.toISOString());
  return null;
}

function failJob(principalId: string, jobType: string, key: string, errorCode: string, now: Date) {
  getDb().prepare(
    `update billing_job_runs set status='failed',result_json=?,completed_at=?
     where principal_id=? and job_type=? and run_idempotency_key=?`,
  ).run(JSON.stringify({ error: errorCode }), now.toISOString(), principalId, jobType, key);
}

function completeJob(principalId: string, jobType: string, key: string, result: Record<string, unknown>, now: Date) {
  getDb().prepare(
    `update billing_job_runs set status='completed',result_json=?,completed_at=?
     where principal_id=? and job_type=? and run_idempotency_key=?`,
  ).run(JSON.stringify(result), now.toISOString(), principalId, jobType, key);
  return result;
}

export function reconcileBilling(principalId: string, input: {
  provider: string;
  environment: BillingEnvironment;
  startDate: string;
  endDate: string;
  cursor?: string;
  limit: number;
  runIdempotencyKey: string;
}, options: { now?: Date; adapter?: BillingCheckoutProviderAdapter } = {}) {
  const now = options.now ?? new Date();
  requireEnvironment(input.environment);
  if (!input.runIdempotencyKey.trim() || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500 ||
    requireIso(input.endDate).getTime() < requireIso(input.startDate).getTime()) {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  const requestHash = hash(input);
  const replay = beginJob(principalId, "reconcile", input.runIdempotencyKey, requestHash, now);
  if (replay) return replay;
  const adapter = options.adapter ?? resolveBillingProviderAdapter(input.provider);
  if (!adapter.listReconciliationEvents) {
    failJob(principalId, "reconcile", input.runIdempotencyKey, "PAYMENT_PROVIDER_NOT_CONFIGURED", now);
    throw new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED");
  }
  let page;
  try {
    page = adapter.listReconciliationEvents(input);
  } catch {
    failJob(principalId, "reconcile", input.runIdempotencyKey, "PAYMENT_PROVIDER_UNAVAILABLE", now);
    throw new BillingAssignmentError("PAYMENT_PROVIDER_UNAVAILABLE");
  }
  const counts = { processed: 0, matched: 0, deferred: 0, errors: 0 };
  for (const event of page.events) {
    try {
      if (isRecurringAgreementEvent(event)) {
        processVerifiedRecurringAgreementEvent(event, now);
      } else processVerifiedPaymentEvent(event, now);
      counts.processed += 1; counts.matched += 1;
    }
    catch { counts.errors += 1; }
  }
  return completeJob(principalId, "reconcile", input.runIdempotencyKey,
    { ...counts, nextCursor: page.nextCursor }, now);
}

export function runUpcomingRenewalReminderSweep(principalId: string, input: {
  startDueAt: string;
  endDueAt: string;
  cursor?: string;
  limit: number;
  runIdempotencyKey: string;
}, options: { now?: Date; notifier?: RenewalReminderNotifier } = {}) {
  const now = options.now ?? new Date();
  const notifier = options.notifier ?? localRenewalReminderNotifier;
  if (!input.runIdempotencyKey.trim() || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500 ||
    requireIso(input.endDueAt).getTime() < requireIso(input.startDueAt).getTime()) {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  const requestHash = hash(input);
  const replay = beginJob(principalId, "renewal_reminder", input.runIdempotencyKey, requestHash, now);
  if (replay) return replay;
  const rows = getDb().prepare(
    `select r.*,s.purchaser_parent_id,s.auto_renew_enabled,s.cancel_at_period_end,s.next_renewal_at,
     s.status subscription_status,p.name product_name,l.display_name learner_name,u.email,
     pp.unit_amount current_amount,pp.currency current_currency,pp.version current_price_version
     from subscription_renewal_reminders r join subscriptions s on s.id=r.subscription_id
     join products p on p.id=s.product_id join learners l on l.id=s.assigned_learner_id
     join users u on u.id=s.purchaser_parent_id join product_prices pp on pp.id=s.billing_price_id
     where r.status in ('pending','retry_pending') and r.reminder_due_at>=? and r.reminder_due_at<=?
     and r.id>? order by r.reminder_due_at,r.id limit ?`,
  ).all(input.startDueAt, input.endDueAt, input.cursor ?? "", input.limit + 1) as any[];
  const page = rows.slice(0, input.limit);
  const counts = { scanned: page.length, sent: 0, skipped: 0, retried: 0, errors: 0 };
  for (const row of page) {
    const eligible = row.auto_renew_enabled === 1 && row.cancel_at_period_end === 0 &&
      row.subscription_status === "active" && row.next_renewal_at === row.renewal_cycle_at;
    if (!eligible) {
      getDb().prepare("update subscription_renewal_reminders set status='skipped',updated_at=? where id=?")
        .run(now.toISOString(), row.id);
      counts.skipped += 1;
      continue;
    }
    if (row.current_amount !== row.expected_amount || row.current_currency !== row.currency ||
      row.current_price_version !== row.price_version) {
      getDb().prepare(
        `update subscription_renewal_reminders set expected_amount=?,currency=?,price_version=?,updated_at=? where id=?`,
      ).run(row.current_amount, row.current_currency, row.current_price_version, now.toISOString(), row.id);
    }
    try {
      notifier.send({ reminderId: row.id, parentId: row.purchaser_parent_id, recipientEmail: row.email,
        subscriptionId: row.subscription_id, renewalAt: row.renewal_cycle_at, amount: row.current_amount,
        currency: row.current_currency, productName: row.product_name, learnerName: row.learner_name,
        manageUrl: `/account/subscriptions#${row.subscription_id}` });
      getDb().transaction(() => {
        getDb().prepare(
          `update subscription_renewal_reminders set status='sent',attempt_count=attempt_count+1,sent_at=?,
           last_error_code=null,updated_at=? where id=? and status in ('pending','retry_pending')`,
        ).run(now.toISOString(), now.toISOString(), row.id);
        recordBillingEvent(row.purchaser_parent_id, "upcoming_renewal_reminder_sent", {
          reminderId: row.id, subscriptionId: row.subscription_id, renewalAt: row.renewal_cycle_at,
          amount: row.current_amount, currency: row.current_currency, productName: row.product_name,
          learnerName: row.learner_name, manageUrl: `/account/subscriptions#${row.subscription_id}`,
        });
      })();
      counts.sent += 1;
      if (row.status === "retry_pending") counts.retried += 1;
    } catch {
      getDb().prepare(
        `update subscription_renewal_reminders set status='retry_pending',attempt_count=attempt_count+1,
         last_error_code='DELIVERY_FAILED',updated_at=? where id=?`,
      ).run(now.toISOString(), row.id);
      counts.errors += 1;
    }
  }
  const nextCursor = rows.length > input.limit ? page.at(-1)?.id ?? null : null;
  return completeJob(principalId, "renewal_reminder", input.runIdempotencyKey,
    { ...counts, nextCursor }, now);
}
