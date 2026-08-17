import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { compactMonitoringHistory, syncMonitoringSnapshots } from "@/lib/monitoring/service";

// AN-002: copies the latest rows from each registered critical job-run
// table into this module's own snapshot storage, then rolls anything
// older than 30 days into a monthly aggregate and purges the aged-out
// detail — never touches a source-domain table.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "operational-monitoring");
  if (!guard.ok) return guard.response;
  const now = new Date();
  const synced = syncMonitoringSnapshots(now);
  const compacted = compactMonitoringHistory(now);
  return NextResponse.json({ ...synced, ...compacted }, { headers: { "Cache-Control": "no-store" } });
}
