import { NextResponse } from "next/server";
import { isStrictCalendarDate } from "@/lib/analytics/calendar-date";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { listDailyRuns } from "@/lib/db/analytics-admin-repo";

// AC32: running/failed dates are visible here with their status so an
// admin can tell them apart from completed ones (the /daily endpoint
// only ever has rows for completed dates).
export async function GET(request: Request) {
  const guard = await requireAdminApi("admin.analytics.runs.read");
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if ((from !== null && !isStrictCalendarDate(from)) || (to !== null && !isStrictCalendarDate(to))) {
    return NextResponse.json({ error: "DATE_FILTER_INVALID" }, { status: 400 });
  }

  const runs = await listDailyRuns({
    from: from ?? undefined,
    to: to ?? undefined,
  });
  return NextResponse.json({ runs });
}
