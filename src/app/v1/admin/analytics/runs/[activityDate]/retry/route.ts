import { NextResponse } from "next/server";
import { isStrictCalendarDate } from "@/lib/analytics/calendar-date";
import { requireAdminApi, verifyReauth } from "@/lib/auth/admin-api-guard";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { runDailyAggregation } from "@/lib/db/analytics-run-repo";

// UI/UX spec: "Retry action requires analytics_run_retry permission."
// runDailyAggregation() already treats a 'failed' date as retryable and
// a 'completed'/'running' date as a safe no-op replay (AT-AN-001-19).
export async function POST(request: Request, { params }: { params: { activityDate: string } }) {
  const guard = await requireAdminApi("analytics_run_retry");
  if (!guard.ok) return guard.response;

  if (!checkRateLimit(`analytics-run-retry:${guard.session.sub}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }

  if (!isStrictCalendarDate(params.activityDate)) {
    return NextResponse.json({ error: "ACTIVITY_DATE_INVALID" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)
    || Object.keys(body).some((key) => key !== "currentPassword")
    || typeof (body as Record<string, unknown>).currentPassword !== "string") {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const currentPassword = (body as { currentPassword: string }).currentPassword;
  if (!(await verifyReauth(guard.session.email, currentPassword))) {
    return NextResponse.json({ error: "REAUTHENTICATION_REQUIRED" }, { status: 401 });
  }

  const outcome = runDailyAggregation(params.activityDate);
  return NextResponse.json(outcome);
}
