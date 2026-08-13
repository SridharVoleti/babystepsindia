import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import type { Subscription } from "@/lib/db/types";
import { BillingAssignmentError } from "@/lib/billing/errors";
import { BILLING_REMINDER_LEAD_MS } from "@/lib/billing/contracts";
import { expireCancellationState } from "@/lib/billing/cancellation-policy";
import { applyLifecycleEvent } from "@/lib/entitlement-lifecycle/service";
import { enqueueTransactionalNotification } from "@/lib/notifications/service";
import {
  resolveBillingProviderAdapter,
  type BillingCheckoutProviderAdapter,
  type VerifiedProviderRecurringAgreementEvent,
} from "@/lib/billing/provider-adapter";

type CancellationSubscription = Subscription & {
  product_name: string;
  learner_name: string;
  unit_amount: number;
  currency: string;
  recipient_email: string;
};

type MutationReceipt = { request_hash: string; result_json: string | null; status: string };

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireIso(value: string, code = "INVALID_REQUEST") {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new BillingAssignmentError(code);
  return date;
}

function subscriptionForParent(parentId: string, subscriptionId: string): CancellationSubscription {
  const row = getDb().prepare(
    `select s.*,p.name product_name,l.display_name learner_name,pp.unit_amount,pp.currency,u.email recipient_email
     from subscriptions s join products p on p.id=s.product_id join learners l on l.id=s.assigned_learner_id
     join users u on u.id=s.purchaser_parent_id left join product_prices pp on pp.id=s.billing_price_id
     where s.id=? and s.purchaser_parent_id=?`,
  ).get(subscriptionId, parentId) as CancellationSubscription | undefined;
  if (!row) throw new BillingAssignmentError("RESOURCE_NOT_FOUND");
  return row;
}

function replayMutation(parentId: string, subscriptionId: string, idempotencyKey: string, requestHash: string) {
  const existing = getDb().prepare(
    `select request_hash,result_json,status from billing_mutation_requests
     where actor_id=? and subscription_id=? and idempotency_key=?`,
  ).get(parentId, subscriptionId, idempotencyKey) as MutationReceipt | undefined;
  if (!existing) return null;
  if (existing.request_hash !== requestHash) throw new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED");
  if (existing.result_json) return JSON.parse(existing.result_json);
  throw new BillingAssignmentError("PAYMENT_EVENT_STATE_CONFLICT");
}

function insertMutation(parentId: string, subscriptionId: string, idempotencyKey: string,
  operation: string, requestHash: string, now: Date) {
  getDb().prepare(
    `insert into billing_mutation_requests(actor_id,subscription_id,idempotency_key,operation,request_hash,
     status,created_at,expires_at) values(?,?,?,?,?,'processing',?,?)`,
  ).run(parentId, subscriptionId, idempotencyKey, operation, requestHash, now.toISOString(),
    new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString());
}

function completeMutation(parentId: string, subscriptionId: string, idempotencyKey: string,
  result: Record<string, unknown>, now: Date) {
  getDb().prepare(
    `update billing_mutation_requests set status='completed',result_json=?,completed_at=?
     where actor_id=? and subscription_id=? and idempotency_key=?`,
  ).run(JSON.stringify(result), now.toISOString(), parentId, subscriptionId, idempotencyKey);
  return result;
}

function recordEvent(parentId: string, eventType: string, metadata: Record<string, unknown>) {
  getDb().prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,?,?)")
    .run(randomUUID(), parentId, eventType, JSON.stringify(metadata));
}

