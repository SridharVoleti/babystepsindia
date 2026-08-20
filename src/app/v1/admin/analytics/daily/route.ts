import { NextResponse } from "next/server";
import { isStrictCalendarDate } from "@/lib/analytics/calendar-date";
import { AnalyticsScopeExceededError, composeScopedDailyAnalytics } from "@/lib/analytics/reporting";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";

// Cohort-only read (AC23): filters and rows never accept or return a
// learner identifier. Aggregate tables only ever contain rows for
// completed dates (business rule 25), so this naturally excludes
// running/failed dates without extra filtering — see
// GET /v1/admin/analytics/runs for status on those.
// AN-004: response shape is role-scoped (Super Admin only gets the
// level-key breakdown) and every row is cohort-suppressed below
// MIN_COHORT_SIZE — see src/lib/analytics/reporting.ts.
export async function GET(request: Request) {
  const guard = await requireAdminApi("admin.analytics.daily.read");
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
    return NextResponse.json(await composeScopedDailyAnalytics(guard.session.roleKeys, filters));
  } catch (err) {
    if (err instanceof AnalyticsScopeExceededError) {
      return NextResponse.json({ error: "ANALYTICS_SCOPE_EXCEEDED" }, { status: 403 });
    }
    throw err;
  }
}
