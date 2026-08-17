import { NextResponse } from "next/server";
import { isStrictCalendarDate } from "@/lib/analytics/calendar-date";
import { AnalyticsScopeExceededError, composeScopedDailyAnalyticsCsv } from "@/lib/analytics/reporting";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";

// AT-AN-004-03: the CSV export contains only the authorised aggregate
// view, with the same filters/scope/cohort-suppression as
// GET /v1/admin/analytics/daily — never a second, unsuppressed egress
// path.
export async function GET(request: Request) {
  const guard = await requireAdminApi("admin.analytics.daily.export");
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const appId = searchParams.get("appId");
  const levelKey = searchParams.get("levelKey");
  const ageBand = searchParams.get("ageBand");

  if ((from !== null && !isStrictCalendarDate(from)) || (to !== null && !isStrictCalendarDate(to))) {
    return NextResponse.json({ error: "DATE_FILTER_INVALID" }, { status: 400 });
  }

  const filters = {
    from: from ?? undefined,
    to: to ?? undefined,
    appId: appId ?? undefined,
    levelKey: levelKey ?? undefined,
    ageBand: ageBand ?? undefined,
  };

  try {
    const csv = composeScopedDailyAnalyticsCsv(guard.session.roleKeys, filters);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": 'attachment; filename="analytics-daily.csv"',
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    if (err instanceof AnalyticsScopeExceededError) {
      return NextResponse.json({ error: "ANALYTICS_SCOPE_EXCEEDED" }, { status: 403 });
    }
    throw err;
  }
}