function queueNotification(subscription: CancellationSubscription, cancellationVersion: number,
  type: "scheduled" | "setup_required" | "reversed", channel: "email" | "in_product", now: Date,
  extra: Record<string, unknown> = {}) {
  const context = JSON.stringify({ subscriptionId: subscription.id,
    learnerId: subscription.assigned_learner_id, learnerName: subscription.learner_name,
    productId: subscription.product_id, productName: subscription.product_name,
    cancellationEffectiveAt: subscription.cancellation_effective_at ?? subscription.current_period_end,
    ...extra });
  getDb().prepare(
    `insert or ignore into billing_cancellation_notifications(id,subscription_id,cancellation_version,
     notification_type,channel,recipient_email,status,safe_context_json,created_at,updated_at)
     values(?,?,?,?,?,?,'pending',?,?,?)`,
  ).run(randomUUID(), subscription.id, cancellationVersion, type, channel,
    channel === "email" ? subscription.recipient_email : null, context, now.toISOString(), now.toISOString());
}

function syncReminderAfterResumption(subscription: CancellationSubscription, now: Date) {
  if (!subscription.billing_price_id || !subscription.billing_price_version) {
    throw new BillingAssignmentError("PAYMENT_EVENT_STATE_CONFLICT");
  }
  const renewalAt = subscription.current_period_end;
  const dueAt = new Date(requireIso(renewalAt).getTime() - BILLING_REMINDER_LEAD_MS).toISOString();
  if (now.toISOString() < dueAt) {
    getDb().prepare(
      `insert into subscription_renewal_reminders(id,subscription_id,renewal_cycle_at,reminder_due_at,
       expected_amount,currency,price_id,price_version,channel,status,created_at,updated_at)
       values(?,?,?,?,?,?,?,?,'email','pending',?,?)
       on conflict(subscription_id,renewal_cycle_at) do update set
         reminder_due_at=excluded.reminder_due_at,expected_amount=excluded.expected_amount,
         currency=excluded.currency,price_id=excluded.price_id,price_version=excluded.price_version,
         status=case when subscription_renewal_reminders.status='sent' then 'sent' else 'pending' end,
         last_error_code=null,updated_at=excluded.updated_at`,
    ).run(randomUUID(), subscription.id, renewalAt, dueAt, subscription.unit_amount, subscription.currency,
      subscription.billing_price_id, subscription.billing_price_version, now.toISOString(), now.toISOString());
    return { scheduled: true, reminderDueAt: dueAt, nextChargeAt: renewalAt,
      expectedAmount: subscription.unit_amount, currency: subscription.currency };
  }
  getDb().prepare(
    `update subscription_renewal_reminders set status='skipped',last_error_code='LATE_RESUMPTION',updated_at=?
     where subscription_id=? and renewal_cycle_at=? and status in ('pending','retry_pending')`,
  ).run(now.toISOString(), subscription.id, renewalAt);
  return { scheduled: false, lateConfirmationRequired: true, nextChargeAt: renewalAt,
    expectedAmount: subscription.unit_amount, currency: subscription.currency };
}

