import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import type { Subscription } from "@/lib/db/types";
import { applyLifecycleEvent } from "@/lib/entitlement-lifecycle/service";
import { enqueueTransactionalNotification } from "@/lib/notifications/service";

// Same light, non-throwing product-name lookup as bi002-service.ts's
// productDisplayName — a grace-expired notification about an already-
// purchased subscription must not fail just because the product was later
// deactivated.
async function productDisplayName(db: DbClient, productId: string, productVersion: number): Promise<string> {
  const row = await db.get<{ name: string }>("select name from products where id=? and version=?",
    [productId, productVersion]);
  return row?.name ?? "Babysteps subscription";
}

type GraceCoverage = {
  subscriptionId: string;
  graceStartedAt: string;
  graceEndsAt: string;
  entitlementPeriodId: string;
};

export function recoveryWindowKey(now: Date) {
  return String(Math.floor(now.getTime() / 86_400_000));
}

async function queueExpiryNotification(db: DbClient, subscription: Subscription, now: Date) {
  const context = JSON.stringify({ subscriptionId: subscription.id,
    learnerId: subscription.assigned_learner_id, productId: subscription.product_id,
    graceEndsAt: subscription.grace_ends_at });
  await db.run(
    `insert or ignore into billing_recovery_notifications(id,subscription_id,notification_type,channel,
     window_key,status,safe_context_json,created_at,updated_at)
     values(?,?, 'expired','in_product',?,'pending',?,?,?)`,
    [randomUUID(), subscription.id, recoveryWindowKey(now), context, now.toISOString(), now.toISOString()]);
}

export async function cancelStartingSessionsForSubscription(subscription: Subscription, now: Date,
  reason: "billing_grace_expired" | "subscription_cancelled") {
  const db = resolveDbClient();
  const rows = await db.all<{
    id: string; source: string; standard_credit_batch_id: string | null; session_credit_id: string | null;
  }>(
    `select ls.id,ls.source,ls.standard_credit_batch_id,ls.session_credit_id
     from learner_sessions ls
     where ls.learner_id=? and ls.status='starting' and exists(
       select 1 from product_version_apps pva where pva.product_id=? and pva.product_version=? and pva.app_id=ls.app_id
     )`,
    [subscription.assigned_learner_id, subscription.product_id, subscription.product_version]);
  for (const row of rows) {
    if (row.source === "standard_monthly" && row.standard_credit_batch_id) {
      await db.run(
        `update learner_app_standard_credit_batches set reserved_count=reserved_count-1,version=version+1,updated_at=?
         where id=? and reserved_count>0`,
        [now.toISOString(), row.standard_credit_batch_id]);
    } else if (row.source === "technical_credit" && row.session_credit_id) {
      await db.run(
        `update learner_session_credits set status=case when expires_at>? then 'available' else 'expired' end,
         reserved_session_id=null,reserved_at=null,version=version+1,updated_at=?
         where id=? and status='reserved' and reserved_session_id=?`,
        [now.toISOString(), now.toISOString(), row.session_credit_id, row.id]);
    }
    await db.run(
      `update learner_sessions set status='cancelled_before_launch',funding_state='released',ended_at=?,
       end_reason=?,version=version+1,updated_at=? where id=? and status='starting'`,
      [now.toISOString(), reason, now.toISOString(), row.id]);
    await db.run(
      `update learner_session_launch_state set status='revoked',code_hash=null,updated_at=?
       where learner_session_id=?`,
      [now.toISOString(), row.id]);
    await db.run(
      `update app_session_grants set status='revoked',revocation_reason=?,revoked_at=?,updated_at=?
       where learner_session_id=? and status in ('provisional','active')`,
      [reason, now.toISOString(), now.toISOString(), row.id]);
  }
  return rows.length;
}

