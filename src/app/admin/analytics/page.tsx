import Link from "next/link";
import type { Metadata } from "next";
import { isStrictCalendarDate } from "@/lib/analytics/calendar-date";
import { requireAdminPermission } from "@/lib/auth/guards";
import { listDailyAppAggregates, listDailyLevelAggregates, listDailyRuns } from "@/lib/db/analytics-admin-repo";
import { listApps } from "@/lib/db/app-registry-repo";
import type { AgeBand } from "@/lib/db/types";

export const metadata: Metadata = { title: "Analytics — Baby Steps Admin" };

const AGE_BANDS: AgeBand[] = ["under_6", "6_7", "8_9", "10_12", "13_15", "16_18", "19_29", "30_49", "50_plus"];

function rate(numerator: number, denominator: number): string {
  if (denominator === 0) return "—";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

// UI/UX spec: cohort-only — date range, app, level and age-band filters,
// totals/averages/rates from *completed* daily aggregates, incomplete
// dates clearly labelled, no learner search or named drill-down (AC23).
export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; appId?: string; levelKey?: string; ageBand?: string };
}) {
  await requireAdminPermission("admin.analytics.daily.read");

  if ((searchParams.from !== undefined && !isStrictCalendarDate(searchParams.from))
    || (searchParams.to !== undefined && !isStrictCalendarDate(searchParams.to))) {
    return (
      <div className="card p-6">
        <h1 className="text-xl font-bold text-chakra-900">Invalid date filter</h1>
        <p className="mt-2 text-sm text-chakra-600">
          Enter a real calendar date in YYYY-MM-DD format.
        </p>
      </div>
    );
  }

  const from = isStrictCalendarDate(searchParams.from) ? searchParams.from : undefined;
  const to = isStrictCalendarDate(searchParams.to) ? searchParams.to : undefined;
  const appId = searchParams.appId || undefined;
  const levelKey = searchParams.levelKey || undefined;
  const ageBand = AGE_BANDS.includes(searchParams.ageBand as AgeBand) ? searchParams.ageBand : undefined;
  const filters = { from, to, appId, levelKey, ageBand };

  const apps = listApps({ includeSoftDeleted: true });
  const appAggregates = listDailyAppAggregates(filters);
  const levelAggregates = listDailyLevelAggregates(filters);
  const incompleteDates = listDailyRuns({ from, to }).filter((run) => run.status !== "completed");

  const totals = appAggregates.reduce(
    (acc, row) => ({
      activeLearnerDays: acc.activeLearnerDays + row.activeLearners,
      engagedSeconds: acc.engagedSeconds + row.engagedSeconds,
      sessionsStarted: acc.sessionsStarted + row.sessionsStarted,
      sessionsCompleted: acc.sessionsCompleted + row.sessionsCompleted,
      sessionsInterrupted: acc.sessionsInterrupted + row.sessionsInterrupted,
      lessonsCompleted: acc.lessonsCompleted + row.lessonsCompleted,
    }),
    { activeLearnerDays: 0, engagedSeconds: 0, sessionsStarted: 0, sessionsCompleted: 0, sessionsInterrupted: 0, lessonsCompleted: 0 },
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-chakra-900">Analytics</h1>
          <p className="mt-1 text-sm text-chakra-500">
            Anonymous cohort aggregates only (AN-001) — no learner search or named drill-down.
          </p>
        </div>
        <Link href="/admin/analytics/runs" className="btn-secondary">
          View runs
        </Link>
      </div>

      <form method="get" className="card flex flex-wrap items-end gap-4 p-5">
        <div>
          <label htmlFor="from" className="field-label">From</label>
          <input id="from" name="from" type="date" defaultValue={from ?? ""} className="field-input" />
        </div>
        <div>
          <label htmlFor="to" className="field-label">To</label>
          <input id="to" name="to" type="date" defaultValue={to ?? ""} className="field-input" />
        </div>
        <div>
          <label htmlFor="appId" className="field-label">App</label>
          <select id="appId" name="appId" defaultValue={appId ?? ""} className="field-input">
            <option value="">All apps</option>
            {apps.map((app) => (
              <option key={app.id} value={app.id}>
                {app.displayName}{app.registryStatus === "soft_deleted" ? " (soft-deleted)" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="levelKey" className="field-label">Level key</label>
          <input id="levelKey" name="levelKey" defaultValue={levelKey ?? ""} placeholder="optional" className="field-input" />
        </div>
        <div>
          <label htmlFor="ageBand" className="field-label">Age band</label>
          <select id="ageBand" name="ageBand" defaultValue={ageBand ?? ""} className="field-input">
            <option value="">All age bands</option>
            {AGE_BANDS.map((band) => (
              <option key={band} value={band}>{band}</option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn-secondary">Apply</button>
      </form>

      {incompleteDates.length > 0 && (
        <div className="card border border-saffron-200 bg-saffron-50 p-5">
          <p className="text-sm font-medium text-saffron-800">
            {incompleteDates.length} date(s) in this range are not yet complete and are excluded from the totals
            below:
          </p>
          <ul className="mt-1 text-xs text-saffron-700">
            {incompleteDates.map((run) => (
              <li key={run.activityDate}>{run.activityDate} — {run.status}{run.failureCode ? ` (${run.failureCode})` : ""}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card grid grid-cols-2 gap-4 p-5 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Active learner-days" value={String(totals.activeLearnerDays)} />
        <Stat label="Engaged seconds" value={String(totals.engagedSeconds)} />
        <Stat label="Sessions started" value={String(totals.sessionsStarted)} />
        <Stat label="Completion rate" value={rate(totals.sessionsCompleted, totals.sessionsStarted)} />
        <Stat label="Interruption rate" value={rate(totals.sessionsInterrupted, totals.sessionsStarted)} />
        <Stat label="Lessons completed" value={String(totals.lessonsCompleted)} />
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-chakra-100 text-left text-xs uppercase tracking-wide text-chakra-400">
            <tr>
              <th className="p-3">Date</th>
              <th className="p-3">App</th>
              <th className="p-3">Age band</th>
              <th className="p-3">Active learners</th>
              <th className="p-3">Engaged (s)</th>
              <th className="p-3">Started</th>
              <th className="p-3">Completed</th>
              <th className="p-3">Interrupted</th>
              <th className="p-3">Lessons</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-chakra-100">
            {appAggregates.length === 0 ? (
              <tr><td colSpan={9} className="p-5 text-sm text-chakra-500">No completed aggregates match these filters.</td></tr>
            ) : (
              appAggregates.map((row) => (
                <tr key={`${row.activityDate}-${row.appId}-${row.ageBand}`}>
                  <td className="p-3">{row.activityDate}</td>
                  <td className="p-3">{row.appDisplayName}</td>
                  <td className="p-3">{row.ageBand}</td>
                  <td className="p-3">{row.activeLearners}</td>
                  <td className="p-3">{row.engagedSeconds}</td>
                  <td className="p-3">{row.sessionsStarted}</td>
                  <td className="p-3">{row.sessionsCompleted}</td>
                  <td className="p-3">{row.sessionsInterrupted}</td>
                  <td className="p-3">{row.lessonsCompleted}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {levelKey && (
        <div className="card overflow-x-auto">
          <p className="p-3 text-xs font-medium uppercase tracking-wide text-chakra-400">Level breakdown</p>
          <table className="w-full text-sm">
            <thead className="border-b border-chakra-100 text-left text-xs uppercase tracking-wide text-chakra-400">
              <tr>
                <th className="p-3">Date</th>
                <th className="p-3">App</th>
                <th className="p-3">Level</th>
                <th className="p-3">Age band</th>
                <th className="p-3">Active learners</th>
                <th className="p-3">Engaged (s)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-chakra-100">
              {levelAggregates.map((row) => (
                <tr key={`${row.activityDate}-${row.appId}-${row.levelKey}-${row.ageBand}`}>
                  <td className="p-3">{row.activityDate}</td>
                  <td className="p-3">{row.appDisplayName}</td>
                  <td className="p-3">{row.levelKey}</td>
                  <td className="p-3">{row.ageBand}</td>
                  <td className="p-3">{row.activeLearners}</td>
                  <td className="p-3">{row.engagedSeconds}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-chakra-400">{label}</p>
      <p className="mt-1 text-xl font-semibold text-chakra-900">{value}</p>
    </div>
  );
}
