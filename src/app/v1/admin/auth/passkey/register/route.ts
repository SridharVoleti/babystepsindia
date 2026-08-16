import { NextResponse } from "next/server";
import { requireAdminApi, requireStaffSensitiveReauth } from "@/lib/staff-identity/guard";
import { staffFailure } from "@/lib/staff-identity/route-helpers";
import { verifyPendingStaffToken } from "@/lib/staff-identity/session";
import { verifyStaffPasskeyRegistration } from "@/lib/webauthn/staff-service";

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
  if (typeof body.pendingToken === "string") {
    const decoded = await verifyPendingStaffToken(body.pendingToken);
    if (!decoded || decoded.purpose !== "enrollment") {
      return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
    }
    staffAccountId = decoded.staffAccountId;
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
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return staffFailure(error);
  }
}
