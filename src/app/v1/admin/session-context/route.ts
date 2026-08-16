import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/staff-identity/guard";
import { findStaffById } from "@/lib/staff-identity/accounts-repo";
import { isSuperAdminDisplay } from "@/lib/staff-identity/roles";

// API-AD-002: any active MFA staff session. Returns safe current staff
// identity, role/capability hints, auth/reauth/session expiry and the
// authorization generation — server-authoritative, the client never
// supplies this as truth (business rules 36-37, 107-108).
export async function GET() {
  const guard = await requireAdminApi("admin.staff.session_context.read");
  if (!guard.ok) return guard.response;
  const staff = findStaffById(guard.session.staffAccountId);
  if (!staff) return NextResponse.json({ error: "RESOURCE_NOT_FOUND" }, { status: 404 });

  return NextResponse.json(
    {
      staffAccountId: staff.id,
      displayName: staff.display_name,
      emailHint: staff.normalized_email.replace(/^(.).*(@.*)$/, "$1***$2"),
      roles: guard.session.roleKeys,
      isSuperAdmin: isSuperAdminDisplay(guard.session.roleKeys),
      authenticationTime: guard.session.authenticationTime,
      mfaVerificationTime: guard.session.mfaVerificationTime,
      authorizationGeneration: guard.session.authorizationGeneration,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
