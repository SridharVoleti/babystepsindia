import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { listDailyAppAggregates, listDailyLevelAggregates } from "@/lib/db/analytics-admin-repo";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Cohort-only read (AC23): filters and rows never accept or return a
// learner identifier. Aggregate tables only ever contain rows for
// completed dates (business rule 25), so this naturally excludes
// running/failed dates without extra filtering — see
// GET /v1/admin/analytics/runs for status on those.
export async function GET(request: Request) {
  const guard = await requireAdminApi();
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  const appId = searchParams.get("appId");
  const levelKey = searchParams.get("levelKey");
  const ageBand = searchParams.get("ageBand");

  const filters = {
    from: from && CALENDAR_DATE.test(from) ? from : undefined,
    to: to && CALENDAR_DATE.test(to) ? to : undefined,
    appId: appId ?? undefined,
    levelKey: levelKey ?? undefined,
    ageBand: ageBand ?? undefined,
  };

  return NextResponse.json({
    levels: listDailyLevelAggregates(filters),
    apps: listDailyAppAggregates(filters),
  });
}
