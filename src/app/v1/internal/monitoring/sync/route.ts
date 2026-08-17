import { NextResponse } from "next/server";
import { requireInternalService } from "@/lib/auth/internal-service-guard";
import { compactMonitoringHistory, registeredJobKeys, syncMonitoringSnapshots } from "@/lib/monitoring/service";
import { escalatePersistentJobFailures } from "@/lib/monitoring/alerting";

// AN-002: copies the latest rows from each registered critical job-run
// table into this module's own snapshot storage, then rolls anything
// older than 30 days into a monthly aggregate and purges the aged-out
// detail — never touches a source-domain table.
// AN-003: once the fresh snapshot is in, checks each job for a truly
// persistent (not single-transient) failure run and raises/resolves a
// deduplicated platform_alerts row accordingly.
export async function POST(request: Request) {
  const guard = await requireInternalService(request, "operational-monitoring");
  if (!guard.ok) return guard.response;
  const now = new Date();
  const synced = syncMonitoringSnapshots(now);
  // Escalation reads the freshest detail rows before compaction can purge
  // any of them out from under it.
  const escalations = registeredJobKeys().map((jobKey) => escalatePersistentJobFailures(jobKey, now));
  const compacted = compactMonitoringHistory(now);
  return NextResponse.json({ ...synced, ...compacted,
    escalated: escalations.filter((e) => e.escalated).length, resolved: escalations.filter((e) => e.resolved).length },
    { headers: { "Cache-Control": "no-store" } });
}
