import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/staff-identity/guard";
import { listOpenAlerts } from "@/lib/monitoring/alerting";

// AN-003: read-only view over the deduplicated Major/Critical alert
// store — never a mutation surface. Recovery closes an alert via the
// internal sync route's own escalation/resolution pass, not this route.
export async function GET() {
  const guard = await requireAdminApi("admin.monitoring.alerts.read");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ alerts: await listOpenAlerts() }, { headers: { "Cache-Control": "private, no-store" } });
}
