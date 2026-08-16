import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { requireAdminApi } from "@/lib/staff-identity/guard";
import { staffFailure } from "@/lib/staff-identity/route-helpers";
import { beginStaffLogin, beginStaffReauth } from "@/lib/staff-identity/auth-service";
import { generateStaffPasskeyAssertionOptions } from "@/lib/webauthn/staff-service";

// API-AD-005: issues a 5-minute WebAuthn assertion challenge. Two flows —
// password-authenticated pending-admin login (body.email/password) or an
// already-authenticated staff session's sensitive-reauth elevation
// (body.currentPassword, no email needed — the session already identifies
// the staff account).
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  try {
    if (typeof body.email === "string") {
      if (!checkRateLimit(`staff-login:${body.email.toLowerCase()}`, 10, 15 * 60_000)) {
        return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
      }
      if (typeof body.password !== "string") return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
      const begin = await beginStaffLogin({ email: body.email, password: body.password });
      if (begin.purpose === "enrollment") {
        return NextResponse.json(
          { pendingToken: begin.pendingToken, purpose: begin.purpose },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      const { challengeId, options } = await generateStaffPasskeyAssertionOptions({
        staffAccountId: begin.staffAccountId,
        purpose: "login",
      });
      return NextResponse.json(
        { pendingToken: begin.pendingToken, purpose: begin.purpose, challengeId, options },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const guard = await requireAdminApi("admin.staff.passkey.assertion_options");
    if (!guard.ok) return guard.response;
    if (typeof body.currentPassword !== "string") {
      return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
    }
    const begin = await beginStaffReauth({
      staffAccountId: guard.session.staffAccountId,
      staffSessionId: guard.session.sessionId,
      currentPassword: body.currentPassword,
    });
    const { challengeId, options } = await generateStaffPasskeyAssertionOptions({
      staffAccountId: guard.session.staffAccountId,
      purpose: "reauth",
    });
    return NextResponse.json(
      { pendingToken: begin.pendingToken, purpose: "reauth", challengeId, options },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return staffFailure(error);
  }
}
