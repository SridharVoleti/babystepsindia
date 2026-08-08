import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { kolkataCalendarDate } from "@/lib/analytics/kolkata-interval";

export const ANALYTICS_NFR = {
  bufferUpdateP95Ms: 500,
  dailyRunMaxMs: 30 * 60 * 1000,
  scheduledMinuteOfDayKolkata: 15,
  monitorMinuteOfDayKolkata: 50,
} as const;

type MonitoredRun = {
  status: "running" | "completed" | "failed";
  started_at: string;
  completed_at: string | null;
  failure_code: string | null;
};

export type AnalyticsMonitorOutcome = {
  activityDate: string;
  state: "too_early" | "healthy" | "missed" | "failed" | "overdue";
  alertCreated: boolean;
};

function previousCalendarDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function kolkataMinuteOfDay(now: Date): number {
  const shifted = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function completionDeadline(activityDate: string): Date {
  const [year, month, day] = activityDate.split("-").map(Number);
  // The date's run starts at 00:15 Asia/Kolkata on the following day.
  return new Date(
    Date.UTC(year, month - 1, day + 1) - (5 * 60 + 30) * 60_000 +
      ANALYTICS_NFR.scheduledMinuteOfDayKolkata * 60_000 + ANALYTICS_NFR.dailyRunMaxMs,
  );
}

function ensureAlert(
  alertType: "analytics_run_missed" | "analytics_run_failed" | "analytics_run_overdue",
  activityDate: string,
  message: string,
  metadata: Record<string, string>,
): boolean {
  const db = getDb();
  const existing = db.prepare(
    `select 1 from platform_alerts
     where alert_type=? and resolved_at is null
       and json_extract(metadata, '$.activityDate')=?`,
  ).get(alertType, activityDate);
  if (existing) return false;
  db.prepare(
    "insert into platform_alerts(id,alert_type,message,metadata) values(?,?,?,?)",
  ).run(randomUUID(), alertType, message, JSON.stringify({ activityDate, ...metadata }));
  return true;
}

/**
 * Independent 00:50 IST health check for the preceding activity date.
 * It is intentionally read-only except for minimal, identifier-free alerts.
 */
export function monitorDailyAnalytics(now: Date = new Date()): AnalyticsMonitorOutcome {
  const localDate = kolkataCalendarDate(now);
  const activityDate = previousCalendarDate(localDate);
  if (kolkataMinuteOfDay(now) < ANALYTICS_NFR.monitorMinuteOfDayKolkata) {
    return { activityDate, state: "too_early", alertCreated: false };
  }

  const run = getDb().prepare(
    "select status,started_at,completed_at,failure_code from analytics_daily_runs where activity_date=?",
  ).get(activityDate) as MonitoredRun | undefined;
  if (!run) {
    return {
      activityDate,
      state: "missed",
      alertCreated: ensureAlert(
        "analytics_run_missed",
        activityDate,
        `Daily analytics run was not started for ${activityDate}`,
        { expectedStart: "00:15 Asia/Kolkata" },
      ),
    };
  }
  if (run.status === "failed") {
    return {
      activityDate,
      state: "failed",
      alertCreated: ensureAlert(
        "analytics_run_failed",
        activityDate,
        `Daily analytics run failed for ${activityDate}`,
        { failureCode: run.failure_code ?? "UNKNOWN" },
      ),
    };
  }

  const finishedAt = run.completed_at ? new Date(run.completed_at) : null;
  if (!finishedAt || finishedAt > completionDeadline(activityDate)) {
    return {
      activityDate,
      state: "overdue",
      alertCreated: ensureAlert(
        "analytics_run_overdue",
        activityDate,
        `Daily analytics run exceeded 30 minutes for ${activityDate}`,
        { status: run.status },
      ),
    };
  }
  return { activityDate, state: "healthy", alertCreated: false };
}
