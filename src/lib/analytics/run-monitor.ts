import { randomUUID } from "node:crypto";
import { resolveDbClient } from "@/lib/db-client";
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

// Was a SQL-side json_extract(metadata, '$.activityDate')=? match — this
// codebase's dominant pattern is JSON.stringify/parse in JS around a text
// column, so this now fetches the (small — open alerts only) candidate
// set and checks the parsed field in JS instead, keeping the query
// dialect-neutral rather than translating to Postgres jsonb operators.
async function ensureAlert(
  alertType: "analytics_run_missed" | "analytics_run_failed" | "analytics_run_overdue",
  activityDate: string,
  message: string,
  metadata: Record<string, string>,
): Promise<boolean> {
  const db = resolveDbClient();
  const openAlerts = await db.all<{ metadata: string }>(
    `select metadata from platform_alerts where alert_type=? and resolved_at is null`,
    [alertType],
  );
  const existing = openAlerts.some((row) => {
    try {
      return (JSON.parse(row.metadata) as { activityDate?: string }).activityDate === activityDate;
    } catch {
      return false;
    }
  });
  if (existing) return false;
  await db.run(
    "insert into platform_alerts(id,alert_type,message,metadata) values(?,?,?,?)",
    [randomUUID(), alertType, message, JSON.stringify({ activityDate, ...metadata })],
  );
  return true;
}

/**
 * Independent 00:50 IST health check for the preceding activity date.
 * It is intentionally read-only except for minimal, identifier-free alerts.
 */
export async function monitorDailyAnalytics(now: Date = new Date()): Promise<AnalyticsMonitorOutcome> {
  const localDate = kolkataCalendarDate(now);
  const activityDate = previousCalendarDate(localDate);
  if (kolkataMinuteOfDay(now) < ANALYTICS_NFR.monitorMinuteOfDayKolkata) {
    return { activityDate, state: "too_early", alertCreated: false };
  }

  const run = await resolveDbClient().get<MonitoredRun>(
    "select status,started_at,completed_at,failure_code from analytics_daily_runs where activity_date=?",
    [activityDate],
  );
  if (!run) {
    return {
      activityDate,
      state: "missed",
      alertCreated: await ensureAlert(
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
      alertCreated: await ensureAlert(
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
      alertCreated: await ensureAlert(
        "analytics_run_overdue",
        activityDate,
        `Daily analytics run exceeded 30 minutes for ${activityDate}`,
        { status: run.status },
      ),
    };
  }
  return { activityDate, state: "healthy", alertCreated: false };
}
