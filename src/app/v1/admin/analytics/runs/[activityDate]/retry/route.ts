import { NextResponse } from "next/server";
import { isStrictCalendarDate } from "@/lib/analytics/calendar-date";
import { requireAdminApi, requireReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { runDailyAggregation } from "@/lib/db/analytics-run-repo";

// UI/UX spec: "Retry action requires analytics_run_retry permission."
// runDailyAggregation() already treats a 'failed' date as retryable and
// a 'completed'/'running' date as a safe no-op replay (AT-AN-001-19).
export async function POST(request: Request, { params }: { params: { activityDate: string } }) {
  const guard = await requireAdminApi("admin.analytics.run.retry");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`analytics-run-retry:${guard.session.sub}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  if (!isStrictCalendarDate(params.activityDate)) {
    return NextResponse.json({ error: "ACTIVITY_DATE_INVALID" }, { status: 400 });
  }

  const reauthFailure = await requireReauth(guard.session);
  if (reauthFailure) return reauthFailure;

  const outcome = await runDailyAggregation(params.activityDate);
  return NextResponse.json(outcome);
}
