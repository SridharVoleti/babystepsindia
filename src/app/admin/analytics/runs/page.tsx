import Link from "next/link";
import type { Metadata } from "next";
import { isStrictCalendarDate } from "@/lib/analytics/calendar-date";
import { requireAdminPermission } from "@/lib/auth/guards";
import { listDailyRuns } from "@/lib/db/analytics-admin-repo";
import { StatusPill } from "@/components/admin/status-pill";
import { RetryRunButton } from "@/components/analytics/retry-run-button";

export const metadata: Metadata = { title: "Analytics runs — Baby Steps Admin" };

// AC20/AC32/UI-UX spec: date, running/completed/failed state, source row
// count, control totals and failure code — never a raw buffer row or
// learner daily key.
export default async function AnalyticsRunsPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string };
}) {
  await requireAdminPermission("admin.analytics.runs.read");

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
  const runs = listDailyRuns({ from, to });

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/analytics" className="text-sm font-medium text-green-700 hover:text-green-800">
          ← Back to analytics
        </Link>
        <h1 className="mt-3 text-2xl font-bold text-chakra-900">Analytics runs</h1>
        <p className="mt-1 text-sm text-chakra-500">
          One row per Asia/Kolkata activity date (AN-001). Retry reprocesses a failed date from its retained
          buffer — it never changes a completed date&apos;s aggregates.
        </p>
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
        <button type="submit" className="btn-secondary">Apply</button>
      </form>

      <div className="card divide-y divide-chakra-100">
        {runs.length === 0 ? (
          <p className="p-5 text-sm text-chakra-500">No runs recorded yet.</p>
        ) : (
          runs.map((run) => (
            <div key={run.activityDate} className="flex items-center justify-between gap-4 p-5">
              <div>
                <p className="font-medium text-chakra-900">{run.activityDate}</p>
                <p className="mt-0.5 text-xs text-chakra-400">
                  {run.sourceRowCount} source rows · {run.controlTotals.engagedSeconds}s engaged ·{" "}
                  {run.controlTotals.sessionsStarted} started / {run.controlTotals.sessionsCompleted} completed /{" "}
                  {run.controlTotals.sessionsInterrupted} interrupted · {run.controlTotals.lessonsCompleted} lessons
                </p>
                {run.failureCode && (
                  <p className="mt-0.5 text-xs text-red-700">Failure: {run.failureCode}</p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <StatusPill status={run.status} />
                {run.status === "failed" && <RetryRunButton activityDate={run.activityDate} />}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
