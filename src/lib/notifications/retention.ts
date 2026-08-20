import { resolveDbClient } from "@/lib/db-client";
import { addCalendarMonthsClamped } from "@/lib/entitlement-cycle/service";

// Rule 89: 13-month default retention for compact notification metadata.
// Rule 92: purging notification metadata never deletes financial documents,
// account audit, entitlement or source business state — this module only
// ever touches the three NT-001 tables below.
const NOTIFICATION_METADATA_RETENTION_MONTHS = 13;

export type NotificationRetentionPurgeResult = {
  intentsPurged: number;
  webhookReceiptsPurged: number;
};

export async function purgeExpiredNotificationMetadata(now: Date = new Date()): Promise<NotificationRetentionPurgeResult> {
  const cutoff = addCalendarMonthsClamped(now.toISOString(), -NOTIFICATION_METADATA_RETENTION_MONTHS, now.getUTCDate());
  return resolveDbClient().transaction(async (tx) => {
    // Deliveries cascade-delete via the FK's `on delete cascade` when their
    // parent intent is removed (migration 0059 / schema.sql).
    const intentsPurged = (await tx.run(
      "delete from transactional_notification_intents where created_at < ?", [cutoff],
    )).changes;
    const webhookReceiptsPurged = (await tx.run(
      "delete from notification_provider_webhook_receipts where received_at < ?", [cutoff],
    )).changes;
    return { intentsPurged, webhookReceiptsPurged };
  });
}

export type NotificationDeliveryHealth = {
  pendingCount: number;
  oldestPendingAgeMs: number | null;
  permanentFailuresLast24h: number;
  recentTemporaryFailures: number;
  queueAgeAlert: boolean;
  failureRateAlert: boolean;
  providerHealthDegraded: boolean;
};

const QUEUE_AGE_ALERT_MS = 30 * 60_000;
const PERMANENT_FAILURE_ALERT_THRESHOLD = 10;
// NT1-G08: a burst of provider-level temporary failures in a short recent
// window is a provider-outage/degradation signal — every deliverOne failure
// reason is already provider-shaped (PROVIDER_TEMPORARY_ERROR/
// PROVIDER_REJECTED, never a content/validation error), so this is a safe
// proxy without a separate provider status API.
const PROVIDER_DEGRADED_WINDOW_MS = 15 * 60_000;
const PROVIDER_DEGRADED_THRESHOLD = 5;

// Rules 108-109, AT-NT-001-48: queue age/pending count/failure-rate/
// provider-health monitoring, alerting when a mandatory notification queue
// is stuck, failing beyond threshold, or the provider itself looks
// unhealthy. Read-only — never mutates delivery state itself (that's
// runNotificationDeliverySweep/reconcileNotificationDeliveries), and never
// touches the provider directly, so a real provider outage can never block
// this health read the way it can never block a source domain's own commit.
export async function getNotificationDeliveryHealth(now: Date = new Date()): Promise<NotificationDeliveryHealth> {
  const db = resolveDbClient();
  const pending = (await db.get<{ n: number; oldest: string | null }>(
    "select count(*) as n, min(created_at) as oldest from transactional_notification_intents where state='pending'",
  ))!;
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const failures = (await db.get<{ n: number }>(
    "select count(*) as n from transactional_notification_deliveries where state='permanent_failed' and updated_at>=?",
    [dayAgo],
  ))!;
  const degradedWindowStart = new Date(now.getTime() - PROVIDER_DEGRADED_WINDOW_MS).toISOString();
  const recentTemporaryFailures = (await db.get<{ n: number }>(
    `select count(*) as n from transactional_notification_deliveries
     where state='temporary_failed' and last_error_code='PROVIDER_TEMPORARY_ERROR' and last_attempt_at>=?`,
    [degradedWindowStart],
  ))!;
  const oldestPendingAgeMs = pending.oldest ? now.getTime() - new Date(pending.oldest).getTime() : null;
  return {
    pendingCount: pending.n,
    oldestPendingAgeMs,
    permanentFailuresLast24h: failures.n,
    recentTemporaryFailures: recentTemporaryFailures.n,
    queueAgeAlert: oldestPendingAgeMs !== null && oldestPendingAgeMs > QUEUE_AGE_ALERT_MS,
    failureRateAlert: failures.n > PERMANENT_FAILURE_ALERT_THRESHOLD,
    providerHealthDegraded: recentTemporaryFailures.n >= PROVIDER_DEGRADED_THRESHOLD,
  };
}
