import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import type { Subscription } from "@/lib/db/types";
import { cancelStartingSessionsForSubscription } from "@/lib/billing/grace-policy";
import { applyLifecycleEvent } from "@/lib/entitlement-lifecycle/service";

function queueEndedNotification(subscription: Subscription, cancellationVersion: number, now: Date) {
  const recipient = getDb().prepare("select email from users where id=?")
    .get(subscription.purchaser_parent_id) as { email: string } | undefined;
  const context = JSON.stringify({ subscriptionId: subscription.id,
    learnerId: subscription.assigned_learner_id, productId: subscription.product_id,
    cancellationEffectiveAt: subscription.cancellation_effective_at });
  getDb().prepare(
    `insert or ignore into billing_cancellation_notifications(id,subscription_id,cancellation_version,
     notification_type,channel,recipient_email,status,safe_context_json,created_at,updated_at)
     values(?,?,?,'ended','email',?,'pending',?,?,?)`,
  ).run(randomUUID(), subscription.id, cancellationVersion, recipient?.email ?? null, context,
    now.toISOString(), now.toISOString());
}

// Shared lazy cutoff used by access and billing reads. The paid entitlement
// already uses [period_start,period_end), while this transition closes billing
// state, releases only unconsumed starts, and preserves active/resumable
// sessions and every progress record.
export function expireCancellationState(subscriptionId: string, now: Date) {
  return getDb().transaction(() => {
    const subscription = getDb().prepare("select * from subscriptions where id=?").get(subscriptionId) as
      Subscription | undefined;
    if (!subscription) return { outcome: "not_found" as const, subscriptionId };
    if (subscription.status === "cancelled" && subscription.cancelled_at) {
      return { outcome: "already_ended" as const, subscriptionId, cancelledReservations: 0 };
    }
    if (subscription.cancel_at_period_end !== 1 || !subscription.cancellation_effective_at ||
      subscription.cancellation_effective_at > now.toISOString()) {
      return { outcome: "not_due" as const, subscriptionId };
    }
    const cancellationVersion = subscription.cancellation_version + 1;
    const changed = getDb().prepare(
      `update subscriptions set status='cancelled',auto_renew_enabled=0,next_renewal_at=null,cancelled_at=?,
       cancellation_version=?,version=version+1,updated_at=?
       where id=? and cancel_at_period_end=1 and cancellation_effective_at<=?
         and status in ('active','cancelling','past_due')`,
    ).run(now.toISOString(), cancellationVersion, now.toISOString(), subscriptionId,
      now.toISOString()).changes;
    if (changed !== 1) return { outcome: "race_lost" as const, subscriptionId };
    const cancelledReservations = cancelStartingSessionsForSubscription(subscription, now, "subscription_cancelled");
    getDb().prepare(
      `update subscription_renewal_reminders set status='cancelled',updated_at=?
       where subscription_id=? and status in ('pending','retry_pending')`,
    ).run(now.toISOString(), subscriptionId);
    getDb().prepare("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,?,?)")
      .run(randomUUID(), subscription.purchaser_parent_id, "subscription_ended_by_cancellation",
        JSON.stringify({ subscriptionId, learnerId: subscription.assigned_learner_id,
          productId: subscription.product_id, cancellationEffectiveAt: subscription.cancellation_effective_at,
          cancelledReservations }));
    queueEndedNotification(subscription, cancellationVersion, now);
    // EN-003 rule 8/68/9-17: audit-only fold into the shared lifecycle
    // ledger — the live access-denial path (evaluateAccessFresh) is
    // untouched, this just records the transition for reconciliation/audit.
    applyLifecycleEvent({ eventId: `cancellation-effective:${subscriptionId}:${cancellationVersion}`,
      eventType: "cancellation_effective", source: "billing_cancellation", sourceVersion: cancellationVersion,
      effectiveAt: subscription.cancellation_effective_at!,
      sourceReference: { subscriptionId, learnerId: subscription.assigned_learner_id,
        reasonCategory: subscription.cancellation_reason_code ?? "self_service" },
      now });
    return { outcome: "ended" as const, subscriptionId, cancelledReservations };
  })();
}

export function expireDueCancellationForLearnerApp(input: {
  learnerId: string; appId: string; now: Date;
}) {
  const due = getDb().prepare(
    `select s.id from subscriptions s join product_version_apps pva
       on pva.product_id=s.product_id and pva.product_version=s.product_version
     where s.assigned_learner_id=? and pva.app_id=? and s.cancel_at_period_end=1
       and s.cancellation_effective_at<=? and s.status in ('active','cancelling','past_due')
     order by s.cancellation_effective_at,s.id limit 1`,
  ).get(input.learnerId, input.appId, input.now.toISOString()) as { id: string } | undefined;
  return due ? expireCancellationState(due.id, input.now) : null;
}
