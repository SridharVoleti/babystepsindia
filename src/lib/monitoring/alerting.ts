import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";

// AN-003: application-health escalation and deduplicated Major/Critical
// alerting. Reuses the existing platform_alerts table (already written
// to by AN-001's daily-analytics monitor, NT-001's notification-health
// monitor and AR-002's deployment-rollback safety observer — confirmed
// by survey, not a new alert store) rather than inventing a second one.
// The one piece none of those three writers had: a resolve/close path —
// every existing platform_alerts row today can only ever be opened, never
// closed. This module adds that, plus a shared, reusable "only alert once
// a signal is PERSISTENT, not on a single transient failure" classifier.

// Rule: "across billing, entitlement/access, progress, notification,
// scheduled processing, privacy/deletion, app-platform contracts, data
// integrity and critical providers" — the bounded capability-family
// vocabulary every alert must be tagged with. Only scheduled_processing
// is actually wired to a live signal in this build (via AN-002's own job
// snapshots); the other 8 are reachable through the same
// raiseDeduplicatedAlert primitive without new machinery once a real
// signal for them exists.
export const CAPABILITY_FAMILIES = [
  "billing", "entitlement_access", "progress", "notification", "scheduled_processing",
  "privacy_deletion", "app_platform_contracts", "data_integrity", "critical_providers",
] as const;
export type CapabilityFamily = (typeof CAPABILITY_FAMILIES)[number];
export type AlertSeverity = "major" | "critical";

export type SafeAlertContext = Record<string, string | number | boolean>;

// Rule: "Alert contains capability/impact/duration/recovery/safe
// diagnostics only" / "No raw PII/secrets" — callers pass only already-
// safe, already-typed primitives; this function never accepts (and so
// can never leak) a raw payload, learner identity, or provider secret.
export function raiseDeduplicatedAlert(input: {
  alertType: string; capabilityFamily: CapabilityFamily; severity: AlertSeverity; message: string;
  safeContext?: SafeAlertContext; now?: Date;
}): { created: boolean } {
  const db = getDb();
  const now = input.now ?? new Date();
  const existing = db.prepare(
    "select 1 from platform_alerts where alert_type=? and resolved_at is null",
  ).get(input.alertType);
  if (existing) return { created: false };
  db.prepare(
    "insert into platform_alerts (id,alert_type,message,metadata,created_at) values (?,?,?,?,?)",
  ).run(randomUUID(), input.alertType, input.message,
    JSON.stringify({ capabilityFamily: input.capabilityFamily, severity: input.severity, ...(input.safeContext ?? {}) }),
    now.toISOString());
  return { created: true };
}

// Rule: "Recovery closes/updates the alert." The missing piece — every
// pre-existing platform_alerts writer in this codebase can open a row but
// none could ever close one.
export function resolveDeduplicatedAlert(alertType: string, now: Date = new Date()): { resolved: number } {
  const result = getDb().prepare(
    "update platform_alerts set resolved_at=? where alert_type=? and resolved_at is null",
  ).run(now.toISOString(), alertType);
  return { resolved: result.changes };
}

export function listOpenAlerts(): Array<{ id: string; alert_type: string; message: string; metadata: string | null; created_at: string }> {
  return getDb().prepare(
    "select id, alert_type, message, metadata, created_at from platform_alerts where resolved_at is null order by created_at desc",
  ).all() as Array<{ id: string; alert_type: string; message: string; metadata: string | null; created_at: string }>;
}

const PERSISTENCE_THRESHOLD = 3;

// Rule: "Recoverable failures retry/reconcile/degrade first... persistent
// Major/Critical conditions create alerts" — wired to AN-002's own fresh
// per-job snapshot history (src/lib/monitoring/service.ts) as the
// representative "scheduled_processing" signal: a single failed run is a
// normal, already-retried transient condition and never alerts; only true
// persistence — every one of the job's last PERSISTENCE_THRESHOLD
// snapshots failing — escalates. A subsequent completed run resolves the
// same deduplicated alert automatically.
export function escalatePersistentJobFailures(jobKey: string, now: Date = new Date()): { escalated: boolean; resolved: boolean } {
  const db = getDb();
  const recent = db.prepare(
    "select status from monitoring_job_snapshots where job_key=? order by run_at desc limit ?",
  ).all(jobKey, PERSISTENCE_THRESHOLD) as Array<{ status: string }>;
  const alertType = `scheduled_job_persistent_failure:${jobKey}`;
  if (recent.length === 0) return { escalated: false, resolved: false };

  const allFailed = recent.length === PERSISTENCE_THRESHOLD && recent.every((row) => row.status === "failed");
  if (allFailed) {
    const result = raiseDeduplicatedAlert({
      alertType, capabilityFamily: "scheduled_processing", severity: "major",
      message: `Job ${jobKey} has failed its last ${PERSISTENCE_THRESHOLD} runs.`,
      safeContext: { jobKey, consecutiveFailures: PERSISTENCE_THRESHOLD }, now,
    });
    return { escalated: result.created, resolved: false };
  }
  if (recent[0]!.status === "completed") {
    const result = resolveDeduplicatedAlert(alertType, now);
    return { escalated: false, resolved: result.resolved > 0 };
  }
  return { escalated: false, resolved: false };
}
