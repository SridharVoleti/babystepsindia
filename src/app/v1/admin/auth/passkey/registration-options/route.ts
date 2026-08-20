import { NextResponse } from "next/server";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { staffFailure } from "@/lib/staff-identity/route-helpers";
import { verifyPendingStaffToken } from "@/lib/staff-identity/session";
import { findStaffById } from "@/lib/staff-identity/accounts-repo";
import { generateStaffPasskeyRegistrationOptions } from "@/lib/webauthn/staff-service";

// API-AD-003: issues a 5-minute WebAuthn registration challenge. Two
// entry points, matching business rules 15/26: a first-time enrollment
// pendingToken (no full session yet — bootstrap/invited staff before any
// passkey exists), or an already-authenticated staff session adding an
// additional passkey (requires business rule 15's recent reauth).
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  let staffAccountId: string;
  if (typeof body.pendingToken === "string") {
    const decoded = await verifyPendingStaffToken(body.pendingToken);
    // AD-005 rule 43: a recovery pendingToken authorizes exactly the same
    // one-new-credential registration flow as first-time enrollment.
    if (!decoded || (decoded.purpose !== "enrollment" && decoded.purpose !== "staff_passkey_recovery")) {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }
    staffAccountId = decoded.staffAccountId;
  } else {
    const guard = await requireAdminApi("admin.staff.passkey.registration_options");
    if (!guard.ok) return guard.response;
    const reauthFailure = await requireStaffSensitiveReauth(guard.session);
    if (reauthFailure) return reauthFailure;
    staffAccountId = guard.session.staffAccountId;
  }

  const staff = findStaffById(staffAccountId);
  if (!staff) return NextResponse.json({ error: "RESOURCE_NOT_FOUND" }, { status: 404 });

  try {
    const result = await generateStaffPasskeyRegistrationOptions({
      staffAccountId,
      displayName: staff.display_name ?? staff.normalized_email,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return staffFailure(error);
  }
}
