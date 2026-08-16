import { NextResponse } from "next/server";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { staffFailure } from "@/lib/staff-identity/route-helpers";
import { verifyPendingStaffToken } from "@/lib/staff-identity/session";
import { verifyStaffPasskeyRegistration } from "@/lib/webauthn/staff-service";
import { completeRecoveryEnrollment } from "@/lib/platform-governance/recovery-sessions";
import { PlatformGovernanceError, platformGovernanceErrorStatus } from "@/lib/platform-governance/contracts";

// API-AD-004: validates challenge/origin/RP/user-verification and stores
// the staff public credential. Same dual entry point as registration-options.
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (
    typeof body.challengeId !== "string" || !body.challengeId ||
    typeof body.label !== "string" || !body.label.trim() || body.label.length > 60 ||
    !body.response || typeof body.response !== "object"
  ) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  let staffAccountId: string;
  let recoverySessionId: string | undefined;
  if (typeof body.pendingToken === "string") {
    const decoded = await verifyPendingStaffToken(body.pendingToken);
    if (!decoded || (decoded.purpose !== "enrollment" && decoded.purpose !== "staff_passkey_recovery")) {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }
    if (decoded.purpose === "staff_passkey_recovery" && !decoded.recoverySessionId) {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }
    staffAccountId = decoded.staffAccountId;
    recoverySessionId = decoded.recoverySessionId;
  } else {
    const guard = await requireAdminApi("admin.staff.passkey.register");
    if (!guard.ok) return guard.response;
    const reauthFailure = requireStaffSensitiveReauth(guard.session);
    if (reauthFailure) return reauthFailure;
    staffAccountId = guard.session.staffAccountId;
  }

  try {
    const result = await verifyStaffPasskeyRegistration({
      staffAccountId,
      challengeId: body.challengeId,
      label: body.label.trim(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.response as any,
    });
    // AD-005 rules 43-46: the recovery session is consumed only once the
    // new credential is actually stored, and only here does the staff
    // account's authorization_generation bump — never at issuance.
    if (recoverySessionId) {
      completeRecoveryEnrollment({ recoverySessionId, staffAccountId });
    }
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlatformGovernanceError) {
      return NextResponse.json({ error: error.code }, { status: platformGovernanceErrorStatus(error.code) });
    }
    return staffFailure(error);
  }
}
