import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { listDailyRuns } from "@/lib/db/analytics-admin-repo";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

// AC32: running/failed dates are visible here with their status so an
// admin can tell them apart from completed ones (the /daily endpoint
// only ever has rows for completed dates).
export async function GET(request: Request) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const runs = listDailyRuns({
    from: from && CALENDAR_DATE.test(from) ? from : undefined,
    to: to && CALENDAR_DATE.test(to) ? to : undefined,
  });
  return NextResponse.json({ runs });
}
