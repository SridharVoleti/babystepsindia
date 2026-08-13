import { getDb } from "@/lib/db/client";
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

export function purgeExpiredNotificationMetadata(now: Date = new Date()): NotificationRetentionPurgeResult {
  const cutoff = addCalendarMonthsClamped(now.toISOString(), -NOTIFICATION_METADATA_RETENTION_MONTHS, now.getUTCDate());
  const db = getDb();
  return db.transaction(() => {
    // Deliveries cascade-delete via the FK's `on delete cascade` when their
    // parent intent is removed (migration 0059 / schema.sql).
    const intentsPurged = db.prepare(
      "delete from transactional_notification_intents where created_at < ?",
    ).run(cutoff).changes;
    const webhookReceiptsPurged = db.prepare(
      "delete from notification_provider_webhook_receipts where received_at < ?",
    ).run(cutoff).changes;
    return { intentsPurged, webhookReceiptsPurged };
  })();
}

export type NotificationDeliveryHealth = {
  pendingCount: number;
  oldestPendingAgeMs: number | null;
  permanentFailuresLast24h: number;
  queueAgeAlert: boolean;
  failureRateAlert: boolean;
};

const QUEUE_AGE_ALERT_MS = 30 * 60_000;
const PERMANENT_FAILURE_ALERT_THRESHOLD = 10;

// Rules 108-109, AT-NT-001-48: queue age/pending count/failure-rate
// monitoring, alerting when a mandatory notification queue is stuck or
// failing beyond threshold. Read-only — never mutates delivery state
// itself (that's runNotificationDeliverySweep/reconcileNotificationDeliveries).
export function getNotificationDeliveryHealth(now: Date = new Date()): NotificationDeliveryHealth {
  const db = getDb();
  const pending = db.prepare(
    "select count(*) as n, min(created_at) as oldest from transactional_notification_intents where state='pending'",
  ).get() as { n: number; oldest: string | null };
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const failures = db.prepare(
    "select count(*) as n from transactional_notification_deliveries where state='permanent_failed' and updated_at>=?",
  ).get(dayAgo) as { n: number };
  const oldestPendingAgeMs = pending.oldest ? now.getTime() - new Date(pending.oldest).getTime() : null;
  return {
    pendingCount: pending.n,
    oldestPendingAgeMs,
    permanentFailuresLast24h: failures.n,
    queueAgeAlert: oldestPendingAgeMs !== null && oldestPendingAgeMs > QUEUE_AGE_ALERT_MS,
    failureRateAlert: failures.n > PERMANENT_FAILURE_ALERT_THRESHOLD,
  };
}
