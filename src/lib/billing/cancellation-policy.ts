import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import type { Subscription } from "@/lib/db/types";
import { cancelStartingSessionsForSubscription } from "@/lib/billing/grace-policy";
import { applyLifecycleEvent } from "@/lib/entitlement-lifecycle/service";

async function queueEndedNotification(db: DbClient, subscription: Subscription, cancellationVersion: number, now: Date) {
  const recipient = await db.get<{ email: string }>("select email from users where id=?",
    [subscription.purchaser_parent_id]);
  const context = JSON.stringify({ subscriptionId: subscription.id,
    learnerId: subscription.assigned_learner_id, productId: subscription.product_id,
    cancellationEffectiveAt: subscription.cancellation_effective_at });
  await db.run(
    `insert or ignore into billing_cancellation_notifications(id,subscription_id,cancellation_version,
     notification_type,channel,recipient_email,status,safe_context_json,created_at,updated_at)
     values(?,?,?,'ended','email',?,'pending',?,?,?)`,
    [randomUUID(), subscription.id, cancellationVersion, recipient?.email ?? null, context,
      now.toISOString(), now.toISOString()]);
}

// Shared lazy cutoff used by access and billing reads. The paid entitlement
// already uses [period_start,period_end), while this transition closes billing
// state, releases only unconsumed starts, and preserves active/resumable
// sessions and every progress record.
export async function expireCancellationState(subscriptionId: string, now: Date) {
  return resolveDbClient().transaction(async (db) => {
    const subscription = await db.get<Subscription>("select * from subscriptions where id=?", [subscriptionId]);
    if (!subscription) return { outcome: "not_found" as const, subscriptionId };
    if (subscription.status === "cancelled" && subscription.cancelled_at) {
      return { outcome: "already_ended" as const, subscriptionId, cancelledReservations: 0 };
    }
    if (subscription.cancel_at_period_end !== 1 || !subscription.cancellation_effective_at ||
      subscription.cancellation_effective_at > now.toISOString()) {
      return { outcome: "not_due" as const, subscriptionId };
    }
    const cancellationVersion = subscription.cancellation_version + 1;
    const changed = (await db.run(
      `update subscriptions set status='cancelled',auto_renew_enabled=0,next_renewal_at=null,cancelled_at=?,
       cancellation_version=?,version=version+1,updated_at=?
       where id=? and cancel_at_period_end=1 and cancellation_effective_at<=?
         and status in ('active','cancelling','past_due')`,
      [now.toISOString(), cancellationVersion, now.toISOString(), subscriptionId,
        now.toISOString()])).changes;
    if (changed !== 1) return { outcome: "race_lost" as const, subscriptionId };
    const cancelledReservations = await cancelStartingSessionsForSubscription(subscription, now, "subscription_cancelled");
    await db.run(
      `update subscription_renewal_reminders set status='cancelled',updated_at=?
       where subscription_id=? and status in ('pending','retry_pending')`,
      [now.toISOString(), subscriptionId]);
    await db.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,?,?)",
      [randomUUID(), subscription.purchaser_parent_id, "subscription_ended_by_cancellation",
        JSON.stringify({ subscriptionId, learnerId: subscription.assigned_learner_id,
          productId: subscription.product_id, cancellationEffectiveAt: subscription.cancellation_effective_at,
          cancelledReservations })]);
    await queueEndedNotification(db, subscription, cancellationVersion, now);
    // EN-003 rule 8/68/9-17: audit-only fold into the shared lifecycle
    // ledger — the live access-denial path (evaluateAccessFresh) is
    // untouched, this just records the transition for reconciliation/audit.
    await applyLifecycleEvent({ eventId: `cancellation-effective:${subscriptionId}:${cancellationVersion}`,
      eventType: "cancellation_effective", source: "billing_cancellation", sourceVersion: cancellationVersion,
      effectiveAt: subscription.cancellation_effective_at!,
      sourceReference: { subscriptionId, learnerId: subscription.assigned_learner_id,
        reasonCategory: subscription.cancellation_reason_code ?? "self_service" },
      now });
    return { outcome: "ended" as const, subscriptionId, cancelledReservations };
  });
}

export async function expireDueCancellationForLearnerApp(input: {
  learnerId: string; appId: string; now: Date;
}) {
  const due = await resolveDbClient().get<{ id: string }>(
    `select s.id from subscriptions s join product_version_apps pva
       on pva.product_id=s.product_id and pva.product_version=s.product_version
     where s.assigned_learner_id=? and pva.app_id=? and s.cancel_at_period_end=1
       and s.cancellation_effective_at<=? and s.status in ('active','cancelling','past_due')
     order by s.cancellation_effective_at,s.id limit 1`,
    [input.learnerId, input.appId, input.now.toISOString()]);
  return due ? expireCancellationState(due.id, input.now) : null;
}
