import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { ProgressIntegrityError, progressIntegrityErrorStatus } from "@/lib/progress-integrity/errors";
import { getSafeIncident } from "@/lib/progress-integrity/incidents";

// PR-004 rule 62: exact progress-integrity operations permission — reads
// don't additionally require recent reauthentication (matching this
// codebase's existing convention that reauth is reserved for mutating
// admin actions, e.g. the deployment-rollback route).
export async function GET(request: Request, { params }: { params: { incidentId: string } }) {
  const guard = await requireAdminApi("admin.progress_integrity.incident.read");
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json(getSafeIncident(params.incidentId));
  } catch (error) {
    if (error instanceof ProgressIntegrityError) {
      return NextResponse.json({ error: error.code }, { status: progressIntegrityErrorStatus(error.code) });
    }
    throw error;
  }
}