// Shared by the bounded sweep and lazy entitlement checks. The write
// transaction serializes recovery and expiry so only one terminal update can
// win; account events and reservation release roll back with the state change.
export async function expireGraceSubscriptionState(subscriptionId: string, now: Date) {
  return resolveDbClient().transaction(async (db) => {
    const subscription = await db.get<Subscription>("select * from subscriptions where id=?", [subscriptionId]);
    if (!subscription) return { outcome: "not_found" as const, subscriptionId };
    if (subscription.payment_state === "inactive_nonpayment") {
      return { outcome: "already_expired" as const, subscriptionId, cancelledReservations: 0 };
    }
    if (subscription.payment_state !== "past_due_grace" || !subscription.grace_ends_at ||
      subscription.grace_ends_at > now.toISOString()) {
      return { outcome: "not_due" as const, subscriptionId };
    }
    const changed = (await db.run(
      `update subscriptions set status='expired',payment_state='inactive_nonpayment',next_renewal_at=null,
       nonpayment_ended_at=?,provider_retry_stop_state='pending',
       recovery_version=recovery_version+1,version=version+1,updated_at=?
       where id=? and payment_state='past_due_grace' and grace_ends_at<=?`,
      [now.toISOString(), now.toISOString(), subscriptionId, now.toISOString()])).changes;
    if (changed !== 1) return { outcome: "race_lost" as const, subscriptionId };
    const cancelledReservations = await cancelStartingSessionsForSubscription(subscription, now, "billing_grace_expired");
    await db.run(
      `update subscription_renewal_reminders set status='cancelled',updated_at=?
       where subscription_id=? and status in ('pending','retry_pending')`,
      [now.toISOString(), subscriptionId]);
    await db.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,?,?)",
      [randomUUID(), subscription.purchaser_parent_id, "subscription_grace_expired",
        JSON.stringify({ subscriptionId, graceEndsAt: subscription.grace_ends_at })]);
    await db.run("insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,?,?)",
      [randomUUID(), subscription.purchaser_parent_id, "entitlement_ended_for_nonpayment",
        JSON.stringify({ subscriptionId, learnerId: subscription.assigned_learner_id,
          productId: subscription.product_id, cancelledReservations })]);
    await queueExpiryNotification(db, subscription, now);
    // NT-001 rule 34: BI-003 owns the grace-expiry trigger; NT-001 only
    // delivers it. Same deterministic identity as the audit-ledger fold
    // below.
    await enqueueTransactionalNotification({
      notificationType: "billing_grace_expired", sourceDomain: "billing",
      sourceEventKey: `grace-expired:${subscriptionId}:${subscription.recovery_version + 1}`,
      sourceVersion: subscription.recovery_version + 1, parentId: subscription.purchaser_parent_id,
      learnerId: subscription.assigned_learner_id,
      safeVariables: { subscriptionLabel: await productDisplayName(db, subscription.product_id, subscription.product_version) },
    }, now);
    // EN-003 rule 8/68/22-25: audit-only fold into the shared lifecycle
    // ledger — the live access-denial path (evaluateAccessFresh) is
    // untouched, this just records the transition for reconciliation/audit.
    await applyLifecycleEvent({ eventId: `grace-expired:${subscriptionId}:${subscription.recovery_version + 1}`,
      eventType: "grace_expired", source: "billing_grace", sourceVersion: subscription.recovery_version + 1,
      effectiveAt: subscription.grace_ends_at!,
      sourceReference: { subscriptionId, learnerId: subscription.assigned_learner_id,
        reasonCategory: "grace_expired" },
      now });
    return { outcome: "expired" as const, subscriptionId, cancelledReservations };
  });
}

export async function findGraceCoverage(input: { learnerId: string; appId: string; now: Date }): Promise<GraceCoverage | null> {
  const db = resolveDbClient();
  const nowIso = input.now.toISOString();
  const row = await db.get<{
    subscription_id: string; grace_started_at: string; grace_ends_at: string; entitlement_period_id: string;
  }>(
    `select s.id subscription_id,s.grace_started_at,s.grace_ends_at,lep.id entitlement_period_id
     from subscriptions s
     join product_version_apps pva on pva.product_id=s.product_id and pva.product_version=s.product_version
     join learner_app_entitlement_periods lep on lep.subscription_id=s.id and lep.learner_id=s.assigned_learner_id
       and lep.app_id=pva.app_id
     where s.assigned_learner_id=? and pva.app_id=? and s.payment_state='past_due_grace'
       and s.grace_started_at<=? and s.grace_ends_at>?
     order by lep.period_end desc limit 1`,
    [input.learnerId, input.appId, nowIso, nowIso]);
  if (row) return { subscriptionId: row.subscription_id, graceStartedAt: row.grace_started_at,
    graceEndsAt: row.grace_ends_at, entitlementPeriodId: row.entitlement_period_id };

  const due = await db.get<{ id: string }>(
    `select s.id from subscriptions s join product_version_apps pva
       on pva.product_id=s.product_id and pva.product_version=s.product_version
     where s.assigned_learner_id=? and pva.app_id=? and s.payment_state='past_due_grace' and s.grace_ends_at<=?
     order by s.grace_ends_at limit 1`,
    [input.learnerId, input.appId, nowIso]);
  if (due) await expireGraceSubscriptionState(due.id, input.now);
  return null;
}
