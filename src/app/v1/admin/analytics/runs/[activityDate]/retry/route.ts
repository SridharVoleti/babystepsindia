import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { runDailyAggregation } from "@/lib/db/analytics-run-repo";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

// UI/UX spec: "Retry action requires analytics_run_retry permission."
// runDailyAggregation() already treats a 'failed' date as retryable and
// a 'completed'/'running' date as a safe no-op replay (AT-AN-001-19).
export async function POST(request: Request, { params }: { params: { activityDate: string } }) {
  const guard = await requireAdminApi("analytics_run_retry");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`analytics-run-retry:${guard.session.sub}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  if (!CALENDAR_DATE.test(params.activityDate)) {
    return NextResponse.json({ error: "ACTIVITY_DATE_INVALID" }, { status: 400 });
  }

  const outcome = runDailyAggregation(params.activityDate);
  return NextResponse.json(outcome);
}
