import { NextResponse } from "next/server";
import { checkRateLimit } from "@/lib/auth/rate-limit";
import { staffFailure } from "@/lib/staff-identity/route-helpers";
import { passwordOnlyStaffLogin } from "@/lib/staff-identity/auth-service";
import { setStaffSessionCookie } from "@/lib/staff-identity/session";

// Temporary simplification (2026-08-27, explicit request): password-only
// staff login, no passkey/MFA ceremony — see passwordOnlyStaffLogin's own
// comment (auth-service.ts) for how to switch back to the MFA flow later.
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }
  if (typeof body.email !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (!checkRateLimit(`staff-login:${body.email.toLowerCase()}`, 10, 15 * 60_000)) {
    return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
  }
  try {
    const { payload } = await passwordOnlyStaffLogin({ email: body.email, password: body.password });
    await setStaffSessionCookie(payload);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return staffFailure(error);
  }
}