export function cancelSubscriptionAtPeriodEnd(parentId: string, subscriptionId: string, input: {
  expectedVersion: number; idempotencyKey: string;
}, options: { now?: Date; adapter?: BillingCheckoutProviderAdapter } = {}) {
  const now = options.now ?? new Date();
  if (!input.idempotencyKey.trim() || !Number.isInteger(input.expectedVersion)) {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  const requestHash = hash({ operation: "cancel_subscription", expectedVersion: input.expectedVersion });
  const replay = replayMutation(parentId, subscriptionId, input.idempotencyKey, requestHash);
  if (replay) return replay;
  const subscription = subscriptionForParent(parentId, subscriptionId);
  if (subscription.version !== input.expectedVersion) throw new BillingAssignmentError("VERSION_CONFLICT");
  if (subscription.cancel_at_period_end === 1) {
    const result = { subscriptionId, autoRenewEnabled: false, cancelAtPeriodEnd: true,
      cancellationEffectiveAt: subscription.cancellation_effective_at ?? subscription.current_period_end,
      currentPeriodEnd: subscription.current_period_end, learner: { id: subscription.assigned_learner_id,
        displayName: subscription.learner_name }, product: { id: subscription.product_id,
        name: subscription.product_name }, version: subscription.version };
    return getDb().transaction(() => {
      insertMutation(parentId, subscriptionId, input.idempotencyKey, "cancel_subscription", requestHash, now);
      return completeMutation(parentId, subscriptionId, input.idempotencyKey, result, now);
    })();
  }
  if (subscription.status !== "active" || subscription.payment_state !== "paid" ||
    now.getTime() >= requireIso(subscription.current_period_end).getTime()) {
    throw new BillingAssignmentError("SUBSCRIPTION_CANCELLATION_NOT_ALLOWED");
  }
  const adapter = options.adapter ?? resolveBillingProviderAdapter(subscription.provider);
  if (!adapter.disableAutoRenewal || !subscription.provider_subscription_ref) {
    throw new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED");
  }
  try {
    const providerResult = adapter.disableAutoRenewal({
      providerSubscriptionRef: subscription.provider_subscription_ref,
      providerMandateRef: subscription.provider_mandate_ref,
      cancelAtPeriodEnd: true,
      idempotencyKey: input.idempotencyKey,
    });
    if (!providerResult.confirmed) throw new Error("not confirmed");
  } catch {
    throw new BillingAssignmentError("PROVIDER_UPDATE_FAILED");
  }
  const cancellationVersion = subscription.cancellation_version + 1;
  const result = { subscriptionId, autoRenewEnabled: false, cancelAtPeriodEnd: true,
    cancellationEffectiveAt: subscription.current_period_end, currentPeriodEnd: subscription.current_period_end,
    learner: { id: subscription.assigned_learner_id, displayName: subscription.learner_name },
    product: { id: subscription.product_id, name: subscription.product_name },
    progressPreserved: true, version: subscription.version + 1 };
  return getDb().transaction(() => {
    insertMutation(parentId, subscriptionId, input.idempotencyKey, "cancel_subscription", requestHash, now);
    const changed = getDb().prepare(
      `update subscriptions set auto_renew_enabled=0,cancel_at_period_end=1,next_renewal_at=null,
       cancellation_requested_at=?,cancellation_effective_at=current_period_end,cancellation_reason_code='self_service',
       cancellation_version=?,version=version+1,updated_at=? where id=? and version=? and cancel_at_period_end=0`,
    ).run(now.toISOString(), cancellationVersion, now.toISOString(), subscriptionId,
      input.expectedVersion).changes;
    if (changed !== 1) throw new BillingAssignmentError("VERSION_CONFLICT");
    getDb().prepare(
      `update subscription_renewal_reminders set status='cancelled',updated_at=?
       where subscription_id=? and status in ('pending','retry_pending')`,
    ).run(now.toISOString(), subscriptionId);
    recordEvent(parentId, "subscription_cancellation_scheduled", {
      subscriptionId, cancellationEffectiveAt: subscription.current_period_end,
      learnerId: subscription.assigned_learner_id, productId: subscription.product_id,
    });
    queueNotification(subscription, cancellationVersion, "scheduled", "email", now);
    // NT-001 rule 35: BI-004 owns the cancellation trigger and exact
    // access-end semantics; NT-001 only delivers it.
    enqueueTransactionalNotification({
      notificationType: "subscription_cancellation_scheduled", sourceDomain: "billing",
      sourceEventKey: `cancellation-scheduled:${subscriptionId}:${cancellationVersion}`,
      sourceVersion: cancellationVersion, parentId,
      safeVariables: { subscriptionLabel: subscription.product_name,
        accessEndsAt: subscription.current_period_end },
    }, now);
    return completeMutation(parentId, subscriptionId, input.idempotencyKey, result, now);
  })();
}

function completeResumption(subscription: CancellationSubscription, idempotencyKey: string,
  now: Date, providerMandateRef: string) {
  const cancellationVersion = subscription.cancellation_version + 1;
  const reminder = syncReminderAfterResumption(subscription, now);
  const result = { subscriptionId: subscription.id, autoRenewEnabled: true, cancelAtPeriodEnd: false,
    cancellationEffectiveAt: null, providerHostedSetupRequired: false,
    nextChargeAt: reminder.nextChargeAt, expectedAmount: reminder.expectedAmount, currency: reminder.currency,
    reminderScheduled: reminder.scheduled, lateConfirmationRequired: reminder.lateConfirmationRequired ?? false,
    version: subscription.version + 1 };
  const changed = getDb().prepare(
    `update subscriptions set auto_renew_enabled=1,cancel_at_period_end=0,next_renewal_at=current_period_end,
     cancellation_requested_at=null,cancellation_effective_at=null,cancellation_reason_code=null,
     cancellation_reversed_at=?,provider_mandate_ref=?,provider_mandate_status='valid',
     cancellation_version=?,version=version+1,updated_at=?
     where id=? and version=? and cancel_at_period_end=1 and current_period_end>?`,
  ).run(now.toISOString(), providerMandateRef, cancellationVersion, now.toISOString(), subscription.id,
    subscription.version, now.toISOString()).changes;
  if (changed !== 1) throw new BillingAssignmentError("CANCELLATION_REVERSAL_WINDOW_EXPIRED");
  recordEvent(subscription.purchaser_parent_id, "subscription_cancellation_reversed", {
    subscriptionId: subscription.id, nextChargeAt: subscription.current_period_end,
    expectedAmount: subscription.unit_amount, currency: subscription.currency,
    reminderScheduled: reminder.scheduled,
  });
  // EN-003 rule 8/68/12: audit-only fold into the shared lifecycle ledger.
  applyLifecycleEvent({ eventId: `cancellation-reversed:${subscription.id}:${cancellationVersion}`,
    eventType: "cancellation_reversed", source: "billing_cancellation", sourceVersion: cancellationVersion,
    effectiveAt: now.toISOString(),
    sourceReference: { subscriptionId: subscription.id, learnerId: subscription.assigned_learner_id,
      reasonCategory: "cancellation_reversed" },
    now });
  queueNotification(subscription, cancellationVersion, "reversed", "email", now, {
    nextChargeAt: subscription.current_period_end, expectedAmount: subscription.unit_amount,
    currency: subscription.currency, lateConfirmationRequired: reminder.lateConfirmationRequired ?? false,
  });
  // NT-001 rule 35: BI-004 owns the reversal trigger; NT-001 only delivers it.
  enqueueTransactionalNotification({
    notificationType: "subscription_cancellation_reversed", sourceDomain: "billing",
    sourceEventKey: `cancellation-reversed:${subscription.id}:${cancellationVersion}`,
    sourceVersion: cancellationVersion, parentId: subscription.purchaser_parent_id,
    safeVariables: { subscriptionLabel: subscription.product_name },
  }, now);
  return completeMutation(subscription.purchaser_parent_id, subscription.id, idempotencyKey, result, now);
}

export function resumeSubscriptionAutoRenewal(parentId: string, subscriptionId: string, input: {
  expectedVersion: number; idempotencyKey: string;
}, options: { now?: Date; adapter?: BillingCheckoutProviderAdapter } = {}) {
  const now = options.now ?? new Date();
  if (!input.idempotencyKey.trim() || !Number.isInteger(input.expectedVersion)) {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  const requestHash = hash({ operation: "resume_auto_renew", expectedVersion: input.expectedVersion });
  const replay = replayMutation(parentId, subscriptionId, input.idempotencyKey, requestHash);
  if (replay) return replay;
  const subscription = subscriptionForParent(parentId, subscriptionId);
  if (subscription.version !== input.expectedVersion) throw new BillingAssignmentError("VERSION_CONFLICT");
  if (subscription.cancel_at_period_end !== 1) throw new BillingAssignmentError("SUBSCRIPTION_NOT_CANCELLED");
  if (now.getTime() >= requireIso(subscription.current_period_end).getTime()) {
    expireCancellationState(subscription.id, now);
    throw new BillingAssignmentError("CANCELLATION_REVERSAL_WINDOW_EXPIRED");
  }
  if (!subscription.provider_subscription_ref) throw new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED");
  const adapter = options.adapter ?? resolveBillingProviderAdapter(subscription.provider);
  if (!adapter.getRecurringAgreementStatus) throw new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED");
  let mandateStatus: "valid" | "invalid";
  try {
    mandateStatus = adapter.getRecurringAgreementStatus({
      providerSubscriptionRef: subscription.provider_subscription_ref,
      providerMandateRef: subscription.provider_mandate_ref,
    }).status;
  } catch {
    throw new BillingAssignmentError("PAYMENT_PROVIDER_UNAVAILABLE");
  }
  if (mandateStatus === "valid" && subscription.provider_mandate_ref) {
    if (!adapter.enableAutoRenewal) throw new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED");
    try {
      if (!adapter.enableAutoRenewal({ providerSubscriptionRef: subscription.provider_subscription_ref,
        providerMandateRef: subscription.provider_mandate_ref,
        idempotencyKey: input.idempotencyKey }).confirmed) throw new Error("not confirmed");
    } catch {
      throw new BillingAssignmentError("PROVIDER_UPDATE_FAILED");
    }
    return getDb().transaction(() => {
      insertMutation(parentId, subscriptionId, input.idempotencyKey, "resume_auto_renew", requestHash, now);
      return completeResumption(subscription, input.idempotencyKey, now,
        subscription.provider_mandate_ref!);
    })();
  }
  if (!adapter.createRecurringAgreementSetupSession) {
    throw new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED");
  }
  const expiresAt = new Date(Math.min(now.getTime() + 15 * 60_000,
    requireIso(subscription.current_period_end).getTime())).toISOString();
  let setup: { providerSessionRef: string; handoffUrl: string; expiresAt: string };
  try {
    setup = adapter.createRecurringAgreementSetupSession({ purchaserParentId: parentId,
      subscriptionId, providerCustomerRef: subscription.provider_customer_ref,
      providerSubscriptionRef: subscription.provider_subscription_ref, expiresAt,
      idempotencyKey: input.idempotencyKey });
  } catch {
    throw new BillingAssignmentError("RECURRING_PAYMENT_SETUP_FAILED");
  }
  if (!setup.providerSessionRef || !setup.handoffUrl || requireIso(setup.expiresAt).getTime() >
    requireIso(subscription.current_period_end).getTime()) {
    throw new BillingAssignmentError("RECURRING_PAYMENT_SETUP_FAILED");
  }
  const cancellationVersion = subscription.cancellation_version + 1;
  const result = { subscriptionId, autoRenewEnabled: false, cancelAtPeriodEnd: true,
    cancellationEffectiveAt: subscription.current_period_end, providerHostedSetupRequired: true,
    setupUrl: setup.handoffUrl, setupExpiresAt: setup.expiresAt, version: subscription.version + 1 };
  return getDb().transaction(() => {
    insertMutation(parentId, subscriptionId, input.idempotencyKey, "resume_auto_renew", requestHash, now);
    getDb().prepare(
      `insert into recurring_agreement_setup_sessions(id,parent_id,subscription_id,provider,provider_environment,
       provider_session_ref,provider_handoff_url,idempotency_key,request_hash,status,expires_at,result_json,
       created_at,updated_at) values(?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`,
    ).run(randomUUID(), parentId, subscriptionId, subscription.provider, subscription.provider_environment,
      setup.providerSessionRef, setup.handoffUrl, input.idempotencyKey, requestHash, setup.expiresAt,
      JSON.stringify(result), now.toISOString(), now.toISOString());
    const changed = getDb().prepare(
      `update subscriptions set provider_mandate_status='pending_setup',cancellation_version=?,
       version=version+1,updated_at=? where id=? and version=? and cancel_at_period_end=1`,
    ).run(cancellationVersion, now.toISOString(), subscriptionId, input.expectedVersion).changes;
    if (changed !== 1) throw new BillingAssignmentError("VERSION_CONFLICT");
    recordEvent(parentId, "subscription_cancellation_reversal_pending_mandate", {
      subscriptionId, setupExpiresAt: setup.expiresAt,
    });
    queueNotification(subscription, cancellationVersion, "setup_required", "in_product", now,
      { setupExpiresAt: setup.expiresAt });
    return completeMutation(parentId, subscriptionId, input.idempotencyKey, result, now);
  })();
}

function recurringEventResult(event: VerifiedProviderRecurringAgreementEvent,
  result: Record<string, unknown>, now: Date) {
  const value = { providerEventId: event.providerEventId, ...result };
  getDb().prepare(
    `update payment_provider_events set status='processed',result_code=?,result_json=?,processed_at=?
     where provider=? and environment=? and account_id=? and provider_event_id=?`,
  ).run(String(result.resultCode), JSON.stringify(value), now.toISOString(), event.provider,
    event.environment, event.accountId, event.providerEventId);
  return value;
}

export function processVerifiedRecurringAgreementEvent(event: VerifiedProviderRecurringAgreementEvent,
  now = new Date()) {
  requireIso(event.occurredAt);
  const payloadHash = hash(event);
  const existing = getDb().prepare(
    `select payload_hash,status,result_json,error_code from payment_provider_events
     where provider=? and environment=? and account_id=? and provider_event_id=?`,
  ).get(event.provider, event.environment, event.accountId, event.providerEventId) as
    { payload_hash: string; status: string; result_json: string | null; error_code: string | null } | undefined;
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED");
    if (existing.result_json) return JSON.parse(existing.result_json);
    if (existing.status === "rejected") throw new BillingAssignmentError(existing.error_code ?? "PAYMENT_EVENT_STATE_CONFLICT");
  } else {
    getDb().prepare(
      `insert into payment_provider_events(provider,environment,account_id,provider_event_id,event_type,payload_hash,
       subscription_id,provider_payment_ref,status,received_at) values(?,?,?,?,?,?,?,null,'received',?)`,
    ).run(event.provider, event.environment, event.accountId, event.providerEventId, event.eventType,
      payloadHash, event.subscriptionId, now.toISOString());
  }
  try {
    const subscription = getDb().prepare(
      `select s.*,p.name product_name,l.display_name learner_name,pp.unit_amount,pp.currency,u.email recipient_email
       from subscriptions s join products p on p.id=s.product_id join learners l on l.id=s.assigned_learner_id
       join users u on u.id=s.purchaser_parent_id left join product_prices pp on pp.id=s.billing_price_id
       where s.id=?`,
    ).get(event.subscriptionId) as CancellationSubscription | undefined;
    if (!subscription || subscription.provider !== event.provider ||
      subscription.provider_environment !== event.environment || subscription.provider_account_id !== event.accountId ||
      subscription.provider_subscription_ref !== event.providerSubscriptionRef) {
      throw new BillingAssignmentError("PAYMENT_EVENT_CONTEXT_MISMATCH");
    }
    const setup = getDb().prepare(
      `select * from recurring_agreement_setup_sessions where subscription_id=? and provider_session_ref=?
       and status='pending'`,
    ).get(event.subscriptionId, event.providerSetupSessionRef ?? "") as any;
    if (!setup) throw new BillingAssignmentError("PAYMENT_EVENT_CONTEXT_MISMATCH");
    if (event.eventType === "recurring_agreement_failed") {
      return getDb().transaction(() => {
        getDb().prepare(
          "update recurring_agreement_setup_sessions set status='failed',updated_at=? where id=? and status='pending'",
        ).run(now.toISOString(), setup.id);
        getDb().prepare(
          `update subscriptions set provider_mandate_status='invalid',version=version+1,updated_at=?
           where id=? and cancel_at_period_end=1`,
        ).run(now.toISOString(), subscription.id);
        recordEvent(subscription.purchaser_parent_id, "subscription_cancellation_reversal_setup_failed", {
          subscriptionId: subscription.id, failureCode: event.failureCode ?? "provider_rejected",
        });
        return recurringEventResult(event, { resultCode: "RECURRING_AGREEMENT_SETUP_FAILED",
          subscriptionId: subscription.id, cancelAtPeriodEnd: true }, now);
      })();
    }
    if (!event.providerMandateRef || now.getTime() >= requireIso(subscription.current_period_end).getTime() ||
      requireIso(event.occurredAt).getTime() > requireIso(setup.expires_at).getTime()) {
      throw new BillingAssignmentError("CANCELLATION_REVERSAL_WINDOW_EXPIRED");
    }
    return getDb().transaction(() => {
      const current = subscriptionForParent(subscription.purchaser_parent_id, subscription.id);
      const syntheticKey = `provider:${event.providerEventId}`;
      const syntheticHash = hash({ operation: "provider_confirmed_resumption", providerEventId: event.providerEventId });
      insertMutation(subscription.purchaser_parent_id, subscription.id, syntheticKey,
        "provider_confirmed_resumption", syntheticHash, now);
      const result = completeResumption(current, syntheticKey, now, event.providerMandateRef!);
      getDb().prepare(
        "update recurring_agreement_setup_sessions set status='confirmed',updated_at=? where id=? and status='pending'",
      ).run(now.toISOString(), setup.id);
      return recurringEventResult(event, { resultCode: "SUBSCRIPTION_CANCELLATION_REVERSED",
        subscriptionId: subscription.id, result }, now);
    })();
  } catch (error) {
    if (error instanceof BillingAssignmentError) {
      getDb().prepare(
        `update payment_provider_events set status='rejected',error_code=?,processed_at=?
         where provider=? and environment=? and account_id=? and provider_event_id=?`,
      ).run(error.code, now.toISOString(), event.provider, event.environment, event.accountId, event.providerEventId);
    }
    throw error;
  }
}

export function getCancellationBillingStatus(parentId: string, subscriptionId: string, now = new Date()) {
  const initial = subscriptionForParent(parentId, subscriptionId);
  getDb().transaction(() => {
    const expired = getDb().prepare(
      `update recurring_agreement_setup_sessions set status='expired',updated_at=?
       where subscription_id=? and status='pending' and expires_at<=?`,
    ).run(now.toISOString(), subscriptionId, now.toISOString()).changes;
    if (expired > 0) {
      const stillPending = getDb().prepare(
        "select 1 from recurring_agreement_setup_sessions where subscription_id=? and status='pending' limit 1",
      ).get(subscriptionId);
      if (!stillPending) getDb().prepare(
        `update subscriptions set provider_mandate_status='invalid',version=version+1,updated_at=?
         where id=? and provider_mandate_status='pending_setup' and cancel_at_period_end=1`,
      ).run(now.toISOString(), subscriptionId);
    }
  })();
  if (initial.cancel_at_period_end === 1 && initial.cancellation_effective_at &&
    initial.cancellation_effective_at <= now.toISOString()) expireCancellationState(subscriptionId, now);
  const row = subscriptionForParent(parentId, subscriptionId);
  return {
    cancellationEffectiveAt: row.cancellation_effective_at,
    canResumeAutoRenew: row.cancel_at_period_end === 1 && row.status === "active" &&
      now.getTime() < requireIso(row.current_period_end).getTime(),
    providerMandateStatus: row.provider_mandate_status,
    nextChargeAt: row.auto_renew_enabled === 1 && row.cancel_at_period_end === 0 ? row.current_period_end : null,
  };
}
