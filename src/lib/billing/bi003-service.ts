import { createHash, randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
import type { DbClient } from "@/lib/db-client/types";
import type { Subscription } from "@/lib/db/types";
import { BillingAssignmentError } from "@/lib/billing/errors";
import { expireGraceSubscriptionState, recoveryWindowKey } from "@/lib/billing/grace-policy";
import { resolveBillingProviderAdapter, type BillingCheckoutProviderAdapter } from "@/lib/billing/provider-adapter";

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function parentSubscription(db: DbClient, parentId: string, subscriptionId: string) {
  const row = await db.get<Subscription>(
    "select * from subscriptions where id=? and purchaser_parent_id=?",
    [subscriptionId, parentId],
  );
  if (!row) throw new BillingAssignmentError("RESOURCE_NOT_FOUND");
  return row;
}

async function currentGraceSubscription(db: DbClient, parentId: string, subscriptionId: string, now: Date) {
  let subscription = await parentSubscription(db, parentId, subscriptionId);
  if (subscription.payment_state === "past_due_grace" && subscription.grace_ends_at &&
    subscription.grace_ends_at <= now.toISOString()) {
    await expireGraceSubscriptionState(subscription.id, now);
    subscription = await parentSubscription(db, parentId, subscriptionId);
  }
  return subscription;
}

export async function getPaymentRecoveryStatus(parentId: string, subscriptionId: string, now = new Date()) {
  const db = resolveDbClient();
  const subscription = await currentGraceSubscription(db, parentId, subscriptionId, now);
  const attempt = await db.get<{ status: string; failure_code: string | null;
    attempted_at: string; settled_at: string | null }>(
    `select status,failure_code,attempted_at,settled_at from renewal_payment_attempts
     where subscription_id=? order by attempted_at desc,id desc limit 1`,
    [subscriptionId],
  );
  return { subscriptionId, paymentState: subscription.payment_state,
    graceStartedAt: subscription.grace_started_at, graceEndsAt: subscription.grace_ends_at,
    currentPeriodEnd: subscription.current_period_end,
    recoveryActionAvailable: subscription.payment_state === "past_due_grace" &&
      !!subscription.grace_ends_at && subscription.grace_ends_at > now.toISOString(),
    lastAttemptStatus: attempt ? { status: attempt.status, failureCode: attempt.failure_code,
      attemptedAt: attempt.attempted_at, settledAt: attempt.settled_at } : null,
    progressPreserved: true, version: subscription.version };
}

export async function createPaymentMethodUpdateSession(parentId: string, subscriptionId: string, input: {
  expectedVersion: number;
  idempotencyKey: string;
}, options: { now?: Date; adapter?: BillingCheckoutProviderAdapter } = {}) {
  const now = options.now ?? new Date();
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1 || !input.idempotencyKey.trim()) {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  const db = resolveDbClient();
  const requestHash = hash({ subscriptionId, expectedVersion: input.expectedVersion });
  const existing = await db.get<{ request_hash: string; result_json: string }>(
    `select request_hash,result_json from payment_method_update_sessions
     where parent_id=? and subscription_id=? and idempotency_key=?`,
    [parentId, subscriptionId, input.idempotencyKey],
  );
  if (existing) {
    if (existing.request_hash !== requestHash) throw new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED");
    return JSON.parse(existing.result_json);
  }
  const subscription = await currentGraceSubscription(db, parentId, subscriptionId, now);
  if (subscription.payment_state !== "past_due_grace" || !subscription.grace_ends_at ||
    subscription.grace_ends_at <= now.toISOString()) throw new BillingAssignmentError("PAYMENT_RECOVERY_NOT_AVAILABLE");
  if (subscription.version !== input.expectedVersion) throw new BillingAssignmentError("VERSION_CONFLICT");
  if (!subscription.provider_subscription_ref) throw new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED");
  const adapter = options.adapter ?? resolveBillingProviderAdapter(subscription.provider);
  if (!adapter.createPaymentMethodUpdateSession) throw new BillingAssignmentError("PAYMENT_PROVIDER_NOT_CONFIGURED");
  const requestedExpiry = new Date(Math.min(now.getTime() + 15 * 60_000,
    new Date(subscription.grace_ends_at).getTime())).toISOString();
  let providerResult;
  try {
    providerResult = adapter.createPaymentMethodUpdateSession({ purchaserParentId: parentId,
      subscriptionId, providerCustomerRef: subscription.provider_customer_ref,
      providerSubscriptionRef: subscription.provider_subscription_ref, expiresAt: requestedExpiry,
      idempotencyKey: input.idempotencyKey });
  } catch {
    throw new BillingAssignmentError("PAYMENT_PROVIDER_UNAVAILABLE");
  }
  if (!providerResult.providerSessionRef || !providerResult.handoffUrl ||
    providerResult.expiresAt > subscription.grace_ends_at) throw new BillingAssignmentError("PAYMENT_EVENT_CONTEXT_MISMATCH");
  const result = { subscriptionId, provider: subscription.provider,
    updateSessionRef: providerResult.providerSessionRef, updateUrl: providerResult.handoffUrl,
    expiresAt: providerResult.expiresAt, paymentState: "past_due_grace",
    paymentMethodUpdateIsNotPayment: true };
  return db.transaction(async (tx) => {
    await tx.run(
      `insert into payment_method_update_sessions(id,parent_id,subscription_id,provider,environment,
       provider_session_ref,provider_handoff_url,status,idempotency_key,request_hash,expires_at,result_json,created_at,updated_at)
       values(?,?,?,?,?,?,?,'created',?,?,?,?,?,?)`,
      [randomUUID(), parentId, subscriptionId, subscription.provider, subscription.provider_environment,
        providerResult.providerSessionRef, providerResult.handoffUrl, input.idempotencyKey, requestHash,
        providerResult.expiresAt, JSON.stringify(result), now.toISOString(), now.toISOString()],
    );
    await tx.run(
      "insert into account_events(id,parent_user_id,event_type,metadata) values(?,?,?,?)",
      [randomUUID(), parentId, "payment_method_update_session_created",
        JSON.stringify({ subscriptionId, updateSessionRef: providerResult.providerSessionRef,
          expiresAt: providerResult.expiresAt })],
    );
    return result;
  });
}

export async function queueRoutineRecoveryNotification(subscriptionId: string, now = new Date()) {
  const db = resolveDbClient();
  const subscription = await db.get<Subscription>("select * from subscriptions where id=?", [subscriptionId]);
  if (!subscription || subscription.payment_state !== "past_due_grace" || !subscription.grace_ends_at ||
    subscription.grace_ends_at <= now.toISOString()) return { queued: false, reason: "not_eligible" };
  const since = new Date(now.getTime() - 86_400_000).toISOString();
  const recent = await db.get(
    `select id from billing_recovery_notifications where subscription_id=? and notification_type='routine_recovery'
     and status in ('pending','sending','sent','retry_pending') and created_at>? limit 1`,
    [subscriptionId, since],
  );
  if (recent) return { queued: false, reason: "daily_cap" };
  const context = JSON.stringify({ subscriptionId, learnerId: subscription.assigned_learner_id,
    productId: subscription.product_id, graceEndsAt: subscription.grace_ends_at,
    updatePaymentPath: `/account/subscriptions#${subscriptionId}` });
  const id = randomUUID();
  await db.run(
    `insert or ignore into billing_recovery_notifications(id,subscription_id,notification_type,channel,
     window_key,status,safe_context_json,created_at,updated_at)
     values(?,?,'routine_recovery','email',?,'pending',?,?,?)`,
    [id, subscriptionId, recoveryWindowKey(now), context, now.toISOString(), now.toISOString()],
  );
  return { queued: true, notificationId: id };
}

async function beginGraceRun(db: DbClient, principalId: string, key: string, requestHash: string, now: Date) {
  const existing = await db.get<{ request_hash: string; status: string; result_json: string | null }>(
    `select request_hash,status,result_json from billing_grace_job_runs
     where principal_id=? and run_idempotency_key=?`,
    [principalId, key],
  );
  if (existing) {
    if (existing.request_hash !== requestHash) throw new BillingAssignmentError("IDEMPOTENCY_KEY_REUSED");
    if (existing.status === "completed" && existing.result_json) return JSON.parse(existing.result_json);
    throw new BillingAssignmentError("PAYMENT_EVENT_STATE_CONFLICT");
  }
  await db.run(
    `insert into billing_grace_job_runs(principal_id,run_idempotency_key,request_hash,status,created_at)
     values(?,?,?,'running',?)`,
    [principalId, key, requestHash, now.toISOString()],
  );
  return null;
}

export async function runGraceExpirySweep(principalId: string, input: {
  provider?: string;
  cursor?: string;
  limit: number;
  runIdempotencyKey: string;
}, options: { now?: Date; adapters?: Record<string, BillingCheckoutProviderAdapter> } = {}) {
  const now = options.now ?? new Date();
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500 || !input.runIdempotencyKey.trim()) {
    throw new BillingAssignmentError("INVALID_REQUEST");
  }
  const db = resolveDbClient();
  const requestHash = hash(input);
  const replay = await beginGraceRun(db, principalId, input.runIdempotencyKey, requestHash, now);
  if (replay) return replay;
  const params: Array<string | number> = [now.toISOString()];
  let where = "((payment_state='past_due_grace' and grace_ends_at<=?) or " +
    "(payment_state='inactive_nonpayment' and provider_retry_stop_state='pending'))";
  if (input.provider) { where += " and provider=?"; params.push(input.provider); }
  if (input.cursor) { where += " and id>?"; params.push(input.cursor); }
  params.push(input.limit);
  const rows = await db.all<Subscription>(`select * from subscriptions where ${where} order by id limit ?`, params);
  const counts = { scanned: rows.length, recovered: 0, expired: 0, deferred: 0, errors: 0 };
  for (const subscription of rows) {
    try {
      const result = await expireGraceSubscriptionState(subscription.id, now);
      if (result.outcome !== "expired" && result.outcome !== "already_expired") {
        counts.deferred += 1;
        continue;
      }
      counts.expired += 1;
      const adapter = options.adapters?.[subscription.provider] ?? resolveBillingProviderAdapter(subscription.provider);
      if (!adapter.stopRenewalRetries || !subscription.provider_subscription_ref) {
        await db.run("update subscriptions set provider_retry_stop_state='unsupported',updated_at=? where id=?",
          [now.toISOString(), subscription.id]);
      } else {
        try {
          adapter.stopRenewalRetries({ providerSubscriptionRef: subscription.provider_subscription_ref,
            providerMandateRef: subscription.provider_mandate_ref });
          await db.run("update subscriptions set provider_retry_stop_state='confirmed',updated_at=? where id=?",
            [now.toISOString(), subscription.id]);
        } catch {
          await db.run("update subscriptions set provider_retry_stop_state='failed',updated_at=? where id=?",
            [now.toISOString(), subscription.id]);
          counts.errors += 1;
        }
      }
    } catch { counts.errors += 1; }
  }
  const result = { ...counts, nextCursor: rows.length === input.limit ? rows.at(-1)!.id : null };
  await db.run(
    `update billing_grace_job_runs set status='completed',result_json=?,completed_at=?
     where principal_id=? and run_idempotency_key=?`,
    [JSON.stringify(result), now.toISOString(), principalId, input.runIdempotencyKey],
  );
  return result;
}
