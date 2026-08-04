import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { runDailyAggregation } from "@/lib/db/analytics-run-repo";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Scheduler-invoked. Business rule 2: the caller always passes the
// explicit previous Asia/Kolkata activityDate — this route never infers
// "today" from the server clock itself.
export async function POST(request: Request, { params }: { params: { activityDate: string } }) {
  const guard = requireInternalService(request);
  if (!guard.ok) return guard.response;

  if (!CALENDAR_DATE.test(params.activityDate)) {
    return NextResponse.json({ error: "ACTIVITY_DATE_INVALID" }, { status: 400 });
  }

  const outcome = runDailyAggregation(params.activityDate);
  return NextResponse.json(outcome);
}
