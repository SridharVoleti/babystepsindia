import { NextResponse } from "next/server";
import { isStrictCalendarDate } from "@/lib/analytics/calendar-date";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { runDailyAggregation } from "@/lib/db/analytics-run-repo";
import { AnalyticsError } from "@/lib/analytics/errors";

// Scheduler-invoked. Business rule 2: the caller always passes the
// explicit previous Asia/Kolkata activityDate — this route never infers
// "today" from the server clock itself.
export async function POST(request: Request, { params }: { params: { activityDate: string } }) {
  const guard = await requireInternalService(request, "scheduler");
  if (!guard.ok) return guard.response;

  if (!isStrictCalendarDate(params.activityDate)) {
    return NextResponse.json({ error: "ACTIVITY_DATE_INVALID" }, { status: 400 });
  }

  try {
    const outcome = await runDailyAggregation(params.activityDate);
    return NextResponse.json(outcome);
  } catch (error) {
    if (error instanceof AnalyticsError) {
      return NextResponse.json({ error: error.code }, { status: 500 });
    }
    throw error;
  }
}
