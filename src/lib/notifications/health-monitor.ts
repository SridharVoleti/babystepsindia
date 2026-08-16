import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { getNotificationDeliveryHealth, type NotificationDeliveryHealth } from "@/lib/notifications/retention";

export type NotificationHealthAlertType =
  | "notification_queue_age_breach"
  | "notification_permanent_failure_threshold"
  | "notification_provider_health_degraded";

export type NotificationHealthMonitorOutcome = {
  health: NotificationDeliveryHealth;
  alertsCreated: NotificationHealthAlertType[];
};

// NT1-G08: same dedup shape as analytics' monitorDailyAnalytics — an alert
// of this type with no resolution yet already exists, so a repeated breach
// on every subsequent check never creates a second alert (no alert storms).
// There is no NT-001-specific "activity date" grain (this is a continuously
// recurring check, not a once-daily run), so dedup is simply "one open
// alert per type at a time", same operator-alert table every other platform
// health check writes to.
function ensureAlert(alertType: NotificationHealthAlertType, message: string, metadata: Record<string, number>): boolean {
  const db = getDb();
  const existing = db.prepare(
    "select 1 from platform_alerts where alert_type=? and resolved_at is null",
  ).get(alertType);
  if (existing) return false;
  db.prepare(
    "insert into platform_alerts(id,alert_type,message,metadata) values(?,?,?,?)",
  ).run(randomUUID(), alertType, message, JSON.stringify(metadata));
  return true;
}

// Connects getNotificationDeliveryHealth's breach signals to the platform's
// approved operational-alert mechanism (platform_alerts, the same table
// AN-001's monitorDailyAnalytics writes to). Read-only apart from the
// alert rows themselves — never touches delivery/intent state, and never
// calls the email provider, so this can run safely on any schedule
// regardless of provider availability.
export function monitorNotificationDeliveryHealth(now: Date = new Date()): NotificationHealthMonitorOutcome {
  const health = getNotificationDeliveryHealth(now);
  const alertsCreated: NotificationHealthAlertType[] = [];

  if (health.queueAgeAlert && ensureAlert(
    "notification_queue_age_breach",
    `Notification queue has a pending intent older than 30 minutes (oldest ${health.oldestPendingAgeMs}ms)`,
    { oldestPendingAgeMs: health.oldestPendingAgeMs ?? 0, pendingCount: health.pendingCount },
  )) alertsCreated.push("notification_queue_age_breach");

  if (health.failureRateAlert && ensureAlert(
    "notification_permanent_failure_threshold",
    `Notification permanent failures exceeded threshold in the last 24h (${health.permanentFailuresLast24h})`,
    { permanentFailuresLast24h: health.permanentFailuresLast24h },
  )) alertsCreated.push("notification_permanent_failure_threshold");

  if (health.providerHealthDegraded && ensureAlert(
    "notification_provider_health_degraded",
    `Notification provider shows ${health.recentTemporaryFailures} temporary failures in the last 15 minutes`,
    { recentTemporaryFailures: health.recentTemporaryFailures },
  )) alertsCreated.push("notification_provider_health_degraded");

  return { health, alertsCreated };
}
