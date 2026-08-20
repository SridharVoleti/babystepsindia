import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/staff-identity/guard";
import { getOperationalStatus } from "@/lib/monitoring/service";

// AN-002: read-only last-run/status/counts for the representative set of
// critical jobs this projection covers — observational only, never able
// to mutate billing/access/session/progress truth.
export async function GET() {
  const guard = await requireAdminApi("admin.monitoring.status.read");
  if (!guard.ok) return guard.response;
  return NextResponse.json({ jobs: await getOperationalStatus() }, { headers: { "Cache-Control": "private, no-store" } });
}
