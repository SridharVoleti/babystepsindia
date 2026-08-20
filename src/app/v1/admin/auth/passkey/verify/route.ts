import { NextResponse } from "next/server";
import { staffFailure } from "@/lib/staff-identity/route-helpers";
import { completeStaffLogin } from "@/lib/staff-identity/auth-service";
import { recordReauthReceipt } from "@/lib/staff-identity/reauth-service";
import { setStaffSessionCookie, verifyPendingStaffToken } from "@/lib/staff-identity/session";
import { verifyStaffPasskeyAssertion } from "@/lib/webauthn/staff-service";

// API-AD-006: validates the assertion; completes MFA staff login OR
// records a recent two-factor-reauth receipt, branching on the pending
// token's purpose established by API-AD-005.
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (
    typeof body.pendingToken !== "string" ||
    typeof body.challengeId !== "string" || !body.challengeId ||
    !body.response || typeof body.response !== "object"
  ) {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }

  const decoded = await verifyPendingStaffToken(body.pendingToken);
  if (!decoded || (decoded.purpose !== "login" && decoded.purpose !== "reauth")) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  try {
    await verifyStaffPasskeyAssertion({
      staffAccountId: decoded.staffAccountId,
      purpose: decoded.purpose,
      challengeId: body.challengeId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response: body.response as any,
    });

    if (decoded.purpose === "login") {
      const { payload } = await completeStaffLogin({ staffAccountId: decoded.staffAccountId });
      await setStaffSessionCookie(payload);
      return NextResponse.json({ ok: true, purpose: "login" }, { headers: { "Cache-Control": "no-store" } });
    }

    if (!decoded.staffSessionId) {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    await recordReauthReceipt({ staffSessionId: decoded.staffSessionId, staffAccountId: decoded.staffAccountId });
    return NextResponse.json({ ok: true, purpose: "reauth" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return staffFailure(error);
  }
}
