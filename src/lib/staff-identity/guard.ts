import { NextResponse } from "next/server";
import type { AuthorizationAction } from "@/lib/authorization/modes";
import { activeRoleKeys, findStaffById } from "@/lib/staff-identity/accounts-repo";
import { StaffIdentityError, staffIdentityErrorStatus } from "@/lib/staff-identity/errors";
import { roleHasCapability } from "@/lib/staff-identity/roles";
import { requireSensitiveReauth } from "@/lib/staff-identity/reauth-service";
import { getStaffSession, isStaffSessionLive, type StaffSessionPayload } from "@/lib/staff-identity/session";

export type StaffApiGuardResult =
  | { ok: true; session: StaffSessionPayload }
  | { ok: false; response: NextResponse };

// Business rules 20, 22-24, 37-38: every admin API resolves the CURRENT
// staff session/role/status server-side on every call — the browser's
// session claims are hints only. Fails closed on a stale authorization
// generation (suspend/role-change/password-change propagate here, not
// just at next login) and on idle/absolute session expiry.
export async function requireAdminApi(action: AuthorizationAction): Promise<StaffApiGuardResult> {
  const session = await getStaffSession();
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 }) };
  }
  const staff = findStaffById(session.staffAccountId);
  if (!staff || !isStaffSessionLive(session, staff, new Date())) {
    return { ok: false, response: NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 }) };
  }
  // Business rule 36-37: current role assignments, not the session's
  // cached roleKeys claim, are authoritative for the capability check —
  // the session payload's roleKeys is refreshed below for callers that
  // need to display it, but the check itself always hits the DB.
  const currentRoleKeys = activeRoleKeys(staff.id);
  if (!roleHasCapability(currentRoleKeys, action)) {
    return { ok: false, response: NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }) };
  }
  return { ok: true, session: { ...session, roleKeys: currentRoleKeys } };
}

// Business rules 60-69: sensitive mutations require a live <=10-minute
// two-factor reauth receipt for this exact session — fails closed with no
// mutation when absent/expired.
export async function requireStaffSensitiveReauth(
  session: Pick<StaffSessionPayload, "sessionId" | "staffAccountId">,
): Promise<NextResponse | null> {
  try {
    await requireSensitiveReauth({ staffSessionId: session.sessionId, staffAccountId: session.staffAccountId });
    return null;
  } catch (error) {
    if (error instanceof StaffIdentityError) {
      return NextResponse.json({ error: error.code }, { status: staffIdentityErrorStatus(error.code) });
    }
    throw error;
  }
}
