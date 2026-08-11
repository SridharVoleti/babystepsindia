import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api-guard";
import { EntitlementIntegrityError, entitlementIntegrityErrorStatus } from "@/lib/entitlement-integrity/errors";
import { getSafeIncident } from "@/lib/entitlement-integrity/incidents";

// EN-004 rule 46: exact operations permission — reads don't additionally
// require recent reauthentication, matching this codebase's existing
// convention (reauth is reserved for mutating admin actions).
export async function GET(request: Request, { params }: { params: { incidentId: string } }) {
  const guard = await requireAdminApi("entitlement_integrity_manage");
  if (!guard.ok) return guard.response;
  try {
    return NextResponse.json(getSafeIncident(params.incidentId));
  } catch (error) {
    if (error instanceof EntitlementIntegrityError) {
      return NextResponse.json({ error: error.code }, { status: entitlementIntegrityErrorStatus(error.code) });
    }
    throw error;
  }
}
